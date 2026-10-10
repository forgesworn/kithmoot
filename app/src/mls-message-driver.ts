import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { BrowserMlsBoxClient, BoxAnswer } from './mls-box-client.js'
import type { BrowserMlsRoomOperations, MlsDriverCommand, MlsDriverGuard, MlsDriverState, MlsRoomContext, MlsRoomResult } from './mls-room-operations.js'

type Rooms = Pick<BrowserMlsRoomOperations, 'driverState' | 'confirmTransport' | 'drive' | 'process'>
type Client = Pick<BrowserMlsBoxClient, 'box' | 'capabilities' | 'deposit' | 'depositSlot' | 'slotStatus' | 'fetch' | 'ack' | 'invalidate' | 'isCurrent'>
export type MlsDriverRound =
  | { state: 'done'; delivered: number; processed: number; held: number; leafHeld: number; stalled: boolean; limited: boolean }
  | { state: 'stopped'; phase: string; reason?: string }
  | { state: 'offline'; answer: Exclude<BoxAnswer<unknown>, { state: 'ok' }> }
  | Exclude<MlsRoomResult<never>, { state: 'active' }>
const stale = (): MlsDriverRound => ({ state: 'pending', reason: 'stale', refused: false })
class Stop { constructor(readonly result: MlsDriverRound) {} }
const runnable = (s: MlsDriverState) => s.phase.type === 'Active' || s.phase.type === 'PendingJoin' || s.phase.type === 'NeedsRecovery' && s.phase.reason === 'Gap'

/** Development-only, one room and one explicitly paired box. The client must
 * own a separate Link endpoint, never the persona witness lease. The caller
 * invalidates on account/privacy/offline transitions and awaits close() before
 * replacing that endpoint. No timers, network or WASM start in the constructor.
 * Call round() on open/reconnection or a caller-owned timer. Production has no
 * caller. The round lock precedes (and never replaces) the persona lock. */
export class BrowserMlsMessageDriver {
  readonly #context: MlsRoomContext
  readonly #abort = new AbortController()
  #closed = false
  #round?: Promise<MlsDriverRound>
  #closing?: Promise<void>
  constructor(private readonly rooms: Rooms, private readonly client: Client, context: MlsRoomContext,
    private readonly session: string, private readonly shutdown: () => Promise<void>,
    private readonly locks: Pick<LockManager, 'request'> = navigator.locks,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly maxPages = 8, private readonly maxRecords = 64) {
    if (!/^[0-9a-f]{64}$/.test(session) || !locks || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 16 ||
      !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1024) throw new Error('Invalid MLS driver configuration')
    this.#context = Object.freeze({ vault: Object.freeze({ ...context.vault }), rendezvousKey: context.rendezvousKey, current: context.current.bind(context) })
  }
  invalidate(): void { this.#closed = true; this.#abort.abort(); this.client.invalidate() }
  close(): Promise<void> {
    this.invalidate()
    return this.#closing ??= this.shutdown()
  }
  /** Coalesce this instance; Web Locks serialise other tabs/instances. A
   * queued round is cancellable and never inherits an earlier account. */
  round(): Promise<MlsDriverRound> {
    if (this.#closed) return Promise.resolve(stale())
    return this.#round ??= this.#locked().finally(() => { this.#round = undefined })
  }
  async #locked(): Promise<MlsDriverRound> {
    const current = () => !this.#closed && this.#context.current() && this.client.isCurrent()
    const context = { ...this.#context, current }
    const poll = setInterval(() => { if (!current()) this.invalidate() }, 50)
    try {
      const result = await this.locks.request(`kithmoot:mls-driver:${context.vault.persona}:${this.session}`, { signal: this.#abort.signal }, async () => {
        if (!current()) return stale()
        return this.#run(context)
      })
      return current() ? result : stale()
    } catch (error) {
      if (!current() || (error as Error)?.name === 'AbortError') return stale()
      throw error
    } finally { clearInterval(poll) }
  }

  async #run(context: MlsRoomContext): Promise<MlsDriverRound> {
    let state: MlsDriverState | undefined, expected: string | undefined, installation = ''
    const owned: unknown[] = []
    const done = { state: 'done' as const, delivered: 0, processed: 0, held: 0, leafHeld: 0, stalled: false, limited: false }
    const live = () => context.current()
    const check = () => { if (!live()) throw new Stop(stale()) }
    const take = <T>(result: MlsRoomResult<T>): T => {
      if (result.state === 'active') owned.push(result.value)
      check()
      if (result.state !== 'active') throw new Stop(result)
      return result.value
    }
    const refresh = async () => {
      const next = take(await this.rooms.driverState(context, this.session))
      if (expected !== undefined && next.generation !== expected) throw new Stop(stale())
      if (next.binding.homeBox !== this.client.box) throw new Stop({ state: 'refused', reason: 'wrong-box' })
      if (state) { wipe(state); owned.splice(owned.indexOf(state), 1) }
      state = next; expected = next.generation
      return next
    }
    const guard = (): MlsDriverGuard => ({ generation: expected!, homeBox: this.client.box, installation })
    const authenticated = async <T>(request: () => Promise<T>): Promise<T> => {
      take(await this.rooms.confirmTransport(context, this.session, { generation: expected!, homeBox: this.client.box }))
      check()
      return request()
    }
    const stepped = async (command: MlsDriverCommand, soft = false) => {
      check()
      const result = await this.rooms.drive(context, this.session, guard(), command)
      if (soft && result.state === 'refused' && result.reason.startsWith('engine:')) { check(); return false }
      expected = take(result).generation
      return true
    }
    const processed = async (mailbox: Uint8Array, envelope: Uint8Array, receipt?: Uint8Array) => {
      check()
      const result = take(await this.rooms.process(context, this.session, { ...guard(), mailbox, envelope, receipt }))
      expected = result.generation; done.processed++
      return result
    }
    const stopPhase = (s: MlsDriverState) => {
      if (!runnable(s)) throw new Stop({ state: 'stopped', phase: s.phase.type, ...(s.phase.reason ? { reason: s.phase.reason } : {}) })
    }
    const noAnswer = (a: BoxAnswer<unknown>) => a.state === 'unavailable' || a.state === 'not-signed'
    try {
      // Confirm the persona before asking its signer; capabilities is the
      // first BOX request, made outside the persona transaction.
      await refresh()
      const caps = await authenticated(() => this.client.capabilities(live)); check()
      if (caps.state !== 'ok') return { state: 'offline', answer: caps }
      installation = caps.value.installation
      await stepped({ type: 'installation' })
      stopPhase(await refresh())
      await stepped({ type: 'tick' })
      let s = await refresh(); stopPhase(s)
      // Keep a bounded list of exact witnessed records, never step.outbound
      // from an uncertain call. Generation guards stop any competing edit.
      const outgoing = structuredClone(s.outbox.slice(0, this.maxRecords)); owned.push(outgoing)
      const heldLeaves = new Set<string>()
      for (const out of outgoing) {
        s = await refresh(); stopPhase(s)
        const d = out.destination, leaf = d.type === 'Leaf' ? bytesToHex(d.leafId) : undefined
        if (leaf && heldLeaves.has(leaf)) { done.leafHeld++; continue }
        if (!s.outbox.some(r => bytesToHex(r.recordId) === bytesToHex(out.recordId))) continue
        if (d.type === 'CommitSlot' && s.epoch !== null && d.epoch < s.epoch) {
          await stepped({ type: 'delivered', records: [out.recordId] }); done.delivered++; continue
        }
        if (d.type === 'CommitSlot' && s.phase.type !== 'Active') continue
        const box = d.type === 'Introduction'
          ? s.join && bytesToHex(d.peerRz) === s.join.adderRz ? s.join.introductionBox : undefined
          : d.type === 'Welcome' ? undefined : bytesToHex(d.homeBox)
        // Welcome requires inviter/package destination metadata not yet in
        // the room API. There is deliberately no implicit home-box fallback.
        if (box !== this.client.box) { done.held++; if (leaf) heldLeaves.add(leaf); continue }
        const expires = d.type === 'Introduction' ? s.join!.expiresAt : d.type === 'ForkEvidence' ? Number(d.expiresAt) : Infinity
        const valid = () => live() && this.now() < expires
        const answer = d.type === 'CommitSlot'
          ? await authenticated(() => this.client.depositSlot(out.mailbox, d.attempt, out.envelope, valid))
          : await authenticated(() => this.client.deposit(out.mailbox, out.envelope, valid))
        check()
        if (!valid() || noAnswer(answer)) { done.stalled = true; return done }
        if (answer.state !== 'ok') {
          if (leaf) heldLeaves.add(leaf)
          if (answer.state === 'refused' && answer.code === 'rate-limited') done.limited = true
          continue
        }
        owned.push(answer.value)
        if (d.type === 'CommitSlot') {
          const receipt = (answer.value as { signedReceipt: Uint8Array | null }).signedReceipt
          // Framing alone is no receipt proof. No durable signed answer:
          // retain exact bytes; the status read may decide the slot below.
          if (!receipt || !await stepped({ type: 'deposit', attempt: d.attempt, receipt }, true)) continue
        }
        await stepped({ type: 'delivered', records: [out.recordId] }); done.delivered++
      }

      s = await refresh(); stopPhase(s)
      const watched = structuredClone(s.watch); owned.push(watched)
      let fetched = 0
      // One mailbox per request makes empty evidence unambiguous. Cursor
      // pages are sequential and bounded. Slots NEVER use fetch.
      for (const w of watched) {
        if (w.kind.type === 'CommitSlot' || w.homeBox && bytesToHex(w.homeBox) !== this.client.box) continue
        s = await refresh(); stopPhase(s)
        if (!s.watch.some(v => bytesToHex(v.mailbox) === bytesToHex(w.mailbox))) continue
        let after: string | undefined, seen = false
        const cursors = new Set<string>()
        for (let page = 0; page < this.maxPages && fetched < this.maxRecords; page++) {
          const answer = await authenticated(() => this.client.fetch([w.mailbox], after, live)); check()
          if (noAnswer(answer)) { done.stalled = true; return done }
          if (answer.state !== 'ok') break
          owned.push(answer.value)
          for (const record of answer.value.records) {
            seen = true
            if (fetched++ >= this.maxRecords) return done
            const effect = await processed(record.mailbox, record.envelope)
            if (effect.ack?.type === 'Now' || effect.ack?.type === 'AfterCommitAck') {
              const ack = await authenticated(() => this.client.ack([{ mailbox: record.mailbox, receipt: record.receipt }], live)); check()
              if (ack.state !== 'ok') { done.stalled = true; return done }
            }
          }
          if (answer.value.next === null) {
            // A page containing records is never an empty assertion. A later
            // round fetches again after successful acknowledgements. Exact
            // generation rejects an empty reply overtaken by any processing.
            if (!seen && w.kind.type === 'RetainedLeaf') await stepped({ type: 'drained', mailbox: w.mailbox })
            break
          }
          if (cursors.has(answer.value.next)) break
          cursors.add(answer.value.next); after = answer.value.next
        }
      }

      s = await refresh(); stopPhase(s)
      const slots = structuredClone(s.watch.filter(w => w.kind.type === 'CommitSlot')); owned.push(slots)
      for (const w of slots.slice(0, this.maxRecords)) {
        if (w.kind.type !== 'CommitSlot' || w.homeBox && bytesToHex(w.homeBox) !== this.client.box) continue
        s = await refresh(); stopPhase(s)
        const attempt = w.kind.attempt
        if (!s.watch.some(v => bytesToHex(v.mailbox) === bytesToHex(w.mailbox) && v.kind.type === 'CommitSlot' && v.kind.attempt === attempt)) continue
        const answer = await authenticated(() => this.client.slotStatus(w.mailbox, attempt, live)); check()
        if (noAnswer(answer)) { done.stalled = true; return done }
        if (answer.state !== 'ok' || !answer.value.signedReceipt) continue
        const value = answer.value; owned.push(value)
        if (value.state === 'filled') await processed(w.mailbox, value.envelope!, value.signedReceipt)
        else if (value.state === 'void' || value.state === 'expired') await stepped({ type: 'slot', attempt: w.kind.attempt, status: value.state === 'void' ? 'Void' : 'Expired', receipt: value.signedReceipt! }, true)
      }
      s = await refresh(); stopPhase(s)
      const queries = structuredClone(s.ordering)
      for (const q of queries.slice(0, this.maxRecords)) {
        s = await refresh(); stopPhase(s)
        if (!s.ordering.some(v => v.slot === q.slot && v.attempt === q.attempt)) continue
        const answer = await authenticated(() => this.client.slotStatus(hexToBytes(q.slot), q.attempt, live)); check()
        if (noAnswer(answer)) { done.stalled = true; return done }
        if (answer.state === 'ok' && answer.value.signedReceipt) {
          owned.push(answer.value)
          await stepped({ type: 'receipt', ...q, receipt: answer.value.signedReceipt }, true)
        }
      }
      return done
    } catch (error) {
      if (error instanceof Stop) return error.result
      throw error
    } finally { for (const value of owned) wipe(value) }
  }
}
function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) wipe(v)
}
