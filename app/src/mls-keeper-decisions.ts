import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, type BrowserPersonaCoordinator, type CoordinationResult, type PersonaTransaction } from './mls-persona-coordinator.js'
import { validateMlsGrant, type BrowserMlsGrantStore, type MlsGrantRecord } from './mls-grant-ledger.js'
import { readMlsRoom, mlsRoomIds } from './mls-room-store.js'
import { loadMlsEngine } from './mls-engine.js'
import { mlsKeeperRemovalOperation, mlsKeeperGrantAuthority, validateMlsKeeperApproval, type MlsKeeperApproval, type MlsKeeperGrantAuthority, type MlsKeeperRoomIntent } from './mls-revocation-decision-store.js'
import { MLS_KEEPER_PROMPT_SECONDS, type MlsRevocationInboxPrompt } from './mls-revocation-inbox-store.js'
import { mlsRevocationInboxState, mlsKeeperPromptAfter } from './mls-revocation-inbox-state.js'
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
export interface MlsKeeperExecutionPlan extends MlsKeeperDecisionPlan {
  revoked: string[]
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
      delete prompt.deferredUntil
      if (approve) {
        const approval: MlsKeeperApproval = { approvedAt: at, grants: structuredClone(fresh.grants), rooms: structuredClone(fresh.rooms) }
        validateMlsKeeperApproval(approval, prompt.request, prompt.operation, prompt.receivedAt)
        prompt.approval = approval
      }
      await saveMlsMembership(tx, journal)
      return structuredClone(prompt)
    }, () => this.#current(scope))
  }
  /** Later hides this sender's pending and approved prompts for one hour.
   * Approval and compromised holds remain; this is not cancellation of an
   * already authorised operation. No signer, grant or room effect occurs. */
  async defer(review: Pick<MlsKeeperDecisionPlan, 'binding' | 'prompt'>): Promise<CoordinationResult<MlsRevocationInboxPrompt[]>> {
    const scope = this.#scope(), expected = structuredClone(review)
    if (JSON.stringify(scope.vault) !== JSON.stringify(expected.binding)) throw new Error('Review the request in the current keeper account.')
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
      const prompt = state.prompts.find(item => item.operation === expected.prompt.operation)
      if (!prompt || !['pending', 'approved'].includes(prompt.state) || JSON.stringify(prompt) !== JSON.stringify(expected.prompt)) throw new Error('The retained request changed. Check it again before choosing Later.')
      const until = state.checkedAt + MLS_KEEPER_PROMPT_SECONDS
      const group = state.prompts.filter(item => item.request.sender === prompt.request.sender && ['pending', 'approved'].includes(item.state))
      for (const item of group) item.deferredUntil = until
      mlsKeeperPromptAfter(state, prompt.request.sender, until)
      const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
      return structuredClone(group)
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
  /** Approved retries stay visible even when all grants are already revoked
   * or current execution authority is unavailable. This list is retained
   * intent, never permission to perform an effect without execution(). */
  approvals(includeDeferred = false): Promise<CoordinationResult<MlsRevocationInboxPrompt[]>> {
    const scope = this.#scope()
    if (typeof includeDeferred !== 'boolean') throw new Error('Invalid deferred request selection.')
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
      return structuredClone(state.prompts.filter(prompt => prompt.state === 'approved' && (includeDeferred || prompt.deferredUntil === undefined || prompt.deferredUntil <= state.checkedAt)))
    }, () => this.#current(scope))
  }
  /** Reopen only the frozen approval, even after request expiry. Newly added
   * grant authority or device leaves require a new review; they are never
   * silently incorporated into an old operator decision. */
  execution(operation: string): Promise<CoordinationResult<MlsKeeperExecutionPlan>> {
    const scope = this.#scope()
    return this.coordinator.transact(scope.vault.persona, tx => this.#execution(tx, scope, operation), () => this.#current(scope))
  }
  complete(operation: string): Promise<CoordinationResult<MlsRevocationInboxPrompt>> {
    const scope = this.#scope()
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const current = await this.#execution(tx, scope, operation)
      if (current.revoked.length !== current.grants.length || current.rooms.some(room => room.action === 'remove')) throw new Error('The approved removal or grant withdrawal is still pending.')
      const journal = await readMlsMembership(tx), prompt = journal.inbox!.prompts.find(item => item.operation === operation)!
      // A target can disappear before its journal catches up. Do not clear
      // an engine-owned compromised hold until that journal is witnessed.
      for (const intent of prompt.approval!.rooms) {
        const record = journal.removals.find(item => item.operation === intent.operation)
        if (!record) continue
        const wasm = await loadMlsEngine()
        const bytes = hexToBytes(record.journal)
        let removal: ReturnType<typeof wasm.removalDecode> | undefined
        try {
          try { removal = wasm.removalDecode(bytes) } catch { throw new InvalidPersonaRecord('Keeper removal journal cannot be decoded') }
          if (bytesToHex(removal.sessionId()) !== intent.session || record.session !== intent.session || record.kind !== 'device' ||
              record.target !== intent.member.leafId || !record.compromised || removal.personIdentity() !== undefined || JSON.stringify(removal.leafIds().map(bytesToHex)) !== JSON.stringify([intent.member.leafId])) throw new InvalidPersonaRecord('Keeper removal journal binding differs')
          if (removal.mls() !== 'Committed') throw new Error('The approved removal journal is still pending.')
          const expected = prompt.approval!.grants.filter(grant => grant.node === intent.member.homeBox).map(grant => ({ node: grant.node, reference: grant.reference }))
          const actual = removal.grants().map(item => ({ node: bytesToHex(item.grant.node), reference: bytesToHex(item.grant.grant) }))
          if (JSON.stringify(actual) !== JSON.stringify(expected) || removal.grants().some(item => !item.grant.keeper)) throw new InvalidPersonaRecord('Keeper removal grant journal binding differs')
          if (removal.grants().some(item => item.state.type !== 'Revoked')) throw new Error('The confirmed withdrawal journal update is still pending.')
        } finally { bytes.fill(0); removal?.free() }
      }
      prompt.state = 'done'
      delete prompt.deferredUntil
      await saveMlsMembership(tx, journal)
      return structuredClone(prompt)
    }, () => this.#current(scope))
  }
  async #execution(tx: PersonaTransaction, scope: MlsRevocationInboxContext, operation: string): Promise<MlsKeeperExecutionPlan> {
    const journal = await readMlsMembership(tx), prompt = journal.inbox?.prompts.find(item => item.operation === operation)
    if (!prompt?.approval || !['approved', 'done'].includes(prompt.state) || journal.inbox?.keeper !== scope.vault.persona) throw new Error('This request has no witnessed keeper approval.')
    const ids = await mlsRoomIds(tx)
    for (const intent of prompt.approval.rooms) {
      if (!ids.includes(intent.session)) throw new Error('An approved keeper room must be restored before continuing.')
      const room = await readMlsRoom(tx, intent.session)
      if (room.keeper !== scope.vault.persona || room.binding.rendezvousKey !== intent.rendezvousKey) throw new Error('An approved room no longer belongs to this keeper.')
    }
    let records: MlsGrantRecord[] = []
    const current = await this.#review(tx, scope, operation, true, value => { records = value }), approved = prompt.approval
    for (const grant of current.grants) {
      const frozen = approved.grants.find(item => item.node === grant.node)
      if (!frozen || grant.reference !== frozen.reference || grant.active !== frozen.active || grant.revocation !== frozen.revocation || JSON.stringify(grant.box) !== JSON.stringify(frozen.box) ||
          grant.rooms.some(use => !frozen.rooms.some(item => item.session === use.session && item.leaf === use.leaf))) throw new Error('The approved grant authority changed. Review the request again.')
    }
    if (approved.grants.some(grant => !current.grants.some(item => item.node === grant.node))) throw new Error('An approved grant is no longer retained. Its access cannot be confirmed here.')
    for (const room of current.rooms) {
      const frozen = approved.rooms.find(item => item.session === room.session && item.member.leafId === room.member.leafId)
      if (!frozen || frozen.rendezvousKey !== room.rendezvousKey || frozen.member.device !== room.member.device || frozen.member.identity !== room.member.identity ||
          frozen.member.homeBox !== room.member.homeBox || frozen.member.bindingExpiresAt !== room.member.bindingExpiresAt || frozen.action === 'remove' && room.action !== 'remove') throw new Error('The approved keeper roster changed. Review the request again.')
      room.action = frozen.action
    }
    const revoked = current.grants.filter(grant => records.some(record => record.node === grant.node && record.device === prompt.request.device && record.state === 'revoked' &&
      record.issuer === scope.vault.persona && record.persona === prompt.request.sender && record.active.id === grant.active && record.revocation.id === grant.revocation)).map(grant => grant.reference)
    return { ...current, grants: structuredClone(approved.grants), revoked }
  }
  async #review(tx: PersonaTransaction, scope: MlsRevocationInboxContext, operation: string, approved = false, verified?: (records: MlsGrantRecord[]) => void): Promise<MlsKeeperDecisionPlan> {
    const at = this.#time(), inbox = await mlsRevocationInboxState(tx, scope.vault.persona, at)
    const prompt = inbox.prompts.find(item => item.operation === operation)
    if (!prompt || (approved ? !prompt.approval || !['approved', 'done'].includes(prompt.state) : prompt.state !== 'pending' || prompt.request.expiration <= at)) throw new Error('This request is no longer awaiting a decision.')
    if (!approved && prompt.deferredUntil !== undefined && prompt.deferredUntil > at) throw new Error('This request is deferred. Check it again after the recorded hour.')
    const records = structuredClone(await this.grants.all())
    if (!Array.isArray(records) || records.length > 256 || new Set(records.map(record => `${record.node}/${record.device}`)).size !== records.length) throw new Error('The keeper grant ledger could not be verified.')
    records.forEach(validateMlsGrant)
    verified?.(records)
    const request = prompt.request, selected = records.filter(record => record.issuer === scope.vault.persona && record.persona === request.sender && record.device === request.device && (approved || record.state !== 'revoked'))
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
    const conflict = inbox.prompts.some(other => (other.state === 'approved' || other.state === 'pending' && other.request.expiration > at) && other.request.sender === request.sender && other.request.device !== request.device)
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
