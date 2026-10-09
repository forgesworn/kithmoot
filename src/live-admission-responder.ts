import { randomBytes } from '@noble/hashes/utils'
import { deriveInvitationId, deriveRoom } from '@forgesworn/fold-kit'
import { getPublicKey } from 'nostr-tools/pure'
import type { LiveKeeperJournal, LiveKeeperStore } from './live-keeper.js'
import type { RelayTransport } from './relay-pool.js'

type Reservation = { at: number; checks: number; challenges: number; bytes: number }
type Ledger = { v: 1; kind: 'live-admission-budget'; id: string; lastAt: number; reservations: Reservation[] }
let processOwner: LiveAdmissionBudget | undefined
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
function requireValue(ok: unknown, message = 'invalid live admission budget'): asserts ok { if (!ok) throw new Error(message) }
function read(raw: string): Ledger {
  requireValue(raw.length <= 32_768)
  const data = JSON.parse(raw) as Ledger
  requireValue(data && JSON.stringify(data) === raw && Object.keys(data).sort().join() === 'id,kind,lastAt,reservations,v')
  requireValue(data.v === 1 && data.kind === 'live-admission-budget' && /^[0-9a-f]{64}$/.test(data.id) && integer(data.lastAt))
  requireValue(Array.isArray(data.reservations) && data.reservations.length <= 256)
  for (const r of data.reservations) requireValue(r && Object.keys(r).sort().join() === 'at,bytes,challenges,checks' &&
    integer(r.at) && r.at <= data.lastAt && integer(r.checks) && r.checks <= 1 && integer(r.challenges) && r.challenges <= 1 &&
    integer(r.bytes) && r.bytes <= 65536 && (r.checks === 1 ? r.bytes === 0 && r.challenges === 0 : r.bytes > 0))
  requireValue(data.reservations.reduce((n, r) => n + r.checks, 0) <= 64 &&
    data.reservations.reduce((n, r) => n + r.challenges, 0) <= 16 && data.reservations.reduce((n, r) => n + r.bytes, 0) <= 65536)
  return data
}

/** One durable allowance shared by every live-admission room in this runtime. */
export class LiveAdmissionBudget {
  #closed = false
  #poisoned = false
  #rooms = new Set<string>()
  #pending = 0
  private constructor(private readonly store: LiveKeeperStore, private data: Ledger, private readonly now: () => number) {}

  static create(store: LiveKeeperStore, now: () => number = () => Math.floor(Date.now() / 1000)): LiveAdmissionBudget {
    return this.#open(store, now, true)
  }
  static open(store: LiveKeeperStore, now: () => number = () => Math.floor(Date.now() / 1000)): LiveAdmissionBudget {
    return this.#open(store, now, false)
  }
  static #open(store: LiveKeeperStore, now: () => number, create: boolean): LiveAdmissionBudget {
    try {
      requireValue(!processOwner, 'a live admission budget already owns this runtime')
      const raw = store.load()
      let data: Ledger
      if (create) {
        requireValue(raw === undefined, 'live admission budget already exists')
        const at = now(); requireValue(integer(at))
        data = { v: 1, kind: 'live-admission-budget', id: Array.from(randomBytes(32), b => b.toString(16).padStart(2, '0')).join(''), lastAt: at, reservations: [] }
        store.save(JSON.stringify(data))
      } else { requireValue(raw !== undefined, 'live admission budget is missing'); data = read(raw) }
      const owner = new LiveAdmissionBudget(store, data, now)
      processOwner = owner
      return owner
    } catch (error) { store.close(); throw error }
  }

  #available(): void { requireValue(!this.#closed && !this.#poisoned, 'live admission budget is unavailable') }
  #reserve(checks: number, challenges: number, bytes: number): boolean {
    this.#available()
    const at = this.now()
    requireValue(integer(at) && at >= this.data.lastAt, 'live admission budget clock moved backwards')
    const reservations = this.data.reservations.filter(r => r.at > at - 60)
    if (reservations.length >= 256 || reservations.reduce((n, r) => n + r.checks, checks) > 64 ||
      reservations.reduce((n, r) => n + r.challenges, challenges) > 16 || reservations.reduce((n, r) => n + r.bytes, bytes) > 65536) return false
    const next: Ledger = { ...this.data, lastAt: at, reservations: [...reservations, { at, checks, challenges, bytes }] }
    try { this.store.save(JSON.stringify(next)); this.data = next }
    catch (error) { this.#poisoned = true; throw error }
    return true
  }

  /** Subscription ownership is separate from ownership of the caller's transport and journal. */
  host(journal: LiveKeeperJournal, transport: RelayTransport, onError: (error: unknown) => void): { close(): void } {
    this.#available()
    const state = journal.snapshot(), room = deriveRoom(state.secret).roomId
    requireValue(journal.status === 'active', 'live admission needs an active journal')
    requireValue(this.#rooms.size < 8 && !this.#rooms.has(room), 'live admission room capacity or duplicate owner')
    this.#rooms.add(room)
    let closed = false, pending = 0, unsubscribe: (() => void) | undefined
    const release = () => { if (closed && pending === 0) this.#rooms.delete(room) }
    const close = () => { if (closed) return; closed = true; try { unsubscribe?.() } finally { release() } }
    const fail = (error: unknown) => { close(); try { onError(error) } catch { /* Owner notification cannot detach promise cleanup. */ } }
    try {
      const id = deriveInvitationId({ bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true })
      unsubscribe = transport.subscribe([{ kinds: [20466], '#d': [id] }], event => {
        if (closed || this.#pending >= 128 || pending >= 16) return
        // Journal shape checks run before copying, queueing or verification.
        pending++; this.#pending++
        void journal.answer(event, async answer => {
          this.#available()
          if (closed) throw new Error('live admission host is closed')
          await transport.publish(answer)
        }, {
          check: () => !closed && this.#reserve(1, 0, 0),
          offer: (bytes, fresh) => !closed && this.#reserve(0, fresh ? 1 : 0, bytes),
        }).catch(fail).finally(() => { pending--; this.#pending--; release() })
      })
      if (closed) unsubscribe()
      return { close }
    } catch (error) { close(); throw error }
  }

  close(): void {
    if (this.#closed) return
    requireValue(this.#rooms.size === 0 && this.#pending === 0, 'close live admission rooms before their budget')
    this.#closed = true
    try { this.store.close() } finally { if (processOwner === this) processOwner = undefined }
  }
}
