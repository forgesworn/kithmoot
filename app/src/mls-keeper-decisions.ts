import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, type BrowserPersonaCoordinator, type CoordinationResult, type PersonaTransaction } from './mls-persona-coordinator.js'
import { validateMlsGrant, mlsGrantReference, type BrowserMlsGrantStore } from './mls-grant-ledger.js'
import { readMlsRoom, mlsRoomIds } from './mls-room-store.js'
import { loadMlsEngine } from './mls-engine.js'
import { mlsKeeperRemovalOperation, mlsKeeperGrantAuthority, validateMlsKeeperApproval, type MlsKeeperApproval, type MlsKeeperGrantAuthority, type MlsKeeperRoomIntent } from './mls-revocation-decision-store.js'
import type { MlsRevocationInboxPrompt } from './mls-revocation-inbox-store.js'
import type { MlsRevocationInboxContext } from './mls-revocation-inbox.js'
import type { MlsMemberStatus } from './mls-room-operations.js'
import type { Platform, Session } from '../public/vmls-wasm/vmls_wasm.js'
import type { VaultContext } from './mls-vault.js'

export interface MlsKeeperDecisionPlan {
  binding: VaultContext
  prompt: MlsRevocationInboxPrompt
  conflict: boolean
  grants: MlsKeeperGrantAuthority[]
  rooms: MlsKeeperRoomIntent[]
}
/** Explicit operator decisions only. Approval records intent before any
 * future room or box effect. This class itself cannot publish or remove. */
export class BrowserMlsKeeperDecisions {
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>, private grants: Pick<BrowserMlsGrantStore, 'all'>,
    private context: () => MlsRevocationInboxContext | undefined, private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  plan(operation: string): Promise<CoordinationResult<MlsKeeperDecisionPlan>> {
    const scope = this.#scope()
    return this.coordinator.transact(scope.vault.persona, tx => this.#review(tx, scope, operation), () => this.#current(scope))
  }
  async decide(plan: MlsKeeperDecisionPlan, approve: boolean): Promise<CoordinationResult<MlsRevocationInboxPrompt>> {
    const scope = this.#scope(), expected = structuredClone(plan)
    if (typeof approve !== 'boolean' || JSON.stringify(scope.vault) !== JSON.stringify(expected.binding)) throw new Error('Review the request in the current keeper account.')
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const fresh = await this.#review(tx, scope, expected.prompt.operation)
      if (JSON.stringify(fresh) !== JSON.stringify(expected)) throw new Error('The request, roster or grant authority changed. Review it again.')
      const journal = await readMlsMembership(tx), inbox = journal.inbox!, prompt = inbox.prompts.find(item => item.operation === expected.prompt.operation)!, at = this.#time()
      if (at < inbox.checkedAt) throw new Error('A trusted request time is unavailable.')
      if (at >= prompt.request.expiration) throw new Error('The request expired before the decision was recorded.')
      inbox.checkedAt = at
      prompt.state = approve ? 'approved' : 'dismissed'
      if (approve) {
        const approval: MlsKeeperApproval = { approvedAt: at, grants: structuredClone(fresh.grants), rooms: structuredClone(fresh.rooms) }
        validateMlsKeeperApproval(approval, prompt.request, prompt.operation, prompt.receivedAt)
        prompt.approval = approval
      }
      await saveMlsMembership(tx, journal)
      return structuredClone(prompt)
    }, () => this.#current(scope))
  }
  retained(operation: string): Promise<CoordinationResult<MlsRevocationInboxPrompt>> {
    const scope = this.#scope()
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const journal = await readMlsMembership(tx)
      if (journal.inbox?.keeper !== scope.vault.persona) throw new InvalidPersonaRecord('Keeper decision belongs to another persona')
      const prompt = journal.inbox.prompts.find(item => item.operation === operation)
      if (!prompt) throw new Error('This request is no longer retained.')
      return structuredClone(prompt)
    }, () => this.#current(scope))
  }
  async #review(tx: PersonaTransaction, scope: MlsRevocationInboxContext, operation: string): Promise<MlsKeeperDecisionPlan> {
    const journal = await readMlsMembership(tx), inbox = journal.inbox, at = this.#time()
    if (!inbox || inbox.keeper !== scope.vault.persona) throw new InvalidPersonaRecord('Keeper decision belongs to another persona')
    if (at < inbox.checkedAt) throw new Error('A trusted request time is unavailable.')
    const prompt = inbox.prompts.find(item => item.operation === operation)
    if (!prompt || prompt.state !== 'pending' || prompt.request.expiration <= at) throw new Error('This request is no longer awaiting a decision.')
    const records = structuredClone(await this.grants.all())
    if (!Array.isArray(records) || records.length > 256 || new Set(records.map(record => `${record.node}/${record.device}`)).size !== records.length) throw new Error('The keeper grant ledger could not be verified.')
    records.forEach(validateMlsGrant)
    const request = prompt.request, selected = records.filter(record => record.issuer === scope.vault.persona && record.persona === request.sender && record.device === request.device && record.state !== 'revoked')
    if (!selected.length) throw new Error('This request no longer matches the keeper grant ledger.')
    const grants: MlsKeeperGrantAuthority[] = selected.map(mlsKeeperGrantAuthority).sort((a, b) => a.node.localeCompare(b.node))
    const ids = await mlsRoomIds(tx), rooms: MlsKeeperRoomIntent[] = []
    if (selected.some(grant => grant.rooms.some(use => !ids.includes(use.session)))) throw new Error('A keeper room must be restored before reviewing this request.')
    for (const id of ids) {
      const room = await readMlsRoom(tx, id)
      if (room.keeper !== scope.vault.persona) {
        if (selected.some(grant => grant.rooms.some(use => use.session === id))) throw new Error('A saved grant room no longer belongs to this keeper.')
        continue
      }
      const saved = await tx.readSession(id)
      if (!saved) throw new Error('A keeper room must be restored before reviewing this request.')
      let platform: Platform | undefined, session: Session | undefined
      try {
        const wasm = await loadMlsEngine()
        platform = new wasm.Platform(hexToBytes(room.binding.device), hexToBytes(room.binding.rendezvousKey), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
        session = wasm.Session.open(platform, hexToBytes(id), saved.plaintext, saved.generation)
        if (bytesToHex(session.id()) !== id || session.generation() !== saved.generation || room.generation !== String(saved.generation)) throw new InvalidPersonaRecord('Keeper decision snapshot does not match its room')
        const members: MlsMemberStatus[] = (session.members() as any[]).map(info => ({ leafId: bytesToHex(info.member.leafId), identity: bytesToHex(info.member.identity),
          device: bytesToHex(info.member.device), homeBox: bytesToHex(info.homeBox), bindingExpiresAt: Number(info.bindingExpiresAt), own: info.own, pending: info.pending }))
        const targets = members.filter(member => member.device === request.device)
        if (targets.some(member => member.identity !== request.sender || member.own)) throw new Error('The requested device no longer belongs to its sender in the keeper roster.')
        for (const member of targets) {
          if (!Number.isSafeInteger(member.bindingExpiresAt) || member.bindingExpiresAt < 0) throw new Error('The member binding time cannot be reviewed by this browser.')
          if (rooms.length >= 64) throw new Error('There are too many affected keeper leaves for one approval.')
          rooms.push({ session: id, name: room.name, rendezvousKey: room.binding.rendezvousKey, operation: mlsKeeperRemovalOperation(operation, id, member.leafId), member,
            action: session.phase().type === 'Active' && !member.pending ? 'remove' : 'ledger-only' })
        }
      } finally { saved.plaintext.fill(0); try { session?.free() } finally { platform?.free() } }
    }
    rooms.sort((a, b) => a.session.localeCompare(b.session) || a.member.leafId.localeCompare(b.member.leafId))
    const conflict = inbox.prompts.some(other => other.state === 'pending' && other.request.expiration > at && other.request.sender === request.sender && other.request.device !== request.device)
    return { binding: { ...scope.vault }, prompt: structuredClone(prompt), conflict, grants, rooms }
  }
  #time(): number { const at = this.now(); if (!Number.isSafeInteger(at) || at < 0) throw new Error('A trusted request time is unavailable.'); return at }
  #scope(): MlsRevocationInboxContext {
    const scope = this.context()
    if (!scope || !scope.current() || !scope.foreground() || !/^[0-9a-f]{64}$/.test(scope.vault.persona)) throw new Error('Open the keeper account in the foreground before deciding.')
    return { ...scope, vault: { ...scope.vault } }
  }
  #current(scope: MlsRevocationInboxContext): boolean {
    const next = this.context()
    return !!next && scope.current() && scope.foreground() && next.current() && next.foreground() && JSON.stringify(next.vault) === JSON.stringify(scope.vault)
  }
}
