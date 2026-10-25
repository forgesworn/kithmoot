import { nip44 } from 'nostr-tools'
import type { Event } from 'nostr-tools/pure'
import { base64 } from '@scure/base'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { hkdf } from '@noble/hashes/hkdf'
import { encryptEnvelope, decryptEnvelope } from './attachment.js'
import type { RelayTransport } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'
import { PROJECT_APP, PROJECT_WRAP_KIND, MAX_PROJECT_WRAP_BYTES, projectAuthority, projectForRecipient, projectId, projectKey,
  projectRecord, signProject, unwrapProject, wrapProject, type ProjectDefinition, type ProjectIdentity, type ProjectRecord, type ProjectReference } from './projects.js'
import { PROJECT_LOGO_APP, MAX_PROJECT_LOGO_WRAP_BYTES, projectLogoRecord, signProjectLogo, unwrapProjectLogo, wrapProjectLogo, type ProjectLogoContext, type ProjectLogoRecord } from './project-logo.js'
import type { LogoImage } from './logo-image.js'
import { shouldCompactJournal, type JournalImage, type JournalStorage } from './journal-storage.js'

/** One writer must own a cache for the directory's lifetime. Browser adapters
 * use the same Web Locks boundary as the durable assignment journal, and
 * capable adapters expose the incremental journal methods so routine
 * commits write encrypted deltas instead of replacing the whole cache. */
export interface ProjectDirectoryStorage extends JournalStorage {}
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
  logo?: LogoImage | null
  logoHeads?: string[]
  logoConflicted?: boolean
}
export interface ProjectDirectorySnapshot {
  projects: SharedProject[]
  ready: boolean
  pendingSends: number
  error?: string
}
interface Pending { inner: Event; outer: Event; recipient: string }
interface Receipt { key: string; head: string; intent: string }
interface Cache { v: 1; events: Event[]; pending: Pending[]; requests: [string, Receipt][];
  logoEvents?: Event[]; logoPending?: Pending[]; logoRequests?: [string, Receipt][]; logoWaiting?: Event[] }
/** The seven durable collections. Maps are replaced, never mutated in place,
 *  and every replacement carries the explicit put/remove that produced it. */
interface ProjectState {
  events: Map<string, Event>
  pending: Map<string, Pending>
  requests: Map<string, Receipt>
  logoEvents: Map<string, Event>
  logoPending: Map<string, Pending>
  logoRequests: Map<string, Receipt>
  logoWaiting: Map<string, Event>
}
interface CollectionChange<T> { remove: string[]; put: T[] }
interface ProjectMutation {
  events?: CollectionChange<Event>
  pending?: CollectionChange<Pending>
  requests?: CollectionChange<[string, Receipt]>
  logoEvents?: CollectionChange<Event>
  logoPending?: CollectionChange<Pending>
  logoRequests?: CollectionChange<[string, Receipt]>
  logoWaiting?: CollectionChange<Event>
}
/** Logical ids only (event id, outer wrap id, request id); the whole delta
 *  is NIP44-encrypted under a subkey of the cache key, so no id or record
 *  becomes visible as a storage key or in plaintext. */
interface ProjectDelta {
  v: 2
  remove?: Partial<Record<keyof ProjectState, string[]>>
  put?: Partial<Record<keyof ProjectState, unknown[]>>
}
interface EventGroupIndex {
  groups: Map<string, { event: Event; body: ProjectRecord }[]>
  projectCount: number
}
interface LogoGroupIndex {
  byProject: Map<string, Map<string, { event: Event; body: ProjectLogoRecord }[]>>
}
interface LoadedProjects {
  state: ProjectState
  eventIndex: EventGroupIndex
  logoIndex: LogoGroupIndex
  hasBase: boolean
  baseBytes: number
  baseRecordCount: number
  deltaBytes: number
  deltaMutations: number
}
const enc = new TextEncoder(), dec = new TextDecoder()
const utf8 = (value: string): number => enc.encode(value).byteLength
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const MAX_EVENTS = 2048
const MAX_PENDING = 1024
const MAX_REQUESTS = 4096
const MAX_LOGO_EVENTS = 1024
const MAX_LOGO_WAITING = 128
const MAX_PROJECTS = 128
const MAX_HEADS = 8
const REPLAY_RECORDS = 64
const REPLAY_BYTES = 1024 * 1024
const COLLECTIONS = ['events', 'pending', 'requests', 'logoEvents', 'logoPending', 'logoRequests', 'logoWaiting'] as const
type CollectionName = typeof COLLECTIONS[number]
const PROJECT_DELTA_KEY_INFO = 'kithmoot/v2/project-journal-delta'
const deriveProjectDeltaKey = (key: Uint8Array): Uint8Array => hkdf(sha256, key, undefined, PROJECT_DELTA_KEY_INFO, 32)
/** Every storage-format literal this module owns, frozen for
 *  `src/labels.test.ts`. Pure data - adding this export changes no runtime
 *  behaviour. */
export const PROJECT_DIRECTORY_LABELS = [
  "kithmoot/v2/project-journal-delta",
] as const
// Only call this for events already verified before insertion into private state.
const storedBody = (event: Event): ProjectRecord => JSON.parse(event.content) as ProjectRecord
const storedLogo = (event: Event): ProjectLogoRecord => JSON.parse(event.content) as ProjectLogoRecord
const logoRef = (event: Event): ProjectReference => ({ owner: event.pubkey, project: storedLogo(event).project })
const hash = (value: unknown) => bytesToHex(sha256(enc.encode(JSON.stringify(value))))
const recordRef = (event: Event, p: ProjectRecord): ProjectReference => ({ owner: p.op === 'follow' ? p.owner : event.pubkey, project: p.project })
const group = (event: Event, p: ProjectRecord) => `${p.op === 'follow' ? 'follow' : 'project'}:${projectKey(recordRef(event, p))}`
const intent = (ref: ProjectReference, op: 'snapshot' | 'follow', value: unknown, parents: string[]) => hash({ owner: ref.owner, project: ref.project, op, value, parents: [...parents].sort() })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Shared directory state and personal joins travel as separately signed,
 *  encrypted records. No directory update joins a room or starts an agent. */
export class ProjectDirectory {
  #events = new Map<string, Event>()
  #pending = new Map<string, Pending>()
  #requests = new Map<string, Receipt>()
  #logoEvents = new Map<string, Event>()
  #logoPending = new Map<string, Pending>()
  #logoRequests = new Map<string, Receipt>()
  #logoWaiting = new Map<string, Event>()
  // Parsed bodies and group/logo indexes are cached per event-map identity:
  // maps are replaced on every accepted change, so the identity is the
  // revision. #groups/#logoContext/#logosFor never rewalk O(events) per
  // candidate, project or snapshot.
  #bodies = new WeakMap<Event, ProjectRecord>()
  #logoBodies = new WeakMap<Event, ProjectLogoRecord>()
  #eventIndexes = new WeakMap<Map<string, Event>, EventGroupIndex>()
  #logoIndexes = new WeakMap<Map<string, Event>, LogoGroupIndex>()
  #listeners = new Set<() => void>()
  #tail: Promise<unknown> = Promise.resolve()
  #key?: Uint8Array
  #deltaKey?: Uint8Array
  #sealedKey?: string
  #off?: () => void
  #ready = false
  #opened = false
  #closed = false
  #publishing = false
  #incremental = false
  #error?: string
  #hasBase = false
  #baseBytes = 0
  #baseRecordCount = 0
  #deltaBytes = 0
  #deltaMutations = 0
  constructor(readonly options: {
    identity: ProjectIdentity; transport: RelayTransport; storage: ProjectDirectoryStorage; now?: () => number
    /** Also hands each wrap for someone else to where that person reads -
     *  their inbox relays - once the owner's own relays have it. Best effort:
     *  a member who shares a relay with the owner finds it there anyway. */
    deliver?: (wrap: Event, recipient: string) => Promise<void>
    /** Rechecks authority before each secondary-relay socket write. */
    deliverGuarded?: (wrap: Event, recipient: string, current: () => boolean) => Promise<void>
  }) {
    const incremental = options.storage.loadIncremental !== undefined
    if (typeof options.storage.loadIncremental !== 'function' && incremental) throw new Error('Invalid incremental project loader')
    const appending = options.storage.appendIncremental !== undefined
    if (typeof options.storage.appendIncremental !== 'function' && appending) throw new Error('Invalid incremental project appender')
    if (incremental !== appending) throw new Error('Incremental project storage requires both loadIncremental and appendIncremental')
    this.#incremental = incremental
  }
  get identity(): string { return this.options.identity.pubkey }
  #now(): number { return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))() }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(fn); this.#tail = task.catch(() => {}); return task
  }
  onChange(fn: () => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn) }
  #emit(): void { for (const fn of this.#listeners) fn() }
  #fail(error: unknown): void { if (!this.#closed) { this.#error = error instanceof Error ? error.message : 'Projects could not be saved'; this.#emit() } }
  #body(event: Event): ProjectRecord {
    let body = this.#bodies.get(event)
    if (!body) { body = storedBody(event); this.#bodies.set(event, body) }
    return body
  }
  #logoBody(event: Event): ProjectLogoRecord {
    let body = this.#logoBodies.get(event)
    if (!body) { body = storedLogo(event); this.#logoBodies.set(event, body) }
    return body
  }
  #indexFor(events: Map<string, Event>): EventGroupIndex {
    let cached = this.#eventIndexes.get(events)
    if (cached) return cached
    const groups = new Map<string, { event: Event; body: ProjectRecord }[]>()
    let projectCount = 0
    for (const event of events.values()) {
      const body = this.#body(event), key = group(event, body), list = groups.get(key)
      if (list) list.push({ event, body })
      else { groups.set(key, [{ event, body }]); if (key.startsWith('project:')) projectCount += 1 }
    }
    cached = { groups, projectCount }
    this.#eventIndexes.set(events, cached)
    return cached
  }
  #cloneEventIndex(index: EventGroupIndex): EventGroupIndex {
    return { groups: new Map([...index.groups].map(([key, list]) => [key, [...list]])), projectCount: index.projectCount }
  }
  #removeFromEventIndex(index: EventGroupIndex, event: Event): void {
    const key = group(event, this.#body(event)), list = index.groups.get(key)
    if (!list) return
    const next = list.filter(item => item.event.id !== event.id)
    if (next.length) index.groups.set(key, next)
    else { index.groups.delete(key); if (key.startsWith('project:')) index.projectCount -= 1 }
  }
  #logoIndexFor(logos: Map<string, Event>): LogoGroupIndex {
    let cached = this.#logoIndexes.get(logos)
    if (cached) return cached
    const byProject = new Map<string, Map<string, { event: Event; body: ProjectLogoRecord }[]>>()
    for (const event of logos.values()) {
      const body = this.#logoBody(event), project = `${event.pubkey}:${body.project}`
      let authorities = byProject.get(project)
      if (!authorities) { authorities = new Map(); byProject.set(project, authorities) }
      const list = authorities.get(body.authority) ?? []
      list.push({ event, body })
      authorities.set(body.authority, list)
    }
    cached = { byProject }
    this.#logoIndexes.set(logos, cached)
    return cached
  }
  #cloneLogoIndex(index: LogoGroupIndex): LogoGroupIndex {
    return { byProject: new Map([...index.byProject].map(([project, authorities]) => [project, new Map([...authorities].map(([authority, list]) => [authority, [...list]]))])) }
  }
  #removeFromLogoIndex(index: LogoGroupIndex, event: Event): void {
    const body = this.#logoBody(event), project = `${event.pubkey}:${body.project}`
    const authorities = index.byProject.get(project), list = authorities?.get(body.authority)
    if (!authorities || !list) return
    const next = list.filter(item => item.event.id !== event.id)
    if (next.length) authorities.set(body.authority, next)
    else { authorities.delete(body.authority); if (!authorities.size) index.byProject.delete(project) }
  }
  /** Applies the acceptance rules to mutable maps and their indexes,
   *  returning the superseded ids, or undefined when the event is not
   *  accepted. Deletes happen before the caller's put, matching the delta
   *  replay order. */
  #applyCandidate(event: Event, events: Map<string, Event>, index: EventGroupIndex): string[] | undefined {
    const body = projectForRecipient(event, this.identity, this.#now())
    if (!body || events.has(event.id)) return undefined
    const key = group(event, body), values = index.groups.get(key) ?? []
    const highest = values[0]?.body.revision ?? 0
    if (body.revision < highest || body.revision === highest && values.length >= MAX_HEADS) return undefined
    if (!values.length && index.projectCount >= MAX_PROJECTS && body.op !== 'follow') return undefined
    let removed: string[] = []
    if (values.length && body.revision > highest) {
      removed = values.map(v => v.event.id)
      for (const id of removed) events.delete(id)
      index.groups.delete(key)
      if (key.startsWith('project:')) index.projectCount -= 1
    }
    const clone = structuredClone(event)
    events.set(event.id, clone)
    const list = index.groups.get(key) ?? []
    index.groups.set(key, [...list, { event: clone, body }])
    if (!list.length && key.startsWith('project:')) index.projectCount += 1
    return removed
  }
  #applyLogoCandidate(event: Event, events: Map<string, Event>, logos: Map<string, Event>, index: LogoGroupIndex): string[] | undefined {
    let ref: ProjectReference
    try { ref = logoRef(event) } catch { return undefined }
    const context = this.#logoContext(ref, events), body = context && projectLogoRecord(event, context, this.#now())
    if (!body || logos.has(event.id)) return undefined
    const project = `${ref.owner}:${ref.project}`
    const list = index.byProject.get(project)?.get(body.authority) ?? []
    const highest = list[0] ? list[0].body.version : 0
    if (body.version < highest || body.version === highest && list.length >= MAX_HEADS) return undefined
    let removed: string[] = []
    if (body.version > highest) {
      const stale = index.byProject.get(project)
      if (stale) {
        index.byProject.delete(project)
        for (const entries of stale.values()) for (const entry of entries) { logos.delete(entry.event.id); removed.push(entry.event.id) }
      }
    }
    const clone = structuredClone(event)
    logos.set(event.id, clone)
    const authorities = index.byProject.get(project) ?? new Map()
    const next = authorities.get(body.authority) ?? []
    next.push({ event: clone, body })
    authorities.set(body.authority, next)
    index.byProject.set(project, authorities)
    return removed
  }
  snapshot(): ProjectDirectorySnapshot {
    const groups = this.#indexFor(this.#events).groups, projects: SharedProject[] = []
    const pendingCounts = new Map<string, number>()
    for (const p of this.#pending.values()) { const key = projectKey(recordRef(p.inner, this.#body(p.inner))); pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1) }
    for (const p of this.#logoPending.values()) { const key = projectKey(logoRef(p.inner)); pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1) }
    for (const [key, values] of groups) {
      if (!key.startsWith('project:')) continue
      const first = values[0]!, ref = recordRef(first.event, first.body), id = projectKey(ref)
      const follows = groups.get('follow:' + id) ?? []
      const one = values.length === 1 ? first.body : undefined
      const definition = one?.op === 'snapshot' ? structuredClone(one.definition) : undefined
      const withdrawn = one?.op === 'withdraw'
      const logos = this.#logosFor(ref), logoHeads = logos.map(event => event.id).sort()
      projects.push({ ...ref, key: id, heads: values.map(v => v.event.id).sort(), revision: first.body.revision,
        ...(definition ? { definition, authority: projectAuthority(ref, definition) } : {}),
        joined: !withdrawn && values.length === 1 && (ref.owner === this.identity || follows.length === 1 && follows[0]!.body.op === 'follow' && follows[0]!.body.joined && follows[0]!.body.membership === definition?.members.find(m => m.pubkey === this.identity)?.epoch),
        withdrawn, conflicted: values.length > 1,
        pendingSends: pendingCounts.get(id) ?? 0,
        logoHeads, logoConflicted: logos.length > 1,
        ...(logos.length === 1 && definition && !definition.archived ? { logo: structuredClone(this.#logoBody(logos[0]!).image) } : {}),
      })
    }
    return { projects: projects.sort((a, b) => (a.definition?.name ?? a.key).localeCompare(b.definition?.name ?? b.key)), ready: this.#ready && !this.#closed && !this.#error,
      pendingSends: this.#pending.size + this.#logoPending.size, ...(this.#error ? { error: this.#error } : {}) }
  }
  #logoContext(ref: ProjectReference, events = this.#events): ProjectLogoContext | undefined {
    const values = this.#indexFor(events).groups.get('project:' + projectKey(ref))
    const body = values?.length === 1 ? values[0]!.body : undefined
    if (body?.op !== 'snapshot' || !body.definition.members.some(member => member.pubkey === this.identity)) return
    return { reference: ref, definition: body.definition }
  }
  #logosFor(ref: ProjectReference, events = this.#events, logos = this.#logoEvents): Event[] {
    const context = this.#logoContext(ref, events)
    if (!context) return []
    const authority = projectAuthority(ref, context.definition)
    return [...(this.#logoIndexFor(logos).byProject.get(`${ref.owner}:${ref.project}`)?.get(authority) ?? [])].map(item => item.event)
  }
  #logoOuter(event: Event): boolean {
    return event.kind === PROJECT_WRAP_KIND && typeof event.content === 'string' && event.content.length <= MAX_PROJECT_LOGO_WRAP_BYTES &&
      Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= this.#now() + 60 &&
      JSON.stringify(event.tags) === JSON.stringify([['p', this.identity], ['l', PROJECT_LOGO_APP]]) && verifyEventUncached(event)
  }
  async #drainLogoWaiting(): Promise<void> {
    const groups = this.#indexFor(this.#events).groups
    const contexts = [...groups].flatMap(([key, values]) => key.startsWith('project:') && values.length === 1 && values[0]!.body.op === 'snapshot'
      ? [this.#logoContext(recordRef(values[0]!.event, values[0]!.body))].filter((value): value is ProjectLogoContext => !!value) : [])
    if (!contexts.length || !this.#logoWaiting.size) return
    const logos = new Map(this.#logoEvents)
    const logoIndex = this.#cloneLogoIndex(this.#logoIndexFor(this.#logoEvents))
    const waiting = new Map(this.#logoWaiting)
    const logoPut: Event[] = [], logoRemove: string[] = [], waitingRemove: string[] = []
    for (const [id, wrap] of waiting) {
      const inner = await unwrapProjectLogo(wrap, this.options.identity, contexts, this.#now())
      if (this.#closed) return
      // An unknown project may arrive after its companion. Keep its bounded
      // encrypted wrap for the next directory change rather than guessing.
      if (!inner) continue
      waiting.delete(id); waitingRemove.push(id)
      const removed = this.#applyLogoCandidate(inner, this.#events, logos, logoIndex)
      if (removed === undefined) continue
      logoRemove.push(...removed)
      logoPut.push(logos.get(inner.id)!)
    }
    if (waiting.size === this.#logoWaiting.size && !logoPut.length) return
    const pending = this.#pruneLogoPending(this.#events, logos)
    const pendingRemove = [...this.#logoPending.keys()].filter(id => !pending.has(id))
    const mutation: ProjectMutation = {}
    if (logoRemove.length || logoPut.length) mutation.logoEvents = { remove: logoRemove, put: logoPut }
    if (pendingRemove.length) mutation.logoPending = { remove: pendingRemove, put: [] }
    if (waitingRemove.length) mutation.logoWaiting = { remove: waitingRemove, put: [] }
    await this.#save(this.#state({ logoEvents: logos, logoPending: pending, logoWaiting: waiting }), mutation)
    if (this.#closed) return
    this.#logoIndexes.set(logos, logoIndex)
    this.#logoEvents = logos; this.#logoPending = pending; this.#logoWaiting = waiting; this.#emit()
  }
  #state(overrides: Partial<ProjectState> = {}): ProjectState {
    return { events: this.#events, pending: this.#pending, requests: this.#requests, logoEvents: this.#logoEvents,
      logoPending: this.#logoPending, logoRequests: this.#logoRequests, logoWaiting: this.#logoWaiting, ...overrides }
  }
  #validateReceipt(request: unknown, receipt: unknown, message: string): void {
    const value = receipt as Receipt
    if (typeof request !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(request) || !object(value) ||
        !/^[0-9a-f]{64}$/.test(value.head) || !/^[0-9a-f]{64}$/.test(value.intent) || !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(value.key)) throw new Error(message)
  }
  #applyCache(cache: Cache, state: ProjectState, eventIndex: EventGroupIndex, logoIndex: LogoGroupIndex): void {
    if (cache.v !== 1 || !Array.isArray(cache.events) || cache.events.length > MAX_EVENTS || !Array.isArray(cache.pending) || cache.pending.length > MAX_PENDING ||
        !Array.isArray(cache.requests) || cache.requests.length > MAX_REQUESTS) throw new Error('Invalid project cache')
    for (const event of cache.events) {
      if (!projectForRecipient(event, this.identity, this.#now())) throw new Error('Project cache failed signature or recipient verification')
      this.#applyCandidate(event, state.events, eventIndex)
    }
    for (const pending of cache.pending) {
      if (pending.inner.pubkey !== this.identity || !projectForRecipient(pending.inner, pending.recipient, this.#now()) ||
          pending.outer.kind !== PROJECT_WRAP_KIND || pending.outer.content.length > MAX_PROJECT_WRAP_BYTES ||
          JSON.stringify(pending.outer.tags) !== JSON.stringify([['p', pending.recipient], ['l', PROJECT_APP]]) || !verifyEventUncached(pending.outer)) throw new Error('Project outbox failed verification')
      state.pending.set(pending.outer.id, pending)
    }
    for (const [request, receipt] of cache.requests) {
      this.#validateReceipt(request, receipt, 'Invalid project request receipt')
      state.requests.set(request, receipt)
    }
    for (const name of ['logoEvents', 'logoPending', 'logoRequests', 'logoWaiting'] as const) {
      const value = cache[name]
      if (value !== undefined && (!Array.isArray(value) || value.length > (name === 'logoRequests' ? MAX_REQUESTS : name === 'logoWaiting' ? MAX_LOGO_WAITING : MAX_PENDING))) throw new Error('Invalid project logo journal')
    }
    for (const event of cache.logoEvents ?? []) {
      if (!verifyEventUncached(event)) throw new Error('Project logo cache failed signature verification')
      this.#applyLogoCandidate(event, state.events, state.logoEvents, logoIndex)
    }
    for (const pending of cache.logoPending ?? []) {
      if (pending.inner.pubkey !== this.identity || !verifyEventUncached(pending.inner) ||
          pending.outer.kind !== PROJECT_WRAP_KIND || pending.outer.content.length > MAX_PROJECT_LOGO_WRAP_BYTES ||
          JSON.stringify(pending.outer.tags) !== JSON.stringify([['p', pending.recipient], ['l', PROJECT_LOGO_APP]]) || !verifyEventUncached(pending.outer)) throw new Error('Project logo outbox failed verification')
      const context = this.#logoContext(logoRef(pending.inner), state.events)
      if (state.logoEvents.has(pending.inner.id) && context && projectLogoRecord(pending.inner, context, this.#now()) && context.definition.members.some(member => member.pubkey === pending.recipient)) state.logoPending.set(pending.outer.id, pending)
    }
    for (const [request, receipt] of cache.logoRequests ?? []) {
      this.#validateReceipt(request, receipt, 'Invalid project logo request receipt')
      state.logoRequests.set(request, receipt)
    }
    for (const event of cache.logoWaiting ?? []) {
      if (!this.#logoOuter(event)) throw new Error('Invalid waiting project logo envelope')
      state.logoWaiting.set(event.id, event)
    }
  }
  #applyDelta(delta: unknown, state: ProjectState, eventIndex: EventGroupIndex, logoIndex: LogoGroupIndex): number {
    if (!object(delta) || delta.v !== 2 || Object.keys(delta).some(key => !['v', 'remove', 'put'].includes(key))) throw new Error('Invalid project journal delta')
    const remove = delta.remove, put = delta.put
    const removeIds: Partial<Record<CollectionName, string[]>> = {}
    const putRecords: Partial<Record<CollectionName, unknown[]>> = {}
    let mutations = 0
    for (const source of [{ value: remove, label: 'remove' as const }, { value: put, label: 'put' as const }]) {
      if (source.value === undefined) continue
      if (!object(source.value) || Object.keys(source.value).some(name => !(COLLECTIONS as readonly string[]).includes(name))) throw new Error('Invalid project journal delta')
      for (const [name, records] of Object.entries(source.value)) {
        if (!Array.isArray(records)) throw new Error('Invalid project journal delta')
        if (source.label === 'remove' && records.some(id => typeof id !== 'string')) throw new Error('Invalid project journal delta')
        mutations += records.length
        if (source.label === 'remove') removeIds[name as CollectionName] = records as string[]
        else putRecords[name as CollectionName] = records
      }
    }
    if (!mutations) throw new Error('Invalid project journal delta')
    // Deletes before puts, matching the replacement/eviction order the
    // writer used when it produced the delta.
    for (const name of COLLECTIONS) {
      const ids = removeIds[name]
      if (!ids?.length) continue
      if (name === 'events') for (const id of ids) { const event = state.events.get(id); if (event) { state.events.delete(id); this.#removeFromEventIndex(eventIndex, event) } }
      else if (name === 'logoEvents') for (const id of ids) { const event = state.logoEvents.get(id); if (event) { state.logoEvents.delete(id); this.#removeFromLogoIndex(logoIndex, event) } }
      else if (name === 'pending') for (const id of ids) state.pending.delete(id)
      else if (name === 'requests') for (const id of ids) state.requests.delete(id)
      else if (name === 'logoPending') for (const id of ids) state.logoPending.delete(id)
      else if (name === 'logoRequests') for (const id of ids) state.logoRequests.delete(id)
      else for (const id of ids) state.logoWaiting.delete(id)
    }
    for (const name of COLLECTIONS) {
      const records = putRecords[name]
      if (!records?.length) continue
      if (name === 'events') for (const record of records) {
        if (!this.#applyCandidate(record as Event, state.events, eventIndex)) throw new Error('Invalid project journal delta')
      } else if (name === 'pending') for (const record of records) {
        const pending = record as Pending
        if (pending.inner.pubkey !== this.identity || !projectForRecipient(pending.inner, pending.recipient, this.#now()) ||
            pending.outer.kind !== PROJECT_WRAP_KIND || pending.outer.content.length > MAX_PROJECT_WRAP_BYTES ||
            JSON.stringify(pending.outer.tags) !== JSON.stringify([['p', pending.recipient], ['l', PROJECT_APP]]) || !verifyEventUncached(pending.outer)) throw new Error('Project outbox failed verification')
        state.pending.set(pending.outer.id, pending)
      } else if (name === 'requests') for (const record of records) {
        const [request, receipt] = record as [string, Receipt]
        this.#validateReceipt(request, receipt, 'Invalid project request receipt')
        state.requests.set(request, receipt)
      } else if (name === 'logoEvents') for (const record of records) {
        const event = record as Event
        if (!verifyEventUncached(event) || this.#applyLogoCandidate(event, state.events, state.logoEvents, logoIndex) === undefined) throw new Error('Invalid project journal delta')
      } else if (name === 'logoPending') for (const record of records) {
        const pending = record as Pending
        if (pending.inner.pubkey !== this.identity || !verifyEventUncached(pending.inner) ||
            pending.outer.kind !== PROJECT_WRAP_KIND || pending.outer.content.length > MAX_PROJECT_LOGO_WRAP_BYTES ||
            JSON.stringify(pending.outer.tags) !== JSON.stringify([['p', pending.recipient], ['l', PROJECT_LOGO_APP]]) || !verifyEventUncached(pending.outer)) throw new Error('Project logo outbox failed verification')
        const context = this.#logoContext(logoRef(pending.inner), state.events)
        if (state.logoEvents.has(pending.inner.id) && context && projectLogoRecord(pending.inner, context, this.#now()) && context.definition.members.some(member => member.pubkey === pending.recipient)) state.logoPending.set(pending.outer.id, pending)
      } else if (name === 'logoRequests') for (const record of records) {
        const [request, receipt] = record as [string, Receipt]
        this.#validateReceipt(request, receipt, 'Invalid project logo request receipt')
        state.logoRequests.set(request, receipt)
      } else for (const record of records) {
        const event = record as Event
        if (!this.#logoOuter(event)) throw new Error('Invalid waiting project logo envelope')
        state.logoWaiting.set(event.id, event)
      }
    }
    if (state.events.size > MAX_EVENTS || state.pending.size > MAX_PENDING || state.requests.size > MAX_REQUESTS || state.logoEvents.size > MAX_LOGO_EVENTS ||
        state.logoPending.size > MAX_PENDING || state.logoRequests.size > MAX_REQUESTS || state.logoWaiting.size > MAX_LOGO_WAITING) throw new Error('Invalid project cache')
    return mutations
  }
  async #image(): Promise<JournalImage> {
    const image: JournalImage = this.#incremental
      ? await this.options.storage.loadIncremental!()
      : { base: await this.options.storage.load(), deltas: [] }
    if (!object(image) || (image.base !== undefined && typeof image.base !== 'string') ||
        !Array.isArray(image.deltas) || image.deltas.length > 4096 || image.deltas.some(delta => typeof delta !== 'string')) throw new Error('Invalid project journal')
    return image
  }
  async #loadStored(): Promise<LoadedProjects | undefined> {
    const image = await this.#image()
    const state: ProjectState = { events: new Map(), pending: new Map(), requests: new Map(), logoEvents: new Map(), logoPending: new Map(), logoRequests: new Map(), logoWaiting: new Map() }
    const eventIndex: EventGroupIndex = { groups: new Map(), projectCount: 0 }
    const logoIndex: LogoGroupIndex = { byProject: new Map() }
    let hasBase = false, baseBytes = 0, baseRecordCount = 0
    if (image.base !== undefined && (image.base.length > 0 || image.deltas.length === 0)) {
      if (image.base.length > MAX_CACHE_BYTES * 2) throw new Error('Project cache exceeds the size limit')
      const saved = JSON.parse(image.base)
      if (saved.v !== 1 || saved.identity !== this.identity || typeof saved.key !== 'string' || saved.key.length > 4096 || typeof saved.body !== 'string') throw new Error('Project cache belongs to another identity or format')
      const key = await this.options.identity.decrypt(this.identity, saved.key)
      if (this.#closed) return undefined
      if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid project cache key')
      this.#key = hexToBytes(key); this.#sealedKey = saved.key; this.#deltaKey = deriveProjectDeltaKey(this.#key)
      const opened = decryptEnvelope(base64.decode(saved.body), key)
      if (opened.source.length > MAX_CACHE_BYTES) throw new Error('Project cache exceeds the size limit')
      this.#applyCache(JSON.parse(dec.decode(opened.source)) as Cache, state, eventIndex, logoIndex)
      hasBase = true; baseBytes = utf8(image.base)
      baseRecordCount = state.events.size + state.pending.size + state.requests.size + state.logoEvents.size + state.logoPending.size + state.logoRequests.size + state.logoWaiting.size
    }
    let deltaBytes = 0, deltaMutations = 0
    for (const raw of image.deltas) {
      if (!this.#deltaKey) throw new Error('Invalid project journal delta')
      let plaintext: string
      try { plaintext = nip44.v2.decrypt(raw, this.#deltaKey) } catch { throw new Error('Invalid project journal delta') }
      if (plaintext.length > MAX_CACHE_BYTES) throw new Error('Project cache exceeds the size limit')
      let delta: unknown
      try { delta = JSON.parse(plaintext) } catch { throw new Error('Invalid project journal delta') }
      deltaMutations += this.#applyDelta(delta, state, eventIndex, logoIndex)
      deltaBytes += utf8(raw)
    }
    return { state, eventIndex, logoIndex, hasBase, baseBytes, baseRecordCount, deltaBytes, deltaMutations }
  }
  async open(): Promise<void> {
    if (this.#opened || this.#closed) throw new Error('Projects have already been opened or closed')
    this.#opened = true
    try {
      const loaded = await this.#loadStored()
      if (this.#closed || !loaded) return
      this.#events = loaded.state.events; this.#pending = loaded.state.pending; this.#requests = loaded.state.requests
      this.#logoEvents = loaded.state.logoEvents; this.#logoPending = loaded.state.logoPending; this.#logoRequests = loaded.state.logoRequests; this.#logoWaiting = loaded.state.logoWaiting
      this.#eventIndexes.set(this.#events, loaded.eventIndex); this.#logoIndexes.set(this.#logoEvents, loaded.logoIndex)
      this.#hasBase = loaded.hasBase; this.#baseBytes = loaded.baseBytes; this.#baseRecordCount = loaded.baseRecordCount
      this.#deltaBytes = loaded.deltaBytes; this.#deltaMutations = loaded.deltaMutations
      if (this.#closed) return
      let historical = true
      let staged: { event?: Event; wrap?: Event }[] = []
      let stagedIds = new Set<string>()
      let stagedBytes = 0
      const clearStaged = () => { staged = []; stagedIds = new Set(); stagedBytes = 0 }
      // Historical replay stages verified events into bounded batches and
      // persists one delta per batch before merging it into live state.
      // After EOSE every accepted event is durable before it is exposed.
      const flush = async (): Promise<void> => {
        if (this.#closed) { clearStaged(); return }
        if (!staged.length) return
        const batch = staged; clearStaged()
        const events = new Map(this.#events)
        const eventIndex = this.#cloneEventIndex(this.#indexFor(this.#events))
        const logoWaiting = new Map(this.#logoWaiting)
        const eventsPut: Event[] = [], eventsRemove: string[] = [], waitingPut = new Map<string, Event>(), waitingRemove: string[] = []
        for (const item of batch) {
          if (item.wrap) {
            if (logoWaiting.has(item.wrap.id)) continue
            logoWaiting.set(item.wrap.id, item.wrap)
            waitingPut.set(item.wrap.id, item.wrap)
            continue
          }
          const removed = this.#applyCandidate(item.event!, events, eventIndex)
          if (removed === undefined) continue
          eventsRemove.push(...removed)
          eventsPut.push(events.get(item.event!.id)!)
        }
        while (logoWaiting.size > MAX_LOGO_WAITING) {
          const oldest = logoWaiting.keys().next().value!
          logoWaiting.delete(oldest)
          if (!waitingPut.delete(oldest)) waitingRemove.push(oldest)
        }
        const mutation: ProjectMutation = {}
        if (eventsRemove.length || eventsPut.length) mutation.events = { remove: eventsRemove, put: eventsPut }
        if (waitingRemove.length || waitingPut.size) mutation.logoWaiting = { remove: waitingRemove, put: [...waitingPut.values()] }
        if (!mutation.events && !mutation.logoWaiting) return
        await this.#save(this.#state({ events, logoWaiting }), mutation)
        if (this.#closed) return
        this.#eventIndexes.set(events, eventIndex)
        this.#events = events; this.#logoWaiting = logoWaiting; this.#emit()
      }
      const stage = async (item: { event?: Event; wrap?: Event }, bytes: number): Promise<void> => {
        if (staged.length && (staged.length >= REPLAY_RECORDS || stagedBytes + bytes > REPLAY_BYTES)) await flush()
        if (this.#closed || stagedIds.has(item.event?.id ?? item.wrap!.id)) return
        staged.push(item); stagedIds.add(item.event?.id ?? item.wrap!.id); stagedBytes += bytes
        if (staged.length >= REPLAY_RECORDS || stagedBytes >= REPLAY_BYTES) await flush()
      }
      this.#off = this.options.transport.subscribe([{ kinds: [PROJECT_WRAP_KIND], '#p': [this.identity], '#l': [PROJECT_APP, PROJECT_LOGO_APP] }], event => {
        // The relay replays history synchronously and signals EOSE in the
        // same tick; capture the phase now, before the serial task runs.
        const replaying = historical
        void this.#serial(async () => {
          if (this.#closed) return
          if (event.tags.some(tag => tag[0] === 'l' && tag[1] === PROJECT_LOGO_APP)) {
            if (!this.#logoOuter(event) || this.#logoWaiting.has(event.id) || stagedIds.has(event.id)) return
            if (replaying) { await stage({ wrap: structuredClone(event) }, utf8(JSON.stringify(event))); return }
            // A failed save must not lose the insertion: build the candidate
            // waiting map, persist it, then adopt it.
            const logoWaiting = new Map(this.#logoWaiting)
            const put = structuredClone(event)
            logoWaiting.set(put.id, put)
            const remove: string[] = []
            if (logoWaiting.size > MAX_LOGO_WAITING) { const oldest = logoWaiting.keys().next().value!; logoWaiting.delete(oldest); remove.push(oldest) }
            await this.#save(this.#state({ logoWaiting }), { logoWaiting: { remove, put: [put] } })
            if (this.#closed) return
            this.#logoWaiting = logoWaiting
            await this.#drainLogoWaiting()
            return
          }
          const inner = await unwrapProject(event, this.options.identity, this.#now())
          if (!inner || this.#closed) return
          if (replaying) {
            if (this.#events.has(inner.id)) return
            await stage({ event: inner }, utf8(JSON.stringify(inner)))
            return
          }
          const events = new Map(this.#events)
          const eventIndex = this.#cloneEventIndex(this.#indexFor(this.#events))
          const removed = this.#applyCandidate(inner, events, eventIndex)
          if (removed === undefined) return
          const logoPending = this.#pruneLogoPending(events, this.#logoEvents)
          const pendingRemove = [...this.#logoPending.keys()].filter(id => !logoPending.has(id))
          const mutation: ProjectMutation = { events: { remove: removed, put: [events.get(inner.id)!] } }
          if (pendingRemove.length) mutation.logoPending = { remove: pendingRemove, put: [] }
          await this.#save(this.#state({ events, logoPending }), mutation)
          if (this.#closed) return
          this.#eventIndexes.set(events, eventIndex)
          this.#events = events; this.#logoPending = logoPending; this.#emit()
          await this.#drainLogoWaiting()
        }).catch(e => this.#fail(e))
      }, () => {
        historical = false
        void this.#serial(async () => {
          if (this.#closed) return
          await flush()
          if (this.#closed) return
          await this.#drainLogoWaiting()
          if (this.#closed) return
          this.#ready = true; this.#emit()
        }).catch(e => this.#fail(e))
      })
      this.#emit()
    } catch (e) { this.#fail(e); throw e }
  }
  #pruneLogoPending(events = this.#events, logos = this.#logoEvents): Map<string, Pending> {
    return new Map([...this.#logoPending].filter(([, pending]) => {
      if (!logos.has(pending.inner.id)) return false
      const context = this.#logoContext(logoRef(pending.inner), events)
      return context && projectLogoRecord(pending.inner, context, this.#now()) && context.definition.members.some(member => member.pubkey === pending.recipient)
    }))
  }
  #snapshot(state: ProjectState, key: Uint8Array): string {
    const cache: Cache = { v: 1, events: [...state.events.values()], pending: [...state.pending.values()], requests: [...state.requests],
      logoEvents: [...state.logoEvents.values()], logoPending: [...state.logoPending.values()], logoRequests: [...state.logoRequests], logoWaiting: [...state.logoWaiting.values()] }
    const sealed = encryptEnvelope(enc.encode(JSON.stringify(cache)), { name: 'kithmoot-projects.json', type: 'application/json' }, { key, maxSourceBytes: MAX_CACHE_BYTES })
    return JSON.stringify({ v: 1, identity: this.identity, key: this.#sealedKey!, body: base64.encode(sealed.envelope) })
  }
  /** Persists exactly the supplied mutation. Empty mutations write nothing,
   *  so failed retries and no-op prunes never append deltas; the first write
   *  and amortised compaction replace the whole cache through the legacy
   *  save(), which capable journals carry as their v2 base. */
  async #save(state: ProjectState, mutation: ProjectMutation): Promise<void> {
    if (this.#closed) throw new Error('Projects are closed')
    let key = this.#key
    if (!key) { key = randomBytes(32); this.#key = key }
    if (!this.#sealedKey) {
      const sealed = await this.options.identity.encrypt(this.identity, bytesToHex(key))
      if (this.#closed || this.#key !== key) throw new Error('Projects closed while encrypting the cache')
      this.#sealedKey = sealed
    }
    if (!this.#deltaKey) this.#deltaKey = deriveProjectDeltaKey(key)
    if (state.pending.size + state.logoPending.size > MAX_PENDING || state.requests.size + state.logoRequests.size > MAX_REQUESTS ||
        state.logoEvents.size > MAX_LOGO_EVENTS || state.logoWaiting.size > MAX_LOGO_WAITING) throw new Error('Project journal limit reached')
    const remove: Partial<Record<CollectionName, string[]>> = {}, put: Partial<Record<CollectionName, unknown[]>> = {}
    let mutations = 0
    for (const name of COLLECTIONS) {
      const change = mutation[name]
      if (!change) continue
      if (change.remove.length) { remove[name] = change.remove; mutations += change.remove.length }
      if (change.put.length) { put[name] = change.put; mutations += change.put.length }
    }
    if (!mutations) return
    const rawDelta = nip44.v2.encrypt(JSON.stringify({ v: 2, ...(Object.keys(remove).length ? { remove } : {}), ...(Object.keys(put).length ? { put } : {}) }), this.#deltaKey)
    const compact = !this.#incremental || !this.#hasBase || shouldCompactJournal({
      baseBytes: this.#baseBytes, deltaBytes: this.#deltaBytes + utf8(rawDelta),
      baseRecordCount: this.#baseRecordCount, deltaMutations: this.#deltaMutations + mutations,
    })
    if (compact) {
      const snapshot = this.#snapshot(state, key)
      await this.options.storage.save(snapshot)
      this.#hasBase = true; this.#baseBytes = utf8(snapshot)
      this.#baseRecordCount = state.events.size + state.pending.size + state.requests.size + state.logoEvents.size + state.logoPending.size + state.logoRequests.size + state.logoWaiting.size
      this.#deltaBytes = 0; this.#deltaMutations = 0
    } else {
      await this.options.storage.appendIncremental!(rawDelta)
      this.#deltaBytes += utf8(rawDelta); this.#deltaMutations += mutations
    }
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
      const previousLogos = this.#logosFor(ref)
      const previous = (this.#indexFor(this.#events).groups.get('project:' + key) ?? []).flatMap(v => v.body.op === 'snapshot' ? [v.body.definition] : [])
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
      const previousMembers = new Set((this.#indexFor(this.#events).groups.get('project:' + key) ?? []).flatMap(v => v.body.op === 'snapshot' ? v.body.definition.members.map(m => m.pubkey) : []))
      const recipients = new Set(canonical.members.map(m => m.pubkey))
      const outgoing: Pending[] = [...recipients].map(recipient => ({ inner: primary, recipient, outer: wrapProject(primary, recipient, this.#now()) }))
      for (const recipient of previousMembers) {
        if (recipients.has(recipient)) continue
        const inner = await signProject(this.options.identity, { v: 1, op: 'withdraw', project: ref.project, revision, request, parents, recipient }, this.#now())
        outgoing.push({ inner, recipient, outer: wrapProject(inner, recipient, this.#now()) })
      }
      let refresh: { event: Event; outgoing: Pending[] } | undefined
      const nextAuthority = projectAuthority(ref, canonical)
      if (previousLogos.length === 1 && this.#logoBody(previousLogos[0]!).authority !== nextAuthority) {
        if (!this.options.transport.publishGuarded) throw new Error('This connection cannot safely refresh project logos')
        const context = { reference: ref, definition: canonical }
        const logo = await signProjectLogo(this.options.identity, context, { v: 1, op: 'logo', project: ref.project, authority: nextAuthority,
          version: 1, request: hash({ refresh: request, authority: nextAuthority }), image: structuredClone(this.#logoBody(previousLogos[0]!).image) }, this.#now())
        refresh = { event: logo, outgoing: canonical.members.map(member => ({ inner: logo, recipient: member.pubkey,
          outer: wrapProjectLogo(logo, member.pubkey, context, this.#now()) })) }
      }
      return this.#commit(primary, outgoing, request, { key, head: primary.id, intent: intentHash }, refresh)
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
      const previous = this.#indexFor(this.#events).groups.get('follow:' + key) ?? []
      const primary = await signProject(this.options.identity, { v: 1, op: 'follow', owner: ref.owner, project: ref.project, joined, membership: current.definition!.members.find(m => m.pubkey === this.identity)!.epoch, invitation: current.heads[0]!,
        revision: (previous[0]?.body.revision ?? 0) + 1, parents: previous.map(v => v.event.id).sort(), request }, this.#now())
      return this.#commit(primary, [{ inner: primary, recipient: this.identity, outer: wrapProject(primary, this.identity, this.#now()) }], request, { key, head: primary.id, intent: intentHash })
    })
    void this.retry(); return receipt
  }
  async updateLogo(ref: ProjectReference, expectedHeads: string[], expectedLogoHeads: string[], image: LogoImage | null, request: string): Promise<Receipt> {
    const chosen = structuredClone(image), heads = [...expectedHeads].sort(), logoHeads = [...expectedLogoHeads].sort()
    const receipt = await this.#serial(async () => {
      this.#require()
      if (ref.owner !== this.identity) throw new Error('Only the project owner can change its logo')
      if (!this.options.transport.publishGuarded) throw new Error('This connection cannot safely publish project logos')
      const context = this.#logoContext(ref), key = projectKey(ref)
      if (!context) throw new Error('Review the current project before changing its logo')
      const authority = projectAuthority(ref, context.definition), intentHash = hash({ key, authority, heads, logoHeads, image: chosen })
      const old = this.#logoRequests.get(request)
      if (old) { if (old.intent !== intentHash) throw new Error('This request ID was used for a different project logo'); return { ...old } }
      const current = this.snapshot().projects.find(project => project.key === key), previous = this.#logosFor(ref)
      if (!current || JSON.stringify(current.heads) !== JSON.stringify(heads) || JSON.stringify(previous.map(event => event.id).sort()) !== JSON.stringify(logoHeads)) throw new Error('Project or logo changed; review it before sharing')
      const version = previous.length ? Math.max(...previous.map(event => this.#logoBody(event).version)) + 1 : 1
      const primary = await signProjectLogo(this.options.identity, context, { v: 1, op: 'logo', project: ref.project, authority, version, request, image: chosen }, this.#now())
      if (this.#closed) throw new Error('Projects closed while signing the logo')
      const logos = new Map(this.#logoEvents)
      const logoIndex = this.#cloneLogoIndex(this.#logoIndexFor(this.#logoEvents))
      const removed = this.#applyLogoCandidate(primary, this.#events, logos, logoIndex)
      const logoRemove = removed ?? []
      const logoPut: Event[] = removed === undefined ? [] : [logos.get(primary.id)!]
      const pending = this.#pruneLogoPending()
      for (const [id, entry] of pending) if (projectKey(logoRef(entry.inner)) === key) pending.delete(id)
      const puts: Pending[] = []
      for (const member of context.definition.members) {
        const outer = wrapProjectLogo(primary, member.pubkey, context, this.#now())
        const entry: Pending = { inner: primary, outer, recipient: member.pubkey }
        pending.set(outer.id, entry); puts.push(entry)
      }
      const requests = new Map(this.#logoRequests)
      const accepted = { key, head: primary.id, intent: intentHash }; requests.set(request, accepted)
      const pendingRemove = [...this.#logoPending.keys()].filter(id => !pending.has(id))
      const mutation: ProjectMutation = {
        ...(logoRemove.length || logoPut.length ? { logoEvents: { remove: logoRemove, put: logoPut } } : {}),
        logoPending: { remove: pendingRemove, put: puts },
        logoRequests: { remove: [], put: [[request, accepted]] },
      }
      try { await this.#save(this.#state({ logoEvents: logos, logoPending: pending, logoRequests: requests }), mutation) } catch (error) { this.#fail(error); throw error }
      if (this.#closed) throw new Error('Projects closed while saving the logo')
      this.#logoIndexes.set(logos, logoIndex)
      this.#logoEvents = logos; this.#logoPending = pending; this.#logoRequests = requests; this.#emit()
      return { ...accepted }
    })
    void this.retry(); return receipt
  }
  async #commit(primary: Event, outgoing: Pending[], request: string, receipt: Receipt, refresh?: { event: Event; outgoing: Pending[] }): Promise<Receipt> {
    if (this.#closed) throw new Error('Projects closed while signing')
    const body = storedBody(primary), target = group(primary, body)
    const events = new Map(this.#events)
    const eventIndex = this.#cloneEventIndex(this.#indexFor(this.#events))
    const eventsRemove = this.#applyCandidate(primary, events, eventIndex)
    if (eventsRemove === undefined || !events.has(primary.id)) throw new Error('Project directory limit reached')
    const pending = new Map(this.#pending)
    const pendingRemove: string[] = []
    // Replace unsent older directory updates with the new authoritative state.
    // An in-flight old wrap may still arrive; recipients compare revisions.
    const recipients = new Set(outgoing.map(p => p.recipient))
    for (const [id, p] of pending) { const old = storedBody(p.inner); if (group(p.inner, old) === target && recipients.has(p.recipient)) { pending.delete(id); pendingRemove.push(id) } }
    for (const p of outgoing) pending.set(p.outer.id, p)
    const requests = new Map(this.#requests)
    requests.set(request, receipt)
    let logos = this.#logoEvents
    let logoRemove: string[] = [], logoPut: Event[] = []
    let logoIndex: LogoGroupIndex | undefined
    if (refresh) {
      logos = new Map(this.#logoEvents)
      logoIndex = this.#cloneLogoIndex(this.#logoIndexFor(this.#logoEvents))
      const removed = this.#applyLogoCandidate(refresh.event, events, logos, logoIndex)
      if (removed !== undefined) { logoRemove = removed; logoPut.push(logos.get(refresh.event.id)!) }
    }
    const logoPending = this.#pruneLogoPending(events)
    const logoPendingRemove = [...this.#logoPending.keys()].filter(id => !logoPending.has(id))
    for (const entry of refresh?.outgoing ?? []) logoPending.set(entry.outer.id, entry)
    const mutation: ProjectMutation = {
      events: { remove: eventsRemove, put: [events.get(primary.id)!] },
      pending: { remove: pendingRemove, put: outgoing },
      requests: { remove: [], put: [[request, receipt]] },
      ...(logoRemove.length || logoPut.length ? { logoEvents: { remove: logoRemove, put: logoPut } } : {}),
      ...(logoPendingRemove.length || refresh?.outgoing.length ? { logoPending: { remove: logoPendingRemove, put: refresh?.outgoing ?? [] } } : {}),
    }
    try { await this.#save(this.#state({ events, pending, requests, logoEvents: logos, logoPending }), mutation) } catch (e) { this.#fail(e); throw e }
    if (this.#closed) throw new Error('Projects closed while saving')
    this.#eventIndexes.set(events, eventIndex)
    if (logoIndex) this.#logoIndexes.set(logos, logoIndex)
    this.#events = events; this.#pending = pending; this.#requests = requests; this.#logoEvents = logos; this.#logoPending = logoPending; this.#emit()
    await this.#drainLogoWaiting()
    return { ...receipt }
  }
  async retry(): Promise<void> {
    if (this.#publishing || this.#closed || !this.#ready || this.#error || !this.#pending.size && !this.#logoPending.size) return
    this.#publishing = true
    try {
      const batch = [...this.#pending.values()]
      const accepted: string[] = []
      let failed = false
      for (let i = 0; i < batch.length && !this.#closed; i += 4) {
        const group = batch.slice(i, i + 4).filter(p => this.#pending.has(p.outer.id))
        const results = await Promise.allSettled(group.map(p => this.options.transport.publish(p.outer)))
        results.forEach((r, n) => {
          if (r.status !== 'fulfilled') { failed = true; return }
          const p = group[n]!
          accepted.push(p.outer.id)
          if (p.recipient !== this.identity) this.options.deliver?.(p.outer, p.recipient).catch(() => {})
        })
      }
      await this.#serial(async () => {
        if (this.#closed) return
        const pending = new Map(this.#pending)
        for (const id of accepted) pending.delete(id)
        // A failed pass removes nothing; empty mutations never write a delta.
        if (accepted.length) await this.#save(this.#state({ pending }), { pending: { remove: accepted, put: [] } })
        this.#pending = pending; this.#emit()
      })
      const logoAccepted: string[] = []
      for (const entry of [...this.#logoPending.values()]) {
        if (this.#closed) break
        const current = () => {
          if (this.#closed || !this.#logoEvents.has(entry.inner.id)) return false
          const context = this.#logoContext(logoRef(entry.inner))
          return !!context && projectAuthority(context.reference, context.definition) === this.#logoBody(entry.inner).authority && context.definition.members.some(member => member.pubkey === entry.recipient)
        }
        if (!current()) continue
        try {
          if (!this.options.transport.publishGuarded) throw new Error('Guarded project logo delivery is unavailable')
          await this.options.transport.publishGuarded(entry.outer, current)
          logoAccepted.push(entry.outer.id)
          if (entry.recipient !== this.identity && current()) this.options.deliverGuarded?.(entry.outer, entry.recipient, current).catch(() => {})
        } catch { failed = true }
      }
      if (this.#logoPending.size || logoAccepted.length) await this.#serial(async () => {
        if (this.#closed) return
        const pending = this.#pruneLogoPending()
        for (const id of logoAccepted) pending.delete(id)
        const removed = [...this.#logoPending.keys()].filter(id => !pending.has(id))
        // Pruning that removes nothing, and empty passes, stay silent.
        if (removed.length) await this.#save(this.#state({ logoPending: pending }), { logoPending: { remove: removed, put: [] } })
        this.#logoPending = pending; this.#emit()
      })
      if (!failed && !this.#closed && (this.#pending.size || this.#logoPending.size)) { this.#publishing = false; await this.retry() }
    } catch (e) { this.#fail(e) } finally { this.#publishing = false }
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true; this.#ready = false; this.#off?.(); this.#emit()
    await this.#tail
    this.#key?.fill(0); this.#key = undefined; this.#sealedKey = undefined
    this.#deltaKey?.fill(0); this.#deltaKey = undefined
    this.#events.clear(); this.#pending.clear(); this.#requests.clear(); this.#logoEvents.clear(); this.#logoPending.clear(); this.#logoRequests.clear(); this.#logoWaiting.clear(); this.#listeners.clear()
  }
}
