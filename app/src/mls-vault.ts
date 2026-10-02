/**
 * The browser's MLS device vault (Vennel MLS contract §6, ticket P3-01).
 *
 * It holds one person-scoped secp256k1 device key per persona, enrolled with
 * a kind-20460 person credential from the identity signer, and does exactly
 * two things with it: signs a validated unsigned leaf binding
 * (`signLeafBindingV1`, §6.2) and answers a rendezvous ECDH through the
 * separate rendezvous vault's child (`rendezvousEcdhV1`, §6.3). There is no
 * scalar getter, no generic digest signing and no identity-key fallback.
 *
 * Storage follows `rendezvous-vault.ts`: IndexedDB, a non-extractable
 * AES-GCM-256 key, a random 96-bit nonce per write. Record names are HMACs
 * under a second non-extractable key, so the database holds no persona in the
 * clear, and every record's AEAD metadata binds persona, installation,
 * purpose and record version. Every mutation runs under one Web Lock, so two
 * tabs never write at once.
 *
 * Interim limits until P3-03: the clock is the browser's, and the decision
 * journal is not witnessed, so restoring an older IndexedDB rolls it back.
 * Nothing here is wired to the MLS engine or to any UI yet.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { createDeviceCredential } from '../../src/credential.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import {
  BindingError, bindingDigest, checkUnsignedBinding, readUnsignedBinding, verifyPersonCredential,
  type BindingErrorCode, type PersonCredential,
} from '../../src/vmls/binding.js'
import type { StoredRendezvousChild } from './rendezvous-vault.js'

/** The stable refusal strings of §6.2. */
export type VaultRefusal =
  | 'unsupported' | 'malformed' | 'unauthorised' | 'expired' | 'revoked'
  | 'denied' | 'busy' | 'stale' | 'replay' | 'restore-fenced'

export type VaultResult<T> = { ok: true; value: T } | { ok: false; refusal: VaultRefusal }

/**
 * Who is asking, taken from the authenticated app, never from a request:
 * the app principal, the selected persona (identity public key) and the
 * vault generation the operation started under.
 */
export interface VaultContext {
  readonly principal: string
  readonly persona: string
  readonly generation: number
}

export interface SignLeafBindingRequest {
  v: 1
  operation: string
  body: string
  digest: string
  expires_at: number
}

export interface SignLeafBindingReply {
  readonly v: 1
  readonly operation: string
  readonly digest: string
  readonly device: string
  readonly signature: string
}

export interface RendezvousEcdhRequest {
  v: 1
  operation: string
  peer_rz: string
  expires_at: number
}

export interface RendezvousEcdhReply {
  readonly v: 1
  readonly operation: string
  readonly peer_rz: string
  readonly own_rz: string
  readonly shared_x: string
}

/** One consent scope (§6.2): approved once, retained revocably. */
export interface ConsentScope {
  principal: string
  persona: string
  device: string
  homeBox: string
  method: typeof SIGN_METHOD
}

export type ConsentDecision = 'approve' | 'deny'

/** Asks the person about a new scope. A promise, because it is a prompt. */
export type ConsentPrompt = (scope: ConsentScope) => Promise<ConsentDecision>

export interface EnrolledDevice {
  persona: string
  device: string
  credentialId: string
  credentialExpiresAt: number
}

export const SIGN_METHOD = 'signLeafBindingV1/1'
/** Live journal records per persona-installation (§6.2). */
export const MAX_JOURNAL_RECORDS = 1024
/** An operation may be at most this far in the future (inclusive). */
export const MAX_OPERATION_SECONDS = 600
const MAX_BODY_BASE64 = 11_000
const HEX64 = /^[0-9a-f]{64}$/
const NONCE_BYTES = 12
const RECORD_VERSION = 1
const AAD_PREFIX = 'kithmoot.mls-vault.v1'
const LOCK = 'kithmoot-mls-vault-v1'

// ---- storage ----

export interface SealedRecord {
  name: string
  version: 1
  nonce: ArrayBuffer
  ciphertext: ArrayBuffer
}

export interface MlsVaultStorage {
  keys(): Promise<{ seal: CryptoKey; name: CryptoKey } | undefined>
  saveKeys(keys: { seal: CryptoKey; name: CryptoKey }): Promise<void>
  get(name: string): Promise<SealedRecord | undefined>
  put(record: SealedRecord): Promise<void>
  remove(name: string): Promise<void>
}

/** The cross-tab lock. `navigator.locks` in a browser. */
export interface VaultLocks {
  request<T>(name: string, work: () => Promise<T>): Promise<T>
}

interface DeviceRecord {
  persona: string
  scalar: string
  device: string
  credential: PersonCredentialEvent
  credentialId: string
  credentialExpiresAt: number
}

interface PersonCredentialEvent {
  kind: number
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
  sig: string
}

interface JournalEntry {
  principal: string
  handle: string
  operation: string
  bodyHash: string
  digest: string
  deadline: number
  outcome: { ok: true; signature: string; homeBox: string } | { ok: false; refusal: 'denied' }
}

interface PolicyRecord {
  approved: ConsentScope[]
  revoked: string[]
}

type Purpose = 'installation' | 'device' | 'journal' | 'policy'

export interface MlsVaultOptions {
  crypto?: Crypto
  locks?: VaultLocks
  /** Unix seconds. The browser's clock until P3-03's witness clock. */
  now?: () => number
  /**
   * The app's own account generation, which rises on sign-in, sign-out and
   * forgetting the browser (KithMoot's `identityGeneration`). The vault's
   * generation follows it as well as its own `bump()`.
   */
  generation?: () => number
}

/** The replies this vault made, and the generation each was made under. */
const made = new WeakMap<object, { vault: MlsVault; generation: number; request: string }>()

export class MlsVault {
  #bumps = 0
  readonly #appGeneration: () => number
  #keys: Promise<{ seal: CryptoKey; name: CryptoKey }> | undefined
  #installation: Promise<string> | undefined
  readonly #crypto: Crypto
  readonly #locks: VaultLocks
  readonly #now: () => number

  constructor(private readonly storage: MlsVaultStorage, options: MlsVaultOptions = {}) {
    this.#crypto = options.crypto ?? globalThis.crypto
    if (!this.#crypto?.subtle || !this.#crypto.getRandomValues) throw new Error('This device cannot create an encrypted MLS vault.')
    this.#locks = options.locks ?? browserLocks() ?? localLocks()
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#appGeneration = options.generation ?? (() => 0)
  }

  /** One number for both: the app's generation and the vault's bumps. */
  get #generation(): number {
    const app = this.#appGeneration()
    if (!Number.isSafeInteger(app) || app < 0) return -1
    return app * 2 ** 20 + this.#bumps
  }

  // ---- generation (S25, E06) ----

  /** The context for an operation by `persona` under app `principal`. */
  context(principal: string, persona: string): VaultContext {
    return Object.freeze({ principal, persona, generation: this.#generation })
  }

  /**
   * Login, logout, account switch or vault clear: every operation started
   * before, and every reply made before, is now stale.
   */
  bump(): void { this.#bumps = (this.#bumps + 1) % 2 ** 20 }

  #current(ctx: VaultContext): boolean { return ctx.generation >= 0 && ctx.generation === this.#generation }

  /** Keys and installation exist before any locked section uses them:
   * making them takes the lock, which a locked section must not re-take. */
  async #ready(): Promise<void> {
    await this.#cryptoKeys()
    await this.installation()
  }

  // ---- enrolment ----

  /**
   * Makes a fresh device key for `ctx.persona`, asks the identity signer for
   * a person credential naming it, checks that credential against the
   * engine's rules and seals both. Replaces any earlier device for the
   * persona: a new device is a new leaf (§6.1).
   */
  async enrol(ctx: VaultContext, identity: ParticipantIdentity, expiresAt: number): Promise<VaultResult<EnrolledDevice>> {
    await this.#ready()
    if (!this.#current(ctx)) return refuse('stale')
    if (!HEX64.test(ctx.persona) || identity.pubkey !== ctx.persona) return refuse('unauthorised')
    const scalar = secp256k1.utils.randomSecretKey()
    try {
      const device = bytesToHex(schnorr.getPublicKey(scalar))
      let event: PersonCredentialEvent
      try {
        event = await createDeviceCredential({ identity, devicePubkey: device, expiresAt, scope: 'person', now: this.#now }) as PersonCredentialEvent
      } catch { return refuse('denied') }
      if (!this.#current(ctx)) return refuse('stale')
      let credential: PersonCredential
      try { credential = verifyPersonCredential(event, this.#now(), ctx.persona) }
      catch (error) { return refuse(refusalOf(error)) }
      if (credential.device !== device) return refuse('unauthorised')
      const record: DeviceRecord = {
        persona: ctx.persona, scalar: bytesToHex(scalar), device, credential: event,
        credentialId: credential.id, credentialExpiresAt: credential.expiresAt,
      }
      return await this.#locked(async () => {
        if (!this.#current(ctx)) return refuse('stale')
        await this.#seal('device', ctx.persona, record)
        return { ok: true, value: { persona: ctx.persona, device, credentialId: credential.id, credentialExpiresAt: credential.expiresAt } }
      })
    } finally { scalar.fill(0) }
  }

  /** The persona's enrolled device, without its key. */
  async device(ctx: VaultContext): Promise<VaultResult<EnrolledDevice>> {
    await this.#ready()
    if (!this.#current(ctx)) return refuse('stale')
    const record = await this.#open<DeviceRecord>('device', ctx.persona)
    if (!record) return refuse('unauthorised')
    record.scalar = ''
    return { ok: true, value: { persona: record.persona, device: record.device, credentialId: record.credentialId, credentialExpiresAt: record.credentialExpiresAt } }
  }

  // ---- policy: consent scopes and known revocations ----

  async approve(ctx: VaultContext, scope: ConsentScope): Promise<VaultResult<void>> {
    await this.#ready()
    if (!this.#current(ctx)) return refuse('stale')
    if (!scopeShape(scope) || scope.persona !== ctx.persona || scope.principal !== ctx.principal) return refuse('malformed')
    return await this.#locked(async () => {
      const policy = await this.#policy(ctx.persona)
      if (!policy.approved.some(s => sameScope(s, scope))) policy.approved.push({ ...scope })
      await this.#seal('policy', ctx.persona, policy)
      return { ok: true, value: undefined }
    })
  }

  /** Withdraws an approval; later requests in that scope need consent again. */
  async withdraw(ctx: VaultContext, scope: ConsentScope): Promise<VaultResult<void>> {
    await this.#ready()
    if (!this.#current(ctx)) return refuse('stale')
    return await this.#locked(async () => {
      const policy = await this.#policy(ctx.persona)
      policy.approved = policy.approved.filter(s => !sameScope(s, scope))
      await this.#seal('policy', ctx.persona, policy)
      return { ok: true, value: undefined }
    })
  }

  /** Records a credential as revoked (a root-signed tombstone the app saw). */
  async revokeCredential(ctx: VaultContext, credentialId: string): Promise<VaultResult<void>> {
    await this.#ready()
    if (!this.#current(ctx)) return refuse('stale')
    if (!HEX64.test(credentialId)) return refuse('malformed')
    return await this.#locked(async () => {
      const policy = await this.#policy(ctx.persona)
      if (!policy.revoked.includes(credentialId)) policy.revoked.push(credentialId)
      await this.#seal('policy', ctx.persona, policy)
      return { ok: true, value: undefined }
    })
  }

  // ---- signLeafBindingV1 (§6.2) ----

  async signLeafBindingV1(ctx: VaultContext, request: unknown, consent: ConsentPrompt): Promise<VaultResult<SignLeafBindingReply>> {
    await this.#ready()
    if (!this.#current(ctx)) return refuse('stale')
    const shape = signRequestShape(request)
    if (!shape.ok) return shape
    const req = shape.value
    const now = this.#now()
    if (!Number.isFinite(now)) return refuse('expired')
    if (req.expires_at < now) return refuse('expired')
    if (req.expires_at > now + MAX_OPERATION_SECONDS) return refuse('malformed')
    const body = base64Decode(req.body)
    if (!body) return refuse('malformed')
    const bodyHash = bytesToHex(sha256(body))
    const device = await this.#open<DeviceRecord>('device', ctx.persona)
    if (!this.#current(ctx)) return refuse('stale')
    if (!device) return refuse('unauthorised')
    try {
      // An identical retry replays its decision; a changed one is refused.
      const earlier = await this.#journalEntry(ctx, device.device, req.operation)
      if (earlier) return await this.#replay(ctx, req, bodyHash, earlier, device)

      if (bytesToHex(bindingDigest(body)) !== req.digest) return refuse('malformed')
      const checked = this.#check(body, ctx, device, await this.#policy(ctx.persona), now)
      if (!checked.ok) return checked
      const scope: ConsentScope = { principal: ctx.principal, persona: ctx.persona, device: device.device, homeBox: checked.value, method: SIGN_METHOD }

      // Consent, outside the lock: it is a prompt.
      let approved = (await this.#policy(ctx.persona)).approved.some(s => sameScope(s, scope))
      if (!approved) {
        let decision: ConsentDecision
        try { decision = await consent({ ...scope }) } catch { decision = 'deny' }
        if (!this.#current(ctx)) return refuse('stale')
        if (decision !== 'approve') {
          return await this.#locked(async () => {
            if (!this.#current(ctx)) return refuse('stale')
            const raced = await this.#journalEntry(ctx, device.device, req.operation)
            if (raced) return await this.#replay(ctx, req, bodyHash, raced, device)
            const recorded = await this.#record(ctx, { principal: ctx.principal, handle: device.device, operation: req.operation, bodyHash, digest: req.digest, deadline: req.expires_at, outcome: { ok: false, refusal: 'denied' } })
            return recorded.ok ? refuse('denied') : recorded
          })
        }
        approved = true
      }

      return await this.#locked(async () => {
        if (!this.#current(ctx)) return refuse('stale')
        const raced = await this.#journalEntry(ctx, device.device, req.operation)
        if (raced) return await this.#replay(ctx, req, bodyHash, raced, device)
        const policy = await this.#policy(ctx.persona)
        // Everything rechecked under the lock, at the time of signing.
        const recheck = this.#check(body, ctx, device, policy, this.#now())
        if (!recheck.ok) return recheck
        if (req.expires_at < this.#now()) return refuse('expired')
        if (approved && !policy.approved.some(s => sameScope(s, scope))) {
          policy.approved.push(scope)
          await this.#seal('policy', ctx.persona, policy)
        }
        const scalar = hexToBytes(device.scalar)
        let signature: Uint8Array
        try {
          const aux = new Uint8Array(32); this.#crypto.getRandomValues(aux)
          signature = schnorr.sign(hexToBytes(req.digest), scalar, aux)
        } finally { scalar.fill(0) }
        if (!schnorr.verify(signature, hexToBytes(req.digest), hexToBytes(device.device))) return refuse('malformed')
        const recorded = await this.#record(ctx, {
          principal: ctx.principal, handle: device.device, operation: req.operation, bodyHash, digest: req.digest,
          deadline: req.expires_at, outcome: { ok: true, signature: bytesToHex(signature), homeBox: scope.homeBox },
        })
        if (!recorded.ok) return recorded
        return { ok: true, value: this.#signReply(ctx, req, device.device, bytesToHex(signature)) }
      })
    } finally { device.scalar = '' }
  }

  /** The body's checks, mapped to refusals; returns the approved home box. */
  #check(body: Uint8Array, ctx: VaultContext, device: DeviceRecord, policy: PolicyRecord, now: number): VaultResult<string> {
    let homeBox: string
    try {
      const binding = readUnsignedBinding(body)
      // The body must name this vault's device for this persona (S19), and
      // the credential must be the person form for them (S18).
      if (bytesToHex(binding.device) !== device.device) return refuse('unauthorised')
      checkUnsignedBinding(binding, now, ctx.persona, new Set(policy.revoked))
      homeBox = bytesToHex(binding.homeBox)
    } catch (error) { return refuse(refusalOf(error)) }
    if (policy.revoked.includes(device.credentialId)) return refuse('revoked')
    if (device.credentialExpiresAt <= now) return refuse('expired')
    return { ok: true, value: homeBox }
  }

  async #replay(ctx: VaultContext, req: SignLeafBindingRequest, bodyHash: string, entry: JournalEntry, device: DeviceRecord): Promise<VaultResult<SignLeafBindingReply>> {
    if (entry.bodyHash !== bodyHash || entry.digest !== req.digest || entry.deadline !== req.expires_at || entry.principal !== ctx.principal) return refuse('replay')
    if (!entry.outcome.ok) return refuse(entry.outcome.refusal)
    // A cached success is rechecked: still unexpired, still approved, still
    // not revoked (S22).
    const now = this.#now()
    if (entry.deadline < now) return refuse('expired')
    const policy = await this.#policy(ctx.persona)
    if (!this.#current(ctx)) return refuse('stale')
    const body = base64Decode(req.body)
    if (!body) return refuse('malformed')
    const checked = this.#check(body, ctx, device, policy, now)
    if (!checked.ok) return checked
    const scope: ConsentScope = { principal: ctx.principal, persona: ctx.persona, device: device.device, homeBox: entry.outcome.homeBox, method: SIGN_METHOD }
    if (!policy.approved.some(s => sameScope(s, scope))) return refuse('unauthorised')
    return { ok: true, value: this.#signReply(ctx, req, device.device, entry.outcome.signature) }
  }

  #signReply(ctx: VaultContext, req: SignLeafBindingRequest, device: string, signature: string): SignLeafBindingReply {
    const reply = Object.freeze({ v: 1 as const, operation: req.operation, digest: req.digest, device, signature })
    made.set(reply, { vault: this, generation: ctx.generation, request: requestKey(req) })
    return reply
  }

  /**
   * The adapter's check before it completes the engine call: the reply was
   * made by this vault, in the current generation, for exactly `request`,
   * and its signature verifies. Anything else is refused (E04, E06).
   */
  acceptSignReply(request: SignLeafBindingRequest, reply: unknown): VaultResult<SignLeafBindingReply> {
    const origin = typeof reply === 'object' && reply !== null ? made.get(reply) : undefined
    if (!origin || origin.vault !== this) return refuse('unauthorised')
    if (origin.generation !== this.#generation) return refuse('stale')
    if (origin.request !== requestKey(request)) return refuse('replay')
    const r = reply as SignLeafBindingReply
    if (!schnorr.verify(hexToBytes(r.signature), hexToBytes(request.digest), hexToBytes(r.device))) return refuse('unauthorised')
    return { ok: true, value: r }
  }

  // ---- rendezvousEcdhV1 (§6.3) ----

  /**
   * ECDH between this persona's provisioned rendezvous child and `peer_rz`.
   * `child` resolves the child from the rendezvous vault for the current
   * account; the vault reads it there and wipes its copy. No response is
   * cached or logged.
   */
  async rendezvousEcdhV1(ctx: VaultContext, request: unknown, child: () => Promise<StoredRendezvousChild | undefined>): Promise<VaultResult<RendezvousEcdhReply>> {
    if (!this.#current(ctx)) return refuse('stale')
    const shape = ecdhRequestShape(request)
    if (!shape.ok) return shape
    const req = shape.value
    const now = this.#now()
    if (req.expires_at < now) return refuse('expired')
    if (req.expires_at > now + MAX_OPERATION_SECONDS) return refuse('malformed')
    let peer: InstanceType<typeof secp256k1.Point>
    try { peer = secp256k1.Point.fromHex('02' + req.peer_rz) } catch { return refuse('malformed') }
    const stored = await child()
    if (!this.#current(ctx)) { stored?.wipe(); return refuse('stale') }
    if (!stored) return refuse('unauthorised')
    try {
      if (stored.receipt.identity !== ctx.persona) return refuse('unauthorised')
      if (stored.receipt.expiresAt <= now) return refuse('expired')
      const own = stored.receipt.rendezvousPubkey
      if (own === req.peer_rz) return refuse('malformed')
      const shared = stored.withScalar(scalar => {
        const point = secp256k1.getSharedSecret(scalar, peer.toBytes(true))
        try { return point.slice(1) } finally { point.fill(0) }
      })
      try {
        if (shared.every(b => b === 0)) return refuse('malformed')
        const reply = Object.freeze({ v: 1 as const, operation: req.operation, peer_rz: req.peer_rz, own_rz: own, shared_x: bytesToHex(shared) })
        made.set(reply, { vault: this, generation: ctx.generation, request: ecdhKey(req) })
        return { ok: true, value: reply }
      } finally { shared.fill(0) }
    } finally { stored.wipe() }
  }

  /** As `acceptSignReply`, for ECDH: a forged or substituted value, another
   * peer, or a reply from a previous vault generation is refused. */
  acceptEcdhReply(request: RendezvousEcdhRequest, reply: unknown): VaultResult<RendezvousEcdhReply> {
    const origin = typeof reply === 'object' && reply !== null ? made.get(reply) : undefined
    if (!origin || origin.vault !== this) return refuse('unauthorised')
    if (origin.generation !== this.#generation) return refuse('stale')
    if (origin.request !== ecdhKey(request)) return refuse('replay')
    return { ok: true, value: reply as RendezvousEcdhReply }
  }

  // ---- clearing ----

  /** Removes the persona's device, journal and policy, and makes every
   * pending operation stale. */
  async clear(persona: string): Promise<void> {
    await this.#ready()
    this.bump()
    await this.#locked(async () => {
      for (const purpose of ['device', 'journal', 'policy'] as const) await this.storage.remove(await this.#name(purpose, persona))
    })
  }

  // ---- the journal (§6.2) ----

  async #journal(ctx: VaultContext): Promise<JournalEntry[]> {
    return (await this.#open<JournalEntry[]>('journal', ctx.persona)) ?? []
  }

  async #journalEntry(ctx: VaultContext, handle: string, operation: string): Promise<JournalEntry | undefined> {
    return (await this.#journal(ctx)).find(e => e.principal === ctx.principal && e.handle === handle && e.operation === operation)
  }

  /** Persists an entry before its outcome is released. Expired entries go;
   * live ones are never evicted: at the cap the operation is `busy`. */
  async #record(ctx: VaultContext, entry: JournalEntry): Promise<VaultResult<void>> {
    const now = this.#now()
    const live = (await this.#journal(ctx)).filter(e => e.deadline >= now)
    if (live.length >= MAX_JOURNAL_RECORDS) return refuse('busy')
    live.push(entry)
    await this.#seal('journal', ctx.persona, live)
    return { ok: true, value: undefined }
  }

  async #policy(persona: string): Promise<PolicyRecord> {
    const policy = await this.#open<PolicyRecord>('policy', persona)
    return policy ?? { approved: [], revoked: [] }
  }

  // ---- sealing ----

  async #locked<T>(work: () => Promise<T>): Promise<T> {
    return await this.#locks.request(LOCK, work)
  }

  async #seal(purpose: Purpose, persona: string, value: unknown): Promise<void> {
    const keys = await this.#cryptoKeys()
    const plaintext = new TextEncoder().encode(JSON.stringify(value))
    const nonce = new Uint8Array(NONCE_BYTES); this.#crypto.getRandomValues(nonce)
    try {
      const ciphertext = await this.#crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: await this.#aad(purpose, persona) }, keys.seal, plaintext)
      await this.storage.put({ name: await this.#name(purpose, persona), version: RECORD_VERSION, nonce: nonce.slice().buffer, ciphertext })
    } finally { plaintext.fill(0) }
  }

  /** Opens a record; a missing one is `undefined`, a corrupt one throws:
   * never a silent fallback (§6.1). */
  async #open<T>(purpose: Purpose, persona: string): Promise<T | undefined> {
    const record = await this.storage.get(await this.#name(purpose, persona))
    if (!record) return undefined
    if (record.version !== RECORD_VERSION || !(record.nonce instanceof ArrayBuffer) || !(record.ciphertext instanceof ArrayBuffer) || record.nonce.byteLength !== NONCE_BYTES) throw new Error('An MLS vault record is malformed.')
    let bytes: Uint8Array | undefined
    try {
      const keys = await this.#cryptoKeys()
      bytes = new Uint8Array(await this.#crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce, additionalData: await this.#aad(purpose, persona) }, keys.seal, record.ciphertext))
      return JSON.parse(new TextDecoder().decode(bytes)) as T
    } catch { throw new Error('An MLS vault record could not be opened.') }
    finally { bytes?.fill(0) }
  }

  async #aad(purpose: Purpose, persona: string): Promise<ArrayBuffer> {
    const installation = purpose === 'installation' ? '' : await this.installation()
    return new TextEncoder().encode(`${AAD_PREFIX}|${purpose}|${persona}|${installation}|${RECORD_VERSION}`).buffer as ArrayBuffer
  }

  async #name(purpose: Purpose, persona: string): Promise<string> {
    const keys = await this.#cryptoKeys()
    const mac = await this.#crypto.subtle.sign('HMAC', keys.name, new TextEncoder().encode(`${AAD_PREFIX}|name|${purpose}|${persona}`))
    return bytesToHex(new Uint8Array(mac))
  }

  /** This browser profile's vault installation: 32 random bytes made with
   * the vault, sealed in it and never exported. Not Bothy's 0xF0B3. */
  installation(): Promise<string> {
    return this.#installation ??= (async () => {
      const existing = await this.#open<string>('installation', '')
      if (existing !== undefined) {
        if (!HEX64.test(existing)) throw new Error('The MLS vault installation is invalid.')
        return existing
      }
      return await this.#locked(async () => {
        const raced = await this.#open<string>('installation', '')
        if (raced !== undefined) return raced
        const id = new Uint8Array(32); this.#crypto.getRandomValues(id)
        const value = bytesToHex(id)
        await this.#seal('installation', '', value)
        return value
      })
    })().catch(error => { this.#installation = undefined; throw error })
  }

  #cryptoKeys(): Promise<{ seal: CryptoKey; name: CryptoKey }> {
    return this.#keys ??= (async () => {
      const existing = await this.storage.keys()
      if (existing) return existing
      return await this.#locked(async () => {
        const raced = await this.storage.keys()
        if (raced) return raced
        const seal = await this.#crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        const name = await this.#crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
        await this.storage.saveKeys({ seal, name })
        return { seal, name }
      })
    })().catch(error => { this.#keys = undefined; throw error })
  }
}

// ---- request shapes ----

function signRequestShape(value: unknown): VaultResult<SignLeafBindingRequest> {
  if (!plain(value)) return refuse('malformed')
  const keys = Object.keys(value).sort().join(',')
  if ('v' in value && value.v !== 1) return refuse('unsupported')
  if (keys !== 'body,digest,expires_at,operation,v') return refuse('malformed')
  const { operation, body, digest, expires_at } = value as Record<string, unknown>
  if (typeof operation !== 'string' || !HEX64.test(operation)) return refuse('malformed')
  if (typeof digest !== 'string' || !HEX64.test(digest)) return refuse('malformed')
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY_BASE64) return refuse('malformed')
  if (typeof expires_at !== 'number' || !Number.isSafeInteger(expires_at) || expires_at < 0) return refuse('malformed')
  return { ok: true, value: { v: 1, operation, body, digest, expires_at } }
}

function ecdhRequestShape(value: unknown): VaultResult<RendezvousEcdhRequest> {
  if (!plain(value)) return refuse('malformed')
  if ('v' in value && value.v !== 1) return refuse('unsupported')
  if (Object.keys(value).sort().join(',') !== 'expires_at,operation,peer_rz,v') return refuse('malformed')
  const { operation, peer_rz, expires_at } = value as Record<string, unknown>
  if (typeof operation !== 'string' || !HEX64.test(operation)) return refuse('malformed')
  if (typeof peer_rz !== 'string' || !HEX64.test(peer_rz)) return refuse('malformed')
  if (typeof expires_at !== 'number' || !Number.isSafeInteger(expires_at) || expires_at < 0) return refuse('malformed')
  return { ok: true, value: { v: 1, operation, peer_rz, expires_at } }
}

function scopeShape(scope: ConsentScope): boolean {
  return plain(scope) && typeof scope.principal === 'string' && scope.principal.length > 0 &&
    HEX64.test(scope.persona) && HEX64.test(scope.device) && HEX64.test(scope.homeBox) && scope.method === SIGN_METHOD
}

function sameScope(a: ConsentScope, b: ConsentScope): boolean {
  return a.principal === b.principal && a.persona === b.persona && a.device === b.device && a.homeBox === b.homeBox && a.method === b.method
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

const requestKey = (r: SignLeafBindingRequest): string => `${r.operation}|${r.digest}|${r.body}|${r.expires_at}`
const ecdhKey = (r: RendezvousEcdhRequest): string => `${r.operation}|${r.peer_rz}|${r.expires_at}`

/** Canonical padded base64 only: what decodes must re-encode identically. */
function base64Decode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return undefined
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0)) } catch { return undefined }
  let again = ''
  for (const b of bytes) again += String.fromCharCode(b)
  return btoa(again) === text ? bytes : undefined
}

export function base64Encode(bytes: Uint8Array): string {
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text)
}

function refusalOf(error: unknown): VaultRefusal {
  if (!(error instanceof BindingError)) return 'malformed'
  const code: BindingErrorCode = error.code
  switch (code) {
    case 'UnsupportedVersion': return 'unsupported'
    case 'CredentialRevoked': return 'revoked'
    case 'CredentialExpired': case 'BindingExpired': return 'expired'
    case 'CredentialNotPersonScoped': case 'CredentialWrongIdentity': case 'CredentialWrongDevice':
    case 'CredentialNotYetValid': case 'CredentialLifetimeTooLong': case 'BindingOutlivesCredential':
      return 'unauthorised'
    default: return 'malformed'
  }
}

function refuse(refusal: VaultRefusal): { ok: false; refusal: VaultRefusal } { return { ok: false, refusal } }

// ---- locks ----

function browserLocks(): VaultLocks | undefined {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  if (!locks) return undefined
  return { request: (name, work) => locks.request(name, { mode: 'exclusive' }, work) as ReturnType<typeof work> }
}

/** One tab, no Web Locks: a promise queue (tests, old browsers). */
export function localLocks(): VaultLocks {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    request<T>(_name: string, work: () => Promise<T>): Promise<T> {
      const next = queue.then(work, work)
      queue = next.then(() => undefined, () => undefined)
      return next
    },
  }
}

// ---- the browser store ----

/** IndexedDB holds the two non-extractable keys by structured clone and the
 * sealed records under HMAC names. */
export class BrowserMlsVaultStorage implements MlsVaultStorage {
  #db: Promise<IDBDatabase> | undefined
  constructor(private readonly dbName = 'kithmoot-mls-vault-v1', private readonly factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new Error('This browser does not provide encrypted MLS vault storage.')
  }
  async keys(): Promise<{ seal: CryptoKey; name: CryptoKey } | undefined> {
    const value = await request((await this.#transaction('keys', 'readonly')).objectStore('keys').get('vault'))
    return value?.seal && value?.name ? { seal: value.seal, name: value.name } : undefined
  }
  async saveKeys(keys: { seal: CryptoKey; name: CryptoKey }): Promise<void> {
    const transaction = await this.#transaction('keys', 'readwrite')
    transaction.objectStore('keys').put({ seal: keys.seal, name: keys.name }, 'vault'); await complete(transaction)
  }
  async get(name: string): Promise<SealedRecord | undefined> { return await request((await this.#transaction('records', 'readonly')).objectStore('records').get(name)) }
  async put(record: SealedRecord): Promise<void> {
    const transaction = await this.#transaction('records', 'readwrite')
    transaction.objectStore('records').put(record); await complete(transaction)
  }
  async remove(name: string): Promise<void> {
    const transaction = await this.#transaction('records', 'readwrite')
    transaction.objectStore('records').delete(name); await complete(transaction)
  }
  async #transaction(store: 'keys' | 'records', mode: IDBTransactionMode): Promise<IDBTransaction> { return (await this.#database()).transaction(store, mode) }
  #database(): Promise<IDBDatabase> {
    return this.#db ??= new Promise((resolve, reject) => {
      const open = this.factory.open(this.dbName, 1)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys')
        if (!open.result.objectStoreNames.contains('records')) open.result.createObjectStore('records', { keyPath: 'name' })
      }
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
  }
}

function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error) }) }
function complete(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error('An MLS vault transaction was aborted.')) }) }
