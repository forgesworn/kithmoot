import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { keeperInboxDestination, type KeeperInboxAuthRequest } from './mls-keeper-inbox-auth.js'
import { publishMlsKeeperInboxDeposit, type MlsKeeperInboxDeposit, type MlsKeeperInboxDepositBudgets } from './mls-keeper-inbox-deposit-relay.js'

const NOW = 1_900_000_000
const challenge = 'ce'.repeat(32)
class Socket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  frames: unknown[][] = []
  closed = false
  send(text: string) { if (this.closed) throw new Error('closed'); this.frames.push(JSON.parse(text)) }
  close() { this.closed = true; this.onclose?.() }
  open() { this.onopen?.() }
  incoming(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function fixture() {
  const keeperKey = generateSecretKey(), deviceKey = generateSecretKey(), keeper = getPublicKey(keeperKey), device = getPublicKey(deviceKey)
  const box = 'ab'.repeat(32), destination = keeperInboxDestination(box)
  const permission = finalizeEvent({ kind: 24242, content: '', created_at: NOW, tags: [
    ['t', 'keeper-inbox-deposit'], ['server', destination], ['device', device], ['grant', 'ac'.repeat(16)],
    ['expiration', String(NOW + 3600)], ['status', 'active'],
  ] }, keeperKey)
  const event = finalizeEvent({ kind: 1059, created_at: NOW, tags: [['p', keeper]], content: 'sealed opaque payload' }, generateSecretKey())
  const socket = new Socket(), factory = vi.fn((url: string) => { expect(url).toBe(destination); return socket as unknown as WebSocket })
  let live = true, clock = NOW
  const auth = (r: KeeperInboxAuthRequest, route = destination) => finalizeEvent({ kind: 22242, created_at: clock, content: '',
    tags: [['relay', route], ['challenge', r.challenge]] }, deviceKey)
  const authenticate = vi.fn(async (r: KeeperInboxAuthRequest) => auth(r))
  const input: MlsKeeperInboxDeposit = { box, keeper, permission, event, current: () => live, authenticate, beforePublish: async () => {} }
  const begin = (phases?: MlsKeeperInboxDepositBudgets) => publishMlsKeeperInboxDeposit(input, factory, () => clock, phases).then(() => true, () => false)
  const start = async () => { socket.open(); socket.incoming(['AUTH', challenge]); await flush() }
  const authOk = async () => { socket.incoming(['OK', (socket.frames[0]![1] as Event).id, true, '']); await flush() }
  const eventOk = () => socket.incoming(['OK', event.id, true, 'stored'])
  return { input, socket, factory, authenticate, auth, begin, start, authOk, eventOk,
    withdraw: () => { live = false }, setTime: (at: number) => { clock = at } }
}

describe('private keeper deposit protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    vi.stubGlobal('WebSocket', vi.fn(() => { throw new Error('native socket forbidden') }))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('requires matching device AUTH OK before EVENT and matching EVENT OK before success', async () => {
    const f = fixture(), result = f.begin()
    await f.start()
    expect(f.socket.frames.map(frame => frame[0])).toEqual(['AUTH'])
    const auth = f.socket.frames[0]![1] as Event
    expect(auth.pubkey).toBe(f.input.permission.tags.find(t => t[0] === 'device')![1])
    expect(auth.pubkey).not.toBe(f.input.keeper)
    f.socket.incoming(['OK', 'f0'.repeat(32), true, 'unrelated'])
    expect(f.socket.frames).toHaveLength(1)
    await f.authOk()
    expect(f.socket.frames.map(frame => frame[0])).toEqual(['AUTH', 'EVENT'])
    expect((f.socket.frames[1]![1] as Event).tags).toEqual([['p', f.input.keeper]])
    f.eventOk()
    expect(await result).toBe(true)
    expect(f.socket.closed).toBe(true)
    expect(WebSocket).not.toHaveBeenCalled()
  })

  it('never publishes after an AUTH refusal', async () => {
    const f = fixture(), result = f.begin()
    await f.start()
    f.socket.incoming(['OK', (f.socket.frames[0]![1] as Event).id, false, 'private detail not surfaced'])
    expect(await result).toBe(false)
    expect(f.socket.frames.map(frame => frame[0])).toEqual(['AUTH'])
  })

  it('does not confirm a refused EVENT or an unrelated ACK', async () => {
    const f = fixture(), result = f.begin({ openMs: 30, authMs: 75, ackMs: 5 })
    await f.start(); await f.authOk()
    f.socket.incoming(['OK', 'f0'.repeat(32), true, 'unrelated'])
    await vi.advanceTimersByTimeAsync(6)
    expect(await result).toBe(false)
    f.eventOk()
    expect(f.socket.frames).toHaveLength(2)
    const g = fixture(), refused = g.begin()
    await g.start(); await g.authOk(); g.socket.incoming(['OK', g.input.event.id, false, 'quota'])
    expect(await refused).toBe(false)
  })

  it('gives delayed consent its AUTH budget and a fresh ACK budget', async () => {
    const f = fixture()
    let release!: () => void
    f.input.authenticate = r => new Promise(resolve => { release = () => resolve(f.auth(r)) })
    const result = f.begin()
    await f.start()
    await vi.advanceTimersByTimeAsync(6500)
    expect(f.socket.frames).toHaveLength(0)
    release(); await flush()
    await f.authOk()
    await vi.advanceTimersByTimeAsync(4500)
    f.eventOk()
    expect(await result).toBe(true)
  })

  it('rechecks authorization after AUTH OK and gives only the subsequent EVENT a fresh ACK budget', async () => {
    const f = fixture()
    let release!: () => void
    f.input.beforePublish = () => new Promise(resolve => { release = resolve })
    const result = f.begin()
    await f.start(); await f.authOk()
    expect(f.socket.frames.map(frame => frame[0])).toEqual(['AUTH'])
    await vi.advanceTimersByTimeAsync(6500)
    release(); await flush()
    expect(f.socket.frames.map(frame => frame[0])).toEqual(['AUTH', 'EVENT'])
    await vi.advanceTimersByTimeAsync(4500)
    f.eventOk()
    expect(await result).toBe(true)
    const g = fixture()
    g.input.beforePublish = async () => { throw new Error('credential no longer current') }
    const refused = g.begin(); await g.start(); await g.authOk()
    expect(await refused).toBe(false)
    expect(g.socket.frames.map(frame => frame[0])).toEqual(['AUTH'])
  })

  it('cannot extend AUTH by repeating the same challenge', async () => {
    const f = fixture()
    let release!: () => void
    f.input.authenticate = r => new Promise(resolve => { release = () => resolve(f.auth(r)) })
    const result = f.begin({ openMs: 30, authMs: 75, ackMs: 5 })
    await f.start(); await vi.advanceTimersByTimeAsync(74)
    f.socket.incoming(['AUTH', challenge]); await vi.advanceTimersByTimeAsync(2)
    expect(await result).toBe(false)
    release(); await flush()
    expect(f.socket.frames).toHaveLength(0)
  })

  it('closes on withdrawal during non-cancellable signing without late AUTH', async () => {
    const f = fixture()
    let release!: () => void
    f.input.authenticate = r => new Promise(resolve => { release = () => resolve(f.auth(r)) })
    const result = f.begin()
    await f.start(); f.withdraw(); await vi.advanceTimersByTimeAsync(25)
    expect(await result).toBe(false)
    release(); await flush()
    expect(f.socket.frames).toHaveLength(0)
  })

  it('refuses changed challenges without another signer call', async () => {
    const f = fixture(), result = f.begin()
    await f.start()
    f.socket.incoming(['AUTH', 'de'.repeat(32)])
    expect(await result).toBe(false)
    expect(f.authenticate).toHaveBeenCalledTimes(1)
    expect(f.socket.frames.map(frame => frame[0])).toEqual(['AUTH'])
  })

  it('rejects wrong-device or changed-route authentication statements', async () => {
    for (const wrong of ['device', 'route']) {
      const f = fixture()
      f.input.authenticate = async r => wrong === 'device'
        ? finalizeEvent({ kind: 22242, created_at: NOW, content: '', tags: [['relay', keeperInboxDestination(r.box)], ['challenge', r.challenge]] }, generateSecretKey())
        : f.auth(r, 'wss://public.invalid/')
      const result = f.begin(); await f.start()
      expect(await result).toBe(false)
      expect(f.socket.frames).toHaveLength(0)
    }
  })

  it('refuses forged permissions and wrong recipients before opening any socket', async () => {
    const f = fixture()
    f.input.permission = { ...f.input.permission, sig: '00'.repeat(64) }
    expect(await f.begin()).toBe(false)
    expect(f.factory).not.toHaveBeenCalled()
    const g = fixture()
    g.input.event = finalizeEvent({ kind: 1059, created_at: NOW, content: 'sealed', tags: [['p', 'ab'.repeat(32)]] }, generateSecretKey())
    expect(await g.begin()).toBe(false)
    expect(g.factory).not.toHaveBeenCalled()
  })

  it('holds on clock rollback after AUTH rather than publishing', async () => {
    const f = fixture(), result = f.begin()
    await f.start(); f.setTime(NOW - 1); await f.authOk()
    expect(await result).toBe(false)
    expect(f.socket.frames.map(frame => frame[0])).toEqual(['AUTH'])
  })

  it('treats abort or oversized peer input as unconfirmed', async () => {
    const f = fixture(), controller = new AbortController()
    f.input.signal = controller.signal
    const result = f.begin(); await f.start(); await f.authOk(); controller.abort(); f.eventOk()
    expect(await result).toBe(false)
    const g = fixture(), oversized = g.begin()
    g.socket.open(); g.socket.onmessage?.({ data: 'x'.repeat(4097) })
    expect(await oversized).toBe(false)
  })

  it('closes safely when the clock provider fails at the asynchronous AUTH boundary', async () => {
    const f = fixture()
    let reads = 0
    const result = publishMlsKeeperInboxDeposit(f.input, f.factory, () => {
      if (++reads === 5) throw new Error('clock unavailable')
      return NOW
    }).then(() => true, () => false)
    f.socket.open(); f.socket.incoming(['AUTH', challenge]); await flush()
    expect(await result).toBe(false)
    expect(f.socket.frames).toHaveLength(0)
    expect(f.socket.closed).toBe(true)
  })

  it('rejects invalid budgets and stale operations without invoking a socket', async () => {
    const f = fixture()
    expect(await f.begin({ openMs: 30_001, authMs: 75_000, ackMs: 5000 })).toBe(false)
    f.withdraw()
    expect(await f.begin()).toBe(false)
    expect(f.factory).not.toHaveBeenCalled()
  })
})
