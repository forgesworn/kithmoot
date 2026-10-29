import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { createFakeFactory } from '../../test/fake-rtc.js'
import { createDeviceCredential } from '../../src/credential.js'
import { localIdentity } from '../../src/identity.js'
import { encodeRosterEvent } from '../../src/roster.js'
import { deriveRoom } from '../../src/room.js'
import { RoomSession } from '../../src/session.js'
import { spryDevicePublicKey } from '../../src/spry-key.js'
import { SpryRoom } from './spry-room.js'

/** A block stays on this device and is never revealed: the owner's app
 *  registers a blocked guest's key with its Spry node like anybody's, so the
 *  guest keeps the room's relay after the grant is sealed and cannot tell. */
const SECRET = new Uint8Array(32).fill(96)
const ROOT = deriveRoom(SECRET)
const ENDPOINT = 'https://relay.example'
const opened: Array<{ close(): void } | RoomSession> = []
afterEach(async () => {
  for (const item of opened.splice(0)) { if (item instanceof RoomSession) await item.leave(); else item.close() }
  vi.useRealTimers()
})

it('registers a blocked guest\'s key like anybody\'s, and seals with it present', async () => {
  const relay = new SimRelay()
  const guestIdentity = localIdentity(generateSecretKey()), guestSk = generateSecretKey()
  const ownerSk = generateSecretKey()
  const owner = new RoomSession({ transport: new SimTransport(relay), secret: SECRET, identity: localIdentity(generateSecretKey()), deviceSk: ownerSk,
    factory: createFakeFactory(), announceJitterMs: 0, isBlocked: participant => participant === guestIdentity.pubkey })
  opened.push(owner)
  await owner.join([], {})
  const posts: { path: string; body: { add?: string[]; seal?: boolean } }[] = []
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(String(options!.body))
    posts.push({ path, body })
    const expiresAt = Math.floor(Date.now() / 1000) + 300
    if (path === '/v1/grants') return Response.json({ v: 1, endpoint: ENDPOINT, token: 't'.repeat(43), expiresAt: expiresAt + 86400 })
    if (path === '/v1/grants/devices') return Response.json({ v: 1, sealed: !!body.seal, enforced: !!body.seal, devices: 2 })
    return Response.json({ urls: ['turn:relay.example:3478?transport=udp'], username: `${expiresAt}:${'b'.repeat(24)}`, credential: 'a'.repeat(27) + '=', expiresAt, accessExpiresAt: expiresAt + 86400 })
  }
  const broker = new SpryRoom(owner, { v: 1, endpoint: ENDPOINT, id: 'c'.repeat(43), secretKey: '04'.repeat(32) }, vi.fn(), fetcher, ownerSk)
  opened.push(broker)
  const credential = await createDeviceCredential({ identity: guestIdentity, devicePubkey: getPublicKey(guestSk), roomId: ROOT.roomId, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
  // Let the first registration (its own key) finish before the guest arrives,
  // so this proves the roster change path, not a lucky first pass.
  await vi.waitFor(() => expect(posts.some(post => post.path === '/v1/credentials')).toBe(true), { timeout: 5000 })
  await new SimTransport(relay).publish(encodeRosterEvent({ participant: guestIdentity.pubkey, device: getPublicKey(guestSk), credential, tracks: [], claims: {},
    updatedAt: Math.floor(Date.now() / 1000), spryKey: spryDevicePublicKey(guestSk) }, { roomId: ROOT.roomId, roomKey: ROOT.roomKey, deviceSk: guestSk }))
  await vi.waitFor(() => expect(posts.filter(post => post.path === '/v1/grants/devices').flatMap(post => post.body.add ?? [])).toContain(spryDevicePublicKey(guestSk)), { timeout: 5000 })
  // The block is still in force on screen.
  expect(owner.participants().some(view => view.participant === guestIdentity.pubkey)).toBe(false)
})
