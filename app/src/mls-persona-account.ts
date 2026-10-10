import { BrowserMlsPersonaStore, PersonaStorageError } from './mls-persona-store.js'
import { BrowserPersonaLinks } from './mls-persona-link.js'
import { BrowserPersonaEnrolment, type PersonaEnrolment } from './mls-persona-enrolment.js'
import { BrowserPersonaCoordinator, type CoordinationResult } from './mls-persona-coordinator.js'
import { CoordinatedMlsVault, type VaultOverview, type BoxRequest, type BoxReply, BrowserCoordinatedVaultSignals } from './mls-coordinated-vault.js'
import { BrowserMlsRevocationOutbox } from './mls-revocation-outbox.js'
import type { MlsStandaloneRevocationRecord } from './mls-membership-store.js'
import type { VmlsRevocationIdentity, VmlsRevocationTransport } from '../../src/vmls-revocation-request.js'

import type { ParticipantIdentity } from '../../src/identity.js'
import { MlsVault, BrowserMlsVaultStorage, type VaultContext, type VaultResult, type ConsentScope, type ConsentPrompt, type SignLeafBindingRequest, type SignLeafBindingReply } from './mls-vault.js'

export interface MlsAccountContext { identity?: ParticipantIdentity; revocationIdentity?: VmlsRevocationIdentity; persona: string; generation: string; mode: 'normal' | 'quiet' | 'tor-only' }
export interface MlsAccountView {
  enrolment: PersonaEnrolment
  check?: CoordinationResult<void>
  vault?: VaultResult<VaultOverview | null>
  installation?: string
  retirement?: { subject: string; installation: string; verified: boolean }
  revocations?: CoordinationResult<MlsStandaloneRevocationRecord[]>
}
interface Services { store: BrowserMlsPersonaStore; links: BrowserPersonaLinks; enrolment: BrowserPersonaEnrolment; coordinator: BrowserPersonaCoordinator }

/** Account-scoped UI operations, never an authority cache for room writes.
 * Merely constructing this does not open storage, load WASM or connect. Each
 * room operation must still go through the coordinator's fresh witness read. */
export class BrowserMlsAccount {
  #services?: Services
  #generation = 0
  #vault?: CoordinatedMlsVault
  #epochKey = ''
  #epochNumber = 0
  #epoch(): number {
    const c = this.context(), key = JSON.stringify([this.#generation, c?.persona, c?.generation, c?.mode])
    if (key !== this.#epochKey) { this.#epochKey = key; this.#epochNumber++ }
    return this.#epochNumber
  }
  #typed(s: Services): CoordinatedMlsVault {
    return this.#vault ??= new CoordinatedMlsVault(s.coordinator, { generation: () => this.#epoch() })
  }
  #stopping: Promise<void> = Promise.resolve()
  #resumeNeeded = false
  #notifications?: BroadcastChannel
  #listeners = new Set<() => void>()
  constructor(private readonly context: () => MlsAccountContext | undefined,
    private readonly create?: () => Services) {}
  async canForgetBrowser(): Promise<boolean> {
    if (this.#services) return !await this.#services.store.hasRetainedState()
    const store = new BrowserMlsPersonaStore()
    try { return !await store.hasRetainedState() } finally { await store.close() }
  }
  listen(changed: () => void): () => void {
    if (!this.#notifications && typeof BroadcastChannel !== 'undefined') {
      this.#notifications = new BroadcastChannel('kithmoot-mls-persona-changed-v1')
      this.#notifications.onmessage = event => {
        if (event.data?.type !== 'changed') return
        void this.pause().catch(() => undefined)
        for (const listener of this.#listeners) listener()
      }
    }
    this.#listeners.add(changed)
    return () => this.#listeners.delete(changed)
  }

  state(): Promise<MlsAccountView> { return this.#run(async (s, c, current) => ({ enrolment: await s.enrolment.status(c.persona, current) })) }
  prepare(): Promise<MlsAccountView> { return this.#run(async (s, c, current) => ({ enrolment: await s.enrolment.prepare(c.persona, current) }), false, true) }
  pair(code: string, relays: readonly string[]): Promise<MlsAccountView> {
    return this.#run(async (s, c, current) => ({ enrolment: await s.enrolment.pair(c.persona, code, relays, current) }), true, true)
  }
  genesis(): Promise<MlsAccountView> { return this.#run(async (s, c, current) => ({ enrolment: await s.enrolment.genesis(c.persona, current) }), false, true) }
  check(): Promise<MlsAccountView> {
    return this.#run(async (s, c, current) => {
      const before = await s.enrolment.status(c.persona, current)
      const check = await s.coordinator.status(c.persona, current)
      const enrolment = await s.enrolment.status(c.persona, current)
      // The UI's local reread uses another lock scope. Never attach an old
      // successful check to a replacement created between those scopes.
      if (check.state === 'active' && (before.state !== 'genesis' || enrolment.state !== 'genesis' || before.installation !== enrolment.installation || before.subject !== enrolment.subject)) return { enrolment }
      return { check, enrolment }
    }, true, true)
  }
  clear(installation: string): Promise<MlsAccountView> {
    if (!/^[0-9a-f]{64}$/.test(installation)) return Promise.reject(new Error('Reopen the installation before clearing it.'))
    return this.#run(async (s, c, current) => {
      new BrowserCoordinatedVaultSignals().invalidate()
      const check = await s.coordinator.clear(c.persona, current, installation)
      return { check, enrolment: await s.enrolment.status(c.persona, current) }
    }, false, true)
  }
  confirmRetired(subject: string): Promise<MlsAccountView> {
    return this.#run(async (s, c, current) => {
      if (!await s.coordinator.keeperConfirmsRetired(c.persona, subject, current)) throw new Error('Retirement could not be confirmed. Check the exact subject and any retained retirement duty.')
      return { enrolment: await s.enrolment.status(c.persona, current) }
    }, false, true)
  }
  /** Explicit network actions only. Opening settings never reads the vault or
   * prompts a signer. The principal is this app origin, never caller input. */
  async #vaultRun<T>(work: (vault: CoordinatedMlsVault, ctx: VaultContext, account: MlsAccountContext, current: () => boolean) => Promise<VaultResult<T>>, changed = false): Promise<VaultResult<T>> {
    let result: VaultResult<T> = { ok: false, refusal: 'stale' }
    const view = await this.#run(async (s, c, current) => {
      const vault = this.#typed(s), ctx = vault.context(globalThis.location.origin, c.persona)
      result = await work(vault, ctx, c, current)
      return { enrolment: await s.enrolment.status(c.persona, current) }
    }, true, changed)
    if (view.enrolment.state !== 'genesis') {
      this.#vault?.bump()
      return { ok: false, refusal: view.enrolment.state === 'fenced' ? 'restore-fenced' : 'stale' }
    }
    return result
  }
  async vaultState(): Promise<MlsAccountView> {
    return this.#run(async (s, c, current) => ({
      vault: await this.#typed(s).overview(this.#typed(s).context(globalThis.location.origin, c.persona)),
      enrolment: await s.enrolment.status(c.persona, current),
    }), true)
  }
  /** Retained evidence is checked explicitly with the witness. No room or
   * local MLS device is needed to ask about an earlier observed device. */
  revocationRecords(): Promise<MlsAccountView> {
    return this.#run(async (s, c, current) => ({
      revocations: await this.#outbox(s, c, current).records(),
      enrolment: await s.enrolment.status(c.persona, current),
    }), true)
  }
  sendRevocation(operation: string, transport: VmlsRevocationTransport): Promise<MlsAccountView> {
    return this.#run(async (s, c, current) => {
      const identity = c.revocationIdentity
      if (!identity || identity.pubkey !== c.persona) throw new Error('This account needs a signer with private-message encryption to send the request.')
      const outbox = this.#outbox(s, c, current), sent = await outbox.send(operation, { identity, transport })
      return { revocations: sent.state === 'active' ? await outbox.records() : sent,
        enrolment: await s.enrolment.status(c.persona, current) }
    }, true, true)
  }
  #outbox(s: Services, c: MlsAccountContext, current: () => boolean): BrowserMlsRevocationOutbox {
    const vault = this.#typed(s)
    return new BrowserMlsRevocationOutbox(s.coordinator, () => ({
      vault: vault.context(globalThis.location.origin, c.persona), current,
    }))
  }
  enrolDevice(expiresAt: number, replace = false, expectedDevice?: string) {
    return this.#vaultRun((vault, ctx, c) => c.identity
      ? vault.enrol(ctx, c.identity, expiresAt, { replace, expectedDevice })
      : Promise.resolve({ ok: false as const, refusal: 'unauthorised' as const }), true)
  }
  migrateDevice() {
    return this.#vaultRun(async (vault, ctx) => {
      try { return await vault.migrate(ctx, new MlsVault(new BrowserMlsVaultStorage())) }
      catch { return { ok: false, refusal: 'restore-fenced' } }
    }, true)
  }
  withdraw(scope: ConsentScope) { return this.#vaultRun((vault, ctx) => vault.withdraw(ctx, scope), true) }
  revokeCredential(id: string) { return this.#vaultRun((vault, ctx) => vault.revokeCredential(ctx, id), true) }
  approveScope(scope: ConsentScope, consent: ConsentPrompt) {
    scope = { ...scope }
    return this.#vaultRun(async (vault, ctx, _c, current) => {
      if (scope.persona !== ctx.persona || scope.principal !== ctx.principal) return { ok: false, refusal: 'unauthorised' }
      if (await consent({ ...scope }) !== 'approve') return { ok: false, refusal: 'denied' }
      if (!current()) return { ok: false, refusal: 'stale' }
      return vault.approve(ctx, scope)
    }, true)
  }
  async signLeafBinding(request: SignLeafBindingRequest, consent: ConsentPrompt): Promise<VaultResult<SignLeafBindingReply>> {
    const result = await this.#vaultRun((vault, ctx, _c, current) => vault.signLeafBindingV1(ctx, request, async scope => current() ? consent(scope) : 'deny'), true)
    return result.ok ? this.#vault!.acceptSignReply(request, result.value) : result
  }
  async signBoxRequest(request: BoxRequest, consent: ConsentPrompt): Promise<VaultResult<BoxReply>> {
    const result = await this.#vaultRun((vault, ctx, _c, current) => vault.signBoxRequestV1(ctx, request, async scope => current() ? consent(scope) : 'deny'), true)
    return result.ok ? this.#vault!.acceptBoxReply(request, result.value) : result
  }
  /** Invalidate immediately; wait for late starts and shutdown before an
   * explicit next operation may resume. A shutdown failure stays fail-closed. */
  pause(): Promise<void> {
    this.#generation++; this.#vault?.bump()
    if (this.#services) {
      this.#services.coordinator.invalidate()
      this.#resumeNeeded = true
      this.#stopping = Promise.all([this.#stopping, this.#services.links.pause()]).then(() => undefined)
    }
    return this.#stopping
  }
  async #run(work: (services: Services, context: MlsAccountContext, current: () => boolean) => Promise<MlsAccountView>, network = false, changed = false): Promise<MlsAccountView> {
    const context = this.context(), generation = this.#generation
    if (!context) throw new Error('Sign in before opening MLS witness settings.')
    if (network && context.mode !== 'normal') throw new Error('Witness connections are held in quiet and Tor-only modes. Leave that mode before connecting.')
    const current = () => {
      const now = this.context()
      return generation === this.#generation && now?.persona === context.persona && now.generation === context.generation && now.mode === context.mode
    }
    await this.#stopping
    if (!current()) return { enrolment: { state: 'stale' } }
    const services = this.#services ??= this.create?.() ?? this.#create()
    if (this.#resumeNeeded) { services.links.resume(); this.#resumeNeeded = false }
    let value: MlsAccountView
    try { value = await work(services, context, current) }
    finally { if (changed) this.#notifications?.postMessage({ type: 'changed' }) }
    if (value.vault?.ok && value.enrolment.state !== 'genesis') {
      this.#vault?.bump()
      value.vault = { ok: false, refusal: value.enrolment.state === 'fenced' ? 'restore-fenced' : 'stale' }
    }
    if (current() && value.enrolment.state === 'fenced') {
      const recovery = await services.store.withPersona(context.persona, async store => {
        try {
          const file = await store.read(true)
          return file ? { installation: file.data.installation, retirement: file.data.enrolment ? { subject: file.data.enrolment.subject, installation: file.data.installation, verified: true } : undefined } : undefined
        } catch (error) {
          // Only a missing file/seal permits the keeper's manual recovery.
          // Readable malformed state may still contain a retiring duty.
          if (!(error instanceof PersonaStorageError) || !['seal-lost', 'missing-record'].includes(error.code)) return undefined
          const marker = await store.marker()
          return marker ? { installation: marker.installation, retirement: marker.subject ? { subject: marker.subject, installation: marker.installation, verified: false } : undefined } : undefined
        }
      })
      value.installation = recovery?.installation; value.retirement = recovery?.retirement
    }
    return current() ? value : { enrolment: { state: 'stale' } }
  }
  #create(): Services {
    const store = new BrowserMlsPersonaStore(), links = new BrowserPersonaLinks(() => this.context()?.mode === 'normal')
    return { store, links, enrolment: new BrowserPersonaEnrolment(store, links), coordinator: new BrowserPersonaCoordinator(store, links.channels) }
  }
}
