/** Typed browser vault under the persona's restore witness (P3-03c).
 * No product caller is enabled yet. Secret records are opened only inside a
 * coordinator transaction; prompts and identity signing happen outside it.
 * Only promoted results acquire reply provenance and can leave this vault. */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { base32 } from '@scure/base'
import { finalizeEvent } from 'nostr-tools/pure'
import { createDeviceCredential } from '../../src/credential.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import { bindingDigest, checkUnsignedBinding, readUnsignedBinding, verifyPersonCredential } from '../../src/vmls/binding.js'
import { BrowserPersonaCoordinator, InvalidPersonaRecord, type PersonaReader, type PersonaTransaction, type CoordinationResult } from './mls-persona-coordinator.js'
import { PersonaStorageError } from './mls-persona-store.js'
import {
  type MlsVault, SIGN_METHOD, MAX_JOURNAL_RECORDS, MAX_OPERATION_SECONDS,
  base64Decode, base64Encode, signRequestShape, scopeShape, sameScope, refusalOf,
  type ConsentScope, type ConsentPrompt, type ConsentDecision, type DeviceRecord,
  type EnrolledDevice, type JournalEntry, type PolicyRecord, type VaultContext,
  type VaultRefusal, type VaultResult, type SignLeafBindingRequest, type SignLeafBindingReply,
} from './mls-vault.js'

export const BOX_METHOD = 'signBoxRequestV1/1'
const RECORD = bytesToHex(new TextEncoder().encode('kithmoot.typed-vault.v1'))
const HEX = /^[0-9a-f]{64}(?![\s\S])/
const EMPTY = bytesToHex(sha256(new Uint8Array()))
const refuse = (refusal: VaultRefusal): { ok: false; refusal: VaultRefusal } => ({ ok: false, refusal })
const ok = <T>(value: T): VaultResult<T> => ({ ok: true, value })
const typedScope = (s: ConsentScope) => scopeShape(s) && HEX.test(s.persona) && HEX.test(s.device) && HEX.test(s.homeBox)
const leafKey = (r: SignLeafBindingRequest) => JSON.stringify([r.v, r.operation, r.body, r.digest, r.expires_at])
const boxKey = (r: BoxRequest) => JSON.stringify([r.v, r.box, r.method, r.path, r.payload])

interface RecordV1 {
  version: 1
  persona: string
  installation: string
  device: DeviceRecord
  policy: PolicyRecord
  journal: JournalEntry[]
  retired: string[]
  /** Retained permanently: a migration retry cannot overwrite newer work. */
  migrated: boolean
}
export interface BoxRequest { v: 1; box: string; method: string; path: string; payload: string }
export interface BoxReply { readonly v: 1; readonly device: string; readonly authorization: string }
export interface VaultSignals { revision(): string; invalidate(): void }
export class BrowserCoordinatedVaultSignals implements VaultSignals {
  constructor(private readonly storage: Storage = globalThis.localStorage, private readonly key = 'kithmoot.mls-coordinated-vault.revision') {}
  revision(): string { return this.storage.getItem(this.key) ?? '' }
  invalidate(): void { this.storage.setItem(this.key, crypto.randomUUID()) }
}
export interface CoordinatedVaultOptions {
  now?: () => number
  generation?: () => number
  signals?: VaultSignals
}

/** A single instance belongs to an app account lifetime. Constructing another
 * mints a boot nonce, so a pre-restart operation id is stale, even if the app's
 * numeric generation repeats. Signals synchronously invalidate other tabs. */
export class CoordinatedMlsVault {
  readonly #boot = crypto.randomUUID()
  readonly #now: () => number
  readonly #generation: () => number
  readonly #signals: VaultSignals
  #bumps = 0
  #made = new WeakMap<object, { ctx: VaultContext; request: string }>()
  // In-memory only. Do not evict live entries: eviction could repeat an id.
  #boxTimes = new Map<string, number>()
  constructor(private readonly coordinator: BrowserPersonaCoordinator, options: CoordinatedVaultOptions = {}) {
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#generation = options.generation ?? (() => 0)
    this.#signals = options.signals ?? new BrowserCoordinatedVaultSignals()
  }
  context(principal: string, persona: string): VaultContext {
    return Object.freeze({ principal, persona, generation: this.#generation(), revision: this.#revision() })
  }
  #revision(): string { return `${this.#boot}:${this.#bumps}:${this.#signals.revision()}` }
  #current(ctx: VaultContext): boolean {
    return Number.isSafeInteger(ctx.generation) && ctx.generation >= 0 && ctx.generation === this.#generation() && ctx.revision === this.#revision()
  }
  bump(): void { this.#bumps++; this.coordinator.invalidate() }
  /** Clearing still retains the coordinator's retirement duty and exact-subject
   * recovery. Invalidate every tab before attempting the destructive operation. */
  async clear(ctx: VaultContext, installation: string) {
    if (!HEX.test(installation)) throw new Error('Reopen the installation before clearing it.')
    const writing = this.#invalidateContext(ctx)
    if (!writing) return { state: 'pending' as const, reason: 'stale' as const, refused: false }
    return this.coordinator.clear(ctx.persona, () => this.#current(writing), installation)
  }
  async #run<T>(ctx: VaultContext, work: (tx: PersonaTransaction) => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    return this.#coordinate(ctx, () => this.coordinator.transact(ctx.persona, work, () => this.#current(ctx)))
  }
  async #look<T>(ctx: VaultContext, work: (tx: PersonaReader) => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    return this.#coordinate(ctx, () => this.coordinator.readConfirmed(ctx.persona, work, () => this.#current(ctx)))
  }
  async #coordinate<T>(ctx: VaultContext, work: () => Promise<CoordinationResult<VaultResult<T>>>): Promise<VaultResult<T>> {
    if (!HEX.test(ctx.persona) || !ctx.principal) return refuse('unauthorised')
    if (!this.#current(ctx)) return refuse('stale')
    let result: CoordinationResult<VaultResult<T>>
    try {
      result = await work()
    } catch (error) {
      this.coordinator.invalidate(ctx.persona)
      if (error instanceof PersonaStorageError && ['seal-lost', 'missing-record', 'invalid'].includes(error.code)) return refuse('restore-fenced')
      throw error
    }
    if (!this.#current(ctx)) return refuse('stale')
    if (result.state === 'active') return result.value
    return refuse(result.state === 'fenced' ? 'restore-fenced' : result.reason === 'stale' ? 'stale' : 'witness-pending')
  }
  async #with<T>(tx: PersonaReader, persona: string, work: (r: RecordV1 | undefined) => Promise<T>): Promise<T> {
    const r = await readRecord(tx, persona)
    try { return await work(r) } finally { if (r) r.device.scalar = '' }
  }
  #device(r: RecordV1 | undefined, now = this.#now()): VaultRefusal | undefined {
    if (!r) return 'unauthorised'
    if (!Number.isSafeInteger(now) || now < 0 || r.device.credentialExpiresAt <= now) return 'expired'
    if (r.policy.revoked.includes(r.device.credentialId) || r.retired.includes(r.device.device)) return 'revoked'
    return undefined
  }
  #public(d: DeviceRecord): EnrolledDevice {
    return { persona: d.persona, device: d.device, credentialId: d.credentialId, credentialExpiresAt: d.credentialExpiresAt }
  }
  device(ctx: VaultContext): Promise<VaultResult<EnrolledDevice>> {
    return this.#run(ctx, tx => this.#with(tx, ctx.persona, async r => r ? ok(this.#public(r.device)) : refuse('unauthorised')))
  }

  async enrol(ctx: VaultContext, identity: ParticipantIdentity, expiresAt: number, options: { replace?: boolean } = {}): Promise<VaultResult<EnrolledDevice>> {
    const replace = options.replace === true
    if (identity.pubkey !== ctx.persona) return refuse('unauthorised')
    const before = await this.#run(ctx, tx => this.#with(tx, ctx.persona, async r => r && !replace ? refuse('unauthorised') : ok(r?.device.device ?? null)))
    if (!before.ok) return before
    const scalar = secp256k1.utils.randomSecretKey()
    try {
      const device = bytesToHex(schnorr.getPublicKey(scalar))
      let credential: DeviceRecord['credential']
      try { credential = await createDeviceCredential({ identity, devicePubkey: device, expiresAt, scope: 'person', now: this.#now }) }
      catch { return refuse('denied') }
      if (!this.#current(ctx)) return refuse('stale')
      let checked: ReturnType<typeof verifyPersonCredential>
      try { checked = verifyPersonCredential(credential, this.#now(), ctx.persona) } catch (e) { return refuse(refusalOf(e)) }
      if (checked.device !== device) return refuse('unauthorised')
      const record: DeviceRecord = { persona: ctx.persona, scalar: bytesToHex(scalar), device, credential, credentialId: checked.id, credentialExpiresAt: checked.expiresAt }
      // Invalidate synchronously before replacement. A failed write also makes
      // old replies stale; it never revives a reply made before replacement.
      if (replace) { this.#signals.invalidate(); this.coordinator.invalidate() }
      const writing = replace ? this.context(ctx.principal, ctx.persona) : ctx
      try {
        return await this.#run(writing, tx => this.#with(tx, ctx.persona, async old => {
          if ((old?.device.device ?? null) !== before.value) return refuse('stale')
          if (old?.retired.includes(device)) return refuse('revoked')
          const retired = old ? [...old.retired, old.device.device] : []
          if (retired.length > 1024) return refuse('busy')
          const r: RecordV1 = { version: 1, persona: ctx.persona, installation: tx.installation, device: record,
            policy: { approved: [], revoked: old ? [...new Set([...old.policy.revoked, old.device.credentialId])] : [] },
            journal: old?.journal ?? [], retired, migrated: old?.migrated ?? false }
          await saveRecord(tx, r)
          return ok(this.#public(record))
        }))
      } finally { record.scalar = '' }
    } finally { scalar.fill(0) }
  }

  /** Source locking precedes destination locking; no other path acquires both.
   * The source marks its one-way destination before the first covered write.
   * Its ciphertext remains available for an interrupted retry, never signing. */
  async migrate(ctx: VaultContext, legacy: MlsVault): Promise<VaultResult<EnrolledDevice>> {
    const target = await this.#run(ctx, tx => this.#with(tx, ctx.persona, async r => {
      if (r && !r.migrated) return refuse('unauthorised')
      return ok({ installation: tx.installation, device: r ? this.#public(r.device) : null })
    }))
    if (!target.ok) return target
    if (target.value.device) return ok(target.value.device)
    return this.#coordinate(ctx, () => legacy.migrateTo(ctx.persona, target.value.installation, this.coordinator, () => this.#current(ctx)))
  }

  async #policy(ctx: VaultContext, change: (r: RecordV1) => VaultResult<void>): Promise<VaultResult<void>> {
    return this.#run(ctx, tx => this.#with(tx, ctx.persona, async r => {
      if (!r) return refuse('unauthorised')
      const answer = change(r)
      if (answer.ok) await saveRecord(tx, r)
      return answer
    }))
  }
  approve(ctx: VaultContext, scope: ConsentScope): Promise<VaultResult<void>> {
    if (!typedScope(scope) || scope.persona !== ctx.persona || scope.principal !== ctx.principal) return Promise.resolve(refuse('malformed'))
    scope = { ...scope }
    return this.#policy(ctx, r => {
      const refusal = this.#device(r)
      if (refusal) return refuse(refusal)
      if (scope.device !== r.device.device) return refuse('unauthorised')
      if (!r.policy.approved.some(s => sameScope(s, scope))) {
        if (r.policy.approved.length >= 1024) return refuse('busy')
        r.policy.approved.push({ ...scope })
      }
      return ok(undefined)
    })
  }
  #invalidateContext(ctx: VaultContext): VaultContext | undefined {
    if (!this.#current(ctx)) return undefined
    this.#signals.invalidate()
    this.coordinator.invalidate()
    return this.context(ctx.principal, ctx.persona)
  }
  withdraw(ctx: VaultContext, scope: ConsentScope): Promise<VaultResult<void>> {
    if (!typedScope(scope) || scope.persona !== ctx.persona || scope.principal !== ctx.principal) return Promise.resolve(refuse('malformed'))
    scope = { ...scope }
    const writing = this.#invalidateContext(ctx)
    if (!writing) return Promise.resolve(refuse('stale'))
    return this.#policy(writing, r => { r.policy.approved = r.policy.approved.filter(s => !sameScope(s, scope)); return ok(undefined) })
  }
  revokeCredential(ctx: VaultContext, credentialId: string): Promise<VaultResult<void>> {
    if (!HEX.test(credentialId)) return Promise.resolve(refuse('malformed'))
    const writing = this.#invalidateContext(ctx)
    if (!writing) return Promise.resolve(refuse('stale'))
    return this.#policy(writing, r => {
      if (!r.policy.revoked.includes(credentialId)) {
        if (r.policy.revoked.length >= 4096) return refuse('busy')
        r.policy.revoked.push(credentialId)
      }
      return ok(undefined)
    })
  }

  #leaf(ctx: VaultContext, req: SignLeafBindingRequest, body: Uint8Array, r: RecordV1 | undefined): VaultResult<ConsentScope> {
    const now = this.#now(), refusal = this.#device(r, now)
    if (refusal || !r) return refuse(refusal ?? 'unauthorised')
    if (req.expires_at < now) return refuse('expired')
    if (req.expires_at > now + MAX_OPERATION_SECONDS) return refuse('malformed')
    if (bytesToHex(bindingDigest(body)) !== req.digest) return refuse('malformed')
    try {
      const binding = readUnsignedBinding(body)
      if (bytesToHex(binding.device) !== r.device.device) return refuse('unauthorised')
      checkUnsignedBinding(binding, now, ctx.persona, new Set(r.policy.revoked))
      return ok({ principal: ctx.principal, persona: ctx.persona, device: r.device.device, homeBox: bytesToHex(binding.homeBox), method: SIGN_METHOD })
    } catch (e) { return refuse(refusalOf(e)) }
  }
  #earlier(ctx: VaultContext, req: SignLeafBindingRequest, r: RecordV1): JournalEntry | undefined {
    return r.journal.find(e => e.principal === ctx.principal && e.handle === r.device.device && e.operation === req.operation)
  }
  #replay(ctx: VaultContext, req: SignLeafBindingRequest, body: Uint8Array, r: RecordV1, scope: ConsentScope, e: JournalEntry): VaultResult<SignLeafBindingReply> {
    if (e.bodyHash !== bytesToHex(sha256(body)) || e.digest !== req.digest || e.deadline !== req.expires_at) return refuse('replay')
    if (e.generation !== ctx.generation || e.revision !== ctx.revision) return refuse('stale')
    if (!e.outcome.ok) return refuse('denied')
    if (e.outcome.homeBox !== scope.homeBox || !r.policy.approved.some(s => sameScope(s, scope))) return refuse('unauthorised')
    return ok(Object.freeze({ v: 1, operation: req.operation, digest: req.digest, device: r.device.device, signature: e.outcome.signature }))
  }
  async signLeafBindingV1(ctx: VaultContext, input: unknown, consent: ConsentPrompt): Promise<VaultResult<SignLeafBindingReply>> {
    const shape = signRequestShape(input)
    if (!shape.ok) return shape
    const req = shape.value, body = base64Decode(req.body)
    if (!HEX.test(req.operation) || !HEX.test(req.digest)) return refuse('malformed')
    if (!body) return refuse('malformed')
    const first = await this.#run(ctx, tx => this.#with(tx, ctx.persona, async r => {
      const checked = this.#leaf(ctx, req, body, r)
      if (!checked.ok) return checked
      if (!r) return refuse('unauthorised')
      // The second transaction replays under a fresh confirmation, including
      // denials. An old operation never opens another consent prompt.
      return ok({ scope: checked.value, ask: !this.#earlier(ctx, req, r) && !r.policy.approved.some(s => sameScope(s, checked.value)) })
    }))
    if (!first.ok) return first
    let decision: ConsentDecision = 'approve'
    if (first.value.ask) {
      try { decision = await consent({ ...first.value.scope }) } catch { decision = 'deny' }
    }
    const answer = await this.#run(ctx, tx => this.#with(tx, ctx.persona, async r => {
      const checked = this.#leaf(ctx, req, body, r)
      if (!checked.ok) return checked
      if (!r) return refuse('unauthorised')
      if (!sameScope(checked.value, first.value.scope)) return refuse('stale')
      const earlier = this.#earlier(ctx, req, r)
      if (earlier) return this.#replay(ctx, req, body, r, checked.value, earlier)
      const live = r.journal.filter(e => e.deadline >= this.#now())
      if (live.length >= MAX_JOURNAL_RECORDS) return refuse('busy')
      // A withdrawn existing approval must not be recreated without a prompt.
      if (!first.value.ask && !r.policy.approved.some(s => sameScope(s, checked.value))) return refuse('unauthorised')
      let outcome: JournalEntry['outcome'] = { ok: false, refusal: 'denied' }
      if (decision === 'approve') {
        if (!r.policy.approved.some(s => sameScope(s, checked.value)) && r.policy.approved.length >= 1024) return refuse('busy')
        const scalar = hexToBytes(r.device.scalar)
        try { outcome = { ok: true, signature: bytesToHex(schnorr.sign(hexToBytes(req.digest), scalar, crypto.getRandomValues(new Uint8Array(32)))), homeBox: checked.value.homeBox } }
        finally { scalar.fill(0) }
        if (!r.policy.approved.some(s => sameScope(s, checked.value))) r.policy.approved.push(checked.value)
      }
      live.push({ generation: ctx.generation, revision: ctx.revision, principal: ctx.principal, handle: r.device.device,
        operation: req.operation, bodyHash: bytesToHex(sha256(body)), digest: req.digest, deadline: req.expires_at, outcome })
      r.journal = live
      await saveRecord(tx, r)
      return outcome.ok ? ok(Object.freeze({ v: 1 as const, operation: req.operation, digest: req.digest, device: r.device.device, signature: outcome.signature })) : refuse('denied')
    }))
    if (answer.ok) this.#made.set(answer.value, { ctx, request: leafKey(req) })
    return answer
  }
  acceptSignReply(req: SignLeafBindingRequest, reply: unknown): VaultResult<SignLeafBindingReply> {
    const shape = signRequestShape(req)
    if (!shape.ok) return shape
    const accepted = this.#accept(leafKey(req), reply)
    if (!accepted.ok) return accepted
    const r = reply as SignLeafBindingReply
    try { return schnorr.verify(hexToBytes(r.signature), hexToBytes(req.digest), hexToBytes(r.device)) ? ok(r) : refuse('unauthorised') }
    catch { return refuse('unauthorised') }
  }
  #accept(request: string, reply: unknown): VaultResult<void> {
    const made = typeof reply === 'object' && reply !== null ? this.#made.get(reply) : undefined
    if (!made) return refuse('unauthorised')
    if (!this.#current(made.ctx)) return refuse('stale')
    return made.request === request ? ok(undefined) : refuse('replay')
  }

  async signBoxRequestV1(ctx: VaultContext, input: unknown, consent: ConsentPrompt): Promise<VaultResult<BoxReply>> {
    const req = boxRequest(input)
    if (!req) return refuse('malformed')
    const first = await this.#look(ctx, tx => this.#with(tx, ctx.persona, async r => {
      const refusal = this.#device(r)
      if (refusal || !r) return refuse(refusal ?? 'unauthorised')
      const scope: ConsentScope = { principal: ctx.principal, persona: ctx.persona, device: r.device.device, homeBox: req.box, method: BOX_METHOD }
      return ok({ scope, approved: r.policy.approved.some(s => sameScope(s, scope)) })
    }))
    if (!first.ok) return first
    if (!first.value.approved) {
      let decision: ConsentDecision
      try { decision = await consent({ ...first.value.scope }) } catch { decision = 'deny' }
      if (!this.#current(ctx)) return refuse('stale')
      if (decision !== 'approve') return refuse('denied')
      const saved = await this.approve(ctx, first.value.scope)
      if (!saved.ok) return saved
    }
    const answer = await this.#look(ctx, tx => this.#with(tx, ctx.persona, async r => {
      const now = this.#now(), refusal = this.#device(r, now)
      if (refusal || !r) return refuse(refusal ?? 'unauthorised')
      if (r.device.device !== first.value.scope.device || !r.policy.approved.some(s => sameScope(s, first.value.scope))) return refuse('unauthorised')
      const key = ctx.persona + '|' + r.device.device + '|' + boxKey(req)
      for (const [k, at] of this.#boxTimes) if (at < now) this.#boxTimes.delete(k)
      if (!this.#boxTimes.has(key) && this.#boxTimes.size >= 1024) return refuse('busy')
      const created_at = Math.max(now, (this.#boxTimes.get(key) ?? now - 1) + 1)
      if (created_at > now + 30) return refuse('busy')
      this.#boxTimes.set(key, created_at)
      const scalar = hexToBytes(r.device.scalar)
      try {
        const event = finalizeEvent({ kind: 27235, created_at, content: '', tags: [
          ['u', `http://${base32.encode(hexToBytes(req.box)).replace(/=+$/, '').toLowerCase()}${req.path}`],
          ['method', req.method], ['payload', req.payload],
        ] }, scalar)
        return ok(Object.freeze({ v: 1 as const, device: r.device.device, authorization: 'Nostr ' + base64Encode(new TextEncoder().encode(JSON.stringify(event))) }))
      } finally { scalar.fill(0) }
    }))
    if (answer.ok) this.#made.set(answer.value, { ctx, request: boxKey(req) })
    return answer
  }
  acceptBoxReply(req: BoxRequest, reply: unknown): VaultResult<BoxReply> {
    if (!boxRequest(req)) return refuse('malformed')
    const accepted = this.#accept(boxKey(req), reply)
    return accepted.ok ? ok(reply as BoxReply) : accepted
  }
}

/** Only the exact contracted routes, no query, alternate encoding or body on
 * the two empty-body routes. The caller cannot provide an event or its time. */
export function boxRequest(value: unknown): BoxRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).sort().join(',') !== 'box,method,path,payload,v') return undefined
  const r = value as BoxRequest
  if (r.v !== 1 || typeof r.box !== 'string' || !HEX.test(r.box) || typeof r.payload !== 'string' || !HEX.test(r.payload) || typeof r.path !== 'string') return undefined
  const id = '[0-9a-f]{64}', attempt = '(0|[1-9][0-9]{0,9})'
  const routes: [string, RegExp][] = [
    ['PUT', new RegExp(`^/vmls/v1/mailboxes/${id}/records$`)],
    ['POST', /^\/vmls\/v1\/(fetch|ack)$/],
    ['PUT', new RegExp(`^/vmls/v1/packages/${id}$`)], ['DELETE', new RegExp(`^/vmls/v1/packages/${id}$`)],
    ['PUT', new RegExp(`^/vmls/v1/slots/${id}/${attempt}$`)], ['POST', new RegExp(`^/vmls/v1/slots/${id}/${attempt}/status$`)],
    ['GET', /^\/vmls\/v1\/capabilities$/],
  ]
  if (!routes.some(([method, path]) => {
    const matched = path.exec(r.path)
    return method === r.method && matched && matched[0] === r.path && (!r.path.includes('/slots/') || Number(matched[1]) <= 0xffff_ffff)
  }) || (['GET', 'DELETE'].includes(r.method) && r.payload !== EMPTY)) return undefined
  return { v: 1, box: r.box, method: r.method, path: r.path, payload: r.payload }
}

/** The seal authenticates bytes, not schema. Reject readable unsupported or
 * incomplete records; never substitute an empty journal/policy/device. */
function validateRecord(r: RecordV1, persona: string, installation: string): void {
  const invalid = () => { throw new PersonaStorageError('invalid') }
  if (!r || r.version !== 1 || r.persona !== persona || r.installation !== installation || typeof r.migrated !== 'boolean') invalid()
  const d = r.device
  if (!d || d.persona !== persona || !HEX.test(d.scalar) || !HEX.test(d.device) || !HEX.test(d.credentialId) || !Number.isSafeInteger(d.credentialExpiresAt)) invalid()
  const scalar = hexToBytes(d.scalar)
  try { if (bytesToHex(schnorr.getPublicKey(scalar)) !== d.device) invalid() } finally { scalar.fill(0) }
  // Check the credential at its issue time, preserving expired credentials
  // for revocation/recovery; signing checks the current clock separately.
  const credential = verifyPersonCredential(d.credential, d.credential.created_at, persona)
  if (credential.device !== d.device || credential.id !== d.credentialId || credential.expiresAt !== d.credentialExpiresAt) invalid()
  if (!r.policy || !Array.isArray(r.policy.approved) || !Array.isArray(r.policy.revoked) || !Array.isArray(r.retired) || !Array.isArray(r.journal)) invalid()
  if (r.policy.approved.length > 1024 || r.policy.revoked.length > 4096 || r.retired.length > 1024 || r.journal.length > MAX_JOURNAL_RECORDS) invalid()
  if (r.policy.approved.some(s => !typedScope(s) || s.persona !== persona) || r.policy.revoked.some(x => !HEX.test(x)) || r.retired.some(x => !HEX.test(x)) || r.retired.includes(d.device)) invalid()
  const ids = new Set<string>()
  for (const e of r.journal) {
    if (!e || !Number.isSafeInteger(e.generation) || e.generation < 0 || (e.revision !== undefined && typeof e.revision !== 'string') || typeof e.principal !== 'string' || !e.principal || !HEX.test(e.handle) || !HEX.test(e.operation) || !HEX.test(e.bodyHash) || !HEX.test(e.digest) || !Number.isSafeInteger(e.deadline) || e.deadline < 0 || !e.outcome) invalid()
    const id = JSON.stringify([e.principal, e.handle, e.operation])
    if (ids.has(id)) invalid(); ids.add(id)
    if (e.outcome.ok === true) {
      if (typeof e.outcome.signature !== 'string' || !/^[0-9a-f]{128}$/.test(e.outcome.signature) || !HEX.test(e.outcome.homeBox) || !schnorr.verify(hexToBytes(e.outcome.signature), hexToBytes(e.digest), hexToBytes(e.handle))) invalid()
    } else if (e.outcome.ok !== false || e.outcome.refusal !== 'denied') invalid()
  }
}

async function readRecord(tx: PersonaReader, persona: string): Promise<RecordV1 | undefined> {
  const bytes = await tx.readVault(RECORD)
  if (!bytes) return undefined
  try {
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as RecordV1
    validateRecord(r, persona, tx.installation)
    return r
  } catch { throw new InvalidPersonaRecord('The stored MLS vault record is unsupported or damaged.') }
}

async function saveRecord(tx: PersonaTransaction, r: RecordV1): Promise<void> {
  validateRecord(r, r.persona, tx.installation)
  const bytes = new TextEncoder().encode(JSON.stringify(r))
  try { await tx.putVault(RECORD, bytes) } finally { bytes.fill(0) }
}

/** Internal migration sink: consumes legacy plaintext but returns only public
 * device metadata. There is no callback-based scalar export on either vault. */
export async function importLegacyVault(tx: PersonaTransaction, persona: string, records: { device: DeviceRecord; policy: PolicyRecord; journal: JournalEntry[] }): Promise<VaultResult<EnrolledDevice>> {
  const existing = await readRecord(tx, persona)
  try {
    if (existing && !existing.migrated) return refuse('unauthorised')
    if (!existing) {
      await saveRecord(tx, { version: 1, persona, installation: tx.installation, ...records, retired: [], migrated: true })
    }
    const d = existing?.device ?? records.device
    return ok({ persona, device: d.device, credentialId: d.credentialId, credentialExpiresAt: d.credentialExpiresAt })
  } finally { if (existing) existing.device.scalar = '' }
}
