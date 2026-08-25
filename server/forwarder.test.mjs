import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import {
  loadConfigFromEnv,
  createForwarder,
  forwarderRef,
  DEFAULT_MAX_PEERS,
  DEFAULT_MAX_TRACKS_PER_PEER,
} from './forwarder.mjs'
import { generateRoomSecret, deriveRoom } from '../dist/src/room.js'
import { wrapSignal, unwrapSignal } from '../dist/src/signal.js'
import { encodeRosterEvent, decodeRosterEvent } from '../dist/src/roster.js'
import { createDeviceCredential } from '../dist/src/credential.js'
import { KINDS } from '../dist/src/kinds.js'
import { SimRelay, SimTransport } from '../dist/test/sim-relay.js'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'forwarder.mjs')

const ROOM_SECRET = generateRoomSecret()
const { roomId: ROOM_ID, roomKey: ROOM_KEY } = deriveRoom(ROOM_SECRET)
const FORWARDER_SK = generateSecretKey()
const FORWARDER_PUB = getPublicKey(FORWARDER_SK)

function baseEnv(overrides = {}) {
  return {
    KITHMOOT_ROOM_ID: ROOM_ID,
    NOSTR_RELAYS: 'wss://relay.example',
    KITHMOOT_FORWARDER_SK: bytesToHex(FORWARDER_SK),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// A fake WebRTC stack. Records everything, decodes nothing - which is the
// point: if the forwarder ever needed to look inside a payload, this double
// could not satisfy it.
// ---------------------------------------------------------------------------

class FakeTrack {
  constructor(kind, id) {
    this.kind = kind
    this.id = id
    this.written = []
    this.subscribers = new Set()
  }
  writeRtp(packet) {
    this.written.push(packet)
  }
  emit(packet) {
    for (const cb of this.subscribers) cb(packet)
  }
  onRtp(cb) {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }
}

class FakeConnection {
  constructor() {
    this.signalingState = 'stable'
    this.localDescription = null
    this.connectionState = 'new'
    this.closed = false
    this.ontrack = null
    this.onicecandidate = null
    this.onconnectionstatechange = null
    this.added = []
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' }
  }
  async setLocalDescription(description) {
    if (description?.type === 'rollback') {
      this.localDescription = null
      this.signalingState = 'stable'
      return
    }
    this.localDescription = description ?? null
    this.signalingState = description?.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(description) {
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
  }
  async addIceCandidate() {}
  addTrack(track) {
    this.added.push(track)
  }
  close() {
    this.closed = true
  }
}

function createFakeStack() {
  const hosts = []
  const stack = {
    hosts,
    createConnection() {
      const connection = new FakeConnection()
      const relayed = []
      const host = {
        connection,
        relayed,
        relay(source) {
          const mirror = new FakeTrack(source.kind, source.id)
          relayed.push({ source, mirror })
          connection.addTrack(mirror)
          return source.onRtp((packet) => mirror.writeRtp(packet))
        },
        close() {
          connection.close()
        },
      }
      hosts.push(host)
      return host
    },
  }
  return stack
}

const teardowns = []
afterEach(() => {
  while (teardowns.length) teardowns.pop()()
})

/** Stand a forwarder up on an in-process relay, with a fake media stack. */
function standUpForwarder(overrides = {}) {
  const relay = new SimRelay()
  const transport = new SimTransport(relay)
  const stack = createFakeStack()
  const logs = []
  const config = loadConfigFromEnv(baseEnv(overrides.env))
  const forwarder = createForwarder({
    config: { ...config, ...overrides.config },
    transport,
    stack,
    log: (line) => logs.push(line),
    now: overrides.now,
  })
  forwarder.start()
  teardowns.push(() => {
    forwarder.close()
    transport.close()
    relay.close()
  })
  return { forwarder, relay, transport, stack, logs, config }
}

/** A device in the room: its own key, and a way to reach the forwarder. */
function makeDevice(transport) {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const received = []
  const unsub = transport.subscribe([{ kinds: [KINDS.SIGNAL_WRAP], '#p': [pubkey] }], (event) => {
    const unwrapped = unwrapSignal(event, { recipientSk: sk, roomId: ROOM_ID })
    if (unwrapped) received.push(unwrapped)
  })
  teardowns.push(unsub)
  return {
    sk,
    pubkey,
    received,
    async offer(body = {}) {
      await transport.publish(
        wrapSignal(
          { type: 'offer', roomId: ROOM_ID, sdp: 'browser-offer', ...body },
          { senderSk: sk, recipientPubkey: FORWARDER_PUB },
        ),
      )
    },
  }
}

describe('loadConfigFromEnv', () => {
  it('refuses to start without a room id', () => {
    const env = baseEnv()
    delete env.KITHMOOT_ROOM_ID
    expect(() => loadConfigFromEnv(env)).toThrow(/KITHMOOT_ROOM_ID/)
  })

  it('refuses a join URL where a room id belongs, and says why', () => {
    expect(() => loadConfigFromEnv(baseEnv({ KITHMOOT_ROOM_ID: 'https://kithmoot.example/#abc' }))).toThrow(
      /never be given the room secret/i,
    )
  })

  it('refuses a room id that is not 32 bytes of hex', () => {
    expect(() => loadConfigFromEnv(baseEnv({ KITHMOOT_ROOM_ID: 'deadbeef' }))).toThrow(/64 hex/)
  })

  it('accepts a room id in upper case and normalises it', () => {
    const config = loadConfigFromEnv(baseEnv({ KITHMOOT_ROOM_ID: ROOM_ID.toUpperCase() }))
    expect(config.roomId).toBe(ROOM_ID)
  })

  // The claim this whole process exists to make, enforced at the only point
  // it can be enforced structurally: refusing to run at all if the room key
  // is anywhere in reach.
  it('refuses to start if the environment offers it a room key or secret at all', () => {
    for (const name of ['KITHMOOT_ROOM_KEY', 'KITHMOOT_ROOM_SECRET', 'KITHMOOT_JOIN_URL']) {
      expect(() => loadConfigFromEnv(baseEnv({ [name]: 'anything' })), name).toThrow(/room id, never the room key/i)
    }
  })

  it('refuses to start without relays', () => {
    const env = baseEnv()
    delete env.NOSTR_RELAYS
    expect(() => loadConfigFromEnv(env)).toThrow(/NOSTR_RELAYS/)
  })

  it('refuses a relay that is not a WebSocket address', () => {
    expect(() => loadConfigFromEnv(baseEnv({ NOSTR_RELAYS: 'https://relay.example' }))).toThrow(/ws:|wss:/)
  })

  it('refuses to start without a forwarder key, and says how to make one', () => {
    const env = baseEnv()
    delete env.KITHMOOT_FORWARDER_SK
    expect(() => loadConfigFromEnv(env)).toThrow(/openssl rand -hex 32/)
  })

  it('refuses a forwarder key that is not 32 bytes of hex', () => {
    expect(() => loadConfigFromEnv(baseEnv({ KITHMOOT_FORWARDER_SK: 'nope' }))).toThrow(/KITHMOOT_FORWARDER_SK/)
  })

  it('derives the forwarder pubkey from the key rather than taking it on trust', () => {
    const config = loadConfigFromEnv(baseEnv())
    expect(config.pubkey).toBe(FORWARDER_PUB)
  })

  it('defaults the advertised url to the first relay and the caps to their constants', () => {
    const config = loadConfigFromEnv(baseEnv({ NOSTR_RELAYS: 'wss://a.example, wss://b.example' }))
    expect(config.url).toBe('wss://a.example')
    expect(config.maxPeers).toBe(DEFAULT_MAX_PEERS)
    expect(config.maxTracksPerPeer).toBe(DEFAULT_MAX_TRACKS_PER_PEER)
  })

  it('refuses an advertised url that a client could not signal over', () => {
    expect(() => loadConfigFromEnv(baseEnv({ KITHMOOT_FORWARDER_URL: 'http://forward.example' }))).toThrow(
      /KITHMOOT_FORWARDER_URL/,
    )
  })

  it('refuses a fan-out cap that is not a positive whole number', () => {
    for (const bad of ['0', '-3', '2.5', 'lots']) {
      expect(() => loadConfigFromEnv(baseEnv({ KITHMOOT_MAX_PEERS: bad })), bad).toThrow(/KITHMOOT_MAX_PEERS/)
    }
  })
})

describe('forwarderRef', () => {
  it('is exactly the three fields a room descriptor may carry', () => {
    const config = loadConfigFromEnv(baseEnv({ KITHMOOT_LABEL: 'trotters box' }))
    expect(forwarderRef(config)).toEqual({
      url: 'wss://relay.example',
      pubkey: FORWARDER_PUB,
      label: 'trotters box',
    })
  })

  it('carries neither the room key nor the forwarder secret key', () => {
    const config = loadConfigFromEnv(baseEnv())
    const serialised = JSON.stringify(forwarderRef(config))
    expect(serialised).not.toContain(bytesToHex(FORWARDER_SK))
    expect(serialised).not.toContain(bytesToHex(ROOM_KEY))
  })
})

describe('the process, run directly', () => {
  it('refuses to start with a clear message when the room id is unset', () => {
    const env = { ...process.env, NOSTR_RELAYS: 'wss://relay.example' }
    delete env.KITHMOOT_ROOM_ID
    const result = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/KITHMOOT_ROOM_ID/)
  })

  it('refuses to start when handed a room secret', () => {
    const env = { ...process.env, ...baseEnv({ KITHMOOT_ROOM_SECRET: 'shh' }) }
    const result = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/room id, never the room key/i)
  })
})

describe('joining a room as a forwarder', () => {
  it('says plainly at startup that it relays ciphertext it cannot read', () => {
    const { logs } = standUpForwarder()
    expect(logs.join('\n')).toMatch(/ciphertext it cannot read/i)
  })

  it('announces the room id it serves, and never a key', () => {
    const { logs, config } = standUpForwarder()
    const joined = logs.join('\n')
    expect(joined).toContain(ROOM_ID)
    expect(joined).not.toContain(bytesToHex(config.secretKey))
  })

  it('subscribes only for signals addressed to itself - never the roster', async () => {
    const { relay, transport, forwarder } = standUpForwarder()
    // A member publishes an ordinary roster entry. The forwarder must not be
    // subscribed to it: it could not read it, and asking for it would leak
    // that it is watching the room's membership.
    const participantSk = generateSecretKey()
    const deviceSk = generateSecretKey()
    const credential = createDeviceCredential({
      participantSk,
      devicePubkey: getPublicKey(deviceSk),
      roomId: ROOM_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    await transport.publish(
      encodeRosterEvent(
        {
          participant: getPublicKey(participantSk),
          device: getPublicKey(deviceSk),
          credential,
          tracks: [],
          claims: {},
          updatedAt: Math.floor(Date.now() / 1000),
        },
        { roomId: ROOM_ID, roomKey: ROOM_KEY, deviceSk },
      ),
    )
    expect(relay.published.some((e) => e.kind === KINDS.ROSTER)).toBe(true)
    await tick()
    // The forwarder asked for one filter and one only, and it names the
    // signalling kind and its own pubkey - nothing about the room's roster.
    expect(forwarder.stats().filters).toEqual([{ kinds: [KINDS.SIGNAL_WRAP], '#p': [FORWARDER_PUB] }])
    // A roster event is not a way in either: nobody joined by publishing one.
    expect(forwarder.stats().peers).toBe(0)
  })

  it('answers an offer addressed to it, over the room signalling it already speaks', async () => {
    const { transport, forwarder } = standUpForwarder()
    const alice = makeDevice(transport)
    await alice.offer()
    await tick()
    expect(alice.received.map((r) => r.body.type)).toContain('answer')
    expect(forwarder.stats().peers).toBe(1)
  })

  it('ignores an offer for a different room', async () => {
    const { transport, forwarder } = standUpForwarder()
    const sk = generateSecretKey()
    await transport.publish(
      wrapSignal(
        { type: 'offer', roomId: 'f'.repeat(64), sdp: 'x' },
        { senderSk: sk, recipientPubkey: FORWARDER_PUB },
      ),
    )
    await tick()
    expect(forwarder.stats().peers).toBe(0)
  })

  it('hears each wrap exactly once, however many times a relay delivers it', async () => {
    const { transport, forwarder, relay } = standUpForwarder()
    const alice = makeDevice(transport)
    await alice.offer()
    await tick()
    const wrap = relay.published.find((e) => e.kind === KINDS.SIGNAL_WRAP && e.tags.some((t) => t[1] === FORWARDER_PUB))
    relay.publish(wrap)
    relay.publish(wrap)
    await tick()
    expect(forwarder.stats().peers).toBe(1)
    expect(forwarder.stats().duplicatesDropped).toBeGreaterThanOrEqual(2)
  })
})

describe('the fan-out cap', () => {
  it('refuses a peer past the cap rather than degrading everybody already connected', async () => {
    const { transport, forwarder, logs } = standUpForwarder({ config: { maxPeers: 2 } })
    const devices = [makeDevice(transport), makeDevice(transport), makeDevice(transport)]
    for (const device of devices) await device.offer()
    await tick()
    expect(forwarder.stats().peers).toBe(2)
    expect(forwarder.stats().refused).toBe(1)
    expect(logs.join('\n')).toMatch(/fan-out cap/i)
    // The refused device gets no answer, so it falls back to direct mesh.
    const answered = devices.filter((d) => d.received.some((r) => r.body.type === 'answer'))
    expect(answered).toHaveLength(2)
  })

  it('caps the tracks one peer may fan out', async () => {
    const { transport, forwarder, stack } = standUpForwarder({ config: { maxTracksPerPeer: 2 } })
    const alice = makeDevice(transport)
    const bob = makeDevice(transport)
    await alice.offer()
    await bob.offer()
    await tick()
    const aliceHost = stack.hosts[0]
    for (let i = 0; i < 4; i++) {
      aliceHost.connection.ontrack({ track: new FakeTrack('video', `t${i}`) })
    }
    await tick()
    expect(forwarder.stats().tracksRefused).toBe(2)
    expect(stack.hosts[1].relayed).toHaveLength(2)
  })
})

describe('forwarding frames without decoding them', () => {
  it("relays one peer's packets to every other peer, byte for byte", async () => {
    const { transport, stack } = standUpForwarder()
    const alice = makeDevice(transport)
    const bob = makeDevice(transport)
    const carol = makeDevice(transport)
    await alice.offer()
    await bob.offer()
    await carol.offer()
    await tick()

    const [aliceHost, bobHost, carolHost] = stack.hosts
    const source = new FakeTrack('video', 'alice-cam')
    aliceHost.connection.ontrack({ track: source })
    await tick()

    const packet = { header: { sequenceNumber: 1 }, payload: new Uint8Array([1, 2, 3, 4]) }
    source.emit(packet)

    expect(bobHost.relayed).toHaveLength(1)
    expect(carolHost.relayed).toHaveLength(1)
    expect(bobHost.relayed[0].mirror.written).toEqual([packet])
    expect(carolHost.relayed[0].mirror.written[0].payload).toBe(packet.payload)
    // Never back to where it came from.
    expect(aliceHost.relayed).toHaveLength(0)
  })

  it('gives a late arrival every track already flowing', async () => {
    const { transport, stack } = standUpForwarder()
    const alice = makeDevice(transport)
    await alice.offer()
    await tick()
    stack.hosts[0].connection.ontrack({ track: new FakeTrack('video', 'alice-cam') })
    await tick()

    const bob = makeDevice(transport)
    await bob.offer()
    await tick()
    expect(stack.hosts[1].relayed).toHaveLength(1)
  })

  it('stops relaying a departed peer to everybody else', async () => {
    const { transport, stack, forwarder } = standUpForwarder()
    const alice = makeDevice(transport)
    const bob = makeDevice(transport)
    await alice.offer()
    await bob.offer()
    await tick()
    const source = new FakeTrack('video', 'alice-cam')
    stack.hosts[0].connection.ontrack({ track: source })
    await tick()

    stack.hosts[0].connection.connectionState = 'failed'
    stack.hosts[0].connection.onconnectionstatechange()
    await tick()

    expect(forwarder.stats().peers).toBe(1)
    const before = stack.hosts[1].relayed[0].mirror.written.length
    source.emit({ payload: new Uint8Array([9]) })
    expect(stack.hosts[1].relayed[0].mirror.written).toHaveLength(before)
  })
})

/** The claim, at the process boundary. */
describe('what a forwarder can and cannot see', () => {
  it('cannot read a roster event for the room it is serving', () => {
    const { config } = standUpForwarder()
    const participantSk = generateSecretKey()
    const deviceSk = generateSecretKey()
    const now = Math.floor(Date.now() / 1000)
    const event = encodeRosterEvent(
      {
        participant: getPublicKey(participantSk),
        device: getPublicKey(deviceSk),
        credential: createDeviceCredential({
          participantSk,
          devicePubkey: getPublicKey(deviceSk),
          roomId: ROOM_ID,
          expiresAt: now + 3600,
        }),
        tracks: [{ trackId: 'alice-cam', role: 'camera' }],
        claims: {},
        updatedAt: now,
      },
      { roomId: ROOM_ID, roomKey: ROOM_KEY, deviceSk },
    )

    // Everything the forwarder holds, offered as a room key in turn.
    for (const candidate of [config.secretKey, hexToBytes32(config.roomId), hexToBytes32(config.pubkey)]) {
      expect(decodeRosterEvent(event, { roomId: config.roomId, roomKey: candidate, now })).toBeNull()
    }
    // And the real key does work, so the assertion above is about the key and
    // not about the event being broken.
    expect(decodeRosterEvent(event, { roomId: ROOM_ID, roomKey: ROOM_KEY, now })).not.toBeNull()
  })
})

function hexToBytes32(hex) {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Let the forwarder's own promise chains settle. */
async function tick() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// The real thing. Everything above drives the forwarder with a media stack
// that cannot decode a payload, which proves the forwarder never asks it to.
// This proves the werift stack the process actually ships with does the same
// job for real: two live peer connections, real DTLS-SRTP, real RTP, and a
// payload that comes out the far side byte for byte having passed through a
// process that never looked at it.
// ---------------------------------------------------------------------------
describe('the werift media stack', () => {
  it('carries a payload from one live connection to another without decoding it', async () => {
    const { RTCPeerConnection, MediaStreamTrack, MediaStream, RtpPacket, RtpHeader } = await import('werift')
    const { createWeriftStack } = await import('./forwarder.mjs')
    const stack = await createWeriftStack()

    const alice = new RTCPeerConnection({ iceServers: [] })
    const bob = new RTCPeerConnection({ iceServers: [] })
    const toAlice = stack.createConnection()
    const toBob = stack.createConnection()
    teardowns.push(() => {
      void alice.close()
      void bob.close()
      toAlice.close()
      toBob.close()
    })

    const aliceTrack = new MediaStreamTrack({ kind: 'video', id: 'alice-cam' })
    alice.addTrack(aliceTrack, new MediaStream({ id: 'alice-cam', tracks: [aliceTrack] }))

    let inbound = null
    toAlice.connection.ontrack = (event) => {
      inbound = event.track
    }
    await negotiate(alice, toAlice.connection)
    expect(inbound).not.toBeNull()

    // The forwarder mirrors what arrived onto the other connection. This is
    // the whole data plane: one call, and it takes a track, not bytes.
    const stopRelay = toBob.relay(inbound)
    teardowns.push(stopRelay)

    const received = []
    bob.ontrack = (event) => {
      event.track.onReceiveRtp.subscribe((rtp) => received.push(rtp))
    }
    await negotiate(toBob.connection, bob)

    // Ciphertext, as far as anything in the middle is concerned. If the
    // forwarder depacketised or decoded, this would not survive.
    const payload = Buffer.from('e2e-ciphertext-the-forwarder-cannot-read')
    const pump = setInterval(() => {
      aliceTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ payloadType: 96, sequenceNumber: received.length + 1, timestamp: 3000, ssrc: 4242 }),
          payload,
        ),
      )
    }, 40)
    teardowns.push(() => clearInterval(pump))

    await waitFor(() => received.length > 0, 8000)
    clearInterval(pump)

    expect(received.length).toBeGreaterThan(0)
    expect(Buffer.from(received[0].payload).toString('utf8')).toBe(
      'e2e-ciphertext-the-forwarder-cannot-read',
    )
  }, 30_000)
})

async function negotiate(from, to) {
  const offer = await from.createOffer()
  await from.setLocalDescription(offer)
  await to.setRemoteDescription(from.localDescription)
  const answer = await to.createAnswer()
  await to.setLocalDescription(answer)
  await from.setRemoteDescription(to.localDescription)
  await Promise.all(
    [from, to].map(
      (pc) =>
        new Promise((resolve) => {
          if (pc.connectionState === 'connected') return resolve()
          pc.connectionStateChange.subscribe(() => {
            if (pc.connectionState === 'connected') resolve()
          })
        }),
    ),
  )
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// ---------------------------------------------------------------------------
// This file imports the protocol from dist/, which tsc produces from src/. A
// stale dist is the one failure mode that makes every assertion here a lie
// about code that is no longer there - and it fails as a confusing assertion
// error rather than as "you forgot to build".
// ---------------------------------------------------------------------------
describe('the built library this process runs against', () => {
  it('is not stale', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const src = join(here, '..', 'src')
    const built = join(here, '..', 'dist', 'src')
    const stale = readdirSync(src)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => {
        const compiled = join(built, `${name.slice(0, -3)}.js`)
        try {
          return statSync(join(src, name)).mtimeMs > statSync(compiled).mtimeMs
        } catch {
          return true
        }
      })
    expect(stale, `dist/src is behind src/ - run \`npm run build:lib\``).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// werift is a full WebRTC stack in TypeScript: DTLS, SRTP, ICE, SCTP, and the
// Node builtins all of that needs. It belongs in this process and nowhere
// else. The browser already has a WebRTC stack - shipping a second one to it
// would be megabytes of dead weight that could not run there anyway.
// ---------------------------------------------------------------------------
describe('werift', () => {
  it('is reachable from server/ and from nowhere the browser bundle can see', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const roots = [join(here, '..', 'src'), join(here, '..', 'app', 'src')]
    const offenders = []
    for (const root of roots) {
      for (const name of readdirSync(root)) {
        if (!name.endsWith('.ts')) continue
        if (/\bfrom ['"]werift/.test(readFileSync(join(root, name), 'utf8'))) offenders.push(join(root, name))
      }
    }
    expect(offenders, 'werift is Node-only and must not reach the browser bundle').toEqual([])
  })
})
