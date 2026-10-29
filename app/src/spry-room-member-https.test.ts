import { expect, it, vi } from 'vitest'
import type { ParticipantView, RoomSession } from '../../src/session.js'
import type { RoomDescriptor } from '../../src/types.js'
import type { SpryOffer } from '../../src/spry.js'
import { SpryRoom } from './spry-room.js'

// A guest and another member's paired Spry relay reached over `https:`: the
// same Hide my IP gate as a built-in relay, naming the one host. A host is the
// one participant whose own descriptor carries the offer unmarked; a copy
// republished by a guest is marked `relayed: true` and names nobody.
const seconds = () => Math.floor(Date.now() / 1000)
const ENDPOINT = 'https://relay.example'
const HOST = 'a1'.repeat(32), GUEST = 'b2'.repeat(32), OTHER = 'c3'.repeat(32)
const offer = (): SpryOffer => ({ v: 1, endpoint: ENDPOINT, token: 'a'.repeat(43), expiresAt: seconds() + 86400 })

function room(shared: SpryOffer, publishers: string[] = [HOST], copies: string[] = []) {
  let change: (views: ParticipantView[]) => void = () => {}
  const publish = vi.fn(async () => {})
  const descriptors = [...publishers.map(participant => ({ participant, device: participant, spry: shared })),
    ...copies.map(participant => ({ participant, device: participant, spry: { ...shared, relayed: true as const } }))]
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

it('republishes another member\'s https offer only as a marked copy', async () => {
  vi.useFakeTimers()
  const { session, publish, change } = room(offer())
  const { fetcher } = node()
  const broker = new SpryRoom(session, undefined, vi.fn(), fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { share: false })
  try {
    await broker.prepare(true)
    change([{ devices: ['generated-a', 'generated-b'] }] as ParticipantView[])
    await vi.advanceTimersByTimeAsync(2000)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ spry: expect.objectContaining({ endpoint: ENDPOINT, relayed: true }) }))
  } finally { broker.close(); vi.useRealTimers() }
})

it('does not copy an offer it may not use yet', async () => {
  vi.useFakeTimers()
  const { session, publish, change } = room(offer())
  const broker = new SpryRoom(session, undefined, vi.fn(), node().fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { share: false, mayUse: () => false })
  try {
    await broker.prepare(true).catch(() => {})
    change([{ devices: ['generated-a', 'generated-b'] }] as ParticipantView[])
    await vi.advanceTimersByTimeAsync(2000)
    expect(publish).not.toHaveBeenCalled()
  } finally { broker.close(); vi.useRealTimers() }
})

it('names the host only from the unmarked offer, ignoring copies beside it', async () => {
  const { session } = room(offer(), [HOST], [OTHER])
  const broker = new SpryRoom(session, undefined, vi.fn(), node().fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { mayUse: () => false })
  try {
    await broker.prepare(true)
    expect(broker.blocked()).toEqual({ endpoint: ENDPOINT, host: HOST })
  } finally { broker.close() }
})

it('names nobody from a marked copy alone: a Hide my IP guest fails closed, one without it still uses the relay', async () => {
  const asked: (string | undefined)[] = []
  // The host is away; only a member's marked copy remains.
  const closed = room(offer(), [], [OTHER])
  const gated = node()
  const brokerOn = new SpryRoom(closed.session, undefined, vi.fn(), gated.fetcher, new Uint8Array(32).fill(9), undefined, () => {},
    { mayUse: host => { asked.push(host); return !!host } })
  try {
    await brokerOn.prepare(true)
    expect(brokerOn.blocked()).toEqual({ endpoint: ENDPOINT, host: undefined })
    expect(gated.requests).toEqual([])
    expect(asked.every(host => host === undefined)).toBe(true)
  } finally { brokerOn.close() }
  // Hide my IP off asks nothing of the gate's host and uses the copy.
  const open = room(offer(), [], [OTHER])
  const free = node(), apply = vi.fn()
  const brokerOff = new SpryRoom(open.session, undefined, apply, free.fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { mayUse: () => true })
  try {
    await brokerOff.prepare(true)
    expect(free.requests).toEqual([ENDPOINT + '/v1/credentials'])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(brokerOff.blocked()).toBeUndefined()
  } finally { brokerOff.close() }
})

it('names nobody when an old client\'s unmarked copy sits beside the host\'s offer', async () => {
  const { session } = room(offer(), [HOST, OTHER])
  const broker = new SpryRoom(session, undefined, vi.fn(), node().fetcher, new Uint8Array(32).fill(9), undefined, () => {}, { mayUse: host => !!host })
  try {
    await broker.prepare(true)
    expect(broker.blocked()).toEqual({ endpoint: ENDPOINT, host: undefined })
  } finally { broker.close() }
})
