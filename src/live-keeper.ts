import { getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import {
  createRoomInvitation, deriveInvitationId, deriveRoom, deriveEpoch, generateRoomSecret,
  encodePersistentInvitation, decodePersistentInvitation, encodeInvitationRetirement,
  decodeInvitationRetirementNotice, decodeLivePersistentRequest, encodeLivePersistentAnswer,
  readRekeyEvidence, epochCommitment, verifyEventUncached,
  type RoomInvitation,
} from '@forgesworn/fold-kit'
import { parseKeeperState, serialiseKeeperState } from './keeper-state.js'
import type { KeeperState } from './agent.js'

/** Each adapter must keep exclusive ownership until close, and durably replace complete records. */
export interface LiveKeeperStore {
  load(): string | undefined
  save(record: string): void
  close(): void
}

type Phase = 'active' | 'retired' | 'closed'
interface Pending { events: Event[]; next: string; phase: Phase }
interface CachedAnswer { request: Event; answer: Event; epoch: number; offers: number }
interface Reservation { at: number; bytes: number; challenge: boolean; check: boolean }
interface Journal {
  v: 1
  revision: number
  phase: Phase
  keeper: string
  welcome: Event
  lastAt: number
  pending: Pending | null
  answers: CachedAnswer[]
  reservations: Reservation[]
}

const MAX_BYTES = 2 * 1024 * 1024
const HEX = /^[0-9a-f]{64}$/
const MAX_EPOCH = 0x7fffffff
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const size = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
function requireValue(ok: unknown, message = 'invalid live keeper journal'): asserts ok {
  if (!ok) throw new Error(message)
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function phase(value: unknown): value is Phase { return value === 'active' || value === 'retired' || value === 'closed' }
function keeper(raw: string): KeeperState {
  requireValue(typeof raw === 'string' && raw.length <= MAX_BYTES)
  const state = parseKeeperState(raw)
  // The old reader intentionally tolerates missing optional data. This owner cannot.
  requireValue(serialiseKeeperState(state) === raw && state.persistent === true)
  requireValue(integer(state.epoch) && state.epoch <= MAX_EPOCH)
  getPublicKey(state.inviterSk)
  return state
}
function invitation(state: KeeperState): RoomInvitation {
  return { bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true }
}
function context(state: KeeperState) { return { invitation: invitation(state), roomId: deriveRoom(state.secret).roomId } }
function boundedEvent(event: Event): void {
  requireValue(event && typeof event.content === 'string' && event.content.length <= 24_000)
  requireValue(Array.isArray(event.tags) && event.tags.length <= 16 && event.tags.every(t => Array.isArray(t) && t.length <= 4 && t.every(v => typeof v === 'string' && v.length <= 256)))
  requireValue(typeof event.id === 'string' && HEX.test(event.id) && typeof event.pubkey === 'string' && HEX.test(event.pubkey))
  requireValue(typeof event.sig === 'string' && /^[0-9a-f]{128}$/.test(event.sig) && size(event) <= 32_768)
}

function validateNext(current: KeeperState, next: KeeperState, event: Event): void {
  boundedEvent(event)
  requireValue(same([...current.secret], [...next.secret]) && same([...current.inviterSk], [...next.inviterSk]) && same([...current.bearer], [...next.bearer]))
  requireValue(current.endsAt === next.endsAt && (!current.destruct || next.destruct === true))
  requireValue(!current.closed && next.epoch === current.epoch! + 1 && next.epoch! <= MAX_EPOCH && next.epochSecret?.length === 32)
  const evidence = readRekeyEvidence(event, { roomId: deriveRoom(current.secret).roomId, authority: getPublicKey(current.inviterSk),
    previous: deriveEpoch({ epoch: current.epoch!, secret: current.epoch === 0 ? current.secret : current.epochSecret! }) })
  requireValue(evidence !== null && evidence.commit === epochCommitment(deriveRoom(current.secret).roomId, next.epoch!, next.epochSecret!))
  requireValue(evidence.closed === (next.closed === true) && (!evidence.destruct || next.destruct === true))
  requireValue(!next.destruct || current.destruct || evidence.destruct)
  requireValue(same(next.removed ?? [], [...new Set([...(current.removed ?? []), ...evidence.removed])].sort()))
  requireValue(evidence.members !== undefined && same(next.members ?? [], evidence.members))
  requireValue(next.epochAt === event.created_at)
}

function readJournal(raw: string): Journal {
  requireValue(raw.length <= MAX_BYTES && new TextEncoder().encode(raw).length <= MAX_BYTES)
  const data = JSON.parse(raw) as Journal
  requireValue(data && same(Object.keys(data).sort(), ['v', 'revision', 'phase', 'keeper', 'welcome', 'lastAt', 'pending', 'answers', 'reservations'].sort()))
  requireValue(data.v === 1 && integer(data.revision) && integer(data.lastAt) && phase(data.phase))
  requireValue(JSON.stringify(data) === raw)
  const state = keeper(data.keeper)
  boundedEvent(data.welcome)
  const decoded = decodePersistentInvitation(data.welcome, invitation(state))
  requireValue(decoded && same([...decoded.secret], [...state.secret]) && decoded.endsAt === state.endsAt &&
    (state.closed ? (!decoded.destruct || state.destruct) : !!decoded.destruct === !!state.destruct))
  requireValue((data.phase === 'closed') === !!state.closed || (data.phase === 'closed' && data.pending !== null))
  requireValue(Array.isArray(data.answers) && data.answers.length <= 128)
  const ids = new Set<string>()
  for (const cached of data.answers) {
    requireValue(cached && integer(cached.offers) && cached.offers >= 1 && cached.offers <= 3)
    requireValue(integer(cached.epoch) && cached.epoch <= state.epoch!)
    boundedEvent(cached.request); boundedEvent(cached.answer)
    const request = decodeLivePersistentRequest(cached.request, { ...context(state), now: cached.answer.created_at })
    requireValue(request && !ids.has(request.requestId) && cached.answer.pubkey === getPublicKey(state.inviterSk))
    requireValue(verifyEventUncached(cached.answer) && cached.answer.kind === 20467)
    requireValue(same(cached.answer.tags, [['d', deriveInvitationId(invitation(state))], ['p', request.requester],
      ['expiration', String(Math.min(request.expiresAt, cached.answer.created_at + 30))]]))
    const plaintext = nip44.v2.decrypt(cached.answer.content, nip44.v2.utils.getConversationKey(state.inviterSk, request.requester))
    const w = data.welcome
    requireValue(plaintext === JSON.stringify({ v: 1, profile: 'persistent-live', request: request.requestId,
      room: context(state).roomId, epoch: cached.epoch, invitation: { id: w.id, pubkey: w.pubkey,
        created_at: w.created_at, kind: w.kind, tags: w.tags, content: w.content, sig: w.sig } }))
    ids.add(request.requestId)
  }
  requireValue(Array.isArray(data.reservations) && data.reservations.length <= 256)
  for (const r of data.reservations) requireValue(integer(r.at) && r.at <= data.lastAt && integer(r.bytes) && r.bytes <= 65536 && typeof r.challenge === 'boolean' && typeof r.check === 'boolean')
  if (data.pending !== null) {
    const pending = data.pending
    requireValue(pending && phase(pending.phase) && Array.isArray(pending.events) && pending.events.length >= 1 && pending.events.length <= 2)
    const next = keeper(pending.next)
    pending.events.forEach(boundedEvent)
    const rekeys = pending.events.filter(e => e.kind === 1462)
    requireValue(rekeys.length <= 1)
    const rekey = rekeys[0]
    if (rekey) validateNext(state, next, rekey)
    else requireValue(pending.phase === 'retired' && pending.next === data.keeper && pending.events.length === 1)
    const tombstones = pending.events.filter(e => e.kind === 1461)
    for (const tombstone of tombstones) {
      const notice = decodeInvitationRetirementNotice(tombstone, invitation(state))
      requireValue(notice && (pending.phase !== 'closed' || notice.ended))
    }
    requireValue(pending.events.every(e => e.kind === 1461 || e.kind === 1462))
    requireValue(pending.phase === 'closed' ? !!next.closed && tombstones.length === 1 : !next.closed)
    requireValue(pending.phase === 'active' ? data.phase === 'active' && tombstones.length === 0 : data.phase === pending.phase)
  }
  return data
}

/** One-room authority primitive. Do not attach beside a root session that bypasses its transitions. */
export class LiveKeeperJournal {
  #data: Journal
  #tail: Promise<unknown> = Promise.resolve()
  #queued = 0
  #closed = false
  #poisoned = false
  private constructor(private readonly store: LiveKeeperStore, data: Journal, private readonly now: () => number) { this.#data = data }

  static create(store: LiveKeeperStore, opts: { relays?: string[]; now?: () => number; endsAt?: number; destruct?: boolean }): LiveKeeperJournal {
    try {
      requireValue(store.load() === undefined, 'live keeper journal already exists')
      const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
      const at = now(); requireValue(integer(at) && at <= Number.MAX_SAFE_INTEGER - 90)
      const host = createRoomInvitation(true)
      const state: KeeperState = { secret: generateRoomSecret(), inviterSk: host.inviterSk, bearer: host.invitation.bearer, persistent: true, epoch: 0, removed: [],
        ...(opts.endsAt !== undefined ? { endsAt: opts.endsAt } : {}), ...(opts.destruct ? { destruct: true as const } : {}) }
      const welcome = encodePersistentInvitation({ invitation: host.invitation, inviterSk: host.inviterSk, roomSecret: state.secret,
        now: at, relays: opts.relays, endsAt: opts.endsAt, destruct: opts.destruct })
      const data: Journal = { v: 1, revision: 0, phase: 'active', keeper: serialiseKeeperState(state), welcome: copy(welcome), lastAt: at, pending: null, answers: [], reservations: [] }
      const serialised = JSON.stringify(data)
      readJournal(serialised)
      store.save(serialised)
      return new LiveKeeperJournal(store, data, now)
    } catch (error) { store.close(); throw error }
  }

  static open(store: LiveKeeperStore, now: () => number = () => Math.floor(Date.now() / 1000)): LiveKeeperJournal {
    try {
      const raw = store.load()
      requireValue(raw !== undefined, 'live keeper journal is missing; legacy exports cannot initialise it')
      return new LiveKeeperJournal(store, readJournal(raw), now)
    } catch (error) { store.close(); throw error }
  }

  snapshot(): KeeperState { return keeper(this.#data.keeper) }
  signedInvitation(): Event { return copy(this.#data.welcome) }
  relayPolicy(): string[] { return [...(decodePersistentInvitation(this.#data.welcome, invitation(this.snapshot()))!.relays ?? [])] }

  /** Same-epoch metadata only; epoch authority changes require a signed transition. */
  checkpoint(nextState: KeeperState): Promise<void> {
    const raw = serialiseKeeperState(nextState)
    return this.#run(() => {
      const current = this.snapshot(), next = keeper(raw)
      requireValue(!this.#data.pending && this.#data.phase !== 'closed', 'resolve the pending transition first')
      for (const field of ['secret', 'inviterSk', 'bearer', 'epochSecret'] as const) {
        requireValue(same(current[field] && [...current[field]!], next[field] && [...next[field]!]))
      }
      requireValue(current.epoch === next.epoch && same(current.removed ?? [], next.removed ?? []))
      requireValue(!!current.closed === !!next.closed && current.endsAt === next.endsAt && !!current.destruct === !!next.destruct)
      this.#save({ ...copy(this.#data), keeper: raw, lastAt: this.#time() })
    })
  }
  get status(): 'poisoned' | 'closed-owner' | 'pending' | Phase {
    return this.#poisoned ? 'poisoned' : this.#closed ? 'closed-owner' : this.#data.pending ? 'pending' : this.#data.phase
  }
  pendingEvents(): Event[] { return copy(this.#data.pending?.events ?? []) }

  #run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.#closed || this.#poisoned || this.#queued >= 128) return Promise.reject(new Error('live keeper owner unavailable'))
    this.#queued++
    const next = this.#tail.then(() => {
      requireValue(!this.#closed && !this.#poisoned, 'live keeper owner unavailable')
      return fn()
    })
    this.#tail = next.catch(() => {}).finally(() => { this.#queued-- })
    return next
  }

  #time(): number {
    const at = this.now()
    requireValue(integer(at) && at <= Number.MAX_SAFE_INTEGER - 90 && at >= this.#data.lastAt, 'live keeper clock moved backwards')
    return at
  }
  #save(next: Journal): void {
    try {
      next.revision = this.#data.revision + 1
      const raw = JSON.stringify(next)
      requireValue(integer(next.revision) && new TextEncoder().encode(raw).length <= MAX_BYTES)
      this.store.save(raw)
      this.#data = next
    } catch (error) { this.#poisoned = true; throw error }
  }
  #reserve(at: number, bytes: number, challenge: boolean, check = false, data = copy(this.#data)): boolean {
    const reservations = data.reservations.filter(r => r.at > at - 60)
    if (reservations.length >= 256 || reservations.reduce((sum, r) => sum + r.bytes, 0) + bytes > 65536 ||
      (challenge && reservations.filter(r => r.challenge).length >= 16) || (check && reservations.filter(r => r.check).length >= 64)) return false
    data.lastAt = at
    data.reservations = [...reservations, { at, bytes, challenge, check }]
    this.#save(data)
    return true
  }

  /** Returns local handoff only; exceptions/unknown handoffs keep the same cached answer. */
  answer(requestEvent: Event, publish: (event: Event) => Promise<void>, budget?: { check(): boolean; offer(bytes: number, fresh: boolean): boolean }): Promise<boolean> {
    // Cheap shape bounds precede allocation/queue admission and crypto.
    try { boundedEvent(requestEvent); if (size(requestEvent) > 4096) return Promise.resolve(false) } catch { return Promise.resolve(false) }
    const requestCopy = copy(requestEvent)
    return this.#run(async () => {
      const at = this.#time()
      if (this.#data.phase !== 'active' || this.#data.pending) return false
      if (budget && !budget.check()) return false
      const state = this.snapshot()
      if (state.endsAt !== undefined && state.endsAt <= at) return false
      if (!this.#reserve(at, 0, false, true)) return false
      const ctx = context(state)
      const request = decodeLivePersistentRequest(requestCopy, { ...ctx, now: at })
      if (!request) return false
      const data = copy(this.#data)
      data.answers = data.answers.filter(c => Number(c.request.tags.find(t => t[0] === 'expiration')?.[1]) > at)
      let cached = data.answers.find(c => c.request.id === request.requestId)
      const fresh = !cached
      if (cached && (cached.epoch !== state.epoch || cached.offers >= 3 || Number(cached.answer.tags.find(t => t[0] === 'expiration')?.[1]) <= at)) return false
      if (!cached) {
        if (data.answers.length >= 128) return false
        const answer = encodeLivePersistentAnswer({ ...ctx, request: requestCopy, invitationEvent: data.welcome,
          inviterSk: state.inviterSk, epoch: state.epoch!, now: at })
        cached = { request: requestCopy, answer: copy(answer), epoch: state.epoch!, offers: 0 }
        data.answers.push(cached)
      }
      cached.offers++
      if (budget && !budget.offer(size(cached.answer), fresh)) return false
      if (!this.#reserve(at, size(cached.answer), fresh, false, data)) return false
      await publish(copy(cached.answer))
      return true
    })
  }

  retire(): Promise<void> {
    return this.#run(() => {
      const at = this.#time()
      requireValue(!this.#data.pending, 'resolve the pending transition first')
      if (this.#data.phase !== 'active') return
      const state = this.snapshot()
      const event = encodeInvitationRetirement({ invitation: invitation(state), inviterSk: state.inviterSk, now: at, endsAt: state.endsAt })
      this.#save({ ...copy(this.#data), phase: 'retired', lastAt: at,
        pending: { events: [copy(event)], next: this.#data.keeper, phase: 'retired' } })
    })
  }

  /** Persist the exact next secret and signed notice before a root session hands it off. */
  prepareRekey(event: Event, nextState: KeeperState): Promise<void> {
    boundedEvent(event)
    const eventCopy = copy(event), next = serialiseKeeperState(nextState)
    return this.#run(() => {
      const at = this.#time(), current = this.snapshot(), state = keeper(next)
      requireValue(!this.#data.pending && this.#data.phase !== 'closed', 'resolve the pending transition first')
      validateNext(current, state, eventCopy)
      requireValue(eventCopy.created_at <= at + 5 && eventCopy.created_at >= at - 90)
      const target: Phase = state.closed ? 'closed' : this.#data.phase
      const events: Event[] = []
      if (state.closed) events.push(copy(encodeInvitationRetirement({ invitation: invitation(current), inviterSk: current.inviterSk,
        now: at, ended: true, destruct: state.destruct, endsAt: current.endsAt })))
      events.push(eventCopy)
      this.#save({ ...copy(this.#data), lastAt: at, phase: target, pending: { events, next, phase: target } })
    })
  }

  /** Resume only the retained bytes. A throw leaves pending state; no competing epoch can be signed here. */
  offerPending(publish: (event: Event) => Promise<void>): Promise<boolean> {
    return this.#run(async () => {
      const pending = this.#data.pending
      if (!pending) return false
      for (const event of pending.events) {
        if (!this.#reserve(this.#time(), size(event), false)) return false
        await publish(copy(event))
      }
      this.#save({ ...copy(this.#data), keeper: pending.next, phase: pending.phase, pending: null,
        // Epoch changes invalidate cached active proofs; leave their request guards
        // until expiry so a retry cannot be re-signed with conflicting state.
      })
      return true
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.#tail
    this.store.close()
  }
}
