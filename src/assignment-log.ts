import { nip44 } from 'nostr-tools'
import { getPublicKey, type Event } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { encodeChatEvent, decodeChatEvent, deriveChannel, type EpochRoot } from './chat.js'
import { KINDS } from './kinds.js'
import type { ParticipantIdentity } from './identity.js'
import type { RelayTransport } from './relay-pool.js'
import type { AgentOwnership, DeviceCredential, KindredProof, RoomPolicy } from './types.js'
import { assignmentId, assignmentPayload, ASSIGNMENT_CHANNEL, projectAssignments, signAssignment, type Assignment, type AssignmentOperation } from './assignments.js'
import { shouldCompactJournal, type JournalImage, type JournalStorage } from './journal-storage.js'

/** An adapter must make each replace atomic and report storage failures.
 * Assignment content is encrypted; v2 references retain the root's existing
 * physical account/room binding. */
export interface AssignmentStorage extends JournalStorage {}
export interface AssignmentLogOptions {
  roomId: string
  roomKey: Uint8Array
  transport: RelayTransport
  deviceSk: Uint8Array
  identity?: ParticipantIdentity
  credential: () => DeviceCredential | undefined
  policy?: RoomPolicy
  proof?: KindredProof
  owner?: AgentOwnership
  name?: string
  epoch?: EpochRoot
  storage: AssignmentStorage
  now?: () => number
  /** A conference room's end: every envelope published carries it as an
   *  expiration. See `withExpiration`. */
  expiresAt?: number
}
/** Navigation can observe work in an already admitted room without a signer,
 * presence announcement or permission to execute it. The bounded replay is
 * deliberately incomplete: open the origin room before making a decision. */
export interface AssignmentReaderOptions extends Pick<AssignmentLogOptions,
  'roomId' | 'roomKey' | 'transport' | 'policy' | 'epoch' | 'now'> {
  readOnly: true
  participant: string
  storage: Pick<AssignmentStorage, 'load' | 'loadIncremental'>
  /** Maximum initial historical envelopes, from 1 to 512. Defaults to 128. */
  historyLimit?: number
  /** Only request recent envelopes. Defaults to the last 24 hours. */
  since?: number
}
interface Pending { inner: Event; outer: Event; reviewRequired?: true }
interface OutboxCiphertext { pending: Pending; ciphertext: string }
interface LoadedAssignments {
  events: Map<string, Event>
  outbox: Map<string, Pending>
  eventCiphertexts: Map<string, string>
  outboxCiphertexts: Map<string, OutboxCiphertext>
  hasBase: boolean
  baseBytes: number
  baseRecordCount: number
  deltaBytes: number
  deltaMutations: number
}
interface AssignmentDelta { v: 2; add: string[]; outbox?: string[] }
const MAX_EVENTS = 20_000
const MAX_OUTBOX = 100
const REPLAY_RECORDS = 64
const REPLAY_BYTES = 1024 * 1024
const encoder = new TextEncoder()
const utf8 = (value: string): number => encoder.encode(value).byteLength
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export interface AssignmentLogSnapshot {
  assignments: Assignment[]
  ready: boolean
  error?: string
  pendingHistory: number
  pendingSends: number
  /** Bounded navigation readers must never imply that unseen work is absent. */
  historyComplete: boolean
}

/** Durable assignment history is separate from the 500-message chat window.
 * It queries the whole retained stream and persists signed inner events before
 * reporting changes. The relay still controls availability; EOSE is not a
 * promise of permanent retention or proof that a malicious relay omitted nothing. */
export class AssignmentLog {
  readonly #opts: AssignmentLogOptions | AssignmentReaderOptions
  readonly #events = new Map<string, Event>()
  readonly #outbox = new Map<string, Pending>()
  readonly #listeners = new Set<() => void>()
  #epoch?: EpochRoot
  #unsub?: () => void
  #tail: Promise<unknown> = Promise.resolve()
  #ready = false
  #error?: string
  #closed = false
  #opened = false
  #generation = 0
  #incremental = false
  #storageUncertain = false
  readonly #eventCiphertexts = new Map<string, string>()
  readonly #outboxCiphertexts = new Map<string, OutboxCiphertext>()
  #durableEvents = new Set<string>()
  #durableOutbox = new Map<string, Pending>()
  #hasBase = false
  #baseBytes = 0
  #baseRecordCount = 0
  #deltaBytes = 0
  #deltaMutations = 0

  constructor(opts: AssignmentLogOptions | AssignmentReaderOptions) {
    const incremental = opts.storage.loadIncremental !== undefined
    if (typeof opts.storage.loadIncremental !== 'function' && incremental) throw new Error('Invalid incremental assignment loader')
    if ('readOnly' in opts) {
      const limit = opts.historyLimit ?? 128
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new Error('Invalid assignment history limit')
      if (opts.since !== undefined && (!Number.isSafeInteger(opts.since) || opts.since < 0)) throw new Error('Invalid assignment history start')
    } else {
      const appending = opts.storage.appendIncremental !== undefined
      if (typeof opts.storage.appendIncremental !== 'function' && appending) throw new Error('Invalid incremental assignment appender')
      if (incremental !== appending) throw new Error('Incremental assignment storage requires both loadIncremental and appendIncremental')
    }
    this.#incremental = incremental
    this.#opts = opts; this.#epoch = opts.epoch
  }
  get participant(): string { return 'readOnly' in this.#opts ? this.#opts.participant : this.#opts.identity?.pubkey ?? this.#opts.credential()?.pubkey ?? '' }
  get roomId(): string { return this.#opts.roomId }
  snapshot(): AssignmentLogSnapshot {
    const p = projectAssignments([...this.#events.values()], this.roomId)
    return { assignments: p.assignments, ready: this.#ready && !this.#error && !this.#closed && p.pending.length === 0,
      ...(this.#error ? { error: this.#error } : {}), pendingHistory: p.pending.length, pendingSends: this.#outbox.size,
      historyComplete: !('readOnly' in this.#opts) && this.#ready && !this.#error && !this.#closed && p.pending.length === 0 }
  }
  onChange(cb: () => void): () => void { this.#listeners.add(cb); return () => this.#listeners.delete(cb) }
  #emit(): void { for (const cb of this.#listeners) cb() }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(work)
    this.#tail = task.catch(() => {})
    return task
  }
  #fail(e: unknown): void { this.#error = e instanceof Error ? e.message : String(e); this.#emit() }

  async open(): Promise<void> {
    if (this.#opened || this.#closed) throw new Error('Assignment log already opened or closed')
    this.#opened = true
    try {
      const loaded = await this.#loadStored()
      if (this.#closed) return
      this.#applyLoaded(loaded)
      this.#subscribe()
    } catch (e) {
      this.#clear()
      this.#fail(e); throw e
    }
  }

  async #image(): Promise<JournalImage> {
    const image: JournalImage = this.#incremental
      ? await this.#opts.storage.loadIncremental!()
      : { base: await this.#opts.storage.load(), deltas: [] }
    if (!object(image) || (image.base !== undefined && typeof image.base !== 'string') ||
        !Array.isArray(image.deltas) || image.deltas.length > 4096 || image.deltas.some(delta => typeof delta !== 'string')) throw new Error('Invalid incremental assignment journal')
    return image
  }

  async #loadStored(): Promise<LoadedAssignments> {
    const image = await this.#image()
    const events = new Map<string, Event>(), outbox = new Map<string, Pending>()
    const eventCiphertexts = new Map<string, string>()
    let outboxCiphertexts = new Map<string, OutboxCiphertext>(), eventRecords = 0
    const addEvent = (encrypted: unknown): void => {
      if (typeof encrypted !== 'string') throw new Error('Invalid assignment cache')
      const event = JSON.parse(nip44.v2.decrypt(encrypted, this.#opts.roomKey)) as Event
      if (!assignmentPayload(event, this.roomId)) throw new Error('Assignment cache failed authentication')
      events.set(event.id, event); eventCiphertexts.set(event.id, encrypted); eventRecords++
      if (eventRecords > MAX_EVENTS) throw new Error('Invalid assignment cache')
    }
    const replaceOutbox = (encrypted: unknown[]): void => {
      if (encrypted.length > MAX_OUTBOX) throw new Error('Invalid assignment cache')
      const next = new Map<string, Pending>(), ciphertexts = new Map<string, OutboxCiphertext>()
      for (const value of encrypted) {
        if (typeof value !== 'string') throw new Error('Invalid assignment cache')
        const pending = JSON.parse(nip44.v2.decrypt(value, this.#opts.roomKey)) as Pending
        const p = pending && assignmentPayload(pending.inner, this.roomId)
        if (!p || pending.inner.pubkey !== this.participant) throw new Error('Assignment outbox failed authentication')
        next.set(p.request, pending); ciphertexts.set(p.request, { pending, ciphertext: value })
      }
      outbox.clear(); for (const [request, pending] of next) outbox.set(request, pending)
      outboxCiphertexts = ciphertexts
    }
    if (image.base !== undefined && (image.base.length > 0 || image.deltas.length === 0)) {
      const cache = JSON.parse(image.base) as { v: number; events: unknown[]; outbox: unknown[] }
      if (cache.v !== 1 || !Array.isArray(cache.events) || !Array.isArray(cache.outbox) || cache.events.length > MAX_EVENTS || cache.outbox.length > MAX_OUTBOX) throw new Error('Invalid assignment cache')
      for (const encrypted of cache.events) addEvent(encrypted)
      replaceOutbox(cache.outbox)
    }
    const baseRecordCount = eventRecords + outbox.size
    let deltaBytes = 0, deltaMutations = 0
    for (const raw of image.deltas) {
      const delta = JSON.parse(raw) as AssignmentDelta
      if (!object(delta)) throw new Error('Invalid assignment delta')
      const hasOutbox = Object.hasOwn(delta, 'outbox')
      if (delta.v !== 2 || !Array.isArray(delta.add) || delta.add.length > MAX_EVENTS ||
          (hasOutbox && !Array.isArray(delta.outbox)) || Object.keys(delta).length !== (hasOutbox ? 3 : 2) ||
          Object.keys(delta).some(key => !['v', 'add', 'outbox'].includes(key))) throw new Error('Invalid assignment delta')
      for (const encrypted of delta.add) addEvent(encrypted)
      if (hasOutbox) replaceOutbox(delta.outbox!)
      deltaBytes += utf8(raw)
      deltaMutations += delta.add.length + (hasOutbox ? Math.max(1, delta.outbox!.length) : 0)
    }
    return { events, outbox, eventCiphertexts, outboxCiphertexts, hasBase: image.base !== undefined,
      baseBytes: utf8(image.base ?? ''), baseRecordCount, deltaBytes, deltaMutations }
  }

  #applyLoaded(loaded: LoadedAssignments): void {
    this.#events.clear(); for (const [id, event] of loaded.events) this.#events.set(id, event)
    this.#outbox.clear(); for (const [request, pending] of loaded.outbox) this.#outbox.set(request, pending)
    this.#eventCiphertexts.clear(); for (const [id, ciphertext] of loaded.eventCiphertexts) this.#eventCiphertexts.set(id, ciphertext)
    this.#outboxCiphertexts.clear(); for (const [request, ciphertext] of loaded.outboxCiphertexts) this.#outboxCiphertexts.set(request, ciphertext)
    this.#durableEvents = new Set(loaded.events.keys()); this.#durableOutbox = new Map(loaded.outbox)
    this.#hasBase = loaded.hasBase; this.#baseBytes = loaded.baseBytes; this.#baseRecordCount = loaded.baseRecordCount
    this.#deltaBytes = loaded.deltaBytes; this.#deltaMutations = loaded.deltaMutations
    this.#storageUncertain = false
  }

  #clear(): void {
    this.#events.clear(); this.#outbox.clear(); this.#eventCiphertexts.clear(); this.#outboxCiphertexts.clear()
    this.#durableEvents.clear(); this.#durableOutbox.clear()
    this.#hasBase = false; this.#baseBytes = 0; this.#baseRecordCount = 0; this.#deltaBytes = 0; this.#deltaMutations = 0
  }

  #subscribe(): void {
    this.#unsub?.(); this.#ready = false
    const generation = ++this.#generation
    const root = this.#epoch ?? { id: this.roomId, key: this.#opts.roomKey }
    const { id } = deriveChannel(root.id, root.key, ASSIGNMENT_CHANNEL)
    const bounded = 'readOnly' in this.#opts
      ? { limit: this.#opts.historyLimit ?? 128, since: this.#opts.since ?? Math.max(0, this.#now() - 86_400) } : undefined
    let historical = true, received = 0, stagedBytes = 0
    let staged: Event[] = [], stagedIds = new Set<string>()
    const clearStaged = () => { staged = []; stagedIds = new Set(); stagedBytes = 0 }
    const failed = (e: unknown) => { if (generation === this.#generation && !this.#closed) this.#fail(e) }
    const flush = async (): Promise<void> => {
      if (generation !== this.#generation || this.#closed) { clearStaged(); return }
      if (!staged.length) return
      const batch = staged; clearStaged()
      const candidate = new Map(this.#events)
      for (const event of batch) candidate.set(event.id, event)
      if (candidate.size > MAX_EVENTS) throw new Error('Assignment history is full; export it before continuing')
      if (!('readOnly' in this.#opts)) await this.#persist(candidate, this.#outbox)
      if (generation !== this.#generation || this.#closed) return
      for (const event of batch) this.#events.set(event.id, event)
      this.#emit()
    }
    this.#unsub = this.#opts.transport.subscribe([{ kinds: [KINDS.CHAT], '#d': [id], ...bounded }], outer => {
      if (generation !== this.#generation || this.#closed) return
      if (bounded && historical && (++received > bounded.limit || outer.created_at < bounded.since)) return
      const message = decodeChatEvent(outer, { roomId: this.roomId, roomKey: this.#opts.roomKey, channel: ASSIGNMENT_CHANNEL,
        epoch: this.#epoch, policy: this.#opts.policy, now: this.#now() })
      if (!message?.assignment) return
      const event = message.assignment, initial = historical
      void this.#serial(async () => {
        if (generation !== this.#generation || this.#closed || this.#events.has(event.id) || stagedIds.has(event.id)) return
        if (!initial && staged.length) await flush()
        if (generation !== this.#generation || this.#closed || this.#events.has(event.id)) return
        if (initial) {
          const bytes = utf8(JSON.stringify(event))
          if (staged.length && (staged.length >= REPLAY_RECORDS || stagedBytes + bytes > REPLAY_BYTES)) await flush()
          if (generation !== this.#generation || this.#closed || this.#events.has(event.id) || stagedIds.has(event.id)) return
          staged.push(event); stagedIds.add(event.id); stagedBytes += bytes
          if (staged.length >= REPLAY_RECORDS || stagedBytes >= REPLAY_BYTES) await flush()
          return
        }
        if (this.#events.size >= MAX_EVENTS) throw new Error('Assignment history is full; export it before continuing')
        const candidate = new Map(this.#events).set(event.id, event)
        if (!('readOnly' in this.#opts)) await this.#persist(candidate, this.#outbox)
        if (generation !== this.#generation || this.#closed) return
        this.#events.set(event.id, event); this.#emit()
      }).catch(failed)
    }, () => {
      historical = false
      void this.#serial(async () => {
        if (generation !== this.#generation || this.#closed) return
        await flush()
        if (generation !== this.#generation || this.#closed) return
        this.#ready = true; this.#emit()
      }).catch(failed)
    })
  }

  #now(): number { return (this.#opts.now ?? (() => Math.floor(Date.now() / 1000)))() }
  #eventCiphertext(event: Event): string {
    const cached = this.#eventCiphertexts.get(event.id)
    if (cached) return cached
    const ciphertext = nip44.v2.encrypt(JSON.stringify(event), this.#opts.roomKey)
    this.#eventCiphertexts.set(event.id, ciphertext)
    return ciphertext
  }
  #outboxCiphertext(request: string, pending: Pending): string {
    const cached = this.#outboxCiphertexts.get(request)
    if (cached?.pending === pending) return cached.ciphertext
    const ciphertext = nip44.v2.encrypt(JSON.stringify(pending), this.#opts.roomKey)
    this.#outboxCiphertexts.set(request, { pending, ciphertext })
    return ciphertext
  }
  #snapshot(events: Map<string, Event>, outbox: Map<string, Pending>): string {
    return JSON.stringify({ v: 1,
      events: [...events.values()].map(event => this.#eventCiphertext(event)),
      outbox: [...outbox].map(([request, pending]) => this.#outboxCiphertext(request, pending)),
    })
  }
  async #recoverPersistence(generation: number): Promise<void> {
    try {
      const loaded = await this.#loadStored()
      if (generation !== this.#generation || this.#closed) { this.#storageUncertain = true; return }
      this.#applyLoaded(loaded); this.#emit()
    } catch {
      this.#storageUncertain = true
      this.#error = 'Assignment storage could not be reloaded after a failed write; reopen the room before continuing'
      this.#emit()
    }
  }
  async #persist(events: Map<string, Event>, outbox: Map<string, Pending>): Promise<void> {
    if ('readOnly' in this.#opts) throw new Error('This assignment reader is read-only')
    if (this.#storageUncertain) throw new Error(this.#error ?? 'Assignment storage state is uncertain; reopen the room before continuing')
    const additions = [...events].filter(([id]) => !this.#durableEvents.has(id))
    const removed = events.size < this.#durableEvents.size || [...this.#durableEvents].some(id => !events.has(id))
    const outboxChanged = outbox.size !== this.#durableOutbox.size || [...outbox].some(([request, pending]) => this.#durableOutbox.get(request) !== pending)
    if (!removed && !additions.length && !outboxChanged) return
    const generation = this.#generation
    try {
      const delta: AssignmentDelta = { v: 2, add: additions.map(([, event]) => this.#eventCiphertext(event)),
        ...(outboxChanged ? { outbox: [...outbox].map(([request, pending]) => this.#outboxCiphertext(request, pending)) } : {}) }
      const rawDelta = JSON.stringify(delta)
      const mutations = delta.add.length + (outboxChanged ? Math.max(1, outbox.size) : 0)
      const compact = removed || !this.#hasBase || (this.#incremental && shouldCompactJournal({
        baseBytes: this.#baseBytes, deltaBytes: this.#deltaBytes + utf8(rawDelta),
        baseRecordCount: this.#baseRecordCount, deltaMutations: this.#deltaMutations + mutations,
      }))
      if (!this.#incremental || compact) {
        const snapshot = this.#snapshot(events, outbox)
        await this.#opts.storage.save(snapshot)
        this.#hasBase = true; this.#baseBytes = utf8(snapshot); this.#baseRecordCount = events.size + outbox.size
        this.#deltaBytes = 0; this.#deltaMutations = 0
      } else {
        await this.#opts.storage.appendIncremental!(rawDelta)
        this.#deltaBytes += utf8(rawDelta); this.#deltaMutations += mutations
      }
      this.#durableEvents = new Set(events.keys()); this.#durableOutbox = new Map(outbox)
      for (const request of this.#outboxCiphertexts.keys()) if (!outbox.has(request)) this.#outboxCiphertexts.delete(request)
    } catch (e) {
      await this.#recoverPersistence(generation)
      throw e
    }
  }

  /** Stable request IDs are mandatory at this boundary. Failed/ambiguous sends
   * remain in the encrypted outbox and retry the exact same signed operation. */
  async submit(assignment: string | undefined, operation: AssignmentOperation, request: string, expectedHead?: string | null, review?: () => boolean): Promise<Assignment> {
    const opts = this.#opts
    if ('readOnly' in opts) throw new Error('Open the origin room to update this assignment')
    const checkReview = () => { if (review && !review()) throw new Error('The reviewed assignment or its source changed') }
    const pending = await this.#serial(async () => {
      checkReview()
      if (!this.snapshot().ready) throw new Error(this.#error ?? 'Wait for assignment history to finish loading')
      const identity = opts.identity
      if (!identity) throw new Error('This device cannot sign assignment updates')
      const existing = [...this.#events.values()].find(e => e.pubkey === identity.pubkey && assignmentPayload(e, this.roomId)?.request === request)
      const retry = this.#outbox.get(request)
      if (retry?.reviewRequired && !review) throw new Error('Review this saved assignment in its source before retrying')
      const old = existing ?? retry?.inner
      if (old) {
        const payload = assignmentPayload(old, this.roomId)!
        if (JSON.stringify(payload.operation) !== JSON.stringify(operation) || (assignment && payload.assignment !== assignment)) throw new Error('Request ID already used for different work')
        if (expectedHead !== undefined && payload.previous !== expectedHead) throw new Error('Assignment version changed')
        return retry ?? { inner: old, outer: undefined }
      }
      if (this.#outbox.size) throw new Error('Resolve the pending assignment send before another update')
      const id = assignment ?? assignmentId(identity.pubkey, request)
      const before = this.snapshot().assignments.find(s => s.id === id)
      if (assignment && !before) throw new Error('Assignment history is missing')
      // Compare inside the serial update, after any queued incoming saves.
      // A host approval for one head must never sign against a newer head.
      if (expectedHead !== undefined && (before?.head ?? null) !== expectedHead) throw new Error('Assignment version changed')
      const inner = await signAssignment(identity, this.roomId, { v: 1, assignment: id, request, previous: before?.head ?? null, device: getPublicKey(opts.deviceSk), operation }, this.#now())
      checkReview()
      const projected = projectAssignments([...this.#events.values(), inner], this.roomId)
      const next = projected.assignments.find(s => s.id === id)
      if (!next || next.head !== inner.id || next.status === 'conflicted' || projected.pending.includes(inner.id)) throw new Error('This update is not permitted in the current assignment state')
      const credential = opts.credential()
      if (!credential || credential.pubkey !== identity.pubkey) throw new Error('No current room credential')
      const outer = encodeChatEvent({ id: bytesToHex(randomBytes(16)), participant: identity.pubkey, device: getPublicKey(opts.deviceSk),
        credential, text: `Assignment ${operation.op}`, sentAt: this.#now(), assignment: inner,
        ...(opts.name ? { name: opts.name } : {}), ...(opts.proof ? { proof: opts.proof } : {}),
        ...(opts.owner ? { owner: opts.owner } : {}),
      }, { roomId: this.roomId, roomKey: opts.roomKey, deviceSk: opts.deviceSk, channel: ASSIGNMENT_CHANNEL, epoch: this.#epoch, expiresAt: opts.expiresAt })
      const saved: Pending = {inner, outer, ...(review ? {reviewRequired: true as const} : {})}
      const candidate = new Map(this.#outbox).set(request, saved)
      checkReview()
      await this.#persist(this.#events, candidate)
      this.#outbox.set(request, saved); this.#emit()
      return saved
    })
    if (pending.outer) {
      checkReview()
      if (this.#closed) throw new Error('The assignment room has closed')
      if (!decodeChatEvent(pending.outer, { roomId: this.roomId, roomKey: this.#opts.roomKey, channel: ASSIGNMENT_CHANNEL, epoch: this.#epoch, policy: this.#opts.policy, now: this.#now() })) {
        throw new Error('Room access changed; this pending operation cannot be republished')
      }
      await this.#opts.transport.publish(pending.outer)
      await this.#serial(async () => {
        const events = new Map(this.#events).set(pending.inner.id, pending.inner)
        const outbox = new Map(this.#outbox); outbox.delete(request)
        await this.#persist(events, outbox)
        this.#events.set(pending.inner.id, pending.inner); this.#outbox.delete(request); this.#emit()
      })
    }
    const id = assignmentPayload(pending.inner, this.roomId)!.assignment
    return this.snapshot().assignments.find(s => s.id === id)!
  }

  async retry(): Promise<void> {
    if ('readOnly' in this.#opts) throw new Error('Open the origin room to retry assignment updates')
    for (const [request, pending] of [...this.#outbox]) {
      const p = assignmentPayload(pending.inner, this.roomId)!
      await this.submit(p.operation.op === 'create' ? undefined : p.assignment, p.operation, request)
    }
  }
  rekey(epoch: EpochRoot): void { if (this.#closed) return; this.#epoch = epoch; if (this.#opened) this.#subscribe() }
  close(): void {
    this.#closed = true; ++this.#generation; this.#unsub?.(); this.#listeners.clear()
    if ('readOnly' in this.#opts) this.#clear()
  }
}
