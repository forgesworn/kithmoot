import { describe, expect, it, vi } from 'vitest'
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
function fixture(circle = false, authentication = false) {
  const socket = new Socket(), sign = vi.fn(localIdentity(secret).signEvent)
  let current = true
  const transport = new NostrMlsKeeperInboxTransport(() => socket as unknown as WebSocket, 100, () => 150)
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
  it('does not let an unsolicited public AUTH challenge prompt the keeper signer', async () => {
    const f = fixture(false, true), pending = f.transport.page(f.query)
    f.socket.open(); const id = f.socket.sent[0][1]
    f.socket.frame(['AUTH', 'opaque']); f.socket.frame(['EOSE', id])
    expect(await pending).toEqual({ complete: true, events: [] }); expect(f.sign).not.toHaveBeenCalled()
  })
  it('retries a refused public page only after exact verified AUTH OK, within the same deadline', async () => {
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
    const f = fixture(), pending = f.transport.page(f.query); f.socket.open(); const id = f.socket.sent[0][1]
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
