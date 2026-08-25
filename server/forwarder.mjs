#!/usr/bin/env node
// KithMoot's reference forwarder.
//
// ## What this is for
//
// Mesh upload is `(N-1) x bitrate`, and upload is the scarce half of a
// domestic connection. Past roughly eight people - sooner, if anybody is
// sharing a legible screen - a mesh cannot carry a room, and somebody has to
// forward. This is that somebody: a small Node process anybody can run.
//
// ## What makes it different from every other conferencing server
//
// **It is given the room *id*, and never the room *key*.** That is not a
// policy this file promises to keep, it is the only thing it is configured
// with: `loadConfigFromEnv` refuses to start if a room key or secret is
// anywhere in its environment, and there is no code path here that could use
// one if it had it. So:
//
// - It cannot decrypt the roster, so it never learns who is in the room, what
//   they are publishing, or which devices belong to one person. It does not
//   even subscribe to the roster kind - see `start()`.
// - It cannot decrypt media, which is encrypted end to end under a key
//   derived from the room key (`src/media-crypto.ts`). It moves RTP packets
//   from one connection to another without ever looking inside a payload.
// - It cannot forge attribution, because it cannot produce a frame that opens
//   under any member's media key.
//
// Jitsi's videobridge sees your media by default. This structurally cannot.
//
// ## How a client finds it, given it cannot read the room's roster
//
// The obvious design - a WebSocket the client dials, saying "let me into room
// X" - needs an inbound port, a TLS certificate, and a story about what stops
// anybody who learns the room id consuming the bandwidth. It also invents a
// second signalling protocol beside the one the room already speaks.
//
// So this does not do that. A forwarder is reached the same way any other
// endpoint in a KithMoot room is reached: a NIP-AC gift wrap on a relay,
// addressed to its pubkey, carrying an ordinary WebRTC offer. The forwarder
// holds its own Nostr key, subscribes on the room's relays for wraps
// addressed to that key, and unwraps them with its own secret - no room key
// involved, because a wrap is sealed to the *recipient*, not to the room. The
// inner signal names the room, which is checked against the one it serves.
//
// What the room descriptor advertises is therefore `{ url, pubkey }` where
// `url` is a relay to signal over and `pubkey` is who to address - which is
// exactly the two fields `ForwarderRef` already has, and exactly what
// `selectForwarder` already orders. The consequences are worth stating:
//
// - **No inbound port, no certificate.** The forwarder dials out to relays.
//   It runs behind NAT, on a home connection, on a Pi.
// - **No new protocol.** Signalling reuses `wrapSignal`/`unwrapSignal` and
//   NIP-AC's staleness, dedup and rate-limit rules, so there is one
//   signalling path to get right rather than two.
// - **The membership check is the room key, and this process does not have
//   it.** Anybody who knows the room id and this forwarder's pubkey can ask
//   for a connection. That is bounded by the fan-out cap rather than by
//   authentication, and it is bounded honestly: a stranger who connects gets
//   ciphertext they cannot read, and costs bandwidth. See deploy/README.md.
//
// ## Node-only
//
// This file never ships to the browser (unlike `src/`), so it may use Node
// builtins freely. It stays plain JavaScript with no build step of its own,
// importing the protocol from the built library - run `npm run build:lib`
// before starting it, after every pull.

import { pathToFileURL } from 'node:url'
import { getPublicKey } from 'nostr-tools/pure'
import { Peer } from '../dist/src/peer.js'
import { KINDS } from '../dist/src/kinds.js'
import { wrapSignal, unwrapSignal } from '../dist/src/signal.js'
import { SignalGuard } from '../dist/src/signal-guard.js'
import { NostrRelayPool } from '../dist/src/relay-pool.js'
import { normaliseHex } from '../dist/src/hex.js'

/**
 * How many devices one forwarder will carry for one room.
 *
 * A forwarder relays every byte it carries, in both directions: N peers each
 * sending one 600 kbps stream costs `N x 600 kbps` in and `N x (N-1) x
 * 600 kbps` out. At 24 that is roughly 14 Mbps in and 330 Mbps out, which is
 * already past what a domestic uplink can do and into what a small VPS is
 * billed for. The cap is not a performance tuning knob - it is the point past
 * which one room stops being able to make the forwarder useless for the next
 * one. See deploy/README.md, "What a forwarder costs".
 */
export const DEFAULT_MAX_PEERS = 24

/**
 * How many tracks one device may fan out.
 *
 * Fan-out is quadratic in tracks as well as in peers, so this is the cheaper
 * of the two caps to get wrong in the generous direction. Four is exactly the
 * `TrackRole` set - camera, mic, screen, screen-audio - so a device
 * publishing everything it legitimately can is unaffected, and a device
 * inventing a fifth is refused.
 */
export const DEFAULT_MAX_TRACKS_PER_PEER = 4

/**
 * Environment variables that must not be set, and the reason.
 *
 * A forwarder that is handed the room key stops being a forwarder and starts
 * being a conferencing server that can see your call. Refusing here is worth
 * more than a comment saying "do not do this": the failure mode it prevents -
 * an operator helpfully putting the join URL in the unit file so the process
 * "has everything it needs" - is a mistake that would otherwise work
 * perfectly and quietly void the whole design.
 */
const FORBIDDEN_ENV = ['KITHMOOT_ROOM_KEY', 'KITHMOOT_ROOM_SECRET', 'KITHMOOT_JOIN_URL', 'KITHMOOT_SECRET']

const HEX_64 = /^[0-9a-f]{64}$/

function splitCsv(raw) {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isWebSocketUrl(raw) {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Read and validate configuration. Throws with a specific message on anything
 * that would make this process unsafe, useless, or a lie about what it is.
 */
export function loadConfigFromEnv(env = process.env) {
  for (const name of FORBIDDEN_ENV) {
    if (env[name]) {
      throw new Error(
        `${name} is set - refusing to start. A forwarder is given the room id, never the room key: ` +
          'it routes ciphertext it cannot read, and handing it the key would quietly make that untrue. ' +
          `Unset ${name} and set KITHMOOT_ROOM_ID to the room's public id instead.`,
      )
    }
  }

  const rawRoomId = (env.KITHMOOT_ROOM_ID ?? '').trim()
  if (!rawRoomId) {
    throw new Error(
      'KITHMOOT_ROOM_ID is not set - refusing to start. It is the 64-character hex room id, which a ' +
        'member can read off `deriveRoom(secret).roomId`. It is not the join URL and not the room secret.',
    )
  }
  if (rawRoomId.includes('#') || rawRoomId.includes('://')) {
    throw new Error(
      'KITHMOOT_ROOM_ID looks like a join URL - refusing to start. A join URL fragment carries the room ' +
        'secret, and a forwarder must never be given the room secret. Pass the room id on its own: 64 hex ' +
        'characters, no scheme and no fragment.',
    )
  }
  const roomId = normaliseHex(rawRoomId)
  if (!HEX_64.test(roomId)) {
    throw new Error(`KITHMOOT_ROOM_ID must be 64 hex characters, got ${rawRoomId.length}.`)
  }

  const relays = splitCsv(env.NOSTR_RELAYS)
  if (relays.length === 0) {
    throw new Error(
      'NOSTR_RELAYS is not set - refusing to start. At least one relay is required, comma-separated for ' +
        'more than one, e.g. "wss://relay.trotters.cc,wss://nos.lol". Use the same relays the room does, ' +
        'or the room will never see this forwarder answer.',
    )
  }
  for (const relay of relays) {
    if (!isWebSocketUrl(relay)) {
      throw new Error(`NOSTR_RELAYS entry "${relay}" is not a ws: or wss: address.`)
    }
  }

  const rawSk = (env.KITHMOOT_FORWARDER_SK ?? '').trim().toLowerCase()
  if (!rawSk) {
    throw new Error(
      'KITHMOOT_FORWARDER_SK is not set - refusing to start. This is the forwarder\'s own Nostr secret ' +
        'key, and it must be stable: a room descriptor names a forwarder by pubkey, so a key generated ' +
        'afresh on each restart would silently orphan every room pointing here. Generate one with ' +
        '`openssl rand -hex 32` and put it in this service\'s EnvironmentFile. There is no default on purpose.',
    )
  }
  if (!HEX_64.test(rawSk)) {
    throw new Error('KITHMOOT_FORWARDER_SK must be 64 hex characters (`openssl rand -hex 32`).')
  }
  const secretKey = hexToBytes(rawSk)
  // Derived, never read from the environment: a pubkey taken on trust could
  // disagree with the key that actually signs, and the room would address
  // wraps this process can never unwrap.
  const pubkey = getPublicKey(secretKey)

  const url = (env.KITHMOOT_FORWARDER_URL ?? '').trim() || relays[0]
  if (!isWebSocketUrl(url)) {
    throw new Error(
      `KITHMOOT_FORWARDER_URL "${url}" is not a ws: or wss: address. It is the relay a client should ` +
        'signal to this forwarder over, and it goes in the room descriptor verbatim.',
    )
  }

  const maxPeers = readPositiveInt(env.KITHMOOT_MAX_PEERS, 'KITHMOOT_MAX_PEERS', DEFAULT_MAX_PEERS)
  const maxTracksPerPeer = readPositiveInt(
    env.KITHMOOT_MAX_TRACKS_PER_PEER,
    'KITHMOOT_MAX_TRACKS_PER_PEER',
    DEFAULT_MAX_TRACKS_PER_PEER,
  )

  const label = (env.KITHMOOT_LABEL ?? '').trim() || undefined

  return { roomId, relays, secretKey, pubkey, url, label, maxPeers, maxTracksPerPeer }
}

function readPositiveInt(raw, name, fallback) {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number, got "${raw}".`)
  }
  return value
}

/**
 * The entry a room descriptor carries for this forwarder.
 *
 * Exactly the three fields `ForwarderRef` allows, built here rather than by
 * hand so an operator pastes something that cannot accidentally include a
 * key. `descriptor.ts` projects onto the same three on the way in and out,
 * so a fourth field would not survive the trip anyway.
 */
export function forwarderRef(config) {
  return config.label
    ? { url: config.url, pubkey: config.pubkey, label: config.label }
    : { url: config.url, pubkey: config.pubkey }
}

/**
 * The WebRTC stack, behind a seam.
 *
 * `createConnection()` returns a host: an `RTCPeerConnectionLike` for `Peer`
 * to negotiate over, and a `relay(track)` that mirrors an inbound track onto
 * this connection and starts moving packets onto it. Both live behind the
 * seam because both are the only werift-shaped things here - and because a
 * double that cannot decode a payload is a fair test of a process whose whole
 * claim is that it never decodes one.
 */
export async function createWeriftStack() {
  const { RTCPeerConnection, MediaStreamTrack, MediaStream } = await import('werift')

  return {
    createConnection() {
      const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      return {
        connection,
        /**
         * Mirror `source` onto this connection.
         *
         * `writeRtp` takes the packet exactly as it arrived: header and an
         * opaque payload. Nothing here depacketises, decodes, transcodes or
         * inspects a payload - werift can do all of those, and this
         * deliberately does none of them. The payload is ciphertext under a
         * key this process does not have; the only sensible thing to do with
         * it is move it.
         */
        relay(source) {
          const mirror = new MediaStreamTrack({ kind: source.kind, id: source.id })
          connection.addTrack(mirror, new MediaStream({ id: source.id, tracks: [mirror] }))
          const dispose = source.onReceiveRtp.subscribe((rtp) => {
            try {
              mirror.writeRtp(rtp)
            } catch {
              // A closed or renegotiating destination rejects a write. One
              // lost packet costs a glitch; letting it escape would take
              // down the sender's whole subscription and with it everybody
              // else's copy of this track.
            }
          })
          return () => dispose.unSubscribe()
        },
        close() {
          // werift's close() is async; there is nothing useful to await it
          // for during teardown, and a rejection here must not stop the rest
          // of the peers being torn down.
          void Promise.resolve(connection.close()).catch(() => {})
        },
      }
    },
  }
}

function defaultLog(line) {
  // stderr, matching server/turn-credentials.mjs: whatever supervises this
  // process should get the operational chatter on the stream meant for it.
  console.error(line)
}

/**
 * Build a forwarder for one room.
 *
 * One process, one room, deliberately: the fan-out cap is only a meaningful
 * promise if there is nothing else on this process competing for the same
 * uplink, and a process with no cross-room state has no cross-room mistake
 * to make.
 */
export function createForwarder({ config, transport, stack, log = defaultLog, now = () => Math.floor(Date.now() / 1000) }) {
  const guard = new SignalGuard()
  /** device -> { peer, host, tracks: Map<trackKey, {track, stops: Map<device, () => void>}> } */
  const peers = new Map()
  const stats = { peers: 0, refused: 0, tracksRefused: 0, duplicatesDropped: 0, staleDropped: 0, relayed: 0 }
  const filters = [{ kinds: [KINDS.SIGNAL_WRAP], '#p': [config.pubkey] }]
  let unsub
  let closed = false

  function send(device, body) {
    const wrap = wrapSignal(
      { ...body, roomId: config.roomId },
      { senderSk: config.secretKey, recipientPubkey: device },
    )
    transport.publish(wrap).catch(() => {})
  }

  function admit(device) {
    const existing = peers.get(device)
    if (existing) return existing
    if (peers.size >= config.maxPeers) {
      stats.refused += 1
      log(
        `forwarder: refusing ${device.slice(0, 8)} - fan-out cap of ${config.maxPeers} peers reached. ` +
          'That device falls back to direct mesh; everybody already connected keeps working.',
      )
      return null
    }

    const host = stack.createConnection()
    const entry = { peer: null, host, tracks: new Map(), relayCount: 0 }

    // Every handler goes through `Peer`'s own options rather than onto the
    // connection: `Peer` takes ownership of `ontrack`, `onicecandidate` and
    // `onconnectionstatechange` in its constructor, so anything assigned
    // directly is silently overwritten.
    entry.peer = new Peer({
      factory: () => host.connection,
      localDevice: config.pubkey,
      remoteDevice: device,
      onSignal: (body) => send(device, body),
      // A forwarder is not a member: a track is not media to it, only packets
      // to move.
      onTrack: (track) => onInboundTrack(device, track),
      onConnectionState: (state) => {
        if (state === 'failed' || state === 'closed' || state === 'disconnected') drop(device)
      },
    })

    peers.set(device, entry)
    stats.peers = peers.size
    log(`forwarder: peer ${device.slice(0, 8)} joined (${peers.size}/${config.maxPeers})`)

    // Everything already flowing, so a late arrival is not deaf to the people
    // who were here first - the same problem the roster solves by having
    // members answer an arrival, solved here by the forwarder answering it.
    for (const [source, sourceEntry] of peers) {
      if (source === device) continue
      for (const held of sourceEntry.tracks.values()) fanOutTo(device, entry, held)
    }

    return entry
  }

  function onInboundTrack(device, track) {
    const entry = peers.get(device)
    if (!entry || closed) return
    const key = track.id ?? track.uuid ?? `${track.kind}:${entry.tracks.size}`
    if (entry.tracks.has(key)) return
    if (entry.tracks.size >= config.maxTracksPerPeer) {
      stats.tracksRefused += 1
      log(
        `forwarder: refusing a ${track.kind} track from ${device.slice(0, 8)} - per-peer track cap of ` +
          `${config.maxTracksPerPeer} reached.`,
      )
      return
    }

    const held = { track, stops: new Map() }
    entry.tracks.set(key, held)
    for (const [other, otherEntry] of peers) {
      if (other === device) continue
      fanOutTo(other, otherEntry, held)
    }
  }

  /** Mirror one held track onto one destination, and renegotiate for it. */
  function fanOutTo(destination, destinationEntry, held) {
    if (held.stops.has(destination)) return
    held.stops.set(destination, destinationEntry.host.relay(held.track))
    destinationEntry.relayCount += 1
    stats.relayed += 1
    renegotiate(destinationEntry)
  }

  /** A track was added to this connection, so its description has to change.
   *  `start([])` adds nothing and offers, which is exactly renegotiation -
   *  and it runs on `Peer`'s operations queue, so several tracks landing in
   *  one tick coalesce behind one another instead of racing. */
  function renegotiate(entry) {
    entry.peer?.start([]).catch(() => {})
  }

  function drop(device) {
    const entry = peers.get(device)
    if (!entry) return
    peers.delete(device)
    stats.peers = peers.size

    // Stop sending this device everybody else's tracks...
    for (const other of peers.values()) {
      for (const held of other.tracks.values()) {
        const stop = held.stops.get(device)
        if (stop) {
          stop()
          held.stops.delete(device)
        }
      }
    }
    // ...and stop sending everybody else this device's.
    for (const held of entry.tracks.values()) {
      for (const stop of held.stops.values()) stop()
      held.stops.clear()
    }

    entry.peer?.close()
    entry.host.close()
    log(`forwarder: peer ${device.slice(0, 8)} left (${peers.size}/${config.maxPeers})`)
  }

  /**
   * Handle one gift wrap. Never throws: this runs inside a relay
   * subscription handler, where a throw takes the whole forwarder down.
   *
   * The three NIP-AC rules, in the same order and for the same reasons as
   * `Mesh` applies them: dedup first because it is cheapest and catches the
   * commonest case (the same wrap from every relay), staleness inside
   * `unwrapSignal` on the inner event's own timestamp, and rate limiting last
   * against the sending device rather than the wrap's ephemeral pubkey.
   */
  function handleWrapEvent(event) {
    if (closed) return
    if (!guard.admitEvent(event.id)) {
      stats.duplicatesDropped += 1
      return
    }

    const unwrapped = unwrapSignal(event, {
      recipientSk: config.secretKey,
      roomId: config.roomId,
      now: now(),
    })
    if (!unwrapped) {
      stats.staleDropped += 1
      return
    }

    if (!guard.admitSender(unwrapped.from, now())) return

    // An answer or a candidate from a device that is not connected is stale
    // by definition, and must not create a peer: only an offer is an arrival.
    const entry = unwrapped.body.type === 'offer' ? admit(unwrapped.from) : peers.get(unwrapped.from)
    if (!entry) return
    entry.peer.handleSignal(unwrapped.body).catch(() => {})
  }

  return {
    start() {
      if (unsub) return
      log('')
      log('  KithMoot forwarder')
      log(`  room ${config.roomId}`)
      log(`  as   ${config.pubkey}`)
      log(`  over ${config.relays.join(', ')}`)
      log(`  cap  ${config.maxPeers} peers, ${config.maxTracksPerPeer} tracks each`)
      log('')
      log('  This process has the room id and NOT the room key. It relays ciphertext it cannot read:')
      log('  it cannot decrypt the roster, so it never learns who is in this room; it cannot decrypt')
      log('  media, which is sealed end to end under a key derived from the room key; and it cannot')
      log('  forge attribution, because it cannot produce a frame that opens under anybody\'s key.')
      log('')
      log('  Add this to the room descriptor to be used:')
      log(`  ${JSON.stringify(forwarderRef(config))}`)
      log('')
      unsub = transport.subscribe(filters, handleWrapEvent)
    },
    handleWrapEvent,
    ref: () => forwarderRef(config),
    stats: () => ({ ...stats, filters }),
    close() {
      if (closed) return
      closed = true
      unsub?.()
      unsub = undefined
      for (const device of [...peers.keys()]) drop(device)
    },
  }
}

function isMainModule() {
  const entry = process.argv[1]
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href
}

async function main() {
  let config
  try {
    config = loadConfigFromEnv(process.env)
  } catch (err) {
    console.error(`forwarder: ${err.message}`)
    process.exitCode = 1
    return
  }

  const transport = new NostrRelayPool(config.relays)
  const stack = await createWeriftStack()
  const forwarder = createForwarder({ config, transport, stack })
  forwarder.start()

  const shutdown = () => {
    forwarder.close()
    transport.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (isMainModule()) void main()
