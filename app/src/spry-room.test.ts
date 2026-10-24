import { afterEach, expect, it, vi } from 'vitest'
import type { RoomSession, ParticipantView } from '../../src/session.js'
import type { RoomDescriptor } from '../../src/types.js'
import { SpryRoom } from './spry-room.js'

afterEach(() => vi.useRealTimers())

it('uses an offer received during joining and renews without the paired participant', async () => {
  vi.useFakeTimers()
  const endpoint = 'https://relay.example:3744'
  const offer = { v: 1 as const, endpoint, token: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 86400 }
  let change: (views: ParticipantView[]) => void = () => {}
  const publish = vi.fn(async () => {})
  const session = { roomId: 'generated-room', call: 'generated-call', descriptor: { spry: offer },
    onDescriptor: (cb: (d: RoomDescriptor) => void) => { cb({ spry: offer } as RoomDescriptor); return () => {} },
    onChange: (cb: typeof change) => { change = cb; return () => {} }, publishDescriptor: publish,
  } as unknown as RoomSession
  const apply = vi.fn(), retained = vi.fn()
  let requests = 0
  const fetcher: typeof fetch = async url => {
    expect(String(url)).toBe(endpoint + '/v1/credentials')
    requests++
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    return Response.json({ urls: ['turn:relay.example:3478?transport=udp'], username: `${expiresAt}:${'b'.repeat(24)}`,
      credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400 })
  }
  const broker = new SpryRoom(session, undefined, apply, fetcher, new Uint8Array(32).fill(1), undefined, retained)
  try {
    await broker.prepare()
    expect(requests).toBe(1)
    expect(apply).toHaveBeenCalledTimes(1)
    const roster = [{ devices: ['generated-a', 'generated-b'] }] as ParticipantView[]
    change(roster)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 4; i++) change(roster)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(240000)
    expect(requests).toBe(2)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(retained).toHaveBeenCalled()
    broker.close()
    await vi.advanceTimersByTimeAsync(300000)
    expect(requests).toBe(2)
  } finally { broker.close() }
})
