import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { RoomSession } from '../../src/session.js'

const peers = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../../src/spry.js', async original => {
  const actual = await original<typeof import('../../src/spry.js')>()
  return {
    ...actual,
    // Nothing else answers, so a refresh reaches the peer list and stops.
    spryGrant: vi.fn(async () => { throw new actual.SpryRequestError(0) }),
    spryPeers: vi.fn(async (...args: unknown[]) => { peers.calls.push(args) }),
  }
})
const { SpryRoom } = await import('./spry-room.js')

afterEach(() => { vi.useRealTimers(); peers.calls.length = 0 })

function card(seed: number, address: string) {
  const key = new Uint8Array(32).fill(seed)
  const now = Math.floor(Date.now() / 1000)
  return finalizeEvent({ kind: 24183, created_at: now, tags: [['expiration', String(now + 600)]],
    content: JSON.stringify({ v: 1, profile: 'spry-peer-v1', address }) }, key)
}

it('tells the paired node its peers only when they change, not every 30 s', async () => {
  vi.useFakeTimers()
  const own = getPublicKey(new Uint8Array(32).fill(9))
  const endpoint = `spry://${own}?relay=${encodeURIComponent('wss://relay.example/')}`
  let descriptors = [{ spry: { node: card(1, '[fd00::1]:3745') } }]
  const session = { roomId: 'generated-room', call: undefined, descriptor: {}, onDescriptor: () => () => {},
    onChange: () => () => {}, publishDescriptor: async () => {}, peerDescriptors: () => descriptors } as unknown as RoomSession
  const broker = new SpryRoom(session, { v: 1, endpoint, id: 'c'.repeat(43), secretKey: '01'.repeat(32) }, () => {}, fetch)
  try {
    await vi.advanceTimersByTimeAsync(1)
    expect(peers.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(peers.calls).toHaveLength(1)
    // A new peer, or a peer's card renewed, is worth telling.
    descriptors = [...descriptors, { spry: { node: card(2, '[fd00::2]:3745') } }]
    await vi.advanceTimersByTimeAsync(30_000)
    expect(peers.calls).toHaveLength(2)
    expect((peers.calls[1]![3] as unknown[]).length).toBe(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(peers.calls).toHaveLength(2)
  } finally { broker.close() }
  // Closing always tells the node the room has no peers left.
  expect(peers.calls).toHaveLength(3)
  expect(peers.calls[2]![3]).toEqual([])
})
