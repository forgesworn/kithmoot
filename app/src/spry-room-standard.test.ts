import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { ParticipantView, RoomSession } from '../../src/session.js'
import type { RoomDescriptor } from '../../src/types.js'
import type { SpryOffer } from '../../src/spry.js'

// A guest and another member's built-in relay (a standard-profile Spry node
// reached over `spry:` control). The control channel answers as such a node.
const control = vi.hoisted(() => ({ requests: [] as { endpoint: string; path: string }[], answer: undefined as undefined | (() => Record<string, unknown>) }))
vi.mock('../../src/spry-link.js', async original => ({
  ...await original<typeof import('../../src/spry-link.js')>(),
  spryControlRequest: async (endpoint: string, path: string) => { control.requests.push({ endpoint, path }); return control.answer!() },
}))
import { SpryRoom, spryOfferHost } from './spry-room.js'

const seconds = () => Math.floor(Date.now() / 1000)
const nodeKey = new Uint8Array(32).fill(1)
const endpoint = `spry://${getPublicKey(nodeKey)}?relay=${encodeURIComponent('wss://relay.example/')}`
const card = (content: string) => finalizeEvent({ kind: 24183, created_at: seconds(), tags: [['expiration', String(seconds() + 600)]], content }, nodeKey)
const standard = () => card('{"profile":"spry-standard-v1","v":1}')
const HOST = 'a1'.repeat(32), GUEST = 'b2'.repeat(32), OTHER = 'c3'.repeat(32)

afterEach(() => { control.requests = []; control.answer = undefined })

function room(offer: SpryOffer, publishers: string[] = [HOST]) {
  let change: (views: ParticipantView[]) => void = () => {}
  const publish = vi.fn(async () => {})
  const descriptors = publishers.map(participant => ({ participant, device: participant, spry: offer }))
  const session = { roomId: 'generated-room', participant: GUEST, call: 'generated-call', descriptor: { spry: offer },
    onDescriptor: (cb: (d: RoomDescriptor) => void) => { cb({ spry: offer, participant: publishers[0] } as unknown as RoomDescriptor); return () => {} },
    peerDescriptors: () => descriptors,
    onChange: (cb: typeof change) => { change = cb; return () => {} }, publishDescriptor: publish,
  } as unknown as RoomSession
  return { session, publish, change: (views: ParticipantView[]) => change(views) }
}
const offerWith = (node = standard()): SpryOffer => ({ v: 1, endpoint, token: 'a'.repeat(43), expiresAt: seconds() + 86400, node })
const credential = () => {
  const expiresAt = seconds() + 300
  return { urls: ['turn:1.2.3.4:51000?transport=udp', 'turn:1.2.3.4:51001?transport=tcp'], username: `${expiresAt}:${'b'.repeat(24)}`,
    credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400, node: standard() }
}

it('a guest redeems another member\'s built-in relay, and never republishes its offer', async () => {
  vi.useFakeTimers()
  control.answer = credential
  const { session, publish, change } = room(offerWith())
  const apply = vi.fn()
  const broker = new SpryRoom(session, undefined, apply, fetch, new Uint8Array(32).fill(9), undefined, () => {}, { share: false })
  try {
    await broker.prepare(true)
    expect(control.requests).toEqual([{ endpoint, path: '/v1/credentials' }])
    expect(apply).toHaveBeenCalledWith([expect.objectContaining({ urls: credential().urls })])
    expect(broker.blocked()).toBeUndefined()
    change([{ devices: ['generated-a', 'generated-b'] }] as ParticipantView[])
    await vi.advanceTimersByTimeAsync(2000)
    expect(publish).not.toHaveBeenCalled()
  } finally { broker.close(); vi.useRealTimers() }
})

it('a guest never contacts another member\'s private node', async () => {
  control.answer = credential
  const { session } = room(offerWith(card(JSON.stringify({ v: 1, profile: 'spry-peer-v1', address: '[fd12:3456::2]:3745' }))))
  const apply = vi.fn()
  const broker = new SpryRoom(session, undefined, apply, fetch, new Uint8Array(32).fill(9))
  try {
    await broker.prepare(true)
    expect(control.requests).toEqual([])
    expect(apply).not.toHaveBeenCalled()
    expect(broker.blocked()).toBeUndefined()
  } finally { broker.close() }
})

it('waits for the app\'s yes before it redeems a member relay, and names the one host', async () => {
  control.answer = credential
  const { session } = room(offerWith())
  let allowed = false
  const asked: (string | undefined)[] = []
  const apply = vi.fn()
  const broker = new SpryRoom(session, undefined, apply, fetch, new Uint8Array(32).fill(9), undefined, () => {},
    { mayUse: host => { asked.push(host); return allowed } })
  try {
    await broker.prepare(true)
    expect(control.requests, 'nothing sent before the choice').toEqual([])
    expect(apply).not.toHaveBeenCalled()
    expect(broker.blocked()).toEqual({ endpoint, host: HOST })
    expect(asked).toContain(HOST)
    allowed = true
    await broker.prepare(true)
    expect(control.requests).toEqual([{ endpoint, path: '/v1/credentials' }])
    expect(apply).toHaveBeenCalled()
    expect(broker.blocked()).toBeUndefined()
  } finally { broker.close() }
})

it('names no host when more than one participant publishes the same relay', async () => {
  const { session } = room(offerWith(), [HOST, OTHER])
  const broker = new SpryRoom(session, undefined, () => {}, fetch, new Uint8Array(32).fill(9), undefined, () => {}, { mayUse: host => !!host })
  try {
    await broker.prepare(true)
    expect(broker.blocked()).toEqual({ endpoint, host: undefined })
    expect(control.requests).toEqual([])
  } finally { broker.close() }
  expect(spryOfferHost([{ participant: HOST, spry: offerWith() }, { participant: HOST, spry: offerWith() }], endpoint)).toBe(HOST)
  expect(spryOfferHost([{ participant: HOST }], endpoint)).toBeUndefined()
})

it('a relay outside test names the host and the Hide my IP answer, and its login touches no call', async () => {
  vi.useFakeTimers()
  control.answer = credential
  const { session } = room(offerWith())
  // Not on a call, so nothing else redeems or applies a login.
  Object.assign(session, { call: undefined })
  const apply = vi.fn()
  let allowed = false
  const broker = new SpryRoom(session, undefined, apply, fetch, new Uint8Array(32).fill(9), undefined, () => {}, { share: false, mayUse: () => allowed })
  try {
    expect(broker.hostedEndpoint()).toBeUndefined()
    expect(broker.testOffer(endpoint.replace('relay.example', 'other.example'))).toBeUndefined()
    expect(broker.testOffer(endpoint)).toEqual({ host: HOST, usable: false })
    await expect(broker.testCredential(endpoint)).rejects.toThrow()
    expect(control.requests).toEqual([])
    allowed = true
    expect(broker.testOffer(endpoint)).toEqual({ host: HOST, usable: true })
    await expect(broker.testCredential(endpoint)).resolves.toMatchObject({ urls: credential().urls })
    expect(control.requests).toEqual([{ endpoint, path: '/v1/credentials' }])
    await vi.advanceTimersByTimeAsync(31_000)
    expect(apply).not.toHaveBeenCalled()
  } finally { broker.close(); vi.useRealTimers() }
})
