import { nip44 } from 'nostr-tools'
import { getPublicKey, type Event } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { encodeChatEvent, decodeChatEvent, deriveChannel, type EpochRoot } from './chat.js'
import { KINDS } from './kinds.js'
import type { ParticipantIdentity } from './identity.js'
import type { RelayTransport } from './relay-pool.js'
import type { AgentOwnership, DeviceCredential, KindredProof, RoomPolicy } from './types.js'
import { assignmentId, assignmentPayload, ASSIGNMENT_CHANNEL, projectAssignments, signAssignment, type Assignment, type AssignmentOperation } from './assignments.js'

/** An adapter must make each replace atomic and report storage failures. The
 * string is already encrypted; neither task IDs nor participant keys are clear. */
export interface AssignmentStorage {
  load(): Promise<string | undefined>
  save(encrypted: string): Promise<void>
}
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
}
interface Pending { inner: Event; outer: Event }
export interface AssignmentLogSnapshot {
  assignments: Assignment[]
  ready: boolean
  error?: string
  pendingHistory: number
  pendingSends: number
}

/** Durable assignment history is separate from the 500-message chat window.
 * It queries the whole retained stream and persists signed inner events before
 * reporting changes. The relay still controls availability; EOSE is not a
 * promise of permanent retention or proof that a malicious relay omitted nothing. */
export class AssignmentLog {
  readonly #opts: AssignmentLogOptions
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

  constructor(opts: AssignmentLogOptions) { this.#opts = opts; this.#epoch = opts.epoch }
  get participant(): string { return this.#opts.identity?.pubkey ?? this.#opts.credential()?.pubkey ?? '' }
  get roomId(): string { return this.#opts.roomId }
  snapshot(): AssignmentLogSnapshot {
    const p = projectAssignments([...this.#events.values()], this.roomId)
    return { assignments: p.assignments, ready: this.#ready && !this.#error && !this.#closed && p.pending.length === 0,
      ...(this.#error ? { error: this.#error } : {}), pendingHistory: p.pending.length, pendingSends: this.#outbox.size }
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
      const stored = await this.#opts.storage.load()
      if (stored) {
        const cache = JSON.parse(stored) as { v: number; events: string[]; outbox: string[] }
        if (cache.v !== 1 || !Array.isArray(cache.events) || !Array.isArray(cache.outbox) || cache.events.length > 20_000 || cache.outbox.length > 100) throw new Error('Invalid assignment cache')
        for (const encrypted of cache.events) {
          const event = JSON.parse(nip44.v2.decrypt(encrypted, this.#opts.roomKey)) as Event
          if (!assignmentPayload(event, this.roomId)) throw new Error('Assignment cache failed authentication')
          this.#events.set(event.id, event)
        }
        for (const encrypted of cache.outbox) {
          const pending = JSON.parse(nip44.v2.decrypt(encrypted, this.#opts.roomKey)) as Pending
          const p = assignmentPayload(pending.inner, this.roomId)
          if (!p || pending.inner.pubkey !== this.participant) throw new Error('Assignment outbox failed authentication')
          this.#outbox.set(p.request, pending)
        }
      }
      this.#subscribe()
    } catch (e) { this.#fail(e); throw e }
  }

  #subscribe(): void {
    this.#unsub?.(); this.#ready = false
    const generation = ++this.#generation
    const root = this.#epoch ?? { id: this.roomId, key: this.#opts.roomKey }
    const { id } = deriveChannel(root.id, root.key, ASSIGNMENT_CHANNEL)
    this.#unsub = this.#opts.transport.subscribe([{ kinds: [KINDS.CHAT], '#d': [id] }], outer => {
      if (generation !== this.#generation || this.#closed) return
      const message = decodeChatEvent(outer, { roomId: this.roomId, roomKey: this.#opts.roomKey, channel: ASSIGNMENT_CHANNEL,
        epoch: this.#epoch, policy: this.#opts.policy, now: this.#now() })
      if (!message?.assignment) return
      const event = message.assignment
      void this.#serial(async () => {
        if (this.#events.has(event.id)) return
        if (this.#events.size >= 20_000) throw new Error('Assignment history is full; export it before continuing')
        const candidate = new Map(this.#events).set(event.id, event)
        await this.#persist(candidate, this.#outbox)
        this.#events.set(event.id, event); this.#emit()
      }).catch(e => this.#fail(e))
    }, () => {
      void this.#serial(async () => {
        if (generation !== this.#generation || this.#closed) return
        this.#ready = true; this.#emit()
      })
    })
  }

  #now(): number { return (this.#opts.now ?? (() => Math.floor(Date.now() / 1000)))() }
  async #persist(events: Map<string, Event>, outbox: Map<string, Pending>): Promise<void> {
    await this.#opts.storage.save(JSON.stringify({ v: 1,
      events: [...events.values()].map(e => nip44.v2.encrypt(JSON.stringify(e), this.#opts.roomKey)),
      outbox: [...outbox.values()].map(e => nip44.v2.encrypt(JSON.stringify(e), this.#opts.roomKey)),
    }))
  }

  /** Stable request IDs are mandatory at this boundary. Failed/ambiguous sends
   * remain in the encrypted outbox and retry the exact same signed operation. */
  async submit(assignment: string | undefined, operation: AssignmentOperation, request: string): Promise<Assignment> {
    const pending = await this.#serial(async () => {
      if (!this.snapshot().ready) throw new Error(this.#error ?? 'Wait for assignment history to finish loading')
      const identity = this.#opts.identity
      if (!identity) throw new Error('This device cannot sign assignment updates')
      const existing = [...this.#events.values()].find(e => e.pubkey === identity.pubkey && assignmentPayload(e, this.roomId)?.request === request)
      const retry = this.#outbox.get(request)
      const old = existing ?? retry?.inner
      if (old) {
        const payload = assignmentPayload(old, this.roomId)!
        if (JSON.stringify(payload.operation) !== JSON.stringify(operation) || (assignment && payload.assignment !== assignment)) throw new Error('Request ID already used for different work')
        return retry ?? { inner: old, outer: undefined }
      }
      if (this.#outbox.size) throw new Error('Resolve the pending assignment send before another update')
      const id = assignment ?? assignmentId(identity.pubkey, request)
      const before = this.snapshot().assignments.find(s => s.id === id)
      if (assignment && !before) throw new Error('Assignment history is missing')
      const inner = await signAssignment(identity, this.roomId, { v: 1, assignment: id, request, previous: before?.head ?? null, device: getPublicKey(this.#opts.deviceSk), operation }, this.#now())
      const projected = projectAssignments([...this.#events.values(), inner], this.roomId)
      const next = projected.assignments.find(s => s.id === id)
      if (!next || next.head !== inner.id || next.status === 'conflicted' || projected.pending.includes(inner.id)) throw new Error('This update is not permitted in the current assignment state')
      const credential = this.#opts.credential()
      if (!credential || credential.pubkey !== identity.pubkey) throw new Error('No current room credential')
      const outer = encodeChatEvent({ id: bytesToHex(randomBytes(16)), participant: identity.pubkey, device: getPublicKey(this.#opts.deviceSk),
        credential, text: `Assignment ${operation.op}`, sentAt: this.#now(), assignment: inner,
        ...(this.#opts.name ? { name: this.#opts.name } : {}), ...(this.#opts.proof ? { proof: this.#opts.proof } : {}),
        ...(this.#opts.owner ? { owner: this.#opts.owner } : {}),
      }, { roomId: this.roomId, roomKey: this.#opts.roomKey, deviceSk: this.#opts.deviceSk, channel: ASSIGNMENT_CHANNEL, epoch: this.#epoch })
      const candidate = new Map(this.#outbox).set(request, { inner, outer })
      await this.#persist(this.#events, candidate)
      this.#outbox.set(request, { inner, outer }); this.#emit()
      return { inner, outer }
    })
    if (pending.outer) {
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
    for (const [request, pending] of [...this.#outbox]) {
      const p = assignmentPayload(pending.inner, this.roomId)!
      await this.submit(p.operation.op === 'create' ? undefined : p.assignment, p.operation, request)
    }
  }
  rekey(epoch: EpochRoot): void { this.#epoch = epoch; if (this.#opened) this.#subscribe() }
  close(): void { this.#closed = true; ++this.#generation; this.#unsub?.(); this.#listeners.clear() }
}
