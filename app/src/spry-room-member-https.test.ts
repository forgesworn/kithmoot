import { expect, it, vi } from 'vitest'
import type { ParticipantView, RoomSession } from '../../src/session.js'
import type { RoomDescriptor } from '../../src/types.js'
import type { SpryOffer } from '../../src/spry.js'
import { SpryRoom } from './spry-room.js'

// A guest and another member's paired Spry relay reached over `https:`: the
// same Hide my IP gate as a built-in relay, naming the one host.
const seconds = () => Math.floor(Date.now() / 1000)
const ENDPOINT = 'https://relay.example'
const HOST = 'a1'.repeat(32), GUEST = 'b2'.repeat(32), OTHER = 'c3'.repeat(32)
const offer = (): SpryOffer => ({ v: 1, endpoint: ENDPOINT, token: 'a'.repeat(43), expiresAt: seconds() + 86400 })

function room(shared: SpryOffer, publishers: string[] = [HOST]) {
  let change: (views: ParticipantView[]) => void = () => {}
  const publish = vi.fn(async () => {})
  const descriptors = publishers.map(participant => ({ participant, device: participant, spry: shared }))
  const session = { roomId: 'generated-room', participant: GUEST, call: 'generated-call', descriptor: { spry: shared },
    onDescriptor: (cb: (d: RoomDescriptor) => void) => { cb({ spry: shared, participant: publishers[0] } as unknown as RoomDescriptor); return () => {} },
    peerDescriptors: () => descriptors,
    onChange: (cb: typeof change) => { change = cb; return () => {} }, publishDescriptor: publish,
  } as unknown as RoomSession
  return { session, publish, change: (views: ParticipantView[]) => change(views) }
}

function node() {
  const requests: string[] = []
  const fetcher: typeof fetch = async url => {
    requests.push(String(url))
    const expiresAt = seconds() + 300
    return Response.json({ urls: ['turn:relay.example:3478?transport=udp'], username: `${expiresAt}:${'b'.repeat(24)}`,
      credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400 })
  }
  return { requests, fetcher }
}

it('waits for the app\'s yes before it redeems a member\'s https relay, and names the one host', async () => {
  const { session } = room(offer())
  const { requests, fetcher } = node()
  let allowed = false
  const asked: (string | undefined)[] = []
  const apply = vi.fn()
  const broker = new SpryRoom(session, undefined, apply, fetcher, new Uint8Array(32).fill(9), undefined, () => {},
    { mayUse: host => { asked.push(host); return allowed } })
  try {
    await broker.prepare(true)
    expect(requests, 'nothing sent before the choice').toEqual([])
    expect(apply).not.toHaveBeenCalled()
    expect(broker.blocked()).toEqual({ endpoint: ENDPOINT, host: HOST })
    expect(asked).toContain(HOST)
    allowed = true
    await broker.prepare(true)
    expect(requests).toEqual([ENDPOINT + '/v1/credentials'])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(broker.blocked()).toBeUndefined()
  } finally { broker.close() }
})

it('uses a member\'s https relay without asking when nothing gates it', async () => {
  const { session } = room(offer())
  const { requests, fetcher } = node()
  const broker = new SpryRoom(session, undefined, vi.fn(), fetcher, new Uint8Array(32).fill(9))
  try {
    await broker.prepare(true)
    expect(requests).toEqual([ENDPOINT + '/v1/credentials'])
    expect(broker.blocked()).toBeUndefined()
  } finally { broker.close() }
})

it('names no host when more than one participant publishes the same https relay, and does not redeem it', async () => {
  const { session } = room(offer(), [HOST, OTHER])
  const { requests, fetcher } = node()
  const broker = new SpryRoom(session, undefined, vi.fn(), fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { mayUse: host => !!host })
  try {
    await broker.prepare(true)
    expect(broker.blocked()).toEqual({ endpoint: ENDPOINT, host: undefined })
    expect(requests).toEqual([])
  } finally { broker.close() }
})

it('never asks about this device\'s own node, even when the room shows the same https offer', async () => {
  const { session } = room(offer())
  const { requests, fetcher } = node()
  const asked = vi.fn(() => false)
  const pairing = { v: 1 as const, endpoint: ENDPOINT, id: 'c'.repeat(43), secretKey: '04'.repeat(32) }
  const broker = new SpryRoom(session, pairing, vi.fn(), fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { share: false, mayUse: asked })
  try {
    await broker.prepare(true).catch(() => {})
    expect(asked).not.toHaveBeenCalled()
    expect(broker.blocked()).toBeUndefined()
    expect(requests.length).toBeGreaterThan(0)
  } finally { broker.close() }
})

it('does not republish another member\'s https offer, so its host stays the only publisher', async () => {
  vi.useFakeTimers()
  const { session, publish, change } = room(offer())
  const { fetcher } = node()
  const broker = new SpryRoom(session, undefined, vi.fn(), fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { share: false })
  try {
    await broker.prepare(true)
    change([{ devices: ['generated-a', 'generated-b'] }] as ParticipantView[])
    await vi.advanceTimersByTimeAsync(2000)
    expect(publish).not.toHaveBeenCalled()
  } finally { broker.close(); vi.useRealTimers() }
})
