/** MIT. Portable encrypted context collections; no network or disk on import.
 * Storage uses the shared Wildbloom envelope. Identities are injected so a
 * browser signer, hardware signer or an agent's own key can use the same core.
 */
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import type { Event } from 'nostr-tools/pure'
import { verifyEventUncached } from './verify.js'
import { encryptEnvelope, decryptEnvelope, uploadEnvelope, normaliseBlossomServer } from './blossom.js'

export type ContextScope = 'personal' | 'kin' | 'kith'
export type ContextRole = 'read' | 'write'
export interface ContextIdentity {
  readonly pubkey: string
  signEvent(unsigned: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<Event>
  encrypt(recipient: string, plaintext: string): Promise<string>
  decrypt(sender: string, ciphertext: string): Promise<string>
}
export interface ContextGrant {
  subject: string
  role: ContextRole
  expiresAt: number
  /** Required for an agent. Ownership is not itself a context grant. */
  agent?: unknown
}
export interface ContextPolicy {
  v: 1
  collection: string
  owner: string
  title: string
  scope: ContextScope
  /** Required for room retrieval; personal collections have no room. */
  room?: string
  epoch: number
  grants: ContextGrant[]
}
export interface ContextRecord {
  id: string
  kind: 'fact' | 'decision' | 'task' | 'blocker' | 'question' | 'evidence'
  text: string
  source: string
  observedAt: number
  /** A correction retains the old signed record as evidence. */
  supersedes?: string
}
interface RecordBody extends ContextRecord { v: 1; collection: string; policy: Event }
interface Snapshot {
  v: 1; collection: string; policy: Event; revision: number; parent: string | null; ancestors: string[]; records: Event[]
}
export interface ContextPointer { url: string; sha256: string; size: number }
interface AccessBody { v: 1; policy: Event; key: string; head: string; pointer: ContextPointer }
interface StoredCollection { access: Event; envelope: string }
interface OpenCollection { policy: Event; snapshot: Event; key: string; envelope: Uint8Array; pointer?: ContextPointer }
export interface ContextView {
  id: string; owner: string; title: string; scope: ContextScope; room?: string; epoch: number
  head: string; revision: number; updatedAt: number; role: ContextRole; uploaded: boolean
  records: (ContextRecord & { author: string; event: string })[]
}

const KIND = 30078
const MAX_BYTES = 2 * 1024 * 1024
const MAX_RECORDS = 128
const MAX_COLLECTIONS = 32
const MAX_EVENT_BYTES = 1024 * 1024
const HEX = /^[0-9a-f]{64}$/
const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })
const id = () => bytesToHex(randomBytes(32))
function assert(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason) }
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid context object.')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
}
function seconds(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function parse(value: string, max = MAX_EVENT_BYTES): unknown {
  assert(enc.encode(value).length <= max, 'Context input is too large.')
  try { return JSON.parse(value) } catch { throw new Error('Invalid context JSON.') }
}
function event(value: unknown, purpose: string): Event {
  const e = object(value) as unknown as Event
  assert(enc.encode(JSON.stringify(e)).length <= MAX_EVENT_BYTES && verifyEventUncached(e), 'Invalid context signature.')
  assert(e.kind === KIND && e.tags.length === 1 && e.tags[0].length === 2 && e.tags[0][0] === 'd' && e.tags[0][1] === `kithmoot/context/v1/${purpose}`, 'Wrong context event domain.')
  return e
}
/** Application-supplied proof verifier. Omission refuses all delegation proofs.
 * The proof is opaque to the core. A verified principal is used only to enforce
 * owner-only delegation of personal collections; it never implies a grant. */
export type VerifyDelegation = (proof: unknown, options: { agent: string; now: number }) =>
  { ok: true; principal: string } | { ok: false }

function validators(verifyDelegation: VerifyDelegation = () => ({ ok: false })) {
  function policy(value: unknown): { event: Event; body: ContextPolicy } {
    const e = event(value, 'policy')
    const p = object(parse(e.content)) as unknown as ContextPolicy
    assert(p.v === 1 && HEX.test(p.collection) && p.owner === e.pubkey && text(p.title, 120), 'Invalid context policy.')
    assert(['personal', 'kin', 'kith'].includes(p.scope) && Number.isSafeInteger(p.epoch) && p.epoch > 0, 'Invalid context scope or epoch.')
    assert(p.room === undefined || HEX.test(p.room), 'Invalid context room.')
    assert(p.scope !== 'personal' || p.room === undefined, 'Personal context cannot belong to a room.')
    assert(Array.isArray(p.grants) && p.grants.length <= 32, 'Too many context grants.')
    const seen = new Set<string>()
    for (const g of p.grants) {
      assert(g && HEX.test(g.subject) && !seen.has(g.subject) && g.subject !== p.owner && ['read', 'write'].includes(g.role) && seconds(g.expiresAt), 'Invalid context grant.')
      seen.add(g.subject)
      const delegation = g.agent === undefined ? undefined : verifyDelegation(g.agent, { agent: g.subject, now: e.created_at })
      if (g.agent !== undefined) assert(delegation?.ok && HEX.test(delegation.principal), 'Invalid agent ownership proof.')
      assert(p.scope !== 'personal' || delegation?.ok && delegation.principal === p.owner, 'Personal context can only grant access to its owner’s agents.')
    }
    return { event: e, body: p }
  }
  function role(p: ContextPolicy, subject: string, at: number): ContextRole | undefined {
    if (subject === p.owner) return 'write'
    const g = p.grants.find(g => g.subject === subject && g.expiresAt > at)
    if (!g || g.agent !== undefined && !verifyDelegation(g.agent, { agent: g.subject, now: at }).ok) return undefined
    return g.role
  }
  function record(value: unknown, owner: string, collection: string): { event: Event; body: RecordBody } {
    const e = event(value, 'record')
    const r = object(parse(e.content)) as unknown as RecordBody
    const p = policy(r.policy)
    assert(e.created_at >= p.event.created_at, 'Record predates its grant.')
    assert(r.v === 1 && r.collection === collection && p.body.collection === collection && p.body.owner === owner, 'Record belongs to another collection.')
    assert(role(p.body, e.pubkey, e.created_at) === 'write', 'Record author has no write grant.')
    assert(HEX.test(r.id) && ['fact', 'decision', 'task', 'blocker', 'question', 'evidence'].includes(r.kind) && text(r.text, 4000) && text(r.source, 1000) && seconds(r.observedAt), 'Invalid context record.')
    assert(r.supersedes === undefined || HEX.test(r.supersedes), 'Invalid correction reference.')
    return { event: e, body: r }
  }
  function snapshot(value: unknown): { event: Event; body: Snapshot; policy: ContextPolicy } {
    const e = event(value, 'snapshot')
    const s = object(parse(e.content)) as unknown as Snapshot
    const signedPolicy = policy(s.policy)
    const p = signedPolicy.body
    assert(e.created_at >= signedPolicy.event.created_at, 'Snapshot predates its policy.')
    assert(s.v === 1 && s.collection === p.collection && Number.isSafeInteger(s.revision) && s.revision > 0, 'Invalid context snapshot.')
    assert(s.revision === 1 ? s.parent === null : typeof s.parent === 'string' && HEX.test(s.parent), 'Invalid snapshot parent.')
    assert(Array.isArray(s.ancestors) && s.ancestors.length < 256 && s.ancestors.length === s.revision - 1 && s.ancestors.every(a => HEX.test(a)) && new Set(s.ancestors).size === s.ancestors.length && (s.ancestors.at(-1) ?? null) === s.parent, 'Invalid context ancestry.')
    assert(role(p, e.pubkey, e.created_at) === 'write', 'Snapshot author has no write grant.')
    assert(Array.isArray(s.records) && s.records.length <= MAX_RECORDS, 'Too many context records.')
    const seen = new Set<string>()
    for (const item of s.records) {
      const r = record(item, p.owner, p.collection)
      const rp = policy(r.body.policy).body
      assert(r.event.created_at <= e.created_at && rp.epoch <= p.epoch && rp.scope === p.scope && rp.room === p.room, 'Record policy or timestamp does not match the collection.')
      assert(!seen.has(r.body.id), 'Duplicate context record.')
      if (r.body.supersedes) assert(seen.has(r.body.supersedes), 'Correction refers to an unknown record.')
      seen.add(r.body.id)
    }
    return { event: e, body: s, policy: p }
  }
  return { policy, role, record, snapshot }
}

function pointer(value: unknown): ContextPointer {
  const p = object(value) as unknown as ContextPointer
  assert(typeof p.url === 'string' && HEX.test(p.sha256) && Number.isSafeInteger(p.size) && p.size > 0 && p.size <= MAX_BYTES, 'Invalid encrypted context pointer.')
  const url = new URL(p.url)
  const origin = normaliseBlossomServer(url.origin)
  assert(url.origin === origin && url.href === p.url && !url.username && !url.password && !url.search && !url.hash &&
    new RegExp(`^/(?:[A-Za-z0-9_-]+/)*${p.sha256}(?:\\.[a-z0-9]{1,10})?$`).test(url.pathname), 'Context storage must use a canonical HTTPS hash URL.')
  return p
}
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(out)
}
function unbase64(value: string): Uint8Array {
  assert(typeof value === 'string' && value.length <= Math.ceil(MAX_BYTES * 4 / 3) + 4, 'Encrypted context cache is too large.')
  return Uint8Array.from(atob(value), ch => ch.charCodeAt(0))
}

export interface ContextVaultOptions {
  verifyDelegation?: VerifyDelegation
  identity: ContextIdentity
  /** Storage operations only contact origins the operator selected. */
  servers?: string[]
  fetch?: typeof fetch
  now?: () => number
  /** A room-bound adapter never exposes personal or other-room collections. */
  room?: string
}

export class ContextVault {
  readonly #checks: ReturnType<typeof validators>
  readonly #identity: ContextIdentity
  readonly #servers: Set<string>
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #room?: string
  readonly #collections = new Map<string, OpenCollection>()

  constructor(opts: ContextVaultOptions) {
    this.#checks = validators(opts.verifyDelegation)
    assert(HEX.test(opts.identity.pubkey), 'Invalid context identity.')
    assert(opts.room === undefined || HEX.test(opts.room), 'Invalid context room.')
    this.#identity = opts.identity
    this.#servers = new Set((opts.servers ?? []).map(normaliseBlossomServer))
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#room = opts.room
  }

  #visible(p: ContextPolicy): boolean {
    return !!this.#checks.role(p, this.#identity.pubkey, this.#now()) &&
      (this.#room === undefined || p.scope !== 'personal' && p.room === this.#room)
  }
  #get(collection: string): OpenCollection {
    const entry = this.#collections.get(collection)
    assert(entry && this.#visible(this.#checks.policy(entry.policy).body), 'Context collection not available.')
    return entry
  }
  async #sign(purpose: string, body: unknown): Promise<Event> {
    const unsigned = { kind: KIND, created_at: this.#now(), tags: [['d', `kithmoot/context/v1/${purpose}`]], content: JSON.stringify(body) }
    assert(enc.encode(unsigned.content).length < MAX_EVENT_BYTES, 'Context collection is full; create another collection.')
    const signed = await this.#identity.signEvent(unsigned)
    assert(signed.pubkey === this.#identity.pubkey && signed.content === unsigned.content && signed.created_at === unsigned.created_at && JSON.stringify(signed.tags) === JSON.stringify(unsigned.tags), 'Signer changed the context request.')
    return event(signed, purpose)
  }
  async #build(p: Event, records: Event[], previous?: OpenCollection, key = previous?.key ?? id()): Promise<OpenCollection> {
    const body = this.#checks.policy(p).body
    const before = previous && this.#checks.snapshot(previous.snapshot)
    const signed = await this.#sign('snapshot', { v: 1, collection: body.collection, policy: p,
      revision: (before?.body.revision ?? 0) + 1, parent: previous?.snapshot.id ?? null,
      ancestors: before ? [...before.body.ancestors, before.event.id] : [], records })
    this.#checks.snapshot(signed)
    const encrypted = encryptEnvelope(enc.encode(JSON.stringify(signed)), { name: 'context.json', type: 'application/json' }, { key: hexToBytes(key), maxSourceBytes: MAX_EVENT_BYTES })
    return { policy: p, snapshot: signed, key, envelope: encrypted.envelope }
  }

  async create(input: { title: string; scope: ContextScope; room?: string }): Promise<ContextView> {
    assert(this.#collections.size < MAX_COLLECTIONS, 'Context collection limit reached.')
    assert(this.#room === undefined || input.scope !== 'personal' && input.room === this.#room, 'A room adapter can only create context in its own room.')
    const collection = id()
    const p = await this.#sign('policy', { v: 1, collection, owner: this.#identity.pubkey, title: input.title, scope: input.scope, room: input.room, epoch: 1, grants: [] })
    const entry = await this.#build(p, [])
    this.#collections.set(collection, entry)
    return this.read(collection)
  }

  grants(collection: string): ContextGrant[] { return structuredClone(this.#checks.policy(this.#get(collection).policy).body.grants) }

  list(): Omit<ContextView, 'records'>[] {
    return [...this.#collections.values()].filter(e => this.#visible(this.#checks.policy(e.policy).body)).map(e => {
      const { records: _, ...view } = this.read(this.#checks.policy(e.policy).body.collection)
      return view
    })
  }
  read(collection: string, query = ''): ContextView {
    assert(query.length <= 500, 'Context query is too long.')
    const entry = this.#get(collection)
    const s = this.#checks.snapshot(entry.snapshot)
    const p = s.policy
    const rows = s.body.records.map(e => this.#checks.record(e, p.owner, p.collection))
    const replaced = new Set(rows.map(r => r.body.supersedes).filter(Boolean))
    const records = rows.filter(r => !replaced.has(r.body.id) && `${r.body.text}\n${r.body.source}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(({ event: e, body: r }) => ({
      id: r.id, kind: r.kind, text: r.text, source: r.source, observedAt: r.observedAt,
      ...(r.supersedes ? { supersedes: r.supersedes } : {}), author: e.pubkey, event: e.id,
    }))
    return { id: p.collection, owner: p.owner, title: p.title, scope: p.scope, ...(p.room ? { room: p.room } : {}), epoch: p.epoch,
      head: entry.snapshot.id, revision: s.body.revision, updatedAt: entry.snapshot.created_at,
      role: this.#checks.role(p, this.#identity.pubkey, this.#now())!, uploaded: !!entry.pointer, records }
  }

  async append(collection: string, expectedHead: string, input: Omit<ContextRecord, 'id'>): Promise<ContextView> {
    const before = this.#get(collection)
    assert(before.snapshot.id === expectedHead, 'Context changed; read the current head before writing.')
    const p = this.#checks.policy(before.policy).body
    assert(this.#checks.role(p, this.#identity.pubkey, this.#now()) === 'write', 'Context write permission required.')
    const r = await this.#sign('record', { v: 1, collection, policy: before.policy, kind: input.kind,
      text: input.text, source: input.source, observedAt: input.observedAt, supersedes: input.supersedes, id: id() })
    this.#checks.record(r, p.owner, collection)
    const next = await this.#build(before.policy, [...this.#checks.snapshot(before.snapshot).body.records, r], before)
    assert(this.#get(collection).snapshot.id === expectedHead, 'Context changed while signing; retry from the current head.')
    this.#collections.set(collection, next)
    return this.read(collection)
  }

  /** Owner-only policy change. Every change rotates the collection key. */
  async setGrants(collection: string, expectedHead: string, grants: ContextGrant[]): Promise<ContextView> {
    const before = this.#get(collection)
    const p = this.#checks.policy(before.policy).body
    assert(p.owner === this.#identity.pubkey, 'Only the collection owner can change grants.')
    assert(before.snapshot.id === expectedHead, 'Context changed; read the current head before changing grants.')
    const nextPolicy = await this.#sign('policy', { ...p, epoch: p.epoch + 1, grants })
    const next = await this.#build(nextPolicy, this.#checks.snapshot(before.snapshot).body.records, before, id())
    assert(this.#get(collection).snapshot.id === expectedHead, 'Context changed while signing; retry from the current head.')
    this.#collections.set(collection, next)
    return this.read(collection)
  }

  async upload(collection: string, server: string): Promise<ContextPointer> {
    const origin = normaliseBlossomServer(server)
    assert(this.#servers.has(origin), 'Context storage server is not enabled on this device.')
    const entry = this.#get(collection)
    assert(this.#checks.role(this.#checks.policy(entry.policy).body, this.#identity.pubkey, this.#now()) === 'write', 'Context write permission required to upload.')
    const descriptor = await uploadEnvelope(origin, entry.envelope, { sign: e => this.#identity.signEvent(e), fetch: this.#fetch, now: this.#now, signal: AbortSignal.timeout(15000) })
    const out = pointer({ url: descriptor.url, sha256: descriptor.sha256, size: descriptor.size })
    assert(this.#get(collection).snapshot.id === entry.snapshot.id, 'Context changed during upload; upload the current revision before sharing.')
    entry.pointer = out
    return out
  }

  async access(collection: string, recipient: string): Promise<Event> {
    const entry = this.#get(collection)
    assert(entry.pointer, 'Upload this context revision before sharing access.')
    return this.#access(entry, recipient, entry.pointer)
  }
  async #access(entry: OpenCollection, recipient: string, location: ContextPointer): Promise<Event> {
    const p = this.#checks.policy(entry.policy).body
    assert(this.#checks.role(p, this.#identity.pubkey, this.#now()) === 'write' && this.#checks.role(p, recipient, this.#now()), 'An active write grant and recipient grant are required to share access.')
    const body: AccessBody = { v: 1, policy: entry.policy, key: entry.key, head: entry.snapshot.id, pointer: location }
    const ciphertext = await this.#identity.encrypt(recipient, JSON.stringify(body))
    return this.#sign('access', { v: 1, recipient, ciphertext })
  }

  async #openAccess(input: unknown): Promise<{ body: AccessBody; access: Event }> {
    const access = event(input, 'access')
    const sealed = object(parse(access.content))
    assert(sealed.v === 1 && sealed.recipient === this.#identity.pubkey && text(sealed.ciphertext, 65536), 'Context collection not available.')
    const body = object(parse(await this.#identity.decrypt(access.pubkey, sealed.ciphertext as string))) as unknown as AccessBody
    const p = this.#checks.policy(body.policy).body
    assert(body.v === 1 && HEX.test(body.key) && HEX.test(body.head), 'Invalid context access.')
    assert(this.#visible(p) && this.#checks.role(p, access.pubkey, access.created_at) === 'write', 'Context collection not available.')
    assert(access.created_at >= body.policy.created_at && access.created_at <= this.#now() + 60, 'Invalid context access timestamp.')
    pointer(body.pointer)
    return { body, access }
  }

  /** Inspect a grant locally before consenting to a network fetch. */
  async previewAccess(input: unknown): Promise<{ collection: string; title: string; owner: string; scope: ContextScope; room?: string; server: string }> {
    const { body } = await this.#openAccess(input)
    const p = this.#checks.policy(body.policy).body
    return { collection: p.collection, title: p.title, owner: p.owner, scope: p.scope, room: p.room, server: new URL(body.pointer.url).origin }
  }
  async importAccess(input: unknown): Promise<ContextView> {
    const opened = await this.#openAccess(input)
    const location = opened.body.pointer
    assert(this.#servers.has(new URL(location.url).origin), 'Context storage server is not enabled on this device.')
    const response = await this.#fetch(location.url, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) })
    assert(response.ok && response.body, 'Encrypted context download failed.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.length
        assert(length <= location.size && length <= MAX_BYTES, 'Encrypted context download exceeded its signed size.')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const envelope = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { envelope.set(chunk, offset); offset += chunk.length }
    return this.#accept(opened.body, envelope)
  }

  #accept(body: AccessBody, envelope: Uint8Array): ContextView {
    assert(envelope.length === body.pointer.size && bytesToHex(sha256(envelope)) === body.pointer.sha256, 'Encrypted context hash or size mismatch.')
    const opened = decryptEnvelope(envelope, body.key)
    const s = this.#checks.snapshot(parse(dec.decode(opened.source)))
    assert(s.event.id === body.head && s.body.policy.id === body.policy.id, 'Context snapshot does not match the signed access.')
    const current = this.#collections.get(s.policy.collection)
    assert(s.event.created_at <= this.#now() + 60, 'Context snapshot is dated in the future.')
    assert(current || this.#collections.size < MAX_COLLECTIONS, 'Context collection limit reached.')
    if (current && current.snapshot.id !== s.event.id) {
      const previous = this.#checks.snapshot(current.snapshot)
      assert(s.policy.owner === previous.policy.owner && s.policy.epoch >= previous.policy.epoch, 'Context policy rollback refused.')
      assert(s.policy.scope === previous.policy.scope && s.policy.room === previous.policy.room && (s.policy.epoch !== previous.policy.epoch || s.body.policy.id === previous.body.policy.id), 'Context policy changed without a new epoch.')
      assert(s.body.ancestors[previous.body.revision - 1] === previous.event.id && previous.body.ancestors.every((a, i) => s.body.ancestors[i] === a), 'Context history conflict: keep both access files and reconcile from the current head.')
      assert(previous.body.records.every((r, i) => s.body.records[i]?.id === r.id), 'Context update removed signed history.')
    }
    this.#collections.set(s.policy.collection, { policy: s.body.policy, snapshot: s.event, key: body.key, envelope, pointer: body.pointer.url.startsWith('https://local.invalid/') ? undefined : body.pointer })
    return this.read(s.policy.collection)
  }

  /** The cache is encrypted to this identity. No plaintext record or key is saved. */
  async save(): Promise<string> {
    const collections: StoredCollection[] = []
    for (const entry of this.#collections.values()) {
      const p = this.#checks.policy(entry.policy).body
      if (!this.#visible(p)) continue
      const location = entry.pointer ?? { url: `https://local.invalid/${bytesToHex(sha256(entry.envelope))}`, sha256: bytesToHex(sha256(entry.envelope)), size: entry.envelope.length }
      const body: AccessBody = { v: 1, policy: entry.policy, key: entry.key, head: entry.snapshot.id, pointer: location }
      // Readers can cache their grant to themselves without gaining share rights.
      const ciphertext = await this.#identity.encrypt(this.#identity.pubkey, JSON.stringify(body))
      const access = await this.#sign('cache', { v: 1, recipient: this.#identity.pubkey, ciphertext })
      collections.push({ access, envelope: base64(entry.envelope) })
    }
    return JSON.stringify({ v: 1, identity: this.#identity.pubkey, collections })
  }
  async restore(serialised: string): Promise<void> {
    const saved = object(parse(serialised, 32 * MAX_BYTES))
    assert(saved.v === 1 && saved.identity === this.#identity.pubkey && Array.isArray(saved.collections) && saved.collections.length <= 32, 'Invalid encrypted context cache.')
    const previous = new Map(this.#collections)
    try { for (const value of saved.collections) {
      const stored = object(value) as unknown as StoredCollection
      const e = event(stored.access, 'cache')
      assert(e.pubkey === this.#identity.pubkey, 'Cache belongs to another identity.')
      const sealed = object(parse(e.content))
      assert(sealed.recipient === this.#identity.pubkey && text(sealed.ciphertext, 65536), 'Invalid encrypted context cache.')
      const body = object(parse(await this.#identity.decrypt(e.pubkey, sealed.ciphertext as string))) as unknown as AccessBody
      const p = this.#checks.policy(body.policy).body
      if (!this.#visible(p)) continue
      assert(body.v === 1 && HEX.test(body.key) && HEX.test(body.head), 'Invalid encrypted context cache.')
      pointer(body.pointer)
      this.#accept(body, unbase64(stored.envelope))
    } } catch (err) { this.#collections.clear(); for (const [id, entry] of previous) this.#collections.set(id, entry); throw err }
  }
}
