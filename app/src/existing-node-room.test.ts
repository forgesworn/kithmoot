import { expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { signNodeRoom, readNodeRoom } from '@forgesworn/fold-kit/node-room'
import { createDeviceCredential } from '../../src/credential.js'
import { localIdentity } from '../../src/identity.js'
import { deriveRoom } from '../../src/room.js'
import { memoryDeviceStore } from './device-store.js'
import { NODE_ROOM_PREFIX, loadNodeRoom } from './node-rooms.js'
import { prepareExistingBrowserNodeRoom, acceptExistingBrowserNodeRoom, type ExistingBrowserRoom } from './existing-node-room.js'
const now = 1_900_000_000
async function fixture() {
  const owner = localIdentity(generateSecretKey()), guest = localIdentity(generateSecretKey()), secret = generateSecretKey(), authoritySk = generateSecretKey()
  const room = deriveRoom(secret).roomId, keys = [generateSecretKey(), generateSecretKey()]
  const credentials = await Promise.all([owner, guest].map((identity, i) => createDeviceCredential({ identity, devicePubkey: getPublicKey(keys[i]!), roomId: room, now: () => now, expiresAt: now + 86400 })))
  const source: ExistingBrowserRoom = { authority: getPublicKey(authoritySk), authoritySk, secret, deviceSk: keys[0]!, credential: credentials[0]!, participant: owner.pubkey,
    epoch: 3, destruct: false, startsAt: now - 100, name: 'Our existing chat', link: 'https://kithmoot.app/j/#original',
    policy: { tier: 'open', members: [owner.pubkey, guest.pubkey], quiet: true }, removed: [],
    devices: credentials.map((credential, i) => ({ credential, device: getPublicKey(keys[i]!), participant: [owner.pubkey, guest.pubkey][i]! })) }
  const store = memoryDeviceStore(), pair = { v: 1 as const, origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), owner: owner.pubkey }
  const posted: Event[] = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const saved = JSON.parse(store.get(NODE_ROOM_PREFIX + owner.pubkey + '.' + room)!)
    expect(saved.source.activated).toBe(false)
    expect(saved.secret).toBe(Buffer.from(secret).toString('hex'))
    if (String(url).endsWith('/node/v1/enrol')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ room, existing: true })
      return new Response(JSON.stringify({ enrolled: true }), { headers: { 'content-type': 'application/json' } })
    }
    const event = JSON.parse(String(init?.body)); posted.push(event)
    return new Response(JSON.stringify({ accepted: true }), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { owner, guest, source, store, pair, keys, credentials, posted, options: { fetcher, now: () => now } }
}
it('stages the same room, identities and policy and provisions current devices before announcing its destination', async () => {
  const f = await fixture(), prepared = await prepareExistingBrowserNodeRoom(f.store, f.pair, f.owner, f.source, f.options)
  expect(prepared.state.node.room).toBe(deriveRoom(f.source.secret).roomId)
  expect(prepared.state.deviceSk).toEqual(f.source.deviceSk)
  expect(prepared.state.node.existing).toEqual({ destruct: false, policy: f.source.policy })
  expect(prepared.state.source?.activated).toBe(false)
  expect(prepared.grants).toHaveLength(2)
  expect(f.posted.map(e => e.id)).toEqual(prepared.grants.map(e => e.id))
  const own = acceptExistingBrowserNodeRoom(f.store, prepared.state.node, f.source, prepared.state.grant!, now)
  expect(loadNodeRoom(f.store, f.owner.pubkey, own.node.room, now)?.source).toEqual({ link: f.source.link, activated: true })
  const peerSource = { ...f.source, authoritySk: undefined, participant: f.guest.pubkey, deviceSk: f.keys[1]!, credential: f.credentials[1]! }
  const peerGrant = prepared.grants.find(e => e.tags.some(t => t[0] === 'device' && t[1] === getPublicKey(peerSource.deviceSk)))!
  const peer = acceptExistingBrowserNodeRoom(memoryDeviceStore(), own.node, peerSource, peerGrant, now)
  expect(peer.participant).toBe(f.guest.pubkey); expect(peer.authoritySk).toBeUndefined()
  expect(peer.secret).toEqual(f.source.secret)
})
it('does not route a source room to a different authority, secret, policy or device grant', async () => {
  const f = await fixture(), prepared = await prepareExistingBrowserNodeRoom(f.store, f.pair, f.owner, f.source, f.options)
  for (const patch of [{ authority: getPublicKey(generateSecretKey()) }, { secret: generateSecretKey() }, { policy: undefined }, { destruct: true }, { deviceSk: generateSecretKey() }]) {
    expect(() => acceptExistingBrowserNodeRoom(memoryDeviceStore(), prepared.state.node, { ...f.source, ...patch }, prepared.state.grant!, now)).toThrow('not authorised')
  }
})
it('retains source recovery data when an enrolment acknowledgement is lost', async () => {
  const f = await fixture()
  await expect(prepareExistingBrowserNodeRoom(f.store, f.pair, f.owner, f.source, { now: () => now, fetcher: async () => { throw Error('connection lost') } })).rejects.toThrow()
  const saved = loadNodeRoom(f.store, f.owner.pubkey, deriveRoom(f.source.secret).roomId, now)!
  expect(saved.phase).toBe('creating'); expect(saved.source?.activated).toBe(false)
  expect(saved.secret).toEqual(f.source.secret); expect(saved.deviceSk).toEqual(f.source.deviceSk)
})
