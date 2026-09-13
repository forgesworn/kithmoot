import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWeriftFactory, DEFAULT_ICE_REFRESH_MS } from './webrtc.js'
import type { PeerContext } from '../peer.js'

const TURN_CONTEXT: PeerContext = { tier: 'turn', remoteDevice: 'device' }

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('createWeriftFactory', () => {
  it('builds no ICE servers, and logs, when nothing is configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const factory = await createWeriftFactory()
    const pc = factory() as unknown as { getConfiguration(): RTCConfiguration }
    expect(pc.getConfiguration().iceServers).toEqual([])
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0]![0]).toContain('no STUN or TURN server configured')
  })

  it('splits static iceUrls into a STUN-only rung and a STUN+TURN rung, applying one credential to every turn: url', async () => {
    const factory = await createWeriftFactory({
      iceUrls: ['stun:s.example:3478', 'turn:t.example:3478', 'turns:t.example:5349'],
      turn: { username: 'u', credential: 'p' },
    })
    const direct = factory() as unknown as { getConfiguration(): RTCConfiguration }
    expect(direct.getConfiguration().iceServers).toEqual([{ urls: 'stun:s.example:3478' }])

    const turnRung = factory(TURN_CONTEXT) as unknown as { getConfiguration(): RTCConfiguration }
    expect(turnRung.getConfiguration().iceServers).toEqual([
      { urls: 'stun:s.example:3478' },
      { urls: 'turn:t.example:3478', username: 'u', credential: 'p' },
      { urls: 'turns:t.example:5349', username: 'u', credential: 'p' },
    ])
  })

  it('resolves refresh once immediately, using it as the initial configuration', async () => {
    const resolve = vi.fn().mockResolvedValue({ iceUrls: ['stun:origin.example:3478'] })
    const factory = await createWeriftFactory({ refresh: { resolve } })
    expect(resolve).toHaveBeenCalledOnce()
    const pc = factory() as unknown as { getConfiguration(): RTCConfiguration }
    expect(pc.getConfiguration().iceServers).toEqual([{ urls: 'stun:origin.example:3478' }])
  })

  it('re-resolves on the refresh interval, and future connections see the fresh result', async () => {
    vi.useFakeTimers()
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ iceUrls: ['stun:first.example:3478'] })
      .mockResolvedValueOnce({ iceUrls: ['stun:second.example:3478'] })
    const factory = await createWeriftFactory({ refresh: { resolve, intervalMs: 1000 } })

    const before = factory() as unknown as { getConfiguration(): RTCConfiguration }
    expect(before.getConfiguration().iceServers).toEqual([{ urls: 'stun:first.example:3478' }])

    await vi.advanceTimersByTimeAsync(1000)
    expect(resolve).toHaveBeenCalledTimes(2)

    const after = factory() as unknown as { getConfiguration(): RTCConfiguration }
    expect(after.getConfiguration().iceServers).toEqual([{ urls: 'stun:second.example:3478' }])
  })

  it('keeps the last good configuration when a refresh fails', async () => {
    vi.useFakeTimers()
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ iceUrls: ['stun:good.example:3478'] })
      .mockRejectedValueOnce(new Error('/turn is down'))
    const factory = await createWeriftFactory({ refresh: { resolve, intervalMs: 1000 } })

    await vi.advanceTimersByTimeAsync(1000)
    expect(resolve).toHaveBeenCalledTimes(2)

    const pc = factory() as unknown as { getConfiguration(): RTCConfiguration }
    expect(pc.getConfiguration().iceServers).toEqual([{ urls: 'stun:good.example:3478' }])
  })

  it('defaults the refresh interval to the same 40 minutes as the web app', () => {
    expect(DEFAULT_ICE_REFRESH_MS).toBe(40 * 60 * 1000)
  })
})
