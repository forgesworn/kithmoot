import type { Event } from 'nostr-tools/pure'
import { base64 } from '@scure/base'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { encryptEnvelope, decryptEnvelope } from './attachment.js'
import type { RelayTransport } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'
import { PROJECT_APP, PROJECT_WRAP_KIND, MAX_PROJECT_WRAP_BYTES, projectAuthority, projectForRecipient, projectId, projectKey,
  projectRecord, signProject, unwrapProject, wrapProject, type ProjectDefinition, type ProjectIdentity, type ProjectRecord, type ProjectReference } from './projects.js'
import { PROJECT_LOGO_APP, MAX_PROJECT_LOGO_WRAP_BYTES, projectLogoRecord, signProjectLogo, unwrapProjectLogo, wrapProjectLogo, type ProjectLogoContext, type ProjectLogoRecord } from './project-logo.js'
import type { LogoImage } from './logo-image.js'

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
const enc = new TextEncoder(), dec = new TextDecoder()
const MAX_CACHE_BYTES = 32 * 1024 * 1024
// Only call this for events already verified before insertion into private state.
const storedBody = (event: Event): ProjectRecord => JSON.parse(event.content) as ProjectRecord
const storedLogo = (event: Event): ProjectLogoRecord => JSON.parse(event.content) as ProjectLogoRecord
const logoRef = (event: Event): ProjectReference => ({ owner: event.pubkey, project: storedLogo(event).project })
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
  #logoEvents = new Map<string, Event>()
  #logoPending = new Map<string, Pending>()
  #logoRequests = new Map<string, Receipt>()
  #logoWaiting = new Map<string, Event>()
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
  constructor(readonly options: {
    identity: ProjectIdentity; transport: RelayTransport; storage: ProjectDirectoryStorage; now?: () => number
    /** Also hands each wrap for someone else to where that person reads -
     *  their inbox relays - once the owner's own relays have it. Best effort:
     *  a member who shares a relay with the owner finds it there anyway. */
    deliver?: (wrap: Event, recipient: string) => Promise<void>
    /** Rechecks authority before each secondary-relay socket write. */
    deliverGuarded?: (wrap: Event, recipient: string, current: () => boolean) => Promise<void>
  }) {}
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
        ...(logos.length === 1 && definition && !definition.archived ? { logo: structuredClone(storedLogo(logos[0]!).image) } : {}),
      })
    }
    return { projects: projects.sort((a, b) => (a.definition?.name ?? a.key).localeCompare(b.definition?.name ?? b.key)), ready: this.#ready && !this.#closed && !this.#error,
      pendingSends: this.#pending.size + this.#logoPending.size, ...(this.#error ? { error: this.#error } : {}) }
  }
  #logoContext(ref: ProjectReference, events = this.#events): ProjectLogoContext | undefined {
    const values = this.#groups(events).get('project:' + projectKey(ref))
    const body = values?.length === 1 ? values[0]!.body : undefined
    if (body?.op !== 'snapshot' || !body.definition.members.some(member => member.pubkey === this.identity)) return
    return { reference: ref, definition: body.definition }
  }
  #logosFor(ref: ProjectReference, events = this.#events, logos = this.#logoEvents): Event[] {
    const context = this.#logoContext(ref, events)
    if (!context) return []
    const authority = projectAuthority(ref, context.definition)
    return [...logos.values()].filter(event => event.pubkey === ref.owner && storedLogo(event).project === ref.project && storedLogo(event).authority === authority)
  }
  #logoCandidate(event: Event, events = this.#events, logos = this.#logoEvents): Map<string, Event> {
    let ref: ProjectReference
    try { ref = logoRef(event) } catch { return logos }
    const context = this.#logoContext(ref, events), body = context && projectLogoRecord(event, context, this.#now())
    if (!body || logos.has(event.id)) return logos
    const values = this.#logosFor(ref, events, logos), highest = values[0] ? storedLogo(values[0]).version : 0
    if (body.version < highest || body.version === highest && values.length >= 8) return logos
    const result = new Map(logos)
    if (body.version > highest) for (const old of result.values()) if (old.pubkey === ref.owner && storedLogo(old).project === ref.project) result.delete(old.id)
    result.set(event.id, structuredClone(event))
    return result
  }
  #logoOuter(event: Event): boolean {
    return event.kind === PROJECT_WRAP_KIND && typeof event.content === 'string' && event.content.length <= MAX_PROJECT_LOGO_WRAP_BYTES &&
      Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= this.#now() + 60 &&
      JSON.stringify(event.tags) === JSON.stringify([['p', this.identity], ['l', PROJECT_LOGO_APP]]) && verifyEventUncached(event)
  }
  async #drainLogoWaiting(): Promise<void> {
    const contexts = [...this.#groups()].flatMap(([key, values]) => key.startsWith('project:') && values.length === 1 && values[0]!.body.op === 'snapshot'
      ? [this.#logoContext(recordRef(values[0]!.event, values[0]!.body))].filter((value): value is ProjectLogoContext => !!value) : [])
    if (!contexts.length || !this.#logoWaiting.size) return
    let logos = this.#logoEvents
    const waiting = new Map(this.#logoWaiting)
    for (const [id, wrap] of waiting) {
      const inner = await unwrapProjectLogo(wrap, this.options.identity, contexts, this.#now())
      if (this.#closed) return
      // An unknown project may arrive after its companion. Keep its bounded
      // encrypted wrap for the next directory change rather than guessing.
      if (!inner) continue
      waiting.delete(id); logos = this.#logoCandidate(inner, this.#events, logos)
    }
    if (waiting.size === this.#logoWaiting.size && logos === this.#logoEvents) return
    const pending = this.#pruneLogoPending(this.#events, logos)
    await this.#save(this.#events, this.#pending, this.#requests, logos, pending, this.#logoRequests, waiting)
    if (this.#closed) return
    this.#logoEvents = logos; this.#logoPending = pending; this.#logoWaiting = waiting; this.#emit()
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
        for (const name of ['logoEvents', 'logoPending', 'logoRequests', 'logoWaiting'] as const) {
          const value = cache[name]
          if (value !== undefined && (!Array.isArray(value) || value.length > (name === 'logoRequests' ? 4096 : name === 'logoWaiting' ? 128 : 1024))) throw new Error('Invalid project logo journal')
        }
        for (const event of cache.logoEvents ?? []) {
          if (!verifyEventUncached(event)) throw new Error('Project logo cache failed signature verification')
          this.#logoEvents = this.#logoCandidate(event)
        }
        for (const pending of cache.logoPending ?? []) {
          if (pending.inner.pubkey !== this.identity || !verifyEventUncached(pending.inner) ||
              pending.outer.kind !== PROJECT_WRAP_KIND || pending.outer.content.length > MAX_PROJECT_LOGO_WRAP_BYTES ||
              JSON.stringify(pending.outer.tags) !== JSON.stringify([['p', pending.recipient], ['l', PROJECT_LOGO_APP]]) || !verifyEventUncached(pending.outer)) throw new Error('Project logo outbox failed verification')
          const context = this.#logoContext(logoRef(pending.inner))
          if (this.#logoEvents.has(pending.inner.id) && context && projectLogoRecord(pending.inner, context, this.#now()) && context.definition.members.some(member => member.pubkey === pending.recipient)) this.#logoPending.set(pending.outer.id, pending)
        }
        for (const [request, receipt] of cache.logoRequests ?? []) {
          if (!/^[a-zA-Z0-9_-]{16,80}$/.test(request) || !/^[0-9a-f]{64}$/.test(receipt.head) || !/^[0-9a-f]{64}$/.test(receipt.intent) || !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(receipt.key)) throw new Error('Invalid project logo request receipt')
          this.#logoRequests.set(request, receipt)
        }
        for (const event of cache.logoWaiting ?? []) {
          if (!this.#logoOuter(event)) throw new Error('Invalid waiting project logo envelope')
          this.#logoWaiting.set(event.id, event)
        }
      }
      if (this.#closed) return
      this.#off = this.options.transport.subscribe([{ kinds: [PROJECT_WRAP_KIND], '#p': [this.identity], '#l': [PROJECT_APP, PROJECT_LOGO_APP] }], event => {
        void this.#serial(async () => {
          if (this.#closed) return
          if (event.tags.some(tag => tag[0] === 'l' && tag[1] === PROJECT_LOGO_APP)) {
            if (!this.#logoOuter(event) || this.#logoWaiting.has(event.id)) return
            this.#logoWaiting.set(event.id, structuredClone(event))
            if (this.#logoWaiting.size > 128) this.#logoWaiting.delete(this.#logoWaiting.keys().next().value!)
            await this.#save(this.#events, this.#pending, this.#requests)
            if (!this.#closed) await this.#drainLogoWaiting()
            return
          }
          const inner = await unwrapProject(event, this.options.identity, this.#now())
          if (!inner || this.#closed) return
          const events = this.#candidate(inner)
          if (events === this.#events) return
          const logoPending = this.#pruneLogoPending(events)
          await this.#save(events, this.#pending, this.#requests, this.#logoEvents, logoPending)
          if (this.#closed) return
          this.#events = events; this.#logoPending = logoPending; this.#emit()
          await this.#drainLogoWaiting()
        }).catch(e => this.#fail(e))
      }, () => {
        void this.#serial(async () => { if (!this.#closed) { await this.#drainLogoWaiting(); this.#ready = true; this.#emit() } }).catch(e => this.#fail(e))
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
  async #save(events: Map<string, Event>, pending: Map<string, Pending>, requests: Map<string, Receipt>,
    logoEvents = this.#logoEvents, logoPending = this.#logoPending, logoRequests = this.#logoRequests, logoWaiting = this.#logoWaiting): Promise<void> {
    if (this.#closed) throw new Error('Projects are closed')
    this.#key ??= randomBytes(32)
    if (!this.#sealedKey) {
      const sealed = await this.options.identity.encrypt(this.identity, bytesToHex(this.#key))
      if (this.#closed || !this.#key) throw new Error('Projects closed while encrypting the cache')
      this.#sealedKey = sealed
    }
    if (pending.size + logoPending.size > 1024 || requests.size + logoRequests.size > 4096 || logoEvents.size > 1024 || logoWaiting.size > 128) throw new Error('Project journal limit reached')
    const cache: Cache = { v: 1, events: [...events.values()], pending: [...pending.values()], requests: [...requests],
      logoEvents: [...logoEvents.values()], logoPending: [...logoPending.values()], logoRequests: [...logoRequests], logoWaiting: [...logoWaiting.values()] }
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
      const previousLogos = this.#logosFor(ref)
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
      let refresh: { event: Event; outgoing: Pending[] } | undefined
      const nextAuthority = projectAuthority(ref, canonical)
      if (previousLogos.length === 1 && storedLogo(previousLogos[0]!).authority !== nextAuthority) {
        if (!this.options.transport.publishGuarded) throw new Error('This connection cannot safely refresh project logos')
        const context = { reference: ref, definition: canonical }
        const logo = await signProjectLogo(this.options.identity, context, { v: 1, op: 'logo', project: ref.project, authority: nextAuthority,
          version: 1, request: hash({ refresh: request, authority: nextAuthority }), image: structuredClone(storedLogo(previousLogos[0]!).image) }, this.#now())
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
      const previous = this.#groups().get('follow:' + key) ?? []
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
      const version = previous.length ? Math.max(...previous.map(event => storedLogo(event).version)) + 1 : 1
      const primary = await signProjectLogo(this.options.identity, context, { v: 1, op: 'logo', project: ref.project, authority, version, request, image: chosen }, this.#now())
      if (this.#closed) throw new Error('Projects closed while signing the logo')
      const logos = this.#logoCandidate(primary), pending = this.#pruneLogoPending(), requests = new Map(this.#logoRequests)
      for (const [id, entry] of pending) if (projectKey(logoRef(entry.inner)) === key) pending.delete(id)
      for (const member of context.definition.members) {
        const outer = wrapProjectLogo(primary, member.pubkey, context, this.#now())
        pending.set(outer.id, { inner: primary, outer, recipient: member.pubkey })
      }
      const accepted = { key, head: primary.id, intent: intentHash }; requests.set(request, accepted)
      try { await this.#save(this.#events, this.#pending, this.#requests, logos, pending, requests) } catch (error) { this.#fail(error); throw error }
      if (this.#closed) throw new Error('Projects closed while saving the logo')
      this.#logoEvents = logos; this.#logoPending = pending; this.#logoRequests = requests; this.#emit()
      return { ...accepted }
    })
    void this.retry(); return receipt
  }
  async #commit(primary: Event, outgoing: Pending[], request: string, receipt: Receipt, refresh?: { event: Event; outgoing: Pending[] }): Promise<Receipt> {
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
    const logos = refresh ? this.#logoCandidate(refresh.event, events) : this.#logoEvents
    const logoPending = this.#pruneLogoPending(events)
    for (const entry of refresh?.outgoing ?? []) logoPending.set(entry.outer.id, entry)
    try { await this.#save(events, pending, requests, logos, logoPending) } catch (e) { this.#fail(e); throw e }
    if (this.#closed) throw new Error('Projects closed while saving')
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
        await this.#save(this.#events, pending, this.#requests)
        this.#pending = pending; this.#emit()
      })
      const logoAccepted: string[] = []
      for (const entry of [...this.#logoPending.values()]) {
        if (this.#closed) break
        const current = () => {
          if (this.#closed || !this.#logoEvents.has(entry.inner.id)) return false
          const context = this.#logoContext(logoRef(entry.inner))
          return !!context && projectAuthority(context.reference, context.definition) === storedLogo(entry.inner).authority && context.definition.members.some(member => member.pubkey === entry.recipient)
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
        await this.#save(this.#events, this.#pending, this.#requests, this.#logoEvents, pending)
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
    this.#events.clear(); this.#pending.clear(); this.#requests.clear(); this.#logoEvents.clear(); this.#logoPending.clear(); this.#logoRequests.clear(); this.#logoWaiting.clear(); this.#listeners.clear()
  }
}
