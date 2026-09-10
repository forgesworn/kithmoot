import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoxRelayReader } from './box-relay-reader.js'
import { boxFixture } from '../../test/box-status-fixture.js'

class Socket {
  readyState = 0
  onopen?: () => void
  onclose?: () => void
  onerror?: () => void
  onmessage?: (message: { data: unknown }) => void
  sent: unknown[][] = []
  open() { this.readyState = 1; this.onopen?.() }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  close() { this.readyState = 3; this.onclose?.() }
}
function setup(two = false) {
  const sockets: Socket[] = [], unavailable = vi.fn(), receive = vi.fn(), ready = vi.fn()
  const reader = new BoxRelayReader((two ? ['wss://one.test', 'wss://two.test'] : ['wss://one.test']).map(url => ({ url, read: true, write: false })), unavailable, () => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket })
  reader.subscribe([{ kinds: [10640], authors: [boxFixture().p] }], receive, ready)
  for (const s of sockets) s.open()
  return { reader, sockets, unavailable, receive, ready }
}
afterEach(() => vi.useRealTimers())
describe('box discovery relay history', () => {
  it('waits for actual EOSE from every read relay and never sends a publication', async () => {
    const f = setup(true)
    f.sockets[0]!.message(['EOSE', 'box-1']); expect(f.ready).not.toHaveBeenCalled()
    f.sockets[1]!.message(['EOSE', 'box-1']); expect(f.ready).toHaveBeenCalledTimes(1)
    f.sockets[0]!.message(['EOSE', 'box-1']); expect(f.ready).toHaveBeenCalledTimes(1)
    await expect(f.reader.publish()).rejects.toThrow('read-only')
    expect(f.sockets.flatMap(s => s.sent).every(m => m[0] === 'REQ')).toBe(true); f.reader.close()
  })
  it('does not turn a timeout into a completed history read', () => {
    vi.useFakeTimers(); const f = setup()
    vi.advanceTimersByTime(15_000)
    expect(f.ready).not.toHaveBeenCalled(); expect(f.unavailable).toHaveBeenCalledTimes(1)
    expect(f.sockets[0]!.readyState).toBe(3)
    vi.advanceTimersByTime(5_000); f.sockets[1]!.open()
    f.sockets[1]!.message(['EOSE', 'box-1']); expect(f.ready).toHaveBeenCalledTimes(1); f.reader.close()
  })
  it('invalidates on disconnect and requires every relay again after reconnect', () => {
    vi.useFakeTimers(); const f = setup(true)
    for (const s of f.sockets) s.message(['EOSE', 'box-1'])
    expect(f.ready).toHaveBeenCalledTimes(1)
    f.sockets[0]!.close(); expect(f.unavailable).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5_000)
    f.sockets[2]!.open(); f.sockets[3]!.open()
    f.sockets[2]!.message(['EOSE', 'box-1']); expect(f.ready).toHaveBeenCalledTimes(1)
    f.sockets[3]!.message(['EOSE', 'box-1']); expect(f.ready).toHaveBeenCalledTimes(2); f.reader.close()
  })
  it('filters events and ignores unknown or malformed completion frames', () => {
    const f = setup(), status = boxFixture().status()
    const s = f.sockets[0]!
    s.message(['EVENT', 'box-1', status]); expect(f.receive).toHaveBeenCalledWith(JSON.parse(JSON.stringify(status)))
    s.message(['EVENT', 'box-1', { ...status, kind: 1 }]); expect(f.receive).toHaveBeenCalledTimes(1)
    s.message(['EOSE', 'unknown']); s.message(['EOSE', 'box-1', 'extra']); expect(f.ready).not.toHaveBeenCalled()
    s.message(['CLOSED', 'box-1', 'restricted']); expect(f.unavailable).toHaveBeenCalledTimes(1); f.reader.close()
  })
  it('bounds oversized frames and floods without retaining their contents', () => {
    vi.useFakeTimers(); const f = setup()
    for (let i = 0; i < 257; i++) f.sockets[0]!.message(['NOTICE', 'noise'])
    expect(f.unavailable).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000); const s = f.sockets[1]!; s.open()
    s.onmessage?.({ data: 'x'.repeat(33_001) }); expect(f.unavailable).toHaveBeenCalledTimes(2)
    f.reader.close(); vi.advanceTimersByTime(60_000); expect(f.sockets).toHaveLength(2)
  })
  it('allows a completed exact-id lookup to close while other relay histories remain live', () => {
    const f = setup(true), seedReady = vi.fn()
    f.reader.subscribe([{ ids: [boxFixture().claim.id], kinds: [30640] }], () => {}, seedReady)
    f.sockets[0]!.message(['EOSE', 'box-2'])
    f.sockets[0]!.message(['CLOSED', 'box-2', 'stored: all requested events found'])
    expect(f.unavailable).not.toHaveBeenCalled(); expect(seedReady).not.toHaveBeenCalled()
    f.sockets[1]!.message(['EOSE', 'box-2'])
    f.sockets[1]!.message(['CLOSED', 'box-2', 'stored: all requested events found'])
    expect(seedReady).toHaveBeenCalledTimes(1); expect(f.unavailable).not.toHaveBeenCalled()
    for (const socket of f.sockets) socket.message(['EOSE', 'box-1'])
    expect(f.ready).toHaveBeenCalledTimes(1)
    f.sockets[0]!.message(['CLOSED', 'box-1', 'live history lost'])
    expect(f.unavailable).toHaveBeenCalledTimes(1); f.reader.close()
  })
  it.each([false, true])('refuses incomplete or prefix-id closure (prefix=%s)', prefix => {
    const f = setup()
    f.reader.subscribe([{ ids: [prefix ? 'abcd' : boxFixture().claim.id] }], () => {}, () => {})
    if (prefix) f.sockets[0]!.message(['EOSE', 'box-2'])
    f.sockets[0]!.message(['CLOSED', 'box-2', 'restricted'])
    expect(f.unavailable).toHaveBeenCalledTimes(1); f.reader.close()
  })
  it('rejects unavailable read configuration', () => {
    expect(() => new BoxRelayReader([{ url: 'wss://one.test', read: false, write: true }], () => {})).toThrow('read relay')
  })
})
