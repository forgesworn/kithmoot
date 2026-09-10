import type { Event } from 'nostr-tools/pure'
import { base64 } from '@scure/base'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { encryptEnvelope, decryptEnvelope } from './attachment.js'
import type { RelayTransport } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'
import { PROJECT_APP, PROJECT_WRAP_KIND, MAX_PROJECT_WRAP_BYTES, projectAuthority, projectForRecipient, projectId, projectKey,
  projectRecord, signProject, unwrapProject, wrapProject, type ProjectDefinition, type ProjectIdentity, type ProjectRecord, type ProjectReference } from './projects.js'

/** One writer must own a cache for the directory's lifetime. Browser adapters
 * use the same Web Locks boundary as the durable assignment journal. */
export interface ProjectDirectoryStorage {
  load(): Promise<string | undefined>
  save(encrypted: string): Promise<void>
}
export interface SharedProject extends ProjectReference {
  key: string
  heads: string[]
  revision: number
  definition?: ProjectDefinition
  authority?: string
  joined: boolean
  withdrawn: boolean
  conflicted: boolean
  pendingSends: number
}
export interface ProjectDirectorySnapshot {
  projects: SharedProject[]
  ready: boolean
  pendingSends: number
  error?: string
}
interface Pending { inner: Event; outer: Event; recipient: string }
interface Receipt { key: string; head: string; intent: string }
interface Cache { v: 1; events: Event[]; pending: Pending[]; requests: [string, Receipt][] }
const enc = new TextEncoder(), dec = new TextDecoder()
const MAX_CACHE_BYTES = 32 * 1024 * 1024
// Only call this for events already verified before insertion into private state.
const storedBody = (event: Event): ProjectRecord => JSON.parse(event.content) as ProjectRecord
const hash = (value: unknown) => bytesToHex(sha256(enc.encode(JSON.stringify(value))))
const recordRef = (event: Event, p: ProjectRecord): ProjectReference => ({ owner: p.op === 'follow' ? p.owner : event.pubkey, project: p.project })
const group = (event: Event, p: ProjectRecord) => `${p.op === 'follow' ? 'follow' : 'project'}:${projectKey(recordRef(event, p))}`
const intent = (ref: ProjectReference, op: 'snapshot' | 'follow', value: unknown, parents: string[]) => hash({ owner: ref.owner, project: ref.project, op, value, parents: [...parents].sort() })

/** Shared directory state and personal joins travel as separately signed,
 * encrypted records. No directory update joins a room or starts an agent. */
export class ProjectDirectory {
  #events = new Map<string, Event>()
  #pending = new Map<string, Pending>()
  #requests = new Map<string, Receipt>()
  #listeners = new Set<() => void>()
  #tail: Promise<unknown> = Promise.resolve()
  #key?: Uint8Array
  #sealedKey?: string
  #off?: () => void
  #ready = false
  #opened = false
  #closed = false
  #publishing = false
  #error?: string
  constructor(readonly options: { identity: ProjectIdentity; transport: RelayTransport; storage: ProjectDirectoryStorage; now?: () => number }) {}
  get identity(): string { return this.options.identity.pubkey }
  #now(): number { return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))() }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(fn); this.#tail = task.catch(() => {}); return task
  }
  onChange(fn: () => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn) }
  #emit(): void { for (const fn of this.#listeners) fn() }
  #fail(error: unknown): void { if (!this.#closed) { this.#error = error instanceof Error ? error.message : 'Projects could not be saved'; this.#emit() } }
  #groups(events = this.#events): Map<string, { event: Event; body: ProjectRecord }[]> {
    const groups = new Map<string, { event: Event; body: ProjectRecord }[]>()
    for (const event of events.values()) {
      const body = storedBody(event)
      const key = group(event, body), list = groups.get(key) ?? []
      list.push({ event, body }); groups.set(key, list)
    }
    return groups
  }
  snapshot(): ProjectDirectorySnapshot {
    const groups = this.#groups(), projects: SharedProject[] = []
    const pendingCounts = new Map<string, number>()
    for (const p of this.#pending.values()) { const key = projectKey(recordRef(p.inner, storedBody(p.inner))); pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1) }
    for (const [key, values] of groups) {
      if (!key.startsWith('project:')) continue
      const first = values[0]!, ref = recordRef(first.event, first.body), id = projectKey(ref)
      const follows = groups.get('follow:' + id) ?? []
      const one = values.length === 1 ? first.body : undefined
      const definition = one?.op === 'snapshot' ? structuredClone(one.definition) : undefined
      const withdrawn = one?.op === 'withdraw'
      projects.push({ ...ref, key: id, heads: values.map(v => v.event.id).sort(), revision: first.body.revision,
        ...(definition ? { definition, authority: projectAuthority(ref, definition) } : {}),
        joined: !withdrawn && values.length === 1 && (ref.owner === this.identity || follows.length === 1 && follows[0]!.body.op === 'follow' && follows[0]!.body.joined && follows[0]!.body.membership === definition?.members.find(m => m.pubkey === this.identity)?.epoch),
        withdrawn, conflicted: values.length > 1,
        pendingSends: pendingCounts.get(id) ?? 0,
      })
    }
    return { projects: projects.sort((a, b) => (a.definition?.name ?? a.key).localeCompare(b.definition?.name ?? b.key)), ready: this.#ready && !this.#closed && !this.#error,
      pendingSends: this.#pending.size, ...(this.#error ? { error: this.#error } : {}) }
  }
  #candidate(event: Event, events = this.#events): Map<string, Event> {
    const body = projectForRecipient(event, this.identity, this.#now())
    if (!body || events.has(event.id)) return events
    const key = group(event, body), values = this.#groups(events).get(key) ?? []
    const highest = values[0]?.body.revision ?? 0
    if (body.revision < highest || body.revision === highest && values.length >= 8) return events
    if (!values.length && new Set([...this.#groups(events).keys()].filter(k => k.startsWith('project:'))).size >= 128 && body.op !== 'follow') return events
    const result = new Map(events)
    if (body.revision > highest) for (const v of values) result.delete(v.event.id)
    result.set(event.id, structuredClone(event))
    return result
  }
  async open(): Promise<void> {
    if (this.#opened || this.#closed) throw new Error('Projects have already been opened or closed')
    this.#opened = true
    try {
      const raw = await this.options.storage.load()
      if (raw) {
        if (raw.length > MAX_CACHE_BYTES * 2) throw new Error('Project cache exceeds the size limit')
        const saved = JSON.parse(raw)
        if (saved.v !== 1 || saved.identity !== this.identity || typeof saved.key !== 'string' || saved.key.length > 4096 || typeof saved.body !== 'string') throw new Error('Project cache belongs to another identity or format')
        const key = await this.options.identity.decrypt(this.identity, saved.key)
        if (this.#closed) return
        if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid project cache key')
        this.#key = hexToBytes(key); this.#sealedKey = saved.key
        const opened = decryptEnvelope(base64.decode(saved.body), key)
        if (opened.source.length > MAX_CACHE_BYTES) throw new Error('Project cache exceeds the size limit')
        const cache = JSON.parse(dec.decode(opened.source)) as Cache
        if (cache.v !== 1 || !Array.isArray(cache.events) || cache.events.length > 2048 || !Array.isArray(cache.pending) || cache.pending.length > 1024 || !Array.isArray(cache.requests) || cache.requests.length > 4096) throw new Error('Invalid project cache')
        for (const event of cache.events) {
          if (!projectForRecipient(event, this.identity, this.#now())) throw new Error('Project cache failed signature or recipient verification')
          this.#events = this.#candidate(event)
        }
        for (const pending of cache.pending) {
          if (pending.inner.pubkey !== this.identity || !projectForRecipient(pending.inner, pending.recipient, this.#now()) ||
              pending.outer.kind !== PROJECT_WRAP_KIND || pending.outer.content.length > MAX_PROJECT_WRAP_BYTES ||
              JSON.stringify(pending.outer.tags) !== JSON.stringify([['p', pending.recipient], ['l', PROJECT_APP]]) || !verifyEventUncached(pending.outer)) throw new Error('Project outbox failed verification')
          this.#pending.set(pending.outer.id, pending)
        }
        for (const [request, receipt] of cache.requests) {
          if (!/^[a-zA-Z0-9_-]{16,80}$/.test(request) || !/^[0-9a-f]{64}$/.test(receipt.head) || !/^[0-9a-f]{64}$/.test(receipt.intent) || !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(receipt.key)) throw new Error('Invalid project request receipt')
          this.#requests.set(request, receipt)
        }
      }
      if (this.#closed) return
      this.#off = this.options.transport.subscribe([{ kinds: [PROJECT_WRAP_KIND], '#p': [this.identity], '#l': [PROJECT_APP] }], event => {
        void this.#serial(async () => {
          if (this.#closed) return
          const inner = await unwrapProject(event, this.options.identity, this.#now())
          if (!inner || this.#closed) return
          const events = this.#candidate(inner)
          if (events === this.#events) return
          await this.#save(events, this.#pending, this.#requests)
          if (this.#closed) return
          this.#events = events; this.#emit()
        }).catch(e => this.#fail(e))
      }, () => {
        void this.#serial(async () => { if (!this.#closed) { this.#ready = true; this.#emit() } }).catch(e => this.#fail(e))
      })
      this.#emit()
    } catch (e) { this.#fail(e); throw e }
  }
  async #save(events: Map<string, Event>, pending: Map<string, Pending>, requests: Map<string, Receipt>): Promise<void> {
    if (this.#closed) throw new Error('Projects are closed')
    this.#key ??= randomBytes(32)
    if (!this.#sealedKey) {
      const sealed = await this.options.identity.encrypt(this.identity, bytesToHex(this.#key))
      if (this.#closed || !this.#key) throw new Error('Projects closed while encrypting the cache')
      this.#sealedKey = sealed
    }
    if (pending.size > 1024 || requests.size > 4096) throw new Error('Project journal limit reached')
    const cache: Cache = { v: 1, events: [...events.values()], pending: [...pending.values()], requests: [...requests] }
    const sealed = encryptEnvelope(enc.encode(JSON.stringify(cache)), { name: 'kithmoot-projects.json', type: 'application/json' }, { key: this.#key, maxSourceBytes: MAX_CACHE_BYTES })
    await this.options.storage.save(JSON.stringify({ v: 1, identity: this.identity, key: this.#sealedKey, body: base64.encode(sealed.envelope) }))
  }
  #require(): void { if (!this.snapshot().ready) throw new Error(this.#error ?? 'Wait for project history to finish loading') }
  #receipt(request: string, intentHash: string): Receipt | undefined {
    const existing = this.#requests.get(request)
    if (existing && existing.intent !== intentHash) throw new Error('This request ID was used for a different project change')
    return existing
  }
  async create(definition: ProjectDefinition, request: string): Promise<Receipt> {
    const ref = { owner: this.identity, project: projectId(this.identity, request) }
    return this.#update(ref, [], definition, request, true)
  }
  async update(ref: ProjectReference, expectedHeads: string[], definition: ProjectDefinition, request: string): Promise<Receipt> {
    return this.#update(ref, expectedHeads, definition, request, false)
  }
  async #update(ref: ProjectReference, expectedHeads: string[], definition: ProjectDefinition, request: string, create: boolean): Promise<Receipt> {
    const receipt = await this.#serial(async () => {
      this.#require()
      if (ref.owner !== this.identity) throw new Error('Only the project owner can change its shared directory')
      const key = projectKey(ref), parents = [...expectedHeads].sort(), intentHash = intent(ref, 'snapshot', definition, parents)
      const existing = this.#receipt(request, intentHash); if (existing) return { ...existing }
      const current = this.snapshot().projects.find(p => p.key === key)
      if (create ? !!current || parents.length !== 0 : !current || JSON.stringify(current.heads) !== JSON.stringify(parents)) throw new Error('Project changed; review its current people and rooms before saving')
      const revision = (current?.revision ?? 0) + 1
      const previous = (this.#groups().get('project:' + key) ?? []).flatMap(v => v.body.op === 'snapshot' ? [v.body.definition] : [])
      const canonical = structuredClone(definition)
      canonical.members = canonical.members.map(member => {
        const prior = previous.map(d => d.members.find(m => m.pubkey === member.pubkey && m.kind === member.kind))
        const epoch = prior.length && prior.every(m => m && m.epoch === prior[0]!.epoch) ? prior[0]!.epoch : revision
        return { ...member, epoch }
      })
      const previousAuthorities = previous.map(d => projectAuthority(ref, d))
      const previousAuthority = previousAuthorities.length && previousAuthorities.every(a => a === previousAuthorities[0]) ? previousAuthorities[0] : undefined
      canonical.authorityRevision = previousAuthority ? previous[0]!.authorityRevision : revision
      // Validate before asking an external signer. Metadata-only updates keep
      // the authority revision; removal and re-addition can never revive it.
      if (!previousAuthority || projectAuthority(ref, canonical) !== previousAuthority) canonical.authorityRevision = revision
      projectAuthority(ref, canonical)
      const primary = await signProject(this.options.identity, { v: 1, op: 'snapshot', project: ref.project, revision, request, parents, definition: canonical }, this.#now())
      const previousMembers = new Set((this.#groups().get('project:' + key) ?? []).flatMap(v => v.body.op === 'snapshot' ? v.body.definition.members.map(m => m.pubkey) : []))
      const recipients = new Set(canonical.members.map(m => m.pubkey))
      const outgoing: Pending[] = [...recipients].map(recipient => ({ inner: primary, recipient, outer: wrapProject(primary, recipient, this.#now()) }))
      for (const recipient of previousMembers) {
        if (recipients.has(recipient)) continue
        const inner = await signProject(this.options.identity, { v: 1, op: 'withdraw', project: ref.project, revision, request, parents, recipient }, this.#now())
        outgoing.push({ inner, recipient, outer: wrapProject(inner, recipient, this.#now()) })
      }
      return this.#commit(primary, outgoing, request, { key, head: primary.id, intent: intentHash })
    })
    void this.retry(); return receipt
  }
  async follow(ref: ProjectReference, joined: boolean, expectedHeads: string[], request: string): Promise<Receipt> {
    const receipt = await this.#serial(async () => {
      this.#require()
      const key = projectKey(ref), intentHash = intent(ref, 'follow', joined, expectedHeads)
      const existing = this.#receipt(request, intentHash); if (existing) return { ...existing }
      const current = this.snapshot().projects.find(p => p.key === key)
      if (!current || current.withdrawn || current.conflicted || JSON.stringify(current.heads) !== JSON.stringify([...expectedHeads].sort())) throw new Error('The project invitation changed; review it again')
      const previous = this.#groups().get('follow:' + key) ?? []
      const primary = await signProject(this.options.identity, { v: 1, op: 'follow', owner: ref.owner, project: ref.project, joined, membership: current.definition!.members.find(m => m.pubkey === this.identity)!.epoch, invitation: current.heads[0]!,
        revision: (previous[0]?.body.revision ?? 0) + 1, parents: previous.map(v => v.event.id).sort(), request }, this.#now())
      return this.#commit(primary, [{ inner: primary, recipient: this.identity, outer: wrapProject(primary, this.identity, this.#now()) }], request, { key, head: primary.id, intent: intentHash })
    })
    void this.retry(); return receipt
  }
  async #commit(primary: Event, outgoing: Pending[], request: string, receipt: Receipt): Promise<Receipt> {
    if (this.#closed) throw new Error('Projects closed while signing')
    const body = storedBody(primary), target = group(primary, body)
    const events = this.#candidate(primary)
    if (!events.has(primary.id)) throw new Error('Project directory limit reached')
    const pending = new Map(this.#pending), requests = new Map(this.#requests).set(request, receipt)
    // Replace unsent older directory updates with the new authoritative state.
    // An in-flight old wrap may still arrive; recipients compare revisions.
    const recipients = new Set(outgoing.map(p => p.recipient))
    for (const [id, p] of pending) { const old = storedBody(p.inner); if (group(p.inner, old) === target && recipients.has(p.recipient)) pending.delete(id) }
    for (const p of outgoing) pending.set(p.outer.id, p)
    try { await this.#save(events, pending, requests) } catch (e) { this.#fail(e); throw e }
    if (this.#closed) throw new Error('Projects closed while saving')
    this.#events = events; this.#pending = pending; this.#requests = requests; this.#emit()
    return { ...receipt }
  }
  async retry(): Promise<void> {
    if (this.#publishing || this.#closed || !this.#ready || this.#error || !this.#pending.size) return
    this.#publishing = true
    try {
      const batch = [...this.#pending.values()]
      const accepted: string[] = []
      let failed = false
      for (let i = 0; i < batch.length && !this.#closed; i += 4) {
        const group = batch.slice(i, i + 4).filter(p => this.#pending.has(p.outer.id))
        const results = await Promise.allSettled(group.map(p => this.options.transport.publish(p.outer)))
        results.forEach((r, n) => { if (r.status === 'fulfilled') accepted.push(group[n]!.outer.id); else failed = true })
      }
      await this.#serial(async () => {
        if (this.#closed) return
        const pending = new Map(this.#pending)
        for (const id of accepted) pending.delete(id)
        await this.#save(this.#events, pending, this.#requests)
        this.#pending = pending; this.#emit()
      })
      if (!failed && !this.#closed && this.#pending.size) { this.#publishing = false; await this.retry() }
    } catch (e) { this.#fail(e) } finally { this.#publishing = false }
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true; this.#ready = false; this.#off?.(); this.#emit()
    await this.#tail
    this.#key?.fill(0); this.#key = undefined; this.#sealedKey = undefined
    this.#events.clear(); this.#pending.clear(); this.#requests.clear(); this.#listeners.clear()
  }
}
