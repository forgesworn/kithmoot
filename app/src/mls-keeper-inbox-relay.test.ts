import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { NostrMlsKeeperInboxTransport } from './mls-keeper-inbox-relay.js'
const secret = new Uint8Array(32).fill(42), keeper = getPublicKey(secret)
class Socket {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: any[] = []
  closed = false
  send(value: string) { this.sent.push(JSON.parse(value)) }
  close() { this.closed = true }
  open() { this.onopen?.() }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  raw(value: unknown) { this.onmessage?.({ data: value }) }
}
const wrap = (at = 100, recipient = keeper) => finalizeEvent({ kind: 1059, created_at: at, tags: [['p', recipient]], content: 'encrypted' }, new Uint8Array(32).fill(43))
const wire = (value: unknown) => JSON.parse(JSON.stringify(value))
function fixture(circle = false, authentication = false, budgets?: { openMs: number; authMs: number; pageMs: number }) {
  const socket = new Socket(), sign = vi.fn(localIdentity(secret).signEvent)
  let current = true
  const transport = new NostrMlsKeeperInboxTransport(() => socket as unknown as WebSocket, budgets?.pageMs ?? 100, () => 150, budgets)
  const query = { relay: { url: 'wss://keeper.test', read: true, write: false, ...(circle ? { circle: true } : {}) }, keeper, since: 50, until: 150,
    current: () => current, ...(authentication ? { authentication: { pubkey: keeper, signEvent: sign } } : {}) }
  return { socket, transport, query, sign, stop: () => { current = false } }
}
describe('finite keeper inbox stored pages', () => {
  it('issues an exact page and verifies before deduplication without decrypting or signing', async () => {
    const f = fixture(), pending = f.transport.page(f.query)
    f.socket.open(); const id = f.socket.sent[0][1], event = wrap()
    expect(f.socket.sent[0]).toEqual(['REQ', expect.any(String), { kinds: [1059], '#p': [keeper], since: 50, until: 150, limit: 64 }])
    f.socket.frame(['EVENT', id, { ...event, content: 'forged', verified: true }])
    f.socket.frame(['EVENT', id, event]); f.socket.frame(['EVENT', id, event])
    for (const foreign of [wrap(49), wrap(151), wrap(100, '11'.repeat(32))]) f.socket.frame(['EVENT', id, foreign])
    f.socket.frame(['EOSE', 'different']); f.socket.frame(['EOSE', id])
    expect(await pending).toEqual({ complete: true, events: [wire(event)] })
    expect(f.sign).not.toHaveBeenCalled(); expect(f.socket.closed).toBe(true)
  })
  it('retains signed query-matching unsupported shapes as original paging boundaries without accepting forged copies', async () => {
    const f = fixture(), pending = f.transport.page(f.query); f.socket.open(); const id = f.socket.sent[0][1]
    const unsupported = finalizeEvent({ kind: 1059, created_at: 100, tags: [['p', keeper], ['x', 'unsupported']], content: 'opaque' }, secret)
    f.socket.frame(['EVENT', id, { ...unsupported, created_at: 50, verified: true }])
    f.socket.frame(['EVENT', id, unsupported]); f.socket.frame(['EOSE', id])
    expect(await pending).toEqual({ complete: true, events: [wire(unsupported)] })
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('does not let an unsolicited public AUTH challenge prompt the keeper signer', async () => {
    const f = fixture(false, true), pending = f.transport.page(f.query)
    f.socket.open(); const id = f.socket.sent[0][1]
    f.socket.frame(['AUTH', 'opaque']); f.socket.frame(['EOSE', id])
    expect(await pending).toEqual({ complete: true, events: [] }); expect(f.sign).not.toHaveBeenCalled()
  })
  it('retries a refused public page only after exact verified AUTH OK', async () => {
    const f = fixture(false, true), pending = f.transport.page(f.query)
    f.socket.open(); const old = f.socket.sent[0][1]
    f.socket.frame(['AUTH', 'opaque']); f.socket.frame(['CLOSED', old, 'auth-required: identify'])
    await vi.waitFor(() => expect(f.socket.sent.find(frame => frame[0] === 'AUTH')).toBeTruthy(), { interval: 1 })
    const auth = f.socket.sent.find(frame => frame[0] === 'AUTH')[1]
    expect(auth).toMatchObject({ kind: 22242, pubkey: keeper, created_at: 150, content: '', tags: [['relay', 'wss://keeper.test/'], ['challenge', 'opaque']] })
    expect(f.socket.sent.filter(frame => frame[0] === 'REQ')).toHaveLength(1)
    f.socket.frame(['OK', auth.id, true, ''])
    const fresh = f.socket.sent.filter(frame => frame[0] === 'REQ')[1][1]
    expect(fresh).not.toBe(old)
    const event = wrap()
    f.socket.frame(['EOSE', old]); f.socket.frame(['EVENT', fresh, event]); f.socket.frame(['EOSE', fresh])
    expect(await pending).toEqual({ complete: true, events: [wire(event)] }); expect(f.sign).toHaveBeenCalledTimes(1)
  })
  it('waits for successful authentication before disclosing a circle relay filter', async () => {
    const f = fixture(true, true), pending = f.transport.page(f.query)
    f.socket.open(); expect(f.socket.sent).toEqual([])
    f.socket.frame(['AUTH', 'circle'])
    await vi.waitFor(() => expect(f.socket.sent[0]?.[0]).toBe('AUTH'), { interval: 1 })
    f.socket.frame(['OK', f.socket.sent[0][1].id, true, ''])
    expect(f.socket.sent[1][0]).toBe('REQ')
    f.socket.frame(['EOSE', f.socket.sent[1][1]])
    expect(await pending).toEqual({ complete: true, events: [] })
  })
  it('refuses circle reads without explicit matching keeper authentication', async () => {
    const f = fixture(true)
    await expect(f.transport.page(f.query)).rejects.toThrow('explicit keeper authentication')
    await expect(f.transport.page({ ...f.query, authentication: { pubkey: '11'.repeat(32), signEvent: f.sign } })).rejects.toThrow('Invalid keeper inbox query')
    expect(f.socket.sent).toEqual([])
  })
  it.each(['refused', 'changed-challenge', 'second-refusal', 'changed-signer'] as const)('fails closed on authentication %s', async scenario => {
    const f = fixture(true, true)
    if (scenario === 'changed-signer') f.sign.mockImplementation(async template => ({ ...await localIdentity(secret).signEvent(template), content: 'changed', verified: true }))
    const pending = f.transport.page(f.query); f.socket.open(); f.socket.frame(['AUTH', 'circle'])
    if (scenario === 'changed-signer') { expect(await pending).toMatchObject({ complete: false }); expect(f.socket.sent).toEqual([]); return }
    await vi.waitFor(() => expect(f.socket.sent[0]?.[0]).toBe('AUTH'), { interval: 1 })
    const id = f.socket.sent[0][1].id
    if (scenario === 'refused') f.socket.frame(['OK', id, false, 'no'])
    if (scenario === 'changed-challenge') f.socket.frame(['AUTH', 'different'])
    if (scenario === 'second-refusal') { f.socket.frame(['OK', id, true, '']); f.socket.frame(['CLOSED', f.socket.sent[1][1], 'auth-required: again']) }
    expect(await pending).toMatchObject({ complete: false }); expect(f.socket.closed).toBe(true)
  })
  it('caps verified pages independently of a relay ignoring its requested limit', async () => {
    // This case measures the item cap, independently of host crypto CPU time.
    const f = fixture(false, false, { openMs: 1000, authMs: 1000, pageMs: 5000 }), pending = f.transport.page(f.query); f.socket.open(); const id = f.socket.sent[0][1]
    for (let i = 0; i < 65; i++) f.socket.frame(['EVENT', id, finalizeEvent({ kind: 1059, created_at: 100, tags: [['p', keeper]], content: `encrypted-${i}` }, secret)])
    const page = await pending
    expect(page.complete).toBe(false); expect(page.events).toHaveLength(64); expect(f.socket.closed).toBe(true)
  })
  it.each([new Uint8Array([1]), '{', 'x'.repeat(128_001)])('bounds malformed, binary and oversized frames', async hostile => {
    const f = fixture(), pending = f.transport.page(f.query); f.socket.open(); f.socket.raw(hostile)
    expect(await pending).toEqual({ complete: false, events: [] }); expect(f.socket.closed).toBe(true)
  })
  it('counts unsolicited frames and never treats a deadline as EOSE', async () => {
    const f = fixture(), pending = f.transport.page(f.query); f.socket.open()
    for (let i = 0; i < 129; i++) f.socket.frame(['NOTICE', 'unsolicited'])
    expect(await pending).toMatchObject({ complete: false }); expect(f.socket.closed).toBe(true)
    const quiet = fixture(), timeout = quiet.transport.page(quiet.query); quiet.socket.open()
    expect(await timeout).toEqual({ complete: false, events: [] }); expect(quiet.socket.closed).toBe(true)
  })
  it('bounds cumulative characters even when every frame is individually allowed', async () => {
    const f = fixture(), pending = f.transport.page(f.query); f.socket.open()
    for (let i = 0; i < 31; i++) f.socket.frame(['NOTICE', 'x'.repeat(100_000)])
    expect(await pending).toEqual({ complete: false, events: [] }); expect(f.socket.closed).toBe(true)
  })
  it('drops retained events and late signer work after account or foreground invalidation', async () => {
    const f = fixture(), pending = f.transport.page(f.query); f.socket.open()
    f.socket.frame(['EVENT', f.socket.sent[0][1], wrap()]); f.stop(); f.socket.frame(['EOSE', f.socket.sent[0][1]])
    expect(await pending).toEqual({ complete: false, events: [] })
    const held = fixture(true, true); let release!: () => void
    held.sign.mockImplementation(template => new Promise(resolve => { release = () => { void localIdentity(secret).signEvent(template).then(resolve) } }))
    const late = held.transport.page(held.query); held.socket.open(); held.socket.frame(['AUTH', 'circle']); held.stop()
    release(); expect(await late).toEqual({ complete: false, events: [] }); expect(held.socket.sent).toEqual([])
  })
})


const smallBudgets = { openMs: 40, authMs: 200, pageMs: 20 }
const fakePhaseClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
afterEach(() => { vi.useRealTimers() })
function delayedSignature(f: ReturnType<typeof fixture>) {
  const sign = f.sign.getMockImplementation()!
  let release!: () => void
  f.sign.mockImplementation(template => new Promise(resolve => { release = () => { void sign(template).then(resolve) } }))
  return () => release()
}

describe('bounded keeper inbox connection, AUTH and page phases', () => {
  it('allows matching private AUTH beyond the page budget and starts a fresh page only after matching OK', async () => {
    fakePhaseClock()
    const f = fixture(true, true, smallBudgets), release = delayedSignature(f), pending = f.transport.page(f.query)
    f.socket.open(); f.socket.frame(['AUTH', 'private'])
    await vi.advanceTimersByTimeAsync(60)
    expect(f.socket.closed).toBe(false); expect(f.socket.sent).toEqual([])
    release(); await vi.advanceTimersByTimeAsync(0)
    const auth = f.socket.sent[0][1]
    expect(f.socket.sent.map(frame => frame[0])).toEqual(['AUTH'])
    f.socket.frame(['OK', 'wrong-id', true, ''])
    await vi.advanceTimersByTimeAsync(60)
    expect(f.socket.sent.map(frame => frame[0])).toEqual(['AUTH'])
    f.socket.frame(['OK', auth.id, true, ''])
    expect(f.socket.sent.map(frame => frame[0])).toEqual(['AUTH', 'REQ'])
    await vi.advanceTimersByTimeAsync(19)
    f.socket.frame(['EOSE', f.socket.sent[1][1]])
    expect(await pending).toEqual({ complete: true, events: [] })
  })

  it('gives an explicitly consented public AUTH retry its own auth and fresh page budgets', async () => {
    fakePhaseClock()
    const f = fixture(false, true, smallBudgets), release = delayedSignature(f), pending = f.transport.page(f.query)
    f.socket.open(); const old = f.socket.sent[0][1]
    f.socket.frame(['AUTH', 'public'])
    expect(f.sign).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5)
    f.socket.frame(['CLOSED', old, 'auth-required: identify'])
    await vi.advanceTimersByTimeAsync(60)
    expect(f.socket.closed).toBe(false); expect(f.socket.sent.map(frame => frame[0])).toEqual(['REQ'])
    f.socket.frame(['EOSE', old])
    release(); await vi.advanceTimersByTimeAsync(0)
    const auth = f.socket.sent[1][1]
    await vi.advanceTimersByTimeAsync(40)
    f.socket.frame(['OK', auth.id, true, ''])
    const fresh = f.socket.sent[2][1]
    expect(fresh).not.toBe(old)
    await vi.advanceTimersByTimeAsync(19)
    f.socket.frame(['EOSE', old]); f.socket.frame(['EOSE', fresh])
    expect(await pending).toEqual({ complete: true, events: [] })
    expect(f.sign).toHaveBeenCalledOnce()
  })

  it.each(['challenge', 'signature', 'matching-ok'] as const)('AUTH expiry during %s cannot release late AUTH or REQ', async waiting => {
    fakePhaseClock()
    const f = fixture(true, true, { ...smallBudgets, authMs: 60 })
    const release = waiting === 'signature' ? delayedSignature(f) : undefined
    const pending = f.transport.page(f.query)
    f.socket.open()
    if (waiting !== 'challenge') f.socket.frame(['AUTH', 'private'])
    await vi.advanceTimersByTimeAsync(61)
    expect(await pending).toEqual({ complete: false, events: [] }); expect(f.socket.closed).toBe(true)
    const before = f.socket.sent.map(frame => frame[0])
    expect(before).toEqual(waiting === 'matching-ok' ? ['AUTH'] : [])
    if (release) { release(); await vi.advanceTimersByTimeAsync(0) }
    f.socket.frame(['AUTH', 'private'])
    const auth = f.socket.sent.find(frame => frame[0] === 'AUTH')?.[1]
    if (auth) f.socket.frame(['OK', auth.id, true, ''])
    expect(f.socket.sent.map(frame => frame[0])).toEqual(before)
    if (waiting === 'challenge') expect(f.sign).not.toHaveBeenCalled()
  })

  it('withdrawal while a noncancellable valid signature is pending suppresses its reply and query', async () => {
    fakePhaseClock()
    const f = fixture(true, true, smallBudgets), release = delayedSignature(f), pending = f.transport.page(f.query)
    f.socket.open(); f.socket.frame(['AUTH', 'private'])
    await vi.advanceTimersByTimeAsync(40)
    f.stop(); await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toEqual({ complete: false, events: [] })
    release(); await vi.advanceTimersByTimeAsync(0)
    expect(f.socket.sent).toEqual([]); expect(f.socket.closed).toBe(true)
  })

  it('connection expiry prevents a late socket open from beginning AUTH', async () => {
    fakePhaseClock()
    const f = fixture(true, true, smallBudgets), pending = f.transport.page(f.query)
    await vi.advanceTimersByTimeAsync(41)
    expect(await pending).toEqual({ complete: false, events: [] })
    f.socket.open(); f.socket.frame(['AUTH', 'late'])
    expect(f.sign).not.toHaveBeenCalled(); expect(f.socket.sent).toEqual([])
  })

  it('an unsolicited public AUTH challenge cannot extend an unauthenticated page budget', async () => {
    fakePhaseClock()
    const f = fixture(false, true, smallBudgets), pending = f.transport.page(f.query)
    f.socket.open(); f.socket.frame(['AUTH', 'unsolicited'])
    await vi.advanceTimersByTimeAsync(21)
    expect(await pending).toEqual({ complete: false, events: [] })
    expect(f.sign).not.toHaveBeenCalled(); expect(f.socket.sent.map(frame => frame[0])).toEqual(['REQ', 'CLOSE'])
  })

  it('the stored page still expires independently after successful AUTH', async () => {
    fakePhaseClock()
    const f = fixture(true, true, smallBudgets), pending = f.transport.page(f.query)
    f.socket.open(); f.socket.frame(['AUTH', 'private']); await vi.advanceTimersByTimeAsync(0)
    f.socket.frame(['OK', f.socket.sent[0][1].id, true, ''])
    await vi.advanceTimersByTimeAsync(21)
    expect(await pending).toEqual({ complete: false, events: [] }); expect(f.socket.closed).toBe(true)
    expect(f.socket.sent.map(frame => frame[0])).toEqual(['AUTH', 'REQ', 'CLOSE'])
  })
})
