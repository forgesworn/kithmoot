import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { deriveRoom, encodeInvitationRetirement } from '@forgesworn/fold-kit'
import { requestLivePersistentAdmission } from './live-admission.js'
import { LiveKeeperJournal } from './live-keeper.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import type { RelayTransport } from './relay-pool.js'

const NOW = 1_800_000_000
const controllers: AbortController[] = [], journals: LiveKeeperJournal[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(async () => { controllers.splice(0).forEach(c => c.abort()); await Promise.all(journals.splice(0).map(j => j.close())); vi.useRealTimers() })
function setup() {
  let raw: string | undefined
  const now = () => NOW + Math.floor(Date.now() / 1000)
  const journal = LiveKeeperJournal.create({ load: () => raw, save: value => { raw = value }, close: () => {} }, { now })
  journals.push(journal)
  const state = journal.snapshot(), relay = new SimRelay(), server = new SimTransport(relay)
  const offered: Event[] = []
  let subscriptions = 0, dropped = 0
  const transport: RelayTransport = {
    publish: async e => { offered.push(e); if (dropped-- <= 0) relay.publish(e) },
    subscribe: (filters, cb, eose) => { subscriptions++; const off = relay.subscribe(filters, cb); eose?.(); let closed = false; return () => { if (!closed) { closed = true; subscriptions--; off() } } },
    close: () => { throw new Error('requester must not close caller route') },
  }
  const controller = new AbortController(); controllers.push(controller)
  const opts = { invitation: { bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true as const },
    roomId: deriveRoom(state.secret).roomId, ownerDevice: getPublicKey(generateSecretKey()), transport,
    signal: controller.signal, now, monotonic: () => Date.now() }
  return { opts, controller, relay, journal, state, offered, active: () => subscriptions,
    drop: (n: number) => { dropped = n }, host: () => relay.subscribe([{ kinds: [20466] }], e => { void journal.answer(e, reply => server.publish(reply)) }) }
}
const outcome = <T>(p: Promise<T>) => p.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }))

describe('live admission exchange owner', () => {
  it('recovers a lost first offer with the identical request, consumes one reply and cleans up', async () => {
    const f = setup(); f.drop(1); f.host()
    const result = outcome(requestLivePersistentAdmission(f.opts))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(f.offered.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const got = await result
    expect(got.error).toBeUndefined()
    expect(got.value?.epochHint).toBe(0)
    expect(f.offered.map(e => e.id)).toEqual([f.offered[0]!.id, f.offered[0]!.id])
    expect(f.active()).toBe(0)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(f.offered.length).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers a lost request and lost reply before the cached answer expires', async () => {
    const f = setup(); f.drop(1)
    const replies: Event[] = []
    f.relay.subscribe([{ kinds: [20466] }], e => { void f.journal.answer(e, async reply => {
      replies.push(reply); if (replies.length > 1) f.relay.publish(reply)
    }) })
    const result = outcome(requestLivePersistentAdmission(f.opts))
    await vi.advanceTimersByTimeAsync(20_001)
    expect((await result).value?.epochHint).toBe(0)
    expect(f.offered).toHaveLength(3)
    expect(replies).toHaveLength(2)
    expect(replies[1]).toEqual(replies[0])
    expect(f.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('silence and EOSE expire after only three identical offers without another route', async () => {
    const f = setup(), result = outcome(requestLivePersistentAdmission(f.opts))
    await vi.advanceTimersByTimeAsync(90_000)
    expect((await result).error?.message).toMatch(/timed out|expired/)
    expect(f.offered).toHaveLength(3)
    expect(new Set(f.offered.map(e => e.id)).size).toBe(1)
    expect(f.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a hung publication promptly and ignores subsequent replies', async () => {
    const f = setup()
    f.opts.transport.publish = async e => { f.offered.push(e); await new Promise(() => {}) }
    const result = outcome(requestLivePersistentAdmission(f.opts))
    f.controller.abort()
    expect((await result).error?.message).toMatch(/cancelled/)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.offered).toHaveLength(1)
    expect(f.active()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses duplicate ownership, and cancellation permits a fresh key and request', async () => {
    const f = setup(), first = outcome(requestLivePersistentAdmission(f.opts))
    await expect(requestLivePersistentAdmission(f.opts)).rejects.toThrow(/owner unavailable/)
    const old = f.offered[0]!
    f.controller.abort(); await first
    const next = new AbortController(); controllers.push(next)
    const second = outcome(requestLivePersistentAdmission({ ...f.opts, signal: next.signal }))
    expect(f.offered[1]!.id).not.toBe(old.id)
    expect(f.offered[1]!.pubkey).not.toBe(old.pubkey)
    next.abort(); await second
  })

  it('cancels observed wall rollback without extending the monotonic window', async () => {
    const f = setup(); let wall = NOW
    const result = outcome(requestLivePersistentAdmission({ ...f.opts, now: () => wall }))
    wall--
    await vi.advanceTimersByTimeAsync(1000)
    expect((await result).error?.message).toMatch(/backwards/)
    expect(f.offered).toHaveLength(1)
    expect(f.active()).toBe(0)
  })

  it('known retirement and synchronous tombstone replay never offer a request', async () => {
    const f = setup()
    await expect(requestLivePersistentAdmission({ ...f.opts, retired: () => true })).rejects.toThrow(/unavailable/)
    const retired = encodeInvitationRetirement({ invitation: f.opts.invitation, inviterSk: f.state.inviterSk, now: NOW })
    let closed = 0
    f.opts.transport.subscribe = (_filters, cb) => { cb(retired); return () => { closed++ } }
    await expect(requestLivePersistentAdmission(f.opts)).rejects.toThrow(/retired/)
    expect(closed).toBe(1)
    expect(f.offered).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds response work and refuses a valid reply after the allowance is exhausted', async () => {
    const f = setup(), result = outcome(requestLivePersistentAdmission(f.opts))
    let valid!: Event
    await f.journal.answer(f.offered[0]!, async event => { valid = event })
    const bad = { ...valid, sig: (valid.sig[0] === '0' ? '1' : '0') + valid.sig.slice(1) }
    for (let i = 0; i < 64; i++) f.relay.publish(bad)
    f.relay.publish(valid)
    await vi.advanceTimersByTimeAsync(90_000)
    expect((await result).error).toBeInstanceOf(Error)
    expect(f.active()).toBe(0)
  })

  it('caps process-wide outstanding challenges and frees all slots on abort', async () => {
    const f = setup(), pending = []
    for (let i = 0; i < 8; i++) pending.push(outcome(requestLivePersistentAdmission({ ...f.opts, roomId: i.toString(16).padStart(64, '0') })))
    await expect(requestLivePersistentAdmission({ ...f.opts, roomId: 'f'.repeat(64) })).rejects.toThrow(/owner unavailable/)
    f.controller.abort(); await Promise.all(pending)
    expect(f.active()).toBe(0)
  }, 20_000)
})
