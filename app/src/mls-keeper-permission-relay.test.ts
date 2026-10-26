import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyEvent } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { publishKeeperInboxPermission } from './mls-keeper-permission-relay.js'
const v = JSON.parse(readFileSync(new URL('../../test/fixtures/keeper-inbox-permission.json', import.meta.url), 'utf8'))
class Socket {
  readyState = 0
  onopen: ((e: any) => void) | null = null
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  onclose: ((e: any) => void) | null = null
  frames: any[][] = []
  open() { this.readyState = 1; this.onopen?.({ type: 'open' }) }
  incoming(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  send(text: string) { if (this.readyState !== 1) throw new Error('closed'); this.frames.push(JSON.parse(text)) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000, reason: 'closed' }) }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fixture() {
  const key = new Uint8Array(32); key[31] = 1
  const local = localIdentity(key), identity = { ...local, signEvent: vi.fn(local.signEvent) }, socket = new Socket()
  let current = true, now = v.now
  const factory = vi.fn((url: string) => { expect(url).toBe(v.server); return socket as unknown as WebSocket })
  const begin = (event = v.active, budgets?: { open: number; auth: number; ack: number }) => publishKeeperInboxPermission(event, identity, () => current, factory, () => now, budgets).then(() => true, () => false)
  return { socket, identity, factory, begin, stop: () => { current = false }, clock: (at: number) => { now = at } }
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Date, 'now').mockReturnValue(v.now * 1000) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('concrete account AUTH permission publication', () => {
  it('identifies the exact keeper with verified NIP42 before publishing exact active material and requires its matching ACK', async () => {
    const f = fixture(), pending = f.begin()
    f.socket.open(); f.socket.incoming(['AUTH', 'ab'.repeat(32)]); await flush()
    expect(f.socket.frames.map(f => f[0])).toEqual(['AUTH'])
    const auth = f.socket.frames[0]![1]
    expect(auth.pubkey).toBe(v.keeper); expect(auth.kind).toBe(22242); expect(verifyEvent(auth)).toBe(true)
    expect(auth.tags).toEqual([['relay', v.server], ['challenge', 'ab'.repeat(32)]])
    f.socket.incoming(['OK', auth.id, true, '']); await flush()
    expect(f.socket.frames.map(f => f[0])).toEqual(['AUTH','EVENT']); expect(f.socket.frames[1]![1]).toEqual(v.active)
    f.socket.incoming(['OK', v.active.id, true, '']); expect(await pending).toBe(true)
    expect(f.socket.readyState).toBe(3); expect(f.identity.signEvent).toHaveBeenCalledOnce()
  })
  it('publishes exact terminal material through the same keeper authentication path', async () => {
    const f = fixture(), pending = f.begin(v.revoked)
    f.socket.open(); f.socket.incoming(['AUTH', 'ab'.repeat(32)]); await flush()
    f.socket.incoming(['OK', f.socket.frames[0]![1].id, true, '']); await flush()
    expect(f.socket.frames[1]![1]).toEqual(v.revoked)
    f.socket.incoming(['OK', v.revoked.id, true, '']); expect(await pending).toBe(true)
  })
  it.each(['AUTH','EVENT'] as const)('never treats a negative %s acknowledgement as installation', async phase => {
    const f = fixture(), pending = f.begin(); f.socket.open(); f.socket.incoming(['AUTH', 'ab'.repeat(32)]); await flush()
    f.socket.incoming(['OK', f.socket.frames[0]![1].id, phase !== 'AUTH', 'denied']); await flush()
    if (phase === 'EVENT') f.socket.incoming(['OK', v.active.id, false, 'denied'])
    expect(await pending).toBe(false); expect(f.socket.frames.filter(f => f[0] === 'EVENT')).toHaveLength(phase === 'AUTH' ? 0 : 1)
  })
  it('does not fabricate an ACK from a different event id and starts a fresh ACK budget after auth', async () => {
    const f = fixture(), pending = f.begin(v.active, { open: 30, auth: 75, ack: 5 })
    f.socket.open(); await vi.advanceTimersByTimeAsync(60); f.socket.incoming(['AUTH', 'ab'.repeat(32)]); await flush()
    f.socket.incoming(['OK', f.socket.frames[0]![1].id, true, '']); await flush(); await vi.advanceTimersByTimeAsync(4)
    f.socket.incoming(['OK', v.revoked.id, true, '']); await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toBe(false)
  })
  it('closes a withdrawn operation and never emits late account AUTH after non-cancellable signing', async () => {
    const f = fixture(); let release!: () => void
    const original = f.identity.signEvent.getMockImplementation()!, waiting = new Promise<void>(resolve => { release = resolve })
    f.identity.signEvent.mockImplementation(async template => { await waiting; return original(template) })
    const pending = f.begin(); f.socket.open(); f.socket.incoming(['AUTH', 'ab'.repeat(32)]); await flush()
    f.stop(); await vi.advanceTimersByTimeAsync(25); release(); await flush()
    expect(await pending).toBe(false); expect(f.socket.frames).toEqual([])
  })
  it('fails closed on malformed frame overflow and clock rollback', async () => {
    const f = fixture(), pending = f.begin(); f.socket.open()
    f.socket.onmessage?.({ data: 'x'.repeat(4097) }); expect(await pending).toBe(false)
    const g = fixture(), other = g.begin(); g.socket.open(); g.clock(v.now - 1); await vi.advanceTimersByTimeAsync(25)
    expect(await other).toBe(false); expect(g.socket.frames).toEqual([])
  })
})
