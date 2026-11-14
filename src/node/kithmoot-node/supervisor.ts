import { randomBytes } from 'node:crypto'
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { parseGroupEvent, type GroupEvent } from '../../group-grants.js'
import { NodeLedger, NodeRefusal, type DeviceAccess, type NodeOperation, type NodeRoom } from './ledger.js'
import { type CallBackend, type RelayBackend, type NodeOffer, type SpryState } from './backends.js'
import { NODE_VERSION } from './version.js'

export interface CloseRequest {
  operation: string
  room: string
  deadline: number
  reset: GroupEvent
  closure: Event
  events: Event[]
}
export interface OperationStatus { operation: string; phase: string; result: Record<string, unknown> }
const chunks = <T>(values: T[], size = 32): T[][] => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size))
const signature = (event: unknown): boolean => { try { return verifyEvent(JSON.parse(JSON.stringify(event))) } catch { return false } }

/** Spry counts every POST from one source address, and from one signing key,
 * in a fixed minute window and refuses the 121st. The supervisor is a single
 * source with a single key, so it paces itself: a burst of SPRY_BURST refilled
 * at SPRY_PER_MINUTE allows at most 100 POSTs in any 60 s, and at most 115 if
 * the supervisor restarts inside a window Spry already opened. */
const SPRY_BURST = 15, SPRY_PER_MINUTE = 85
/** Tokens only revocations and the lease may spend, so paced additions can
 * neither delay a revocation nor let the 15 s child lease lapse. */
const SPRY_RESERVE = 2
/** Longest a pass waits for budget; the client gives up on a request at 6 s. */
const SPRY_WAIT_MS = 3000
/** Spry's child lease lasts 15 s; renew once 5 s have passed, from the 2 s tick. */
const LEASE_REFRESH_MS = 5000
export interface SupervisorOptions { clock?: () => number; sleep?: (ms: number) => Promise<void> }
const budgetRefusal = (error: unknown): boolean => error instanceof NodeRefusal && error.code === 'spry-budget'
class SpryBudget {
  #tokens = SPRY_BURST
  #at: number
  constructor(readonly clock: () => number, readonly sleep: (ms: number) => Promise<void>) { this.#at = clock() }
  #refill(): void { const at = this.clock(); this.#tokens = Math.min(SPRY_BURST, this.#tokens + Math.max(0, at - this.#at) * SPRY_PER_MINUTE / 60000); this.#at = at }
  async take(deadline: number, priority: boolean): Promise<void> {
    const floor = priority ? 0 : SPRY_RESERVE
    for (this.#refill(); this.#tokens < floor + 1; this.#refill()) {
      const wait = Math.ceil((floor + 1 - this.#tokens) * 60000 / SPRY_PER_MINUTE)
      if (this.clock() + wait > deadline) throw new NodeRefusal(503, 'spry-budget')
      await this.sleep(wait)
    }
    this.#tokens -= 1
  }
  /** Spry refused for rate: something else spent the window, so spend nothing more until it refills. */
  exhaust(): void { this.#refill(); this.#tokens = Math.min(this.#tokens, 0) }
}

/** The ledger is authoritative. Children are disposable projections. A failed
 * or interrupted projection is retried before a new admission is acknowledged. */
export class NodeSupervisor {
  #tail: Promise<unknown> = Promise.resolve()
  #queued = 0
  #timer?: ReturnType<typeof setInterval>
  #ticking = false
  #lastCollect = 0
  #ready = false
  /** A queued reconcile that has not started yet; later mutations join it. */
  #nextPass?: Promise<void>
  #leasedAt = -Infinity
  /** Set once per observed lapse of the child lease: every room was marked for
   * re-sending, and registrations Spry has acknowledged since, held here as
   * room, device and expiry, are not re-sent again. */
  #recovering = false
  readonly #recovered = new Set<string>()
  readonly #clock: () => number
  readonly #budget: SpryBudget
  readonly #receiptKey: Uint8Array
  constructor(readonly ledger: NodeLedger, readonly calls: CallBackend, readonly relay: RelayBackend,
    readonly host: string, receiptKey: Uint8Array, readonly now = () => Math.floor(Date.now() / 1000), options: SupervisorOptions = {}) {
    this.#receiptKey = receiptKey
    this.#clock = options.clock ?? Date.now
    this.#budget = new SpryBudget(this.#clock, options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))
  }
  #serial<T>(work: () => Promise<T>, bounded = true): Promise<T> {
    if (bounded && this.#queued >= 64) return Promise.reject(new NodeRefusal(429, 'node-busy'))
    this.#queued++
    const result = this.#tail.then(work)
    this.#tail = result.catch(() => {}).finally(() => { this.#queued-- })
    return result
  }
  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.tick().catch(() => {}) }, 2000)
    this.#timer.unref()
    void this.tick().catch(() => {})
  }
  async stop(): Promise<void> { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; await this.#tail }
  prepareDeletion(): Promise<{ deleteReady: true }> {
    return this.#serial(async () => {
      if (!this.#ready && this.ledger.meta('deleting') !== '1') throw new NodeRefusal(503, 'node-reconciling')
      this.ledger.prepareDeletion()
      return { deleteReady: true }
    })
  }
  cancelDeletion(): Promise<{ deleteReady: false }> {
    return this.#serial(async () => { this.ledger.setMeta('deleting', '0'); return { deleteReady: false } })
  }
  enrol(room: NodeRoom): Promise<void> { return this.#serial(async () => { this.ledger.enrol(room) }).then(() => this.#reconcile()) }
  apply(event: unknown): Promise<{ accepted: true }> {
    return this.#serial(async () => { this.ledger.apply(event) }).then(() => this.#reconcile()).then(() => ({ accepted: true as const }))
  }
  /** Projects every committed mutation. A caller's ledger write has already
   * committed, so any pass that has not started yet covers it: concurrent
   * mutations share one queued pass behind the one in flight. The pass is not
   * counted against the queue limit, because at most one waits at a time. */
  #reconcile(): Promise<void> {
    if (this.#nextPass) return this.#nextPass
    const pass = this.#serial(async () => { if (this.#nextPass === pass) this.#nextPass = undefined; await this.#project() }, false)
    this.#nextPass = pass
    return pass
  }
  /** One Spry POST within the pacing budget. Spry's rate gate refuses before
   * it reads the request, so a 429 was not applied; `send` is retried once and
   * must persist a fresh revision itself on each call. */
  async #spry<T>(deadline: number, send: () => Promise<T>, priority = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.#budget.take(deadline, priority)
      try { return await send() } catch (error) {
        if (attempt > 0 || !(error instanceof NodeRefusal) || error.code !== 'spry-http-429') throw error
        this.#budget.exhaust()
      }
    }
  }
  async offer(room: string, device: string): Promise<NodeOffer> {
    return this.#serial(async () => {
      const record = this.ledger.room(room)
      const access = this.ledger.devices().find(d => d.room === room && d.device === device && d.turn)
      if (!record || record.state !== 'active' || !access) throw new NodeRefusal(403, 'access-required')
      // Access polls read the last acknowledged projection. Re-projecting all
      // rooms here renews the child lease on every device poll, exhausting
      // Spry's write budget and then amplifying the failure with retries.
      // Mutations and the periodic tick own reconciliation and lease renewal.
      const state = this.ledger.child(room, 'spry') as unknown as SpryState | undefined
      if (!this.#ready || !state || state.offer.expiresAt <= this.now() || state.devices[device] !== access.expires) throw new NodeRefusal(503, 'node-reconciling')
      return structuredClone(state.offer)
    })
  }
  tick(): Promise<void> {
    if (this.#ticking) return Promise.resolve()
    this.#ticking = true
    return this.#serial(async () => {
      const now = this.now()
      for (const room of this.ledger.rooms()) if (room.ends !== undefined && room.ends <= now && room.state === 'active') {
        this.ledger.beginOperation(randomBytes(16).toString('hex'), room.room, { type: 'expired', deadline: room.ends })
      }
      // A failed operation must not prevent another room's removal or lease.
      const results = await Promise.allSettled(this.ledger.operations().map(op => this.#resume(op)))
      let projected = true
      try { await this.#project() } catch { projected = false }
      this.#ready = projected && results.every(r => r.status === 'fulfilled')
      if (now - this.#lastCollect >= 60) { this.ledger.collect(); this.#lastCollect = now }
      if (!this.#ready) throw new NodeRefusal(503, 'node-reconciling')
    }).finally(() => { this.#ticking = false })
  }
  status(): { v: 1; ready: boolean; paired: boolean; rooms: number; devices: number; pending: number; deleting?: true } {
    const deleting = this.ledger.meta('deleting') === '1'
    return { v: 1, ready: this.#ready && !deleting, paired: !!this.ledger.meta('owner'), rooms: this.ledger.rooms().length,
      devices: this.ledger.devices().length, pending: this.ledger.operations().length, ...(deleting ? { deleting: true as const } : {}) }
  }
  async ownerStatus(): Promise<ReturnType<NodeSupervisor['status']> & {
    version: string; turnReady: boolean; relayReady: boolean; storeBytes?: number
  }> {
    const [calls, relay] = await Promise.allSettled([this.calls.status(), this.relay.status()])
    const state = this.status()
    const turnReady = calls.status === 'fulfilled' && calls.value.ready && (state.devices === 0 || calls.value.leaseActive)
    const relayReady = relay.status === 'fulfilled' && (state.rooms === 0 || relay.value.leaseActive)
    return { ...state, version: NODE_VERSION, ready: state.ready && turnReady && relayReady, turnReady, relayReady,
      ...(relay.status === 'fulfilled' ? { storeBytes: relay.value.usedBytes } : {}) }
  }
  operation(id: string): OperationStatus {
    const operation = this.ledger.operation(id)
    if (!operation) throw new NodeRefusal(404, 'operation-not-found')
    return { operation: operation.id, phase: operation.phase, result: operation.result }
  }
  close(actor: string, request: CloseRequest): Promise<OperationStatus> {
    return this.#serial(async () => {
      const { operation, room, ...payload } = request
      const old = this.ledger.operation(operation)
      if (old) {
        if (request.reset?.pubkey !== actor) throw new NodeRefusal(403, 'room-authority-required')
        this.ledger.beginOperation(operation, room, payload) // immutable request binding survives erasure
      } else {
        const record = this.ledger.room(room), now = this.now()
        if (!record || record.authority !== actor) throw new NodeRefusal(403, 'room-authority-required')
        if (!Number.isSafeInteger(request.deadline) || request.deadline < now || request.deadline > now + 120) throw new NodeRefusal(400, 'invalid-drain-deadline')
        const reset = parseGroupEvent(request.reset, { now, servers: [this.host], keepers: [actor] })
        if (!reset.ok || reset.parsed.type !== 'reset' || reset.parsed.roomId !== room || reset.parsed.createdAt < now - 60) throw new NodeRefusal(400, 'invalid-close-reset')
        // Canonical reset tags make the later compact proof reconstructable
        // using the member's pinned room authority, room ID and node host.
        const canonical = [['t', 'reset'], ['d', room], ['server', this.host], ['expiration', String(reset.parsed.expiration)]]
        if (JSON.stringify(request.reset.tags) !== JSON.stringify(canonical)) throw new NodeRefusal(400, 'noncanonical-close-reset')
        const closure = request.closure
        const closeTags = [['t', 'closed'], ['d', room], ['server', this.host], ['operation', operation], ['expiration', String((closure?.created_at ?? 0) + 30 * 86400)]]
        if (!closure || Object.keys(closure).length !== 7 || closure.kind !== 27543 || closure.pubkey !== actor || closure.content !== ''
          || !Number.isSafeInteger(closure.created_at) || closure.created_at < now - 60 || closure.created_at > now + 30
          || JSON.stringify(closure.tags) !== JSON.stringify(closeTags) || !signature(closure)) throw new NodeRefusal(400, 'invalid-close-statement')
        if (!Array.isArray(request.events) || request.events.length !== 2 || request.events.some(e => !e || typeof e !== 'object') || new Set(request.events.map(e => e.kind)).size !== 2) throw new NodeRefusal(400, 'invalid-closing-events')
        for (const event of request.events) {
          const expiration = Array.isArray(event.tags) ? event.tags.filter(t => Array.isArray(t) && t[0] === 'expiration') : []
          if (Object.keys(event).length !== 7 || ![1461, 1462].includes(event.kind) || event.pubkey !== actor
            || Buffer.byteLength(JSON.stringify(event)) > 256 * 1024 || event.created_at < now - 60 || event.created_at > now + 30 || !signature(event)
            || expiration.length !== 1 || expiration[0]!.length !== 2 || !/^[1-9][0-9]*$/.test(expiration[0]![1]!)
            || Number(expiration[0]![1]) <= request.deadline || Number(expiration[0]![1]) > now + 30 * 86400) throw new NodeRefusal(400, 'invalid-closing-events')
        }
        this.ledger.beginOperation(operation, room, payload)
      }
      try { await this.#resume(this.ledger.operation(operation)!) } catch { /* durable pending state is returned to the caller */ }
      return this.operation(operation)
    })
  }
  #tearingDown(room: string): boolean {
    return this.ledger.operations().some(op => op.room === room && (op.phase === 'teardown' || Number(op.payload.deadline) <= this.now()))
  }
  async #project(): Promise<void> {
    const rooms = this.ledger.rooms().filter(r => !this.#tearingDown(r.room))
    const devices = this.ledger.devices().filter(d => rooms.some(r => r.room === d.room))
    const acknowledged: string[] = []
    const results = await Promise.allSettled([this.#projectCalls(rooms, devices, acknowledged), this.relay.sync(rooms, devices)])
    // A room's re-send mark clears only once Spry acknowledged its additions
    // and the relay holds the same projection; any other room keeps its mark.
    if (results[1].status === 'fulfilled') for (const room of acknowledged) this.ledger.setChild(room, 'shelter', { pending: false })
    if (results.some(r => r.status === 'rejected')) { this.#ready = false; throw new NodeRefusal(503, 'children-pending') }
    this.#ready = true
  }
  #desired(room: string, devices: DeviceAccess[]): Record<string, number> {
    return Object.fromEntries(devices.filter(d => d.room === room && d.turn).map(d => [d.device, d.expires]))
  }
  async #projectCalls(rooms: NodeRoom[], devices: DeviceAccess[], acknowledged: string[]): Promise<void> {
    const deadline = this.#clock() + SPRY_WAIT_MS
    const status = await this.calls.status()
    if (!status.ready) throw new NodeRefusal(503, 'spry-not-ready')
    if (!status.leaseActive && !this.#recovering) {
      // Re-send after restart or lapse. The durable marks let a paced
      // recovery resume where it stopped instead of starting again.
      for (const room of rooms) this.ledger.setChild(room.room, 'shelter', { pending: true })
      this.#recovering = true; this.#recovered.clear()
    }
    // Once the budget runs out, offers and additions wait for a later pass,
    // but every remaining room is still walked for removals.
    let shortfall: unknown
    for (const room of rooms) {
      let state = this.ledger.child(room.room, 'spry') as unknown as SpryState | undefined
      try {
        if (!state) { if (shortfall) continue; state = { offer: await this.#spry(deadline, () => this.calls.offer(room.room)), revision: 0, devices: {} } }
        else if (state.offer.expiresAt <= this.now() + 3600 && !shortfall) {
          const offer = await this.#spry(deadline, () => this.calls.offer(room.room))
          state = { offer, revision: state.offer.token === offer.token ? state.revision : 0,
            devices: state.offer.token === offer.token ? state.devices : {} }
        }
      } catch (error) {
        if (!budgetRefusal(error)) throw error
        // An offer with more than ten minutes left is renewed by a later pass.
        if (!state || state.offer.expiresAt <= this.now() + 600) shortfall = error
        if (!state) continue
      }
      const current = state
      this.ledger.setChild(room.room, 'spry', current as unknown as Record<string, unknown>)
      const desired = this.#desired(room.room, devices)
      const remove = Object.keys(current.devices).filter(k => !(k in desired))
      for (const batch of chunks(remove)) {
        await this.#spry(deadline, () => {
          current.revision++
          this.ledger.setChild(room.room, 'spry', current as unknown as Record<string, unknown>)
          return this.calls.register(current.offer.token, current.revision, [], batch)
        }, true)
        for (const key of batch) delete current.devices[key]
      }
      this.ledger.setChild(room.room, 'spry', current as unknown as Record<string, unknown>)
      if (shortfall) continue
      // Re-send after restart/lapse and on admission retries. Persist the
      // union first so a lost add acknowledgement cannot hide a key from
      // a later revocation. Revision is persisted before every request.
      // Only a room whose additions this pass sends is marked.
      const marked = this.ledger.child(room.room, 'shelter')?.pending === true
      const additions = Object.keys(desired).filter(k => current.devices[k] !== desired[k] || marked && !this.#recovered.has(`${room.room}:${k}:${desired[k]}`))
      const groups = new Map<number, string[]>()
      for (const key of additions) { const end = desired[key]!; groups.set(end, [...(groups.get(end) ?? []), key]) }
      if (additions.length && !marked) this.ledger.setChild(room.room, 'shelter', { pending: true })
      try {
        for (const [expiration, keys] of groups) for (const batch of chunks(keys)) {
          await this.#spry(deadline, () => {
            current.revision++
            for (const key of batch) current.devices[key] = desired[key]!
            this.ledger.setChild(room.room, 'spry', current as unknown as Record<string, unknown>)
            return this.calls.register(current.offer.token, current.revision, batch, [], expiration)
          })
          if (this.#recovering) for (const key of batch) this.#recovered.add(`${room.room}:${key}:${expiration}`)
        }
      } catch (error) { if (!budgetRefusal(error)) throw error; shortfall = error; continue }
      this.ledger.setChild(room.room, 'spry', current as unknown as Record<string, unknown>)
      if (marked || additions.length) acknowledged.push(room.room)
    }
    if (this.ledger.operations().some(op => op.phase === 'teardown' && op.result.callsRevoked !== true)) throw new NodeRefusal(503, 'call-removal-pending')
    const due = this.#clock() - this.#leasedAt >= LEASE_REFRESH_MS
    if (shortfall) {
      // Only pacing stopped this pass. The lease is renewed solely when it is
      // live and Spry holds nothing the ledger no longer wants; any revocation
      // still owed lets it lapse, as every other failed pass does.
      if (due && status.leaseActive && !this.#recovering && !this.#owesRemoval(rooms, devices)) await this.#lease(deadline)
      throw shortfall
    }
    if (due || !status.leaseActive || this.#recovering) {
      await this.#lease(deadline)
      this.#recovering = false; this.#recovered.clear()
    }
  }
  async #lease(deadline: number): Promise<void> {
    const at = this.#clock()
    await this.#spry(deadline, () => this.calls.lease(), true)
    this.#leasedAt = at
  }
  /** Whether any persisted registration, including one whose acknowledgement
   * was lost, is absent from the ledger or outlives the ledger's expiry. */
  #owesRemoval(rooms: NodeRoom[], devices: DeviceAccess[]): boolean {
    return rooms.some(room => {
      const state = this.ledger.child(room.room, 'spry') as unknown as SpryState | undefined
      const desired = this.#desired(room.room, devices)
      return !!state && Object.entries(state.devices).some(([key, end]) => !(key in desired) || end > desired[key]!)
    })
  }
  async #resume(initial: NodeOperation): Promise<void> {
    let op = this.ledger.operation(initial.id)!
    if (op.phase === 'done') return
    if (op.phase === 'publishing') {
      if (op.payload.type !== 'expired') {
        try {
          await this.relay.publish(op.room, op.payload.events as Event[])
          this.ledger.advance(op.id, 'draining', { ...op.result, published: true })
        } catch (error) { if (this.now() < Number(op.payload.deadline)) throw error }
      }
      op = this.ledger.operation(op.id)!
      if (op.phase === 'publishing') this.ledger.advance(op.id, 'draining', { ...op.result, published: false })
    }
    op = this.ledger.operation(op.id)!
    if (op.phase === 'draining') {
      if (this.now() < Number(op.payload.deadline)) return
      if (op.payload.reset) this.ledger.apply(op.payload.reset)
      this.ledger.advance(op.id, 'teardown', op.result)
    }
    op = this.ledger.operation(op.id)!
    if (op.phase === 'teardown') {
      const state = this.ledger.child(op.room, 'spry') as unknown as SpryState | undefined
      const result = { ...op.result }
      await Promise.allSettled([
        (async () => {
          if (result.callsRevoked === true) return
          // Even an empty room may have a grant whose creation ACK was lost.
          const deadline = this.#clock() + SPRY_WAIT_MS
          const offer = state?.offer ?? await this.#spry(deadline, () => this.calls.offer(op.room), true)
          await this.#spry(deadline, () => this.calls.remove(offer.token), true)
          result.callsRevoked = true
          this.ledger.advance(op.id, 'teardown', result)
        })(),
        (async () => {
          if (result.relayPurged === true) return
          const count = await this.relay.purge(op.room)
          result.relayPurged = true; result.eventsDeleted = count
          this.ledger.advance(op.id, 'teardown', result)
        })(),
      ])
      if (result.callsRevoked !== true || result.relayPurged !== true) throw new NodeRefusal(503, 'teardown-pending')
      const closure = op.payload.closure as Event | undefined
      this.ledger.eraseRoom(op.id, closure ? { id: closure.id, sig: closure.sig, createdAt: closure.created_at,
        operation: op.id, expiration: closure.tags.find(t => t[0] === 'expiration')![1] } : undefined)
    }
    op = this.ledger.operation(op.id)!
    if (op.phase === 'erasing') {
      const now = this.now(), result = { ...op.result, completedAt: now }
      const receipt = finalizeEvent({ kind: 27544, created_at: now, content: JSON.stringify({ v: 1, operation: op.id, ...result }),
        tags: [['operation', op.id], ['expiration', String(now + 30 * 86400)]] }, this.#receiptKey)
      this.ledger.finishErasure(op.id, { ...result, receipt })
    }
  }
}
