import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, type BrowserPersonaCoordinator, type CoordinationResult, type PersonaTransaction } from './mls-persona-coordinator.js'
import { validateMlsGrant, mlsKeeperGrantRecordDigest, BrowserMlsGrantLedger, type BrowserMlsGrantStore, type MlsGrantRecord } from './mls-grant-ledger.js'
import type { BrowserMlsKeeperBoxClock, MlsKeeperBoxClockEvidence } from './mls-keeper-box-clock.js'
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
  unavailable: string[]
  lapsed: string[]
}
/** Explicit operator decisions only. Approval records intent before any
 * future room or box effect. This class itself cannot publish or remove. */
export class BrowserMlsKeeperDecisions {
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>, private grants: Pick<BrowserMlsGrantStore, 'all'>,
    private context: () => MlsRevocationInboxContext | undefined, private now: () => number = () => Math.floor(Date.now() / 1000),
    private routes?: { available(authority: MlsKeeperGrantAuthority, sender: string, device: string, current: () => boolean): Promise<boolean> },
    private clockFor?: (node: string) => BrowserMlsKeeperBoxClock | undefined,
    private installations?: BrowserMlsGrantLedger) {}

  /** The caller probes its independent endpoint before entering this witness.
   * This records expiry only; it neither deletes nor publishes a tombstone. */
  async lapse(operation: string, record: MlsGrantRecord, evidence: MlsKeeperBoxClockEvidence): Promise<CoordinationResult<MlsRevocationInboxPrompt>> {
    const scope = this.#scope(), expected = structuredClone(record)
    validateMlsGrant(expected)
    const clock = this.clockFor?.(expected.node)
    let floor = evidence.phoneTime
    const current = () => { const at = this.now(); return this.#current(scope) && Number.isSafeInteger(at) && at >= floor }
    try { return await this.coordinator.transact(scope.vault.persona, async tx => {
      const plan = await this.#execution(tx, scope, operation)
      const authority = plan.grants.find(grant => grant.node === expected.node && grant.reference === evidence.reference)
      if (!authority || expected.issuer !== scope.vault.persona || expected.persona !== plan.prompt.request.sender || expected.device !== plan.prompt.request.device ||
          authority.expiration !== expected.expiration || plan.prompt.grantOutcomes?.some(item => item.reference === authority.reference)) throw new Error('This exact grant is not awaiting a lapse decision.')
      const records = await this.grants.all()
      if (!Array.isArray(records) || records.length > 256 || new Set(records.map(item => `${item.node}/${item.device}`)).size !== records.length) throw new Error('The keeper grant ledger could not be verified.')
      records.forEach(validateMlsGrant)
      const retained = records.find(item => item.node === expected.node && item.device === expected.device)
      if (JSON.stringify(retained) !== JSON.stringify(expected)) throw new Error('The probed grant changed before its lapse was witnessed.')
      if (!clock) throw new Error('An authenticated keeper clock observation is required.')
      const accepted = clock.acceptEvidence(expected, evidence)
      const journal = await readMlsMembership(tx), inbox = journal.inbox!, prompt = inbox.prompts.find(item => item.operation === operation)!
      const at = this.#time()
      if (!this.#current(scope) || JSON.stringify(accepted.binding) !== JSON.stringify(scope.vault)) throw new Error('The keeper account or foreground session changed.')
      if (at < inbox.checkedAt || at < accepted.phoneTime || at > Number.MAX_SAFE_INTEGER - MLS_KEEPER_PROMPT_SECONDS) throw new Error('A trusted request time is unavailable.')
      if (expected.expiration > Math.min(accepted.phoneTime, accepted.boxTime)) throw new Error('Both authenticated clocks must confirm the exact grant expired.')
      inbox.checkedAt = at
      floor = at
      prompt.grantOutcomes ??= []
      prompt.grantOutcomes.push({ node: expected.node, reference: authority.reference, at, outcome: 'no-live', evidence: structuredClone(accepted), recordDigest: mlsKeeperGrantRecordDigest(expected) })
      prompt.grantOutcomes.sort((a, b) => a.reference.localeCompare(b.reference))
      await saveMlsMembership(tx, journal)
      return structuredClone(prompt)
    }, current) } finally { clock?.invalidate() }
  }

  plan(operation: string): Promise<CoordinationResult<MlsKeeperDecisionPlan>> {
    const scope = this.#scope()
    return this.coordinator.transact(scope.vault.persona, tx => this.#review(tx, scope, operation), () => this.#current(scope))
  }
  async decide(plan: MlsKeeperDecisionPlan, approve: boolean): Promise<CoordinationResult<MlsRevocationInboxPrompt>> {
    const scope = this.#scope(), expected = structuredClone(plan)
    if (typeof approve !== 'boolean' || JSON.stringify(scope.vault) !== JSON.stringify(expected.binding)) throw new Error('Review the request in the current keeper account.')
    const decide = (current: () => boolean) => this.coordinator.transact(scope.vault.persona, async tx => {
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
    }, current)
    if (!approve) return decide(() => this.#current(scope))
    if (!(this.installations instanceof BrowserMlsGrantLedger)) throw new Error('Keeper approval requires the affected-device grant-install hold.')
    return this.installations.withDeviceInstallHold(this.grants, scope.vault.persona, expected.prompt.request.device,
      () => this.#current(scope), decide)
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
      for (const item of group) {
        if (item.revision === Number.MAX_SAFE_INTEGER) throw new Error('The keeper prompt revision is full.')
        item.revision = (item.revision ?? 0) + 1
        item.deferredUntil = until
      }
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
      // A ledger read and persona witness are different atomic domains.
      // Until affected-device installation is held across this commit, a
      // replacement could arrive after the last read. Keep the approval hold.
      if (current.lapsed.length) throw new Error('Lapsed grant completion awaits the affected-device grant-install hold.')
      if (current.revoked.length + current.unavailable.length + current.lapsed.length !== current.grants.length || current.rooms.some(room => room.action === 'remove')) throw new Error('The approved removal or grant withdrawal is still pending.')
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
          if (removal.grants().some(item => current.revoked.includes(bytesToHex(item.grant.grant)) && item.state.type !== 'Revoked')) throw new Error('The confirmed withdrawal journal update is still pending.')
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
      if (!frozen || grant.reference !== frozen.reference || grant.active !== frozen.active || grant.revocation !== frozen.revocation || JSON.stringify(grant.box) !== JSON.stringify(frozen.box) || frozen.expiration !== undefined && frozen.expiration !== grant.expiration ||
          grant.rooms.some(use => !frozen.rooms.some(item => item.session === use.session && item.leaf === use.leaf))) throw new Error('The approved grant authority changed. Review the request again.')
    }
    for (const frozen of approved.grants) {
      const terminal = prompt.grantOutcomes?.find(item => item.reference === frozen.reference && item.outcome === 'no-live')
      const record = records.find(item => item.node === frozen.node && item.device === prompt.request.device)
      if (!current.grants.some(item => item.node === frozen.node) && (!terminal || record)) throw new Error('An approved grant is no longer retained. Its access cannot be confirmed here.')
      if (terminal?.outcome === 'no-live' && record && mlsKeeperGrantRecordDigest(record) !== terminal.recordDigest) throw new Error('The witnessed lapsed grant record changed. Review the request again.')
    }
    for (const room of current.rooms) {
      const frozen = approved.rooms.find(item => item.session === room.session && item.member.leafId === room.member.leafId)
      if (!frozen || frozen.rendezvousKey !== room.rendezvousKey || frozen.member.device !== room.member.device || frozen.member.identity !== room.member.identity ||
          frozen.member.homeBox !== room.member.homeBox || frozen.member.bindingExpiresAt !== room.member.bindingExpiresAt || frozen.action === 'remove' && room.action !== 'remove') throw new Error('The approved keeper roster changed. Review the request again.')
      room.action = frozen.action
    }
    const revoked = current.grants.filter(grant => records.some(record => record.node === grant.node && record.device === prompt.request.device && record.state === 'revoked' &&
      record.issuer === scope.vault.persona && record.persona === prompt.request.sender && record.active.id === grant.active && record.revocation.id === grant.revocation)).map(grant => grant.reference)
    const saved = await readMlsMembership(tx), retained = saved.inbox!.prompts.find(item => item.operation === operation)!, before = JSON.stringify(retained)
    // New approvals freeze expiry; legacy migration requires the exact signed
    // record. This slice never interprets expiry from the browser clock.
    for (const frozen of retained.approval!.grants) if (frozen.expiration === undefined) frozen.expiration = current.grants.find(grant => grant.reference === frozen.reference)!.expiration
    const outcomes = retained.grantOutcomes ??= []
    const recorded = new Set(outcomes.map(item => item.reference))
    for (const frozen of retained.approval!.grants) {
      const terminal = outcomes.find(item => item.reference === frozen.reference)
      if (terminal) {
        if (terminal.outcome === 'revoked' && !revoked.includes(frozen.reference)) throw new Error('The confirmed grant authority changed. Review the request again.')
        continue
      }
      if (revoked.includes(frozen.reference)) outcomes.push({ node: frozen.node, reference: frozen.reference, at: saved.inbox!.checkedAt, outcome: 'revoked' })
      else if (this.routes) {
        const available = await this.routes.available(structuredClone(frozen), retained.request.sender, retained.request.device, () => this.#current(scope))
        if (typeof available !== 'boolean') throw new Error('The keeper pairing evidence could not be verified.')
        if (!this.#current(scope)) throw new Error('The keeper account or foreground session changed.')
        // The grant and pairing stores have separate locks. Recheck the full
        // ledger before recording a fact about this frozen old authority.
        // Unavailable means access unconfirmed, never no live remote access.
        const latest = await this.grants.all()
        if (!Array.isArray(latest)) throw new Error('The keeper grant ledger could not be verified.')
        latest.forEach(validateMlsGrant)
        if (JSON.stringify(latest) !== JSON.stringify(records)) throw new Error('The approved grant authority changed while checking its pairing.')
        if (!available) outcomes.push({ node: frozen.node, reference: frozen.reference, at: saved.inbox!.checkedAt, outcome: 'route-unavailable' })
      }
    }
    const at = this.#time()
    if (at < saved.inbox!.checkedAt || at > Number.MAX_SAFE_INTEGER - MLS_KEEPER_PROMPT_SECONDS) throw new Error('A trusted request time is unavailable.')
    if (!this.#current(scope)) throw new Error('The keeper account or foreground session changed.')
    for (const outcome of outcomes) if (!recorded.has(outcome.reference)) outcome.at = at
    saved.inbox!.checkedAt = at
    outcomes.sort((a, b) => a.reference.localeCompare(b.reference))
    if (before !== JSON.stringify(retained)) await saveMlsMembership(tx, saved)
    const unavailable = outcomes.filter(item => item.outcome === 'route-unavailable').map(item => item.reference)
    return { ...current, prompt: structuredClone(retained), grants: structuredClone(retained.approval!.grants),
      revoked: outcomes.filter(item => item.outcome === 'revoked').map(item => item.reference), unavailable,
      lapsed: outcomes.filter(item => item.outcome === 'no-live').map(item => item.reference) }
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
    if (!selected.length && !(approved && prompt.approval!.grants.every(grant => prompt.grantOutcomes?.some(item => item.reference === grant.reference && item.outcome === 'no-live')))) throw new Error('This request no longer matches the keeper grant ledger.')
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
