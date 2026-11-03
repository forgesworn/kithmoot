import { randomBytes } from 'node:crypto'
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { parseGroupEvent, type GroupEvent } from '../../group-grants.js'
import { NodeLedger, NodeRefusal, type NodeOperation, type NodeRoom } from './ledger.js'
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

/** The ledger is authoritative. Children are disposable projections. A failed
 * or interrupted projection is retried before a new admission is acknowledged. */
export class NodeSupervisor {
  #tail: Promise<unknown> = Promise.resolve()
  #queued = 0
  #timer?: ReturnType<typeof setInterval>
  #ticking = false
  #lastCollect = 0
  #ready = false
  readonly #receiptKey: Uint8Array
  constructor(readonly ledger: NodeLedger, readonly calls: CallBackend, readonly relay: RelayBackend,
    readonly host: string, receiptKey: Uint8Array, readonly now = () => Math.floor(Date.now() / 1000)) { this.#receiptKey = receiptKey }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.#queued >= 64) return Promise.reject(new NodeRefusal(429, 'node-busy'))
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
  enrol(room: NodeRoom): Promise<void> { return this.#serial(async () => { this.ledger.enrol(room); await this.#project() }) }
  apply(event: unknown): Promise<{ accepted: true }> {
    return this.#serial(async () => { this.ledger.apply(event); await this.#project(); return { accepted: true } })
  }
  async offer(room: string, device: string): Promise<NodeOffer> {
    return this.#serial(async () => {
      const record = this.ledger.room(room)
      if (!record || record.state !== 'active' || !this.ledger.devices().some(d => d.room === room && d.device === device && d.turn)) throw new NodeRefusal(403, 'access-required')
      await this.#project()
      return structuredClone((this.ledger.child(room, 'spry') as unknown as SpryState).offer)
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
    const results = await Promise.allSettled([
      (async () => {
        const status = await this.calls.status()
        if (!status.ready) throw new NodeRefusal(503, 'spry-not-ready')
        for (const room of rooms) {
          let state = this.ledger.child(room.room, 'spry') as unknown as SpryState | undefined
          if (!state) state = { offer: await this.calls.offer(room.room), revision: 0, devices: {} }
          else if (state.offer.expiresAt <= this.now() + 3600) {
            const offer = await this.calls.offer(room.room)
            state = { offer, revision: state.offer.token === offer.token ? state.revision : 0,
              devices: state.offer.token === offer.token ? state.devices : {} }
          }
          this.ledger.setChild(room.room, 'spry', state as unknown as Record<string, unknown>)
          const desired = Object.fromEntries(devices.filter(d => d.room === room.room && d.turn).map(d => [d.device, d.expires]))
          const remove = Object.keys(state.devices).filter(k => !(k in desired))
          for (const batch of chunks(remove)) {
            state.revision++
            this.ledger.setChild(room.room, 'spry', state as unknown as Record<string, unknown>)
            await this.calls.register(state.offer.token, state.revision, [], batch)
            for (const key of batch) delete state.devices[key]
          }
          // Re-send after restart/lapse and on admission retries. Persist the
          // union first so a lost add acknowledgement cannot hide a key from
          // a later revocation. Revision is persisted before every request.
          const additions = Object.keys(desired).filter(k => !status.leaseActive || state!.devices[k] !== desired[k] || this.ledger.child(room.room, 'shelter')?.pending === true)
          const groups = new Map<number, string[]>()
          for (const key of additions) { const end = desired[key]!; groups.set(end, [...(groups.get(end) ?? []), key]) }
          this.ledger.setChild(room.room, 'shelter', { pending: true })
          for (const [expiration, keys] of groups) for (const batch of chunks(keys)) {
            state.revision++
            for (const key of batch) state.devices[key] = desired[key]!
            this.ledger.setChild(room.room, 'spry', state as unknown as Record<string, unknown>)
            await this.calls.register(state.offer.token, state.revision, batch, [], expiration)
          }
          this.ledger.setChild(room.room, 'spry', state as unknown as Record<string, unknown>)
        }
        if (this.ledger.operations().some(op => op.phase === 'teardown' && op.result.callsRevoked !== true)) throw new NodeRefusal(503, 'call-removal-pending')
        await this.calls.lease()
      })(),
      this.relay.sync(rooms, devices),
    ])
    if (results.some(r => r.status === 'rejected')) { this.#ready = false; throw new NodeRefusal(503, 'children-pending') }
    for (const room of rooms) this.ledger.setChild(room.room, 'shelter', { pending: false })
    this.#ready = true
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
          const offer = state?.offer ?? await this.calls.offer(op.room)
          await this.calls.remove(offer.token)
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
