/**
 * The claim this whole stage exists to make, tested rather than asserted.
 *
 * **A forwarder is given the room `id`, never the room `key`.** It routes
 * ciphertext it cannot read and cannot forge attribution for. Jitsi's
 * videobridge sees your media by default; this structurally cannot.
 *
 * A blindness test is worthless if it is vacuous - "the forwarder could not
 * decrypt this" is trivially true of a corrupt frame, an empty buffer, or a
 * scheme that is simply broken for everybody. So every assertion here that
 * something CANNOT be read is paired with the same operation succeeding for
 * somebody who holds the room key. If the negative assertions were passing
 * because the media was broken, the positive ones would fail.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2'
import { hkdf } from '@noble/hashes/hkdf'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { SimRelay, SimTransport } from './sim-relay.js'
import { RoomSession } from '../src/session.js'
import { generateRoomSecret, deriveRoom } from '../src/room.js'
import { encodeRosterEvent, decodeRosterEvent } from '../src/roster.js'
import { encodeDescriptorEvent, decodeDescriptorEvent } from '../src/descriptor.js'
import { createDeviceCredential } from '../src/credential.js'
import { KINDS } from '../src/kinds.js'
import { unwrapSignal, wrapSignal } from '../src/signal.js'
import { localIdentity } from '../src/identity.js'
import {
  MEDIA_KEY_INFO,
  SALT_LENGTH,
  decryptFrame,
  deriveMediaKey,
  encryptFrame,
  frameIv,
  resolveFrameSender,
  unencryptedPrefixLength,
} from '../src/media-crypto.js'
// The forwarder process itself, not a stand-in for it. Its config loader is
// where "never the room key" is actually enforced.
// @ts-expect-error - server/ is plain Node JavaScript with no build step.
import { loadConfigFromEnv, roomConfigs, createForwarder, createWeriftStack } from '../server/forwarder.mjs'

const NOW = 1_800_000_000
const now = () => NOW

const ROOM_SECRET = generateRoomSecret()
const { roomId: ROOM_ID, roomKey: ROOM_KEY } = deriveRoom(ROOM_SECRET)

const FORWARDER_SK = generateSecretKey()
const FORWARDER_PUB = getPublicKey(FORWARDER_SK)

/** Exactly what an operator puts in the forwarder's EnvironmentFile. */
function forwarderEnv() {
  return {
    KITHMOOT_ROOM_ID: ROOM_ID,
    NOSTR_RELAYS: 'wss://relay.example',
    KITHMOOT_FORWARDER_SK: bytesToHex(FORWARDER_SK),
  }
}

const teardowns: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})

/**
 * Every key the forwarder process could possibly assemble.
 *
 * Not a token gesture at "it tried": this is its own Nostr secret key, the
 * room id it was configured with in every shape a mistake might take it, and
 * a NIP-44 conversation key with every device pubkey it has ever seen. If any
 * of these opened anything, the design would be wrong.
 */
function everyKeyTheForwarderHolds(config: { secretKey: Uint8Array; roomId: string; pubkey: string }, seenDevices: string[]): Uint8Array[] {
  const keys: Uint8Array[] = [
    config.secretKey,
    hexToBytes(config.roomId),
    hexToBytes(config.pubkey),
    sha256(hexToBytes(config.roomId)),
    // The room id mistaken for the room key, run through the same derivation
    // a member uses. This is the closest a forwarder can get.
    hkdf(sha256, hexToBytes(config.roomId), undefined, MEDIA_KEY_INFO, 32),
  ]
  for (const device of seenDevices) {
    // A wrap is sealed to its recipient, so the forwarder really can derive
    // this one - and it is the right key for nothing but wraps addressed to
    // it. Neither the roster nor the media is sealed to a pair.
    keys.push(nip44.v2.utils.getConversationKey(config.secretKey, device))
    keys.push(hkdf(sha256, hexToBytes(config.roomId), undefined, `${MEDIA_KEY_INFO}/${device}`, 32))
  }
  return keys
}

// ---------------------------------------------------------------------------

describe('a forwarder is given the room id, never the room key', () => {
  it('refuses to start at all if the room key is within its reach', async () => {
    // Structural, not a promise kept by good behaviour: there is no
    // configuration of this process that carries a room key.
    for (const name of ['KITHMOOT_ROOM_KEY', 'KITHMOOT_ROOM_SECRET', 'KITHMOOT_JOIN_URL']) {
      expect(() => loadConfigFromEnv({ ...forwarderEnv(), [name]: bytesToHex(ROOM_KEY) }), name).toThrow(
        /room id, never the room key/i,
      )
    }
    // And a join URL in the room id slot, which is the mistake an operator
    // would actually make: its fragment carries the room secret.
    expect(() =>
      loadConfigFromEnv({ ...forwarderEnv(), KITHMOOT_ROOM_ID: 'https://kithmoot.example/#c2VjcmV0' }),
    ).toThrow(/never be given the room secret/i)
  })

  it('holds nothing from which the room key can be derived', async () => {
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const alice = getPublicKey(generateSecretKey())
    const candidates = everyKeyTheForwarderHolds(config, [alice])
    for (const key of candidates) {
      expect(bytesToHex(key)).not.toBe(bytesToHex(ROOM_KEY))
      expect(bytesToHex(key)).not.toBe(bytesToHex(ROOM_SECRET))
      expect(bytesToHex(key)).not.toBe(bytesToHex(deriveMediaKey(ROOM_KEY)))
      expect(bytesToHex(key)).not.toBe(bytesToHex(deriveMediaKey(ROOM_KEY, alice)))
    }
  })
})

describe("a forwarder's view of the roster is opaque", () => {
  it('cannot read a roster entry, while a member can read the same one', async () => {
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const participantSk = generateSecretKey()
    const deviceSk = generateSecretKey()
    const device = getPublicKey(deviceSk)
    const event = encodeRosterEvent(
      {
        participant: getPublicKey(participantSk),
        device,
        credential: await createDeviceCredential({
          identity: localIdentity(participantSk),
          devicePubkey: device,
          roomId: ROOM_ID,
          expiresAt: NOW + 3600,
        }),
        tracks: [{ trackId: 'alice-cam', role: 'camera' }],
        claims: { mic: NOW },
        updatedAt: NOW,
      },
      { roomId: ROOM_ID, roomKey: ROOM_KEY, deviceSk },
    )

    for (const key of everyKeyTheForwarderHolds(config, [device, FORWARDER_PUB])) {
      expect(decodeRosterEvent(event, { roomId: ROOM_ID, roomKey: key, now: NOW })).toBeNull()
    }

    // Not vacuous: the same event, the same decoder, the room key.
    const read = decodeRosterEvent(event, { roomId: ROOM_ID, roomKey: ROOM_KEY, now: NOW })
    expect(read?.participant).toBe(getPublicKey(participantSk))
    expect(read?.tracks).toEqual([{ trackId: 'alice-cam', role: 'camera' }])
  })

  it('learns nothing about the room from the descriptor that names it', async () => {
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const participantSk = generateSecretKey()
    const deviceSk = generateSecretKey()
    const device = getPublicKey(deviceSk)
    const event = encodeDescriptorEvent(
      {
        device,
        participant: getPublicKey(participantSk),
        credential: await createDeviceCredential({
          identity: localIdentity(participantSk),
          devicePubkey: device,
          roomId: ROOM_ID,
          expiresAt: NOW + 3600,
        }),
        forwarders: [{ url: 'wss://relay.example', pubkey: FORWARDER_PUB }],
        iceServers: [],
        updatedAt: NOW,
      },
      { roomId: ROOM_ID, roomKey: ROOM_KEY, deviceSk },
    )

    for (const key of everyKeyTheForwarderHolds(config, [device])) {
      expect(decodeDescriptorEvent(event, { roomId: ROOM_ID, roomKey: key, now: NOW })).toBeNull()
    }
    expect(decodeDescriptorEvent(event, { roomId: ROOM_ID, roomKey: ROOM_KEY, now: NOW })).not.toBeNull()
  })

  it('never asks a relay for the roster in the first place', async () => {
    const relay = new SimRelay()
    const transport = new SimTransport(relay)
    const stack = await createWeriftStack()
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const forwarder = createForwarder({ config, transport, stack, log: () => {}, now })
    forwarder.start()
    teardowns.push(() => {
      forwarder.close()
      transport.close()
      relay.close()
    })

    // Being unable to decrypt the roster is one thing; asking for it anyway
    // would still tell a relay that this machine is watching the room's
    // membership, and would still let it count devices by their signatures.
    const filters = forwarder.stats().filters
    expect(filters).toEqual([{ kinds: [KINDS.SIGNAL_WRAP], '#p': [FORWARDER_PUB] }])
    expect(JSON.stringify(filters)).not.toContain(String(KINDS.ROSTER))
    expect(JSON.stringify(filters)).not.toContain(String(KINDS.DESCRIPTOR))
    expect(JSON.stringify(filters)).not.toContain(String(KINDS.CHAT))
    expect(JSON.stringify(filters)).not.toContain(ROOM_ID)
  })

  it('sees real members join and still cannot say who they are', async () => {
    const relay = new SimRelay()
    const stack = await createWeriftStack()
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const forwarder = createForwarder({ config, transport: new SimTransport(relay), stack, log: () => {}, now })
    forwarder.start()

    const alice = new RoomSession({
      transport: new SimTransport(relay),
      secret: ROOM_SECRET,
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    const bob = new RoomSession({
      transport: new SimTransport(relay),
      secret: ROOM_SECRET,
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      announceJitterMs: 0,
    })
    await alice.join([{ trackId: 'alice-cam', role: 'camera' }], { mic: NOW })
    await bob.join([{ trackId: 'bob-cam', role: 'camera' }], {})
    teardowns.push(() => {
      alice.leave()
      bob.leave()
      forwarder.close()
      relay.close()
    })

    const roster = relay.published.filter((e) => e.kind === KINDS.ROSTER)
    expect(roster.length).toBeGreaterThanOrEqual(2)

    // Everything a relay - or anything watching one - can see about these
    // events. The participant pubkeys, the credentials and the track names
    // are all inside the ciphertext.
    const onTheWire = JSON.stringify(roster)
    expect(onTheWire).toContain(ROOM_ID)
    expect(onTheWire).not.toContain(alice.participant)
    expect(onTheWire).not.toContain(bob.participant)
    expect(onTheWire).not.toContain('alice-cam')
    expect(onTheWire).not.toContain('bob-cam')

    for (const event of roster) {
      for (const key of everyKeyTheForwarderHolds(config, [alice.device, bob.device, FORWARDER_PUB])) {
        expect(decodeRosterEvent(event, { roomId: ROOM_ID, roomKey: key, now: NOW })).toBeNull()
      }
    }
    // Alice, who holds the room key, reads exactly what the forwarder cannot.
    expect(alice.participants().map((v) => v.participant).sort()).toEqual(
      [alice.participant, bob.participant].sort(),
    )
  })
})

describe('a forwarder cannot read the media it relays', () => {
  /** A VP8-shaped frame: a 3-byte codec header the forwarder is *meant* to
   *  see, and a payload it is not. */
  function vp8Frame(marker: number): Uint8Array {
    const frame = new Uint8Array(64)
    frame.set([0x10, 0x02, 0x00], 0)
    for (let i = 3; i < frame.length; i++) frame[i] = (i * 7 + marker) & 0xff
    return frame
  }

  it('relays a frame end to end: the far end reads it, the forwarder cannot', async () => {
    const werift = await import('werift')
    const { RTCPeerConnection, MediaStreamTrack, MediaStream, RtpPacket, RtpHeader } = werift
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const stack = await createWeriftStack()

    const aliceDevice = getPublicKey(generateSecretKey())
    const aliceKey = deriveMediaKey(ROOM_KEY, aliceDevice)
    const salt = new Uint8Array(SALT_LENGTH).fill(3)
    const prefix = unencryptedPrefixLength('video/VP8', 'delta')!

    const plaintext = vp8Frame(1)
    const sealed = encryptFrame(plaintext, aliceKey, frameIv(salt, 0), prefix)

    // Alice's browser, the forwarder's two connections, Bob's browser.
    const alicePc = new RTCPeerConnection({ iceServers: [] })
    const bobPc = new RTCPeerConnection({ iceServers: [] })
    const toAlice = stack.createConnection()
    const toBob = stack.createConnection()
    teardowns.push(async () => {
      await alicePc.close()
      await bobPc.close()
      toAlice.close()
      toBob.close()
    })

    const aliceTrack = new MediaStreamTrack({ kind: 'video', id: 'alice-cam' })
    alicePc.addTrack(aliceTrack, new MediaStream({ id: 'alice-cam', tracks: [aliceTrack] }))

    let inbound: InstanceType<typeof MediaStreamTrack> | null = null
    toAlice.connection.ontrack = (event: { track: InstanceType<typeof MediaStreamTrack> }) => {
      inbound = event.track
    }
    await negotiate(alicePc, toAlice.connection)
    expect(inbound).not.toBeNull()

    // Exactly the bytes the forwarder process has in its hands.
    const seenByForwarder: Uint8Array[] = []
    inbound!.onReceiveRtp.subscribe((rtp: { payload: Uint8Array }) => seenByForwarder.push(new Uint8Array(rtp.payload)))

    teardowns.push(toBob.relay(inbound))

    const seenByBob: Uint8Array[] = []
    bobPc.ontrack = (event: { track: { onReceiveRtp: { subscribe: (cb: (rtp: { payload: Uint8Array }) => void) => unknown } } }) => {
      event.track.onReceiveRtp.subscribe((rtp) => seenByBob.push(new Uint8Array(rtp.payload)))
    }
    await negotiate(toBob.connection, bobPc)

    const pump = setInterval(() => {
      aliceTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ payloadType: 96, sequenceNumber: seenByBob.length + 1, timestamp: 3000, ssrc: 4242 }),
          Buffer.from(sealed),
        ),
      )
    }, 40)
    teardowns.push(() => clearInterval(pump))
    await waitFor(() => seenByBob.length > 0 && seenByForwarder.length > 0, 10_000)
    clearInterval(pump)

    expect(seenByForwarder.length).toBeGreaterThan(0)
    expect(seenByBob.length).toBeGreaterThan(0)

    // THE POSITIVE HALF. Bob holds the room key and Alice's device pubkey -
    // both from the roster - so he opens it, byte for byte.
    const opened = decryptFrame(seenByBob[0]!, deriveMediaKey(ROOM_KEY, aliceDevice))
    expect(opened).toEqual(plaintext)

    // THE NEGATIVE HALF, on the very same bytes. Nothing the forwarder holds
    // opens them.
    for (const frame of seenByForwarder) {
      for (const key of everyKeyTheForwarderHolds(config, [aliceDevice, FORWARDER_PUB])) {
        expect(decryptFrame(frame, key)).toBeNull()
      }
      // And the room-wide media key does not work either, because the frame
      // is bound to the device that sent it.
      expect(decryptFrame(frame, deriveMediaKey(ROOM_KEY))).toBeNull()
    }

    // The codec header IS in the clear, deliberately - a forwarder that could
    // not read a frame type could not route. That is the whole of what it
    // sees, and it is authenticated, so it cannot be changed.
    expect(Array.from(seenByForwarder[0]!.slice(0, prefix))).toEqual([0x10, 0x02, 0x00])
    // Everything past the header is unrecognisable.
    expect(Array.from(seenByForwarder[0]!.slice(prefix, prefix + 16))).not.toEqual(
      Array.from(plaintext.slice(prefix, prefix + 16)),
    )
  }, 30_000)
})

describe('a forwarder cannot forge attribution for a track it relays', () => {
  const aliceDevice = getPublicKey(generateSecretKey())
  const carolDevice = getPublicKey(generateSecretKey())
  const salt = new Uint8Array(SALT_LENGTH).fill(4)
  const prefix = unencryptedPrefixLength('video/VP8', 'delta')!

  function aliceFrame(counter = 0): Uint8Array {
    const frame = new Uint8Array([0x10, 0x02, 0x00, ...Array.from({ length: 32 }, (_, i) => i)])
    return encryptFrame(frame, deriveMediaKey(ROOM_KEY, aliceDevice), frameIv(salt, counter), prefix)
  }

  it("cannot relabel one member's stream as another member's", async () => {
    const sealed = aliceFrame()
    // The forwarder relays Alice's real ciphertext, untouched, but presents
    // it on the track the roster says is Carol's. This is the only
    // attribution attack a blind forwarder actually has, because it controls
    // which stream carries which track id.
    expect(decryptFrame(sealed, deriveMediaKey(ROOM_KEY, carolDevice))).toBeNull()
    // ...and it fails. Attribution is settled by the ciphertext, not by the
    // label the forwarder put on it.
    expect(resolveFrameSender(sealed, ROOM_KEY, [carolDevice, aliceDevice])).toBe(aliceDevice)
    // Not vacuous: relayed honestly, the same bytes open under Alice's key.
    expect(decryptFrame(sealed, deriveMediaKey(ROOM_KEY, aliceDevice))).not.toBeNull()
  })

  it('cannot invent media for a member', async () => {
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const invented = new Uint8Array([0x10, 0x02, 0x00, ...Array.from({ length: 32 }, () => 0x41)])
    for (const key of everyKeyTheForwarderHolds(config, [aliceDevice, carolDevice, FORWARDER_PUB])) {
      // Whatever it seals with, no member's key opens it - so nothing it
      // makes up is ever rendered as anybody.
      const forged = encryptFrame(invented, key.slice(0, 32), frameIv(salt, 0), prefix)
      expect(decryptFrame(forged, deriveMediaKey(ROOM_KEY, aliceDevice))).toBeNull()
      expect(resolveFrameSender(forged, ROOM_KEY, [aliceDevice, carolDevice])).toBeNull()
    }
  })

  it('cannot alter the one part of a frame it can read', async () => {
    const sealed = aliceFrame()
    // The codec header is in the clear so the forwarder can route on frame
    // type - and it is passed as associated data, so changing it breaks the
    // tag. A forwarder cannot promote a delta frame to a key frame to make a
    // member's video appear to restart, or corrupt a stream unnoticed.
    for (let i = 0; i < prefix; i++) {
      const tampered = new Uint8Array(sealed)
      tampered[i] ^= 0xff
      expect(decryptFrame(tampered, deriveMediaKey(ROOM_KEY, aliceDevice))).toBeNull()
    }
    // Nor the ciphertext, nor the IV in the trailer.
    for (const index of [prefix + 1, sealed.length - 2, sealed.length - 6]) {
      const tampered = new Uint8Array(sealed)
      tampered[index] ^= 0xff
      expect(decryptFrame(tampered, deriveMediaKey(ROOM_KEY, aliceDevice))).toBeNull()
    }
  })

  it('cannot put words in a member\'s mouth on the room channel either', async () => {
    // Media is not the only attribution surface. A forwarder that could mint
    // a roster entry or a signal for a member could rearrange the room
    // without touching a frame.
    const config = roomConfigs(loadConfigFromEnv(forwarderEnv()))[0]
    const alicePartSk = generateSecretKey()
    const aliceDevSk = generateSecretKey()

    // It cannot write a roster entry: it has no room key to encrypt to, and
    // no participant key to mint a credential with.
    const forged = encodeRosterEvent(
      {
        participant: getPublicKey(alicePartSk),
        device: getPublicKey(aliceDevSk),
        credential: await createDeviceCredential({
          identity: localIdentity(config.secretKey),
          devicePubkey: FORWARDER_PUB,
          roomId: ROOM_ID,
          expiresAt: NOW + 3600,
        }),
        tracks: [{ trackId: 'not-alices', role: 'camera' }],
        claims: {},
        updatedAt: NOW,
      },
      { roomId: ROOM_ID, roomKey: hkdf(sha256, hexToBytes(ROOM_ID), undefined, MEDIA_KEY_INFO, 32), deviceSk: config.secretKey },
    )
    expect(decodeRosterEvent(forged, { roomId: ROOM_ID, roomKey: ROOM_KEY, now: NOW })).toBeNull()

    // And a signal it wraps is signed by its own device key, so it arrives
    // attributed to the forwarder and to nobody else.
    const bobSk = generateSecretKey()
    const wrap = wrapSignal(
      { type: 'offer', roomId: ROOM_ID, sdp: 'not-alices-offer' },
      { senderSk: config.secretKey, recipientPubkey: getPublicKey(bobSk) },
    )
    // The real clock, because `wrapSignal` stamps the inner event with it and
    // staleness is checked against that - the fixed `NOW` these tests use for
    // the roster would make this look twenty years old.
    const unwrapped = unwrapSignal(wrap, { recipientSk: bobSk, roomId: ROOM_ID })
    expect(unwrapped?.from).toBe(FORWARDER_PUB)
    expect(unwrapped?.from).not.toBe(getPublicKey(aliceDevSk))
  })
})

async function negotiate(from: any, to: any): Promise<void> {
  const offer = await from.createOffer()
  await from.setLocalDescription(offer)
  await to.setRemoteDescription(from.localDescription)
  const answer = await to.createAnswer()
  await to.setLocalDescription(answer)
  await from.setRemoteDescription(to.localDescription)
  await Promise.all(
    [from, to].map(
      (pc) =>
        new Promise<void>((resolve) => {
          if (pc.connectionState === 'connected') return resolve()
          pc.connectionStateChange.subscribe(() => {
            if (pc.connectionState === 'connected') resolve()
          })
        }),
    ),
  )
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
