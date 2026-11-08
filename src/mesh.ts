import type { ExpirationDeadline } from './expiration.js'
import type { Event } from 'nostr-tools/pure'
import { cameraRungFor } from './camera-budget.js'
import { Peer } from './peer.js'
import type { NegotiatingPeer, PeerFactory } from './peer.js'
import { SlotPeer } from './slot-peer.js'
import { PairController } from './pair-controller.js'
import type { PairDiagnostics } from './pair-controller.js'
import type { RoleResolver } from './peer-slots.js'
import { wrapSignal, unwrapSignalEvent, SIGNAL_MAX_AGE_SECONDS } from './signal.js'
import type { CarryEntry, ScreenAnnotation, SignalBody } from './signal.js'
import { MAX_CARRY_ENTRIES } from './signal.js'
import { RELAY_TEST_SIGNALS_PER_WINDOW, type RelayTestRequest, type RelayTestResult } from './relay-test.js'
import { SignalGuard } from './signal-guard.js'
import { KINDS } from './kinds.js'
import type { RelayTransport } from './relay-pool.js'
import type { ParticipantView } from './session.js'
import { needsForwarding, selectForwarder } from './forwarder.js'
import type { CapacityEstimate, ForwarderRef } from './forwarder.js'
import { assistPairKey, selectAssistant } from './peer-assist.js'
import type { AssistVolunteer } from './peer-assist.js'
import type { PeerRelay, RelayLegHandle, RelayMediaPipeline, RelayPair } from './peer-relay.js'
import type { RouteTier } from './peer.js'
import type { AssistOffer, TrackRole } from './types.js'
import { normaliseHex } from './hex.js'

/**
 * The subset of `RoomSession` that `Mesh` actually touches - the same
 * structural-typing seam as `RTCPeerConnectionLike`: a real `RoomSession`
 * satisfies this with no adapter, and tests can hand in a fully
 * controllable double.
 */
export interface MeshSession {
  participants(): ParticipantView[]
  onChange(cb: (views: ParticipantView[]) => void): () => void
}

/**
 * The browser-specific half of server-forwarder media protection.
 *
 * `Mesh` owns the routing and roster attribution, while the embedding app
 * owns WebRTC's browser-only encoded-transform objects. Both hooks are called
 * at the first point the browser exposes the relevant RTP endpoint: directly
 * after `addTrack()` for a sender, and in the `track` event for a receiver.
 * Returning false refuses that forwarding path rather than letting ordinary
 * hop-by-hop DTLS-SRTP terminate at the server.
 */
export interface ForwarderMediaPipeline {
  /**
   * Replace every endpoint's room epoch key. A rekey changes the secret
   * which protects forwarded media just as it changes roster and chat
   * traffic; keeping the old media key would let a removed member continue
   * opening frames through a forwarder.
   */
  rekey(roomKey: Uint8Array): boolean
  protectSender(sender: unknown, senderDevice: string, track: MediaStreamTrack): boolean
  protectReceiver(receiver: unknown, expectedDevice: string, track: MediaStreamTrack): boolean
  close?(): void
}

export interface RemoteAnnotation {
  participant: string
  device: string
  annotation: ScreenAnnotation
}

/** A relay outside test message from another admitted room device: a
 *  host's request, or a tester's result. See `relay-test.ts`. */
export type RemoteRelayTest = { participant: string; device: string; createdAt: number } & (
  | { type: 'relay-test'; relayTest: RelayTestRequest }
  | { type: 'relay-test-result'; relayTest: RelayTestResult })

/** Something that went wrong in signalling and was survived, or something
 *  ordinary worth a line in a call's timeline. See `MeshOptions.onDiagnostic`. */
export interface MeshDiagnostic {
  kind:
    /** A relay rejected a signal outright, so it never left this device. */
    | 'signal-publish-failed'
    /** A signal reached the peer and the peer would not have it - a
     *  description that does not match the session, most often. */
    | 'signal-handling-failed'
    /** A renegotiation on a connected pair went unanswered for long enough
     *  that ICE was restarted on it. */
    | 'renegotiation-stalled'
    /** An ordinary signal was handed to the transport for publishing. */
    | 'signal-sent'
    /** An ordinary signal was received, decrypted and admitted. */
    | 'signal-received'
    /** A signal was retransmitted after its publish failed. */
    | 'signal-retransmitted'
    /** A signal held for a peer that did not exist yet was dropped as too
     *  old once that peer was finally created. */
    | 'signal-dropped-as-stale'
    /** This endpoint's connection changed state. */
    | 'connection-state-change'
    /** A profile-2 pair's health ladder moved: a restart, a rebuild, a
     *  change of rung, or a rest between walks of it. See §3.4. */
    | 'pair-ladder'
    /** A route through a volunteer was given up: refused, no media, or
     *  media that stopped. */
    | 'route-assist-failed'
    /** This device stopped carrying a pair. */
    | 'relay-pair-ended'
    /** One of a carried pair's tracks could not be carried. */
    | 'relay-leg-refused'
  /** The remote device the signal was to or from. */
  device: string
  /** Free text, for a bug report. Signal types, states and error messages
   *  only - never a description, a candidate or anything from the SDP. */
  detail: string
}

/** A rejection reduced to something a bug report can carry: never an object
 *  a caller could walk back to a key or a room. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'rejected'
}

export interface MeshOptions {
  session: MeshSession
  /** When supplied, only these room devices receive media connections.
   *  Room annotations and membership still use the whole roster. */
  callDevices?: (views: readonly ParticipantView[]) => ReadonlySet<string>
  factory: PeerFactory
  localDevice: string
  /** Our own participant pubkey. Supplied explicitly, never inferred from
   *  the roster: our own entry only appears there once a relay echoes it
   *  back, and until it does an inferred answer does not recognise our other
   *  device as ours. */
  localParticipant: string
  deviceSk: Uint8Array
  transport: RelayTransport
  roomId: string
  /** Unix seconds. Defaults to the real clock; the session hands in its own so
   *  staleness and rate limiting are judged by the same clock as everything
   *  else in the room. */
  now?: () => number
  /**
   * This device's measured uplink and per-peer send bitrate.
   *
   * The peer count is deliberately NOT taken from the caller: the mesh is
   * what knows how many devices it is sending to, and a caller that got that
   * number wrong would promote a room that did not need it or leave one that
   * did. Called on every roster change, because both terms move - a screen
   * share changes `perPeerBps`, and a train changes `uplinkBps`.
   *
   * Omit it, or return null, and the mesh never promotes. That is the right
   * default: promotion is on measured capacity or it does not happen, and a
   * room that has measured nothing must not guess.
   */
  uplink?: () => { uplinkBps: number; perPeerBps: number } | null
  /** Passed to every peer: how long a connection that was up is given to
   *  come back before it is believed failed. See `PeerOptions.iceRestart`. */
  iceRestart?: { graceMs?: number; timeoutMs?: number }
  /** Passed to every peer: how long an offer waits for its answer before it
   *  is sent again. See `PeerOptions.offerRetry`. */
  offerRetry?: { intervalMs?: number; maxIntervalMs?: number; jitter?: number; wedgeMs?: number }
  /** Forwarders the room descriptor names. Swappable at runtime; see
   *  `setForwarders`. */
  forwarders?: ForwarderRef[]
  /**
   * Whether this client has installed a sender-attributed encoded-frame
   * pipeline for a server forwarder.
   *
   * A forwarder terminates WebRTC's hop-by-hop DTLS-SRTP. It must therefore
   * never be promoted merely because a descriptor names it: without the
   * additional media transform it receives plaintext media. Omit this (the
   * safe default) until the embedding application has proved that every
   * forwarded sender is encrypted under its own device-bound media key and
   * every received track is checked against that sender.
   *
   * This is a function because support can disappear at runtime when a media
   * pipeline is torn down. A thrown check is treated as unavailable.
   */
  forwarderMedia?: () => boolean
  /** The actual encoded-frame pipeline backing `forwarderMedia`. Capability
   * without this is not sufficient to promote: it would only be a promise
   * that a readable forwarder was safe. */
  forwarderMediaPipeline?: ForwarderMediaPipeline
  /** A forwarder pubkey or url to prefer over the deterministic ordering. */
  preferForwarder?: string
  /** How long a forwarder has to connect before the room gives up on it and
   *  stays a mesh. See `DEFAULT_FORWARDER_TIMEOUT_MS`. */
  forwarderTimeoutMs?: number
  /**
   * How long one rung of the route ladder has to connect before the room
   * tries the next one. See `DEFAULT_ROUTE_TIMEOUT_MS`.
   */
  routeTimeoutMs?: number
  /** How long the direct rung may check candidates without connecting. See
   *  `DEFAULT_DIRECT_CHECK_TIMEOUT_MS`. */
  directCheckTimeoutMs?: number
  /** A relay-only factory already uses TURN on its first connection. Start
   * there, with its relay budget, and retain that choice after a rest. */
  initialTier?: 'direct' | 'turn'
  /** How long the TURN rung gets. See `DEFAULT_TURN_ROUTE_TIMEOUT_MS`. */
  turnRouteTimeoutMs?: number
  /**
   * How long a renegotiation on an already connected pair gets before ICE is
   * restarted on it. See `DEFAULT_RENEGOTIATION_TIMEOUT_MS`.
   */
  renegotiationTimeoutMs?: number
  /**
   * Where things that went wrong and were survived are reported.
   *
   * Signalling is full of failures that must not take the room down and must
   * not be silent either: a relay that rejected a publish, a description the
   * far end would not apply. Both used to vanish into an empty `catch`, which
   * is how a pair could be wedged for a whole call with nothing anywhere
   * saying so. Never called with anything secret - a signal's type and a
   * device pubkey, both already on the wire.
   *
   * Optional, and a throw from it is swallowed: a caller's logger is not
   * allowed to be the thing that breaks a call.
   */
  onDiagnostic?: (event: MeshDiagnostic) => void
  /** How long an exhausted route rests before the ladder is retried from
   *  the top. See `EXHAUSTED_RETRY_MS`. */
  exhaustedRetryMs?: number
  /** The longest that rest grows to. See `MAX_EXHAUSTED_RETRY_MS`. */
  maxExhaustedRetryMs?: number
  /**
   * Whether this room may route a failing pair through a member who
   * volunteered. Defaults to on, because it costs the pair nothing and costs
   * the volunteer only what they already agreed to give.
   *
   * Consent lives at the other end: nobody is relayed through who did not
   * publish an offer, and nothing here can make them publish one.
   */
  assist?: () => boolean
  /**
   * This device's own relay registry, when it is volunteering.
   *
   * Absent means this device never accepts a request to carry anybody, which
   * is the default and the only safe one: relaying spends somebody's
   * bandwidth and battery, so it happens because they said so and for no
   * other reason. Passing one in is what saying so looks like, and dropping
   * it - or calling `close()` on it - is what revoking looks like, mid-call,
   * without anybody's room ending.
   */
  relay?: PeerRelay
  /**
   * The encoded-frame pumps that actually carry a pair - see
   * `RelayMediaPipeline`. Without a ready one this device refuses every
   * request to carry, whatever `relay` and `offering` say: accepting a pair
   * and carrying nothing is what left people on a dead route.
   */
  relayMedia?: RelayMediaPipeline
  /** How long a volunteer holds one end's request for the other end's. See
   *  `ASSIST_HOLD_MS`. */
  assistHoldMs?: number
  /** How long carried media may stop arriving before the route is given up.
   *  See `ASSIST_STALL_MS`. */
  assistStallMs?: number
  /** How often carried media is checked for. See `ASSIST_SAMPLE_MS`. */
  assistSampleMs?: number
  /** How often a carried end asks again. See `ASSIST_RENEW_MS`. */
  assistRenewMs?: number
  /** How long a volunteer carries without a renewal. See `ASSIST_LEASE_MS`. */
  assistLeaseMs?: number
  /** A conference room's end: every signal wrap this mesh publishes is
   *  lowered to it if it would outlive it. See `withExpiration`. */
  expiresAt?: ExpirationDeadline
  /**
   * Whether this device is, right now, advertising an offer to relay.
   *
   * Checked before every request to carry a pair is accepted, and it is the
   * consent gate rather than a convenience: `relay` being present says a
   * person once turned this on, and this says they have not turned it off.
   * Without it a hostile client could ask a device that never advertised
   * anything to carry a pair, and be told yes - spending somebody's bandwidth
   * because they were asked rather than because they offered.
   *
   * Absent means "offering", so a caller that manages consent by passing or
   * withholding `relay` keeps working.
   */
  offering?: () => boolean
  /** Called when this device takes on a pair to carry, once both ends have
   *  asked. The frames themselves are pumped through `relayMedia`. */
  onRelayStart?: (pair: RelayPair) => void
  /** Called when this device stops carrying a pair, for any reason. */
  onRelayStop?: (pair: RelayPair) => void
  /** Called whenever a remote device's route changes rung. What a UI needs to
   *  say "connected through Priya" honestly, and to say "we could not connect"
   *  when the ladder runs out. */
  onRoute?: (device: string, route: RouteView) => void
  /**
   * Which call signalling profile this build speaks.
   *
   * `1` is every client from before today: negotiation per track, no
   * generations, healing by ICE restart. `2` adds the fixed media slots, the
   * reliable signal channel and pair generations of the call reliability
   * design - and only ever for a pair where the far end's roster entry says
   * `callProfile: 2` as well, because a profile-2 offer is meaningless to a
   * far end that cannot read `slots`.
   *
   * Defaults to `1`, deliberately: the published library must behave exactly
   * as it did, and an embedding turns this on when it has shipped the rest of
   * the profile. A bad day is then one flag away from today's behaviour.
   */
  callProfile?: 1 | 2
  /**
   * Which fixed slot each published track belongs in.
   *
   * Only read on a profile-2 pair, where a track has to land in the right one
   * of four m-lines. The app knows - it publishes a `TrackAdvert` carrying
   * exactly this role - so asking is honest where guessing from kind and
   * order is not. Omitted, the slots fall back to inference, which two
   * cameras or a share with no camera would get wrong.
   */
  trackRole?: RoleResolver
  /**
   * A profile-2 far end reports a slot of ours dead and the local track for
   * it has ended - a camera another application took, a microphone that was
   * unplugged.
   *
   * Nothing this library owns can repair that: replacing the track means
   * asking for a device, which is the embedding app's business and nobody
   * else's. Absent, the slot simply stays empty and the far end keeps saying
   * so, which is exactly what happened before this existed.
   */
  onSlotRecovery?: (device: string, role: TrackRole) => void
  /**
   * The pair-health thresholds of §3.4, for a caller that has to drive them
   * in milliseconds rather than wait them out. Defaults are the constants in
   * `src/pair-health.ts`; nothing in the app overrides them.
   */
  pairHealth?: {
    sampleMs?: number
    deadMs?: number
    graceMs?: number
    rtcpDeadMs?: number
    restartMs?: { direct: number; turn: number }
    rebuildMs?: { direct: number; turn: number }
    healthMs?: number
    rebuildWindowMs?: number
    maxRebuilds?: number
  }
}

/** How one remote device is currently being reached. */
export interface RouteView {
  tier: RouteTier
  /** The endpoint carrying it: the device itself at `direct` and `turn`, the
   *  volunteer at `assist`, the forwarder at `forwarder`. */
  endpoint: string
  /** True once that endpoint's connection has actually reported `connected`.
   *  Not "we sent an offer" - the only honest signal that a rung worked. */
  connected: boolean
  /** True when every rung has been tried and none of them worked. The room
   *  keeps going without this person's media, and says so. */
  exhausted: boolean
}

/** One source track this device is carrying for a pair, one way. */
interface CarriedLeg {
  pairKey: string
  from: string
  to: string
  role: TrackRole
  /** The receiver's track on the connection to `from`. */
  source: MediaStreamTrack
  /** The clone of it this device sends to `to`, whose frames are replaced. */
  clock: MediaStreamTrack
  /** The connection to `to` the clock was added to. */
  peer: Peer
  handle: RelayLegHandle | null
}

/** A device this one has asked a volunteer to carry. */
interface AssistState {
  volunteer: string
  /** The volunteer said yes. Not the same as media arriving. */
  accepted: boolean
  /** The budget for the volunteer to answer, then for the first media. */
  timer?: ReturnType<typeof setTimeout>
  sampler?: ReturnType<typeof setInterval>
  /** Asks again while carried. See `ASSIST_RENEW_MS`. */
  renew?: ReturnType<typeof setInterval>
  /** Tracks attributed to this device that arrived through the volunteer,
   *  each with its own high-water mark: a receiver whose report vanishes
   *  must not pull the others' total down, and a camera that stops while
   *  the microphone flows is still a stall. */
  tracks: Array<{ track: MediaStreamTrack; receiver?: unknown; role?: TrackRole; bytes: number; progressAt: number }>
}

interface Route extends RouteView {
  /** Volunteers already tried for this device and found wanting. Both ends of
   *  the pair accumulate this independently; they converge because the roster
   *  is the shared input and a volunteer that has gone leaves it. */
  failed: string[]
  /** How many times the ladder has been retried from the top for this
   *  device without a connection in between. Sets the rest. */
  retries: number
}

export interface RemoteTrack {
  participant: string
  device: string
  track: MediaStreamTrack
  /**
   * How this track reached us.
   *
   * `direct` is attributed by which peer connection it arrived on, which
   * nothing but the two endpoints controls. A connection that ICE ended up
   * relaying through TURN still reads as `direct`, because no member of the
   * room carried it and none of them could have relabelled it.
   *
   * `forwarder` is attributed by matching the track against the roster's own
   * signed, room-key-encrypted adverts, because every forwarded track arrives
   * on the same connection and it is the forwarder that chooses which stream
   * carries which id. That match is a *hint*: what settles it is which
   * member's media key opens the frames (`deriveMediaKey`,
   * `resolveFrameSender`), so a forwarder that relabels one member's stream
   * as another's produces frames that will not decrypt.
   *
   * `assist` is attributed by the volunteer's own `carry` map, and only when
   * this device asked that volunteer to carry exactly that person and the
   * roster says they publish that role. That is a hint and nothing settles
   * it: a volunteer is a member, the assist path has no frame layer, and
   * until each sender signs their own frames a dishonest volunteer could
   * show something else under another member's name. The app says so.
   */
  via: 'direct' | 'assist' | 'forwarder'
  /**
   * Which fixed slot this track arrived in, on a profile-2 pair.
   *
   * Resolved from the transceiver mid against the generation-opening offer's
   * `slots` map, which is the one identity both ends agree on: measured in
   * Chromium and Firefox, a receiver's track id never matches the sender's in
   * a slot, and `muted` never becomes true when the far end stops sending. So
   * the app is told the role rather than left to infer it from an advert that
   * may be a moment stale.
   *
   * Absent for a profile-1 peer and for a forwarded track, where the roster
   * advert remains the only hint there is. For an assisted track it is the
   * role the volunteer's `carry` map named, checked against the source's
   * roster advert.
   */
  role?: TrackRole
}

/** Whether this room is routing through a forwarder, and how confidently. */
export type ForwardingState =
  /** Direct mesh. Either capacity is fine or the room names no usable forwarder. */
  | 'off'
  /** A forwarder connection is being negotiated. **The direct mesh is still
   *  up** - nothing is dismantled on the strength of a connection that has
   *  not happened yet. */
  | 'trying'
  /** The forwarder is connected and carrying the room; direct peers closed. */
  | 'up'
  /** The forwarder did not come up, or dropped. The room is a direct mesh
   *  again - degraded, since every device is back to paying `(N-1) x
   *  bitrate`, but working. */
  | 'failed'

/**
 * How long a forwarder has to connect before the room gives up on it.
 *
 * Long enough for a real negotiation over a slow link - ICE gathering, DTLS,
 * a relayed candidate if it comes to that - and short enough that a room
 * whose forwarder is simply gone is not held in a degraded-but-silent state
 * while people wonder why nobody can hear them. The mesh keeps working
 * throughout either way; this only bounds how long the room waits before
 * writing the forwarder off.
 */
export const DEFAULT_FORWARDER_TIMEOUT_MS = 8_000

/**
 * How long one rung of the route ladder has to connect before the next is
 * tried.
 *
 * ICE reports `failed` on its own for most dead paths, and this is the
 * backstop for the ones it does not: a candidate pair that stays `checking`
 * for ever, a volunteer that accepted and then closed its laptop before any
 * media moved. Long enough for a real negotiation over a slow link, short
 * enough that nobody sits looking at a blank tile wondering.
 */
export const DEFAULT_ROUTE_TIMEOUT_MS = 10_000

/**
 * How long a volunteer holds one end's request to be carried while it waits
 * for the other end's.
 *
 * A volunteer carries a pair only once both ends have asked, because each
 * end's request is its consent to its own media going to the other through
 * somebody else (see `RelayPair.ask`). Both ends walk the same ladder on the
 * same roster, so the second request normally follows within a second or
 * two. Shorter than `DEFAULT_ROUTE_TIMEOUT_MS`, so the refusal reaches the
 * asker before its own timer gives up on this volunteer: an end that never
 * asks - an old client, one that refused the other, one whose person turned
 * "Let members pass my call on" off - costs its partner a refusal, not a
 * dead route.
 */
export const ASSIST_HOLD_MS = 8_000

/**
 * How long carried media may stop arriving before the route is given up.
 *
 * A volunteer can stay in the roster and stop delivering: a frozen tab, an
 * uplink that has filled. Nothing else would ever notice, because the pair
 * reaches the volunteer over a connection that is still up. Six seconds is
 * three samples of the app's own two-second poll, long enough not to fire on
 * a key-frame wait, short enough that a frozen picture is not left up long.
 */
export const ASSIST_STALL_MS = 6_000

/** How often a carried route's receivers are asked whether bytes are
 *  arriving: first to count the route connected, then to notice a stall. */
export const ASSIST_SAMPLE_MS = 1_000

/**
 * How often an end that is being carried asks again.
 *
 * Carrying is a lease, not a one-off yes. Each end's request is its consent
 * to its own media going to the other end through the volunteer, and consent
 * taken back has to stop the carrying even when the one signal saying so is
 * lost on a relay. So an end keeps asking while it is carried, checking each
 * time that it still sends to the far end, and a volunteer drops a pair whose
 * ends have stopped asking: see `ASSIST_LEASE_MS`.
 */
export const ASSIST_RENEW_MS = 10_000

/** How long a volunteer carries a pair after an end last asked. Three
 *  renewals, so one or two lost signals never cost a working route. */
export const ASSIST_LEASE_MS = 30_000

/** The most tracks held unattributed at once. A volunteer offering m-lines
 *  nobody can place is not a reason to hold them all for ever. */
export const MAX_PARKED_TRACKS = 16

/**
 * How long the direct rung may sit checking candidates without connecting
 * before the next rung is tried.
 *
 * `DEFAULT_ROUTE_TIMEOUT_MS` starts when a negotiation does, so it has to
 * cover descriptions crossing a public relay before a single check runs.
 * Once ICE is checking the question is narrower and answered sooner: a
 * direct path that works connects well inside a second of the candidates
 * arriving, and one through a symmetric NAT never does. Measured in an
 * emulated NAT matrix, every direct pair connected 0.13 to 0.41 s after its
 * checks began, while every pair behind a symmetric NAT sat in `checking`
 * until the ten-second timer moved it to TURN, so a relayed call took over
 * eleven seconds to join.
 *
 * The clock starts when the connection reports `connecting`, which is when
 * checks begin, and starts again whenever a candidate crosses in either
 * direction: a late candidate is a path that has not been tried yet. Only
 * the direct rung has it. The route timeout still bounds the whole rung,
 * and nothing about the rungs or their order changes; this only stops a
 * pair that has already shown it cannot connect directly from waiting out
 * the rest of the ten seconds.
 */
export const DEFAULT_DIRECT_CHECK_TIMEOUT_MS = 3_000

/**
 * How long the TURN rung gets, which is longer than the others.
 *
 * It is the last rung, so nothing is waiting behind it; and it is the slow
 * one: the far end has to be told over a public relay, allocate on the TURN
 * server, and trickle relay candidates back over the relay again before a
 * single check can run. Measured on real relays that took five seconds on a
 * good day. Ten was the budget for every rung, and a TURN rung that timed
 * out was a pair declared unreachable that would have connected in the next
 * breath.
 */
export const DEFAULT_TURN_ROUTE_TIMEOUT_MS = 20_000

/**
 * How long a renegotiation on an already connected pair gets before the pair
 * is treated as stuck.
 *
 * The route ladder deliberately stops watching a pair the moment it connects:
 * its job is finding a rung that works, and one has. But a connected pair
 * renegotiates constantly - every camera toggle, every share, every mic
 * pipeline swap is an offer - and a renegotiation that loses its answer
 * leaves the connection up, carrying what it was already carrying, and blind
 * to whatever the offer was about. Nothing noticed, because nothing was
 * watching: measured on a fault-injecting relay, the others could not see
 * that person again for the rest of the call.
 *
 * Longer than several retransmissions of the offer, because the cheap repair
 * is the offer arriving on the second or third ask and this is only for when
 * it does not. What happens at the end of it is an ICE restart on the
 * connection that exists - never a replacement connection, see
 * `Peer.healStalledNegotiation`.
 */
export const DEFAULT_RENEGOTIATION_TIMEOUT_MS = 20_000

/**
 * The shortest gap between two retransmissions prompted by a rejected
 * publish.
 *
 * A relay that is rejecting is likely to reject the retry too, and the retry
 * is itself a publish: without a floor the rejection handler would call
 * itself for as long as the relay stayed unhappy.
 */
export const PUBLISH_RETRY_MIN_MS = 1_000

/**
 * How long a device whose every rung has failed is left alone before the
 * ladder is tried again from the top.
 *
 * Exhaustion used to be final: a pair that lost direct, assist, forwarder
 * and TURN in one bad minute - a phone crossing a dead spot, a laptop lid,
 * a router rebooting - stayed lost for the rest of the call, however long
 * that was, until one side left and rejoined. In a room meant to stay open
 * for days that is a tile that has gone blank for good. So a route that has
 * run out of rungs rests, then starts again at `direct` with a clean slate:
 * the volunteers it burned may be reachable again, and so may the device.
 * Long enough that a device that really has gone is not chased every few
 * seconds; short enough that the person watching does not give up first.
 */
export const EXHAUSTED_RETRY_MS = 30_000

/**
 * The longest rest between retries. Each retry that fails doubles the rest
 * from `EXHAUSTED_RETRY_MS` up to this, and a success resets it. A pair
 * that will never connect - a member with no WebRTC stack at all, which an
 * agent that only reads the chat is - would otherwise be re-negotiated
 * every thirty seconds for as long as the two shared a room, which in a
 * standing room is for ever.
 */
export const MAX_EXHAUSTED_RETRY_MS = 10 * 60_000

/**
 * How many signals may wait for a peer that does not exist yet, per device
 * and across all of them. See `#holdSignal`.
 *
 * Generous per device, because what waits is an offer and the candidates
 * trickling behind it, and mean across them: the devices this ever holds
 * anything for are the ones the roster is about to name, and a room with
 * more than a few of those at once is a room being flooded rather than
 * joined.
 */
export const MAX_HELD_SIGNALS_PER_DEVICE = 32

/** How many replaced far-end sessions are remembered per endpoint. A far end
 *  rebuilds its connection a handful of times in a bad call, not hundreds. */
export const MAX_RETIRED_REMOTE_SESSIONS = 8
export const MAX_HELD_SIGNAL_DEVICES = 16

/**
 * One `Peer` per remote device, kept in step with the roster.
 *
 * Other devices belonging to our participant also receive media, so each
 * device can show our other cameras. Playback suppresses their audio to
 * avoid feedback; only this exact device is excluded from the mesh.
 *
 * A remote track is always reported against the device's *participant*,
 * never the device itself: two devices of one remote person yield two peer
 * connections but must read as one person in attribution, which is the
 * entire product.
 */
/**
 * Bytes a receiver reports having received, summed over its `inbound-rtp`
 * entries. Undefined when it cannot report, which is not the same as zero.
 */
async function bytesReceived(receiver: unknown): Promise<number | undefined> {
  const getStats = (receiver as { getStats?: () => Promise<{ forEach(cb: (value: Record<string, unknown>) => void): void }> } | undefined)?.getStats
  if (typeof getStats !== 'function') return undefined
  try {
    const report = await getStats.call(receiver)
    let total = 0
    let seen = false
    report.forEach((stat) => {
      if (stat.type !== 'inbound-rtp') return
      seen = true
      total += Number(stat.bytesReceived) || 0
    })
    return seen ? total : 0
  } catch {
    return undefined
  }
}

export class Mesh {
  readonly #opts: MeshOptions
  readonly #peers = new Map<string, NegotiatingPeer>()
  /** A camera rung pass is already waiting. See `#rebalanceCamera`. */
  #rebalanceQueued = false
  /**
   * The page session each open peer was built for - see `RosterEntry.sid`.
   *
   * A connection is to a page session, not to a device key. Two tabs of one
   * browser sign as the same device, so a second tab taking over a call
   * used to collide with the first tab's still-open connection under the
   * identical key: the endpoint looked unchanged, the peer was reused, and
   * the pair waited out the route ladder while a live person was audible to
   * nobody. A changed `sid` is a physically different endpoint that cannot
   * take over a transport it was never party to, so the peer is closed and
   * rebuilt at once rather than waited out.
   */
  readonly #peerSids = new Map<string, string>()
  /** The page session the roster currently names for each device. */
  readonly #deviceSids = new Map<string, string>()
  /** The call signalling profile each device's roster entry claims. See
   *  `RosterEntry.callProfile`; absent means profile 1. */
  readonly #deviceProfiles = new Map<string, number>()
  /**
   * Devices whose roster entry claims profile 2 but whose signalling says
   * otherwise - a far end that reloaded into an old build mid-call (§2.3).
   * Held for the life of the room rather than the roster snapshot, because
   * the roster entry that lied will keep arriving and would otherwise flip
   * the pair back on every heartbeat.
   */
  readonly #downgraded = new Set<string>()
  /**
   * Devices a signature-valid signal carrying `gen` has arrived from.
   *
   * §2.3's second half of the capability rule, and it exists for one window:
   * a far end that has just reloaded into a profile-2 build is speaking it
   * before its roster entry says so, and its offer would otherwise be
   * answered by a profile-1 peer that cannot read `slots`. Evidence is
   * weaker than the roster entry only in that `#downgraded` beats it, which
   * is what stops a pair flapping between the two profiles.
   */
  readonly #profile2Evidence = new Set<string>()
  /**
   * The per-pair controller for each profile-2 pair - §3.4's replacement for
   * the route and exhausted-retry timers on the `direct` and `turn` rungs.
   *
   * Keyed by device rather than by endpoint and held for the life of the
   * pair rather than of any one connection, because carrying the rest
   * ladder's position across a rebuild is the whole reason it is not simply
   * part of `SlotPeer`.
   */
  readonly #controllers = new Map<string, PairController>()
  /** Another page session of this device is speaking for it. See
   *  `standDown`. */
  #quiet = false
  /** Every other admitted room device, including another device belonging
   *  to our own participant. Room signalling such as screen annotations
   *  reaches these devices even before their media connects. */
  readonly #annotationDevices = new Map<string, string>()
  readonly #deviceToParticipant = new Map<string, string>()
  /** Track id -> the device the roster says publishes it. The only
   *  attribution available for a track that arrives over a forwarder, since
   *  every one of them arrives on the same connection. */
  readonly #trackOwner = new Map<string, string>()
  readonly #trackListeners = new Set<(t: RemoteTrack) => void>()
  readonly #retiringPeers = new Map<string, { peer: Peer; tracks: RemoteTrack[]; timer: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout> }>()
  readonly #annotationListeners = new Set<(annotation: RemoteAnnotation) => void>()
  readonly #relayTestListeners = new Set<(message: RemoteRelayTest) => void>()
  /** Staleness, deduplication and rate limiting - the three rules §3 of the
   *  design says signalling reuses from NIP-AC. */
  readonly #guard = new SignalGuard()
  readonly #annotationGuard = new SignalGuard(480)
  /** Relay tests have a budget of their own, far below a call's, so a test
   *  can neither starve the call nor be used to keep a device busy. */
  readonly #relayTestGuard = new SignalGuard(RELAY_TEST_SIGNALS_PER_WINDOW)
  readonly #now: () => number
  #tracks: MediaStreamTrack[] = []
  /** Who the tracks are for. Absent means everybody. See `publish`. */
  #audience?: (participant: ParticipantView) => boolean
  /** The roster as last reconciled, so `#tracksFor` can ask about a
   *  participant without a round trip through the session. */
  #views: ParticipantView[] = []
  readonly #unsubSession: () => void
  readonly #unsubSignal: () => void
  #closed = false

  /** How each remote device is currently reached, and what has been tried. */
  readonly #routes = new Map<string, Route>()
  /** Assist offers on the roster right now, by volunteering device. */
  readonly #volunteers = new Map<string, AssistOffer>()
  /** As a volunteer: one end has asked and the other has not yet, by pair
   *  key. See `ASSIST_HOLD_MS`. */
  readonly #pendingAsks = new Map<string, { a: string; b: string; asked: Set<string>; timer: ReturnType<typeof setTimeout> }>()
  /** As a volunteer: what each directly connected device is sending this
   *  one, by track id. These are what a carried leg taps. */
  readonly #endpointMedia = new Map<string, Map<string, { track: MediaStreamTrack; receiver: unknown }>>()
  /** The role the roster says each advertised track id plays. */
  readonly #trackRoles = new Map<string, TrackRole>()
  /** As a volunteer: every leg being carried, by pair, source and role. */
  readonly #legs = new Map<string, CarriedLeg>()
  /** As one end of a pair: the `carry` map from each volunteer's latest
   *  offer. */
  readonly #carryIn = new Map<string, Record<string, CarryEntry>>()
  /** As one end of a pair: every device this one has asked to be carried,
   *  and what has arrived. */
  readonly #assisted = new Map<string, AssistState>()
  /** As a volunteer: the pairs this mesh admitted. The relay registry is
   *  shared with any other room session of this app, and this mesh answers
   *  only for its own. */
  readonly #ownPairs = new Set<string>()
  /** As a volunteer: when each end of each pair last asked. See
   *  `ASSIST_LEASE_MS`. */
  readonly #leases = new Map<string, Map<string, number>>()
  #leaseSweep?: ReturnType<typeof setInterval>
  /** As a volunteer: legs the pipeline refused, by leg id, with the source
   *  track refused. Not retried until that source changes. */
  readonly #refusedLegs = new Map<string, MediaStreamTrack>()
  /** As one end: tracks that arrived on a volunteer's connection and could
   *  not be attributed yet - the roster or the `carry` map may still be on
   *  its way. Re-checked on every reconcile. */
  #parked: Array<{ endpoint: string; track: MediaStreamTrack; receiver: unknown; mid?: string }> = []
  /** When each unexpected carry was last answered with a release, so a
   *  volunteer re-offering is not answered on every offer. */
  readonly #releasedAt = new Map<string, number>()
  /** Signals that arrived for a device this mesh has no peer for yet, by
   *  sending device, oldest first. See `#holdSignal`. */
  readonly #pendingSignals = new Map<string, { body: SignalBody; createdAt: number }[]>()
  /** One timer per endpoint, bounding how long a rung gets. */
  readonly #routeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** One timer per endpoint whose direct rung is checking candidates. See
   *  `DEFAULT_DIRECT_CHECK_TIMEOUT_MS`. */
  readonly #checkTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** One timer per exhausted device, after which its ladder is retried. */
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** One timer per endpoint with a negotiation outstanding on a connection
   *  that is already up. The route timers deliberately stop at `connected`;
   *  this is what watches what happens after. See
   *  `DEFAULT_RENEGOTIATION_TIMEOUT_MS`. */
  readonly #renegotiationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** When each device last had a retransmission forced by a rejected
   *  publish. See `PUBLISH_RETRY_MIN_MS`. */
  readonly #publishRetryAt = new Map<string, number>()
  /** Endpoints being closed deliberately, so their own `closed` state change
   *  is not mistaken for the rung failing. Same guard as
   *  `#tearingDownForwarder`, for the same reason. */
  readonly #closingEndpoints = new Set<string>()
  /** Far-end session ids each endpoint has moved on from - see
   *  `#replaceForRemoteSession`. A late copy of an offer from one of them is
   *  a connection the far end has already closed, and must not cost a second
   *  rebuild. Bounded by `MAX_RETIRED_REMOTE_SESSIONS`. */
  readonly #retiredRemoteSessions = new Map<string, Set<string>>()
  /** A delayed reply to a closed connection must not match the replacement's
   * first offer. Profile 1 correlates replies with this optional wire seq. */
  readonly #legacyOfferSequences = new Map<string, number>()

  #forwarders: ForwarderRef[]
  #forwarding: ForwardingState = 'off'
  #forwarderPeer?: Peer
  #forwarderDevice?: string
  #forwarderTimer?: ReturnType<typeof setTimeout>
  /** Forwarders that have already failed this session, so the room does not
   *  spend the call cycling through one that is not there. */
  readonly #failedForwarders = new Set<string>()
  /** Set while we are deliberately tearing the forwarder peer down, so its
   *  own `closed` state change is not mistaken for the forwarder dropping. */
  #tearingDownForwarder = false

  constructor(opts: MeshOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#forwarders = opts.forwarders ?? []

    this.#unsubSignal = opts.transport.subscribe(
      [{ kinds: [KINDS.SIGNAL_WRAP], '#p': [opts.localDevice] }],
      (event) => this.#onSignalEvent(event),
    )

    // The pumps' worker has to be running before the first remote track
    // arrives, so that track can be tapped in time - see `#ownTrack`.
    if (opts.relay) {
      try {
        opts.relayMedia?.warm?.()
      } catch {
        // No pumps: this device will refuse to carry, as it would anyway.
      }
    }
    this.#unsubSession = opts.session.onChange((views) => this.#reconcile(views))
    this.#reconcile(opts.session.participants())
  }

  /** Whether this room is routing through a forwarder. See `ForwardingState`. */
  get forwarding(): ForwardingState {
    return this.#forwarding
  }

  /** The forwarder currently being used or attempted, if any. */
  get forwarderDevice(): string | undefined {
    return this.#forwarderDevice
  }

  /** How many direct peer connections are open. Zero while a forwarder is
   *  carrying the room; back to one per remote device the moment it is not. */
  get directPeers(): number {
    return this.#peers.size
  }

  /** How each remote device is currently being reached. What a UI reads to
   *  say who is direct, who is being carried by whom, and who could not be
   *  reached at all. */
  get routes(): Map<string, RouteView> {
    const view = new Map<string, RouteView>()
    for (const [device, route] of this.#routes) {
      view.set(device, { tier: route.tier, endpoint: route.endpoint, connected: route.connected, exhausted: route.exhausted })
    }
    return view
  }

  /** What this device is carrying for other people, if it volunteered. */
  get relaying(): number {
    return this.#opts.relay?.relaying ?? 0
  }

  /**
   * Stop being this device on the wire: close every connection, open none,
   * and answer nothing addressed to this device key.
   *
   * For the one case where a device key is not one endpoint: another page
   * session of this browser, in this room, is on the call. Both tabs sign
   * as the same device, so both unwrap and both can answer the same offer,
   * and the far end has exactly one connection per device key to give. The
   * tab that is only looking wins that race often enough to matter, and
   * when it does it answers with a connection carrying no media at all: the
   * others reach "Ada", hear silence, and their ladder walks itself to TURN
   * against a tab that has nothing to send, while the tab the person is
   * actually talking into cannot get a connection of its own.
   *
   * So the quiet tab goes quiet on signalling too, not only on presence.
   * See `RoomSession.pausePresence`, which is the same fact said about the
   * roster, and `RosterEntry.sid`, which is how everybody else tells the
   * two page sessions apart.
   */
  standDown(): void {
    if (this.#quiet) return
    this.#quiet = true
    this.#teardownForwarder()
    this.#reconcile(this.#opts.session.participants())
  }

  /** This page session speaks for the device again: rebuild the mesh from
   *  the roster as it stands. Safe to call when it never stood down. */
  standUp(): void {
    if (!this.#quiet) return
    this.#quiet = false
    this.#reconcile(this.#opts.session.participants())
  }

  /**
   * Replace the forwarder list, as a new room descriptor names it.
   *
   * A list that names a forwarder this session has not already failed is a
   * fresh chance: a room whose operator has just stood up a replacement must
   * be able to use it without everybody rejoining.
   */
  setForwarders(refs: ForwarderRef[]): void {
    if (this.#closed) return
    this.#forwarders = refs
    this.#reconcile(this.#opts.session.participants())
  }

  /** Publish tracks to every current peer - or to the forwarder, when one is
   *  carrying the room. Own devices never receive them, because they never
   *  have a peer connection in the first place. */
  publish(tracks: MediaStreamTrack[], audience?: (participant: ParticipantView) => boolean): void {
    this.#tracks = tracks
    this.#audience = audience
    // A narrowed audience takes back the consent an earlier request gave: a
    // volunteer must not go on passing this device's media to somebody it
    // has just stopped sending to.
    for (const device of [...this.#assisted.keys()]) {
      if (!this.#mayAsk(device)) this.#assistFailed(device, 'this device no longer sends to them')
    }
    // Both of those feed the promotion decision - what this device is being
    // asked to send, and whether it is keeping any of it from somebody - and
    // the decision used to be taken only when the roster moved. A camera
    // turned on in a room that then needed a forwarder waited for the next
    // arrival, and a switch turned on while a forwarder was carrying the
    // room did not come back down at all. Reconciling here asks the whole
    // question again, and it is the same question `#reconcile` answers on
    // every roster change.
    this.#reconcile(this.#opts.session.participants())
    for (const [endpoint, peer] of this.#peers) {
      peer.start(this.#tracksFor(endpoint)).catch(() => {})
      // A connection that was idle because nobody had anything to send now
      // has something, and its rung gets its budget from here.
      this.#armRouteTimerIfNeeded(endpoint)
    }
    // Never narrowed: a forwarder cannot skip anybody, which is why a device
    // that narrows never promotes at all - see `#audienceNarrows`.
    this.#forwarderPeer?.start(tracks).catch(() => this.#forwarderFailed())
    this.#rebalanceCamera()
  }

  /**
   * Step this device's camera down for the number of connections that
   * carry it: see `cameraRungFor`. Run whenever a peer is added, replaced
   * or dropped and whenever the published set or its audience changes. One
   * recipient (a one-to-one call) and none (camera off, or a forwarder
   * carrying the room) mean the browser's defaults; each peer ignores a
   * rung it already has, so a repeat costs nothing.
   *
   * Coalesced into one pass per turn of the event loop: a join opens every
   * connection in one reconcile, and the rung should be worked out once
   * from the final count rather than once per connection on the way there.
   */
  #rebalanceCamera(): void {
    if (this.#rebalanceQueued) return
    this.#rebalanceQueued = true
    queueMicrotask(() => {
      this.#rebalanceQueued = false
      this.#applyCameraRung()
    })
  }

  #applyCameraRung(): void {
    if (this.#closed) return
    let recipients = 0
    for (const endpoint of this.#peers.keys()) {
      if (this.#tracksFor(endpoint).some((track) => track.kind === 'video' && track.contentHint !== 'detail')) recipients++
    }
    const rung = cameraRungFor(recipients)
    for (const peer of this.#peers.values()) peer.setCameraRung?.(rung)
  }

  /**
   * The tracks this endpoint is sent: everything, unless the caller named
   * an audience and the participant behind this endpoint is not in it.
   *
   * Judged per endpoint rather than per publish, so a participant who
   * arrives after `publish` was called is judged by the same rule on the
   * connection opened for them, and one the rule refuses gets an empty
   * list - which `Peer.start` turns into removed senders, not silent ones.
   */
  #tracksFor(endpoint: string): MediaStreamTrack[] {
    if (!this.#audience) return this.#tracks
    const participant = this.#deviceToParticipant.get(endpoint)
    const view = this.#views.find((v) => v.participant === participant)
    if (!view) return []
    try {
      return this.#audience(view) ? this.#tracks : []
    } catch {
      // A rule that throws has not said yes.
      return []
    }
  }

  onRemoteTrack(cb: (t: RemoteTrack) => void): () => void {
    this.#trackListeners.add(cb)
    return () => this.#trackListeners.delete(cb)
  }

  /** Send transient markup to every other device in the room. The existing
   * signal wrap supplies membership checks, encryption, staleness and dedup. */
  publishAnnotation(annotation: ScreenAnnotation): void {
    if (this.#closed) return
    for (const device of this.#annotationDevices.keys()) {
      this.#send(device, { type: 'annotation', annotation })
    }
  }

  onAnnotation(cb: (annotation: RemoteAnnotation) => void): () => void {
    this.#annotationListeners.add(cb)
    return () => this.#annotationListeners.delete(cb)
  }

  /** Send one relay outside test message to one other admitted room device.
   *  False, and nothing sent, when that device is not in the roster. */
  sendRelayTest(device: string, message: { type: 'relay-test'; relayTest: RelayTestRequest } | { type: 'relay-test-result'; relayTest: RelayTestResult }): boolean {
    const to = normaliseHex(device)
    if (this.#closed || !this.#annotationDevices.has(to)) return false
    this.#send(to, { type: message.type, relayTest: message.relayTest })
    return true
  }

  onRelayTest(cb: (message: RemoteRelayTest) => void): () => void {
    this.#relayTestListeners.add(cb)
    return () => this.#relayTestListeners.delete(cb)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubSession()
    this.#unsubSignal()
    this.#teardownForwarder()
    for (const endpoint of [...this.#routeTimers.keys()]) this.#clearRouteTimer(endpoint)
    for (const endpoint of [...this.#checkTimers.keys()]) this.#clearCheckTimer(endpoint)
    for (const endpoint of [...this.#renegotiationTimers.keys()]) this.#clearRenegotiationTimer(endpoint)
    for (const device of [...this.#retryTimers.keys()]) this.#clearRetryTimer(device)
    this.#publishRetryAt.clear()
    for (const pending of this.#pendingAsks.values()) clearTimeout(pending.timer)
    this.#pendingAsks.clear()
    for (const id of [...this.#legs.keys()]) this.#closeLeg(id)
    for (const device of [...this.#assisted.keys()]) this.#leaveAssist(device, false)
    this.#endpointMedia.clear()
    this.#carryIn.clear()
    this.#parked = []
    // Only this mesh's own pairs. The registry may be shared with another
    // room session - a docked call - whose pairs are not this mesh's to end,
    // and closing it would drop them with nobody told.
    for (const pair of this.#ownPairList()) this.#endPair(pair, [], 'this room closed')
    this.#stopLeaseSweep()
    this.#routes.clear()
    this.#volunteers.clear()
    this.#pendingSignals.clear()
    for (const peer of this.#peers.values()) peer.close()
    for (const endpoint of [...this.#retiringPeers.keys()]) this.#closeRetiringPeer(endpoint)
    this.#peers.clear()
    this.#peerSids.clear()
    this.#retiredRemoteSessions.clear()
    this.#legacyOfferSequences.clear()
    this.#deviceProfiles.clear()
    this.#downgraded.clear()
    this.#profile2Evidence.clear()
    for (const controller of this.#controllers.values()) controller.close()
    this.#controllers.clear()
    this.#annotationDevices.clear()
    this.#deviceToParticipant.clear()
    this.#trackOwner.clear()
    this.#trackListeners.clear()
    this.#annotationListeners.clear()
    this.#relayTestListeners.clear()
    try {
      this.#opts.forwarderMediaPipeline?.close?.()
    } catch {
      // A browser worker that is already gone is not a reason to leave the
      // room's relay subscriptions or peer connections alive.
    }
    try {
      this.#opts.relayMedia?.close?.()
    } catch {
      // As above.
    }
  }

  /** Reconcile the peer set against a roster snapshot: close peers for
   *  devices no longer present, open peers for newly-seen remote devices,
   *  including our other devices, but never this device itself. */
  #reconcile(views: ParticipantView[]): void {
    if (this.#closed) return

    this.#views = views
    const callDevices = this.#opts.callDevices?.(views)
    const wantedDevices = new Map<string, string>() // device -> participant
    const annotationDevices = new Map<string, string>() // every other admitted room device
    this.#trackOwner.clear()
    this.#trackRoles.clear()
    this.#deviceSids.clear()
    this.#deviceProfiles.clear()
    for (const view of views) {
      for (const [device, sid] of Object.entries(view.sids ?? {})) this.#deviceSids.set(device, sid)
      for (const [device, profile] of Object.entries(view.callProfiles ?? {})) this.#deviceProfiles.set(device, profile)
      for (const device of view.devices) {
        if (device !== this.#opts.localDevice) annotationDevices.set(device, view.participant)
      }
      for (const device of view.devices) {
        // Belt and braces: a malformed roster claiming our device under
        // someone else's participant must not talk us into a peer to
        // ourselves either.
        if (device === this.#opts.localDevice) continue
        if (callDevices && !callDevices.has(device)) continue
        wantedDevices.set(device, view.participant)
      }
      // Track adverts are kept for every remote device whether or not it has
      // a direct peer, because when a forwarder is carrying the room none of
      // them do and this map is the only attribution there is.
      for (const advert of view.tracks) {
        if (advert.device === this.#opts.localDevice) continue
        this.#trackOwner.set(advert.trackId, advert.device)
        this.#trackRoles.set(advert.trackId, advert.role)
      }
    }

    // The roster is the whole answer to who is here, so this map tracks it
    // rather than the peer set - a forwarded track's device has to resolve to
    // a participant even though it has no direct peer.
    this.#annotationDevices.clear()
    for (const [device, participant] of annotationDevices) this.#annotationDevices.set(device, participant)
    this.#deviceToParticipant.clear()
    for (const [device, participant] of wantedDevices) this.#deviceToParticipant.set(device, participant)

    this.#collectVolunteers(views)
    this.#reconcileRoutes(wantedDevices)

    // Decided before any peer is opened or closed, because the answer governs
    // both. `wantedDevices.size` is the `(N-1)` in `(N-1) x bitrate`: the
    // devices this one would have to send its own media to.
    // Never while stood down: a tab that is carrying nothing must not go
    // looking for a forwarder to carry it.
    if (!this.#quiet) this.#evaluatePromotion(wantedDevices.size)

    // A tab that has stood down holds no connections and opens none: the
    // empty endpoint set below closes what it had, and the early return
    // after it stops anything being opened. See `standDown`.
    const direct = this.#forwarding !== 'up' && !this.#quiet

    // The endpoints, not the devices. Usually the same set: most people are
    // reached at their own address. A device being carried by a volunteer is
    // reached at the volunteer's, and one on the forwarder rung or out of
    // rungs is not reached at all, so neither contributes an endpoint.
    const endpoints = new Set<string>()
    if (direct) {
      for (const route of this.#routes.values()) {
        if (route.tier === 'forwarder' || route.exhausted) continue
        endpoints.add(route.endpoint)
      }
    }

    for (const [endpoint, retiring] of this.#retiringPeers) {
      if (!endpoints.has(endpoint)) this.#closeRetiringPeer(endpoint)
      else void retiring.peer.start(this.#tracksFor(endpoint))
    }
    for (const [endpoint, peer] of [...this.#peers]) {
      // Not the endpoint we built this for any more, even though the key is
      // the same one: another page session of that device is answering now,
      // and it has no way to take over a transport it was never party to.
      // Closed here rather than left to the route ladder, because the
      // ladder's own timers are what made this cost half a minute.
      const swapped = endpoints.has(endpoint) && this.#sessionChanged(endpoint)
      if (endpoints.has(endpoint) && !swapped) continue
      this.#closePeer(endpoint, peer)
      // The rung did not fail - there is nothing wrong with this route - so
      // it keeps its tier and its budget. What it loses is the claim to be
      // connected, which was true of a connection that no longer exists and
      // which would otherwise stop the rebuilt one from being given a
      // watchdog at all.
      if (!swapped) continue
      for (const [device, route] of this.#routes) {
        if (route.endpoint !== endpoint || !route.connected) continue
        route.connected = false
        this.#announceRoute(device, route)
      }
    }

    // Nothing is negotiating, so nothing is connected: a route left saying
    // it was would deny the rebuilt connection a watchdog when this page
    // session speaks for the device again.
    if (this.#quiet) {
      for (const [device, route] of this.#routes) {
        if (!route.connected) continue
        route.connected = false
        this.#announceRoute(device, route)
      }
    }

    if (!direct) {
      this.#syncCarry()
      return
    }

    for (const endpoint of endpoints) {
      if (this.#peers.has(endpoint)) {
        // Already open, and perhaps only now with something to carry: a
        // camera turned on at one end or the other. The rung gets its
        // budget from that moment, not from when the idle connection was
        // made.
        this.#armRouteTimerIfNeeded(endpoint)
        continue
      }
      const peer = this.#createEndpointPeer(endpoint)
      this.#peers.set(endpoint, peer)
      this.#rebalanceCamera()
      const sid = this.#deviceSids.get(endpoint)
      if (sid === undefined) this.#peerSids.delete(endpoint)
      else this.#peerSids.set(endpoint, sid)
      this.#armRouteTimerIfNeeded(endpoint)
      peer.start(this.#tracksFor(endpoint)).catch(() => {})
      // After `start`, never before: the offer waiting here is answered by
      // the peer, and the answer has to carry our own tracks. Both are
      // queued on the peer, so this ordering is what puts them in it.
      this.#drainSignals(endpoint, peer)
    }

    // What this device carries for others follows the roster and the peer
    // set, which have both just moved; so does when a carried route of our
    // own is owed its first media.
    this.#syncCarry()
    this.#armAssistTimersForMedia()
    this.#recheckParked()
  }

  /**
   * Whether this side is about to negotiate with this endpoint: it has
   * tracks the endpoint is due, so it will offer.
   *
   * A pair with nothing to carry never negotiates - neither side offers,
   * because an offer with no media in it negotiates nothing - and so never
   * connects, and used to be treated as a rung that failed. Two people with
   * their cameras off, or a person and an agent that is here to read the
   * chat, walked the whole ladder to TURN and were declared unreachable,
   * every thirty seconds, for as long as they were in the room together.
   * The connection is kept - it costs nothing idle, and it is where the
   * media will go the moment either side has some - but the clock on it
   * does not start until a negotiation does: when this side has something
   * to send, here, or when the far end's offer arrives, in
   * `#onSignalEvent`. What the far end ADVERTISES is deliberately not
   * enough: it may be advertising a camera it is not sending to us - an
   * agent it has chosen not to be heard by - and a clock started on that
   * walked the agent's ladder to exhaustion, so that the person's real
   * offer, when it came, arrived into the churn.
   */
  #needsMedia(endpoint: string): boolean {
    return this.#tracksFor(endpoint).length > 0
  }

  #armRouteTimerIfNeeded(endpoint: string): void {
    if (this.#routeTimers.has(endpoint)) return
    // A profile-2 pair is watched by its controller, which judges the pair on
    // whether media is arriving rather than on a stopwatch started when the
    // connection was opened. Two watchdogs on one pair would race to decide
    // what to do about it, and the loser's decision would be a teardown.
    if (this.#controlled(endpoint)) return
    if (this.#routes.get(endpoint)?.connected) return
    if (!this.#needsMedia(endpoint)) return
    this.#armRouteTimer(endpoint)
  }

  /** The far end has offered: a negotiation is under way, whatever this
   *  side has to send, and the rung gets its budget from here. */
  #armRouteTimerForOffer(endpoint: string): void {
    if (this.#routeTimers.has(endpoint)) return
    if (this.#controlled(endpoint)) return
    if (!this.#peers.has(endpoint)) return
    if (this.#routes.get(endpoint)?.connected) return
    this.#armRouteTimer(endpoint)
  }

  /** Every assist offer currently on the roster, minus our own participant's
   *  devices - we never open a media connection to those, so one of them
   *  volunteering could not carry anything for us. */
  #collectVolunteers(views: ParticipantView[]): void {
    this.#volunteers.clear()
    if (this.#opts.assist?.() === false) return
    for (const view of views) {
      if (view.participant === this.#opts.localParticipant) continue
      for (const advert of view.assist ?? []) {
        const device = normaliseHex(advert.device)
        if (device === this.#opts.localDevice) continue
        this.#volunteers.set(device, advert)
      }
    }
  }

  /** Keep one route per remote device, and drop a volunteer that has gone. */
  #reconcileRoutes(wantedDevices: Map<string, string>): void {
    for (const device of [...this.#routes.keys()]) {
      if (!wantedDevices.has(device)) {
        // Asked somebody to carry them, perhaps: that is over, and the
        // volunteer is told so it can give the slot to somebody else.
        this.#leaveAssist(device, true)
        this.#routes.delete(device)
        this.#clearRetryTimer(device)
        // The pair itself has gone, which is the one thing that ends a
        // profile-2 pair's controller: §3.4's "while both devices are in the
        // roster" is exactly this check.
        this.#controllers.get(device)?.close()
        this.#controllers.delete(device)
        this.#profile2Evidence.delete(device)
        this.#retiredRemoteSessions.delete(device)
        // We may have been carrying this device for somebody. Holding the
        // slot open would cost a slot we could give somebody else.
        this.#stopRelayingFor(device)
      }
    }

    for (const device of wantedDevices.keys()) {
      if (this.#routes.has(device)) continue
      this.#routes.set(device, { tier: this.#opts.initialTier ?? 'direct', endpoint: device, connected: false, exhausted: false, failed: [], retries: 0 })
    }

    // A volunteer who closed their laptop mid-sentence is the normal case,
    // not the edge case. It shows up here first, as an offer that has left
    // the roster, and it must cost the people they were carrying one rung
    // rather than their place in the room.
    for (const [device, route] of [...this.#routes]) {
      if (route.tier !== 'assist') continue
      if (wantedDevices.has(route.endpoint) && this.#volunteers.has(route.endpoint)) continue
      this.#escalate(device)
    }
  }

  /** The rung a connection to this endpoint is being opened on. An endpoint
   *  is always a room device, so its own route says which. */
  #tierOfEndpoint(endpoint: string): RouteTier {
    return this.#routes.get(endpoint)?.tier === 'turn' ? 'turn' : 'direct'
  }

  /**
   * Whether the page session behind this endpoint is not the one its open
   * peer was built for.
   *
   * Only a swap between two *named* page sessions counts. A far end that
   * has never published one, and one that publishes for the first time
   * mid-room, both read as "no news": rebuilding a working connection on
   * that would churn every pair the first time a peer upgraded.
   */
  #sessionChanged(endpoint: string): boolean {
    const built = this.#peerSids.get(endpoint)
    const current = this.#deviceSids.get(endpoint)
    return built !== undefined && current !== undefined && built !== current
  }

  #closePeer(endpoint: string, peer: NegotiatingPeer, retainMedia = false): void {
    const held = this.#retiringPeers.get(endpoint)
    if (!retainMedia) this.#closeRetiringPeer(endpoint)
    else if (held) {
      // Another repair may supersede a replacement still negotiating. Keep
      // the original connected transport and deadline, never another one.
      held.tracks = []
      if (held.settle !== undefined) clearTimeout(held.settle)
      held.settle = undefined
    }
    this.#peers.delete(endpoint)
    this.#rebalanceCamera()
    this.#peerSids.delete(endpoint)
    // Detached, not closed: the controller outlives any one connection, and
    // a rebuild's peer is attached to the same one a moment later.
    if (this.#controllers.get(endpoint)?.peer === peer) this.#controllers.get(endpoint)!.detach()
    this.#clearRouteTimer(endpoint)
    this.#clearCheckTimer(endpoint)
    this.#clearRenegotiationTimer(endpoint)
    this.#publishRetryAt.delete(endpoint)
    // Its receivers and m-lines went with it: nothing carried can be tapped
    // from it or attributed through it any more.
    this.#endpointMedia.delete(endpoint)
    this.#carryIn.delete(endpoint)
    this.#parked = this.#parked.filter((held) => held.endpoint !== endpoint)
    for (const [device, state] of this.#assisted) {
      if (state.volunteer !== endpoint) continue
      this.#endAssistTracks(state)
      const route = this.#routes.get(device)
      if (route?.connected) {
        route.connected = false
        this.#announceRoute(device, route)
      }
      // Owed its media again on the rebuilt connection - if there is any.
      if (state.accepted && state.timer === undefined && this.#advertises(device)) this.#armAssistTimer(device)
    }
    this.#closingEndpoints.add(endpoint)
    try {
      if (retainMedia && !held && peer instanceof Peer && peer.retire()) {
        const timer = setTimeout(() => this.#closeRetiringPeer(endpoint, true), 20_000)
        ;(timer as unknown as { unref?: () => void }).unref?.()
        this.#retiringPeers.set(endpoint, { peer, tracks: [], timer })
      } else peer.close()
    } finally {
      this.#closingEndpoints.delete(endpoint)
    }
  }

  #closeRetiringPeer(endpoint: string, flush = false): void {
    const retiring = this.#retiringPeers.get(endpoint)
    if (!retiring) return
    this.#retiringPeers.delete(endpoint)
    clearTimeout(retiring.timer)
    if (retiring.settle !== undefined) clearTimeout(retiring.settle)
    retiring.peer.close()
    if (flush && !this.#closed && this.#peers.has(endpoint)) {
      for (const remote of retiring.tracks) for (const listener of this.#trackListeners) listener(remote)
    }
  }

  #armRouteTimer(endpoint: string): void {
    this.#clearRouteTimer(endpoint)
    const timeout =
      this.#routes.get(endpoint)?.tier === 'turn'
        ? (this.#opts.turnRouteTimeoutMs ?? DEFAULT_TURN_ROUTE_TIMEOUT_MS)
        : (this.#opts.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS)
    const timer = setTimeout(() => {
      this.#routeTimers.delete(endpoint)
      this.#endpointFailed(endpoint)
    }, timeout)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.#routeTimers.set(endpoint, timer)
  }

  #clearRouteTimer(endpoint: string): void {
    const timer = this.#routeTimers.get(endpoint)
    if (timer !== undefined) clearTimeout(timer)
    this.#routeTimers.delete(endpoint)
  }

  /**
   * The direct rung's connection has started checking candidates: give the
   * checks `DEFAULT_DIRECT_CHECK_TIMEOUT_MS` to find a path, and start that
   * clock again if it is already running.
   *
   * Only for a pair reached directly and not yet connected. Assist and the
   * forwarder are reached through somebody else; TURN has its own, longer
   * budget; a profile-2 pair has its controller.
   */
  #armCheckTimer(endpoint: string): void {
    const route = this.#routes.get(endpoint)
    if (!route || route.tier !== 'direct' || route.endpoint !== endpoint || route.connected) return
    if (this.#controlled(endpoint) || !this.#peers.has(endpoint)) return
    this.#clearCheckTimer(endpoint)
    const timer = setTimeout(() => {
      this.#checkTimers.delete(endpoint)
      this.#endpointFailed(endpoint)
    }, this.#opts.directCheckTimeoutMs ?? DEFAULT_DIRECT_CHECK_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.#checkTimers.set(endpoint, timer)
  }

  /** A candidate crossed, either way: one more path for the checks to try,
   *  so the direct rung's checking clock starts again. */
  #candidateCrossed(endpoint: string): void {
    if (this.#checkTimers.has(endpoint)) this.#armCheckTimer(endpoint)
  }

  #clearCheckTimer(endpoint: string): void {
    const timer = this.#checkTimers.get(endpoint)
    if (timer !== undefined) clearTimeout(timer)
    this.#checkTimers.delete(endpoint)
  }

  /**
   * A negotiation has started on a pair that is already carrying media.
   *
   * Only for a connected pair: everything before that belongs to the route
   * ladder, which is watching already, and two watchdogs on one negotiation
   * would race to decide what to do about it.
   */
  #armRenegotiationTimer(endpoint: string): void {
    if (this.#closed) return
    if (this.#renegotiationTimers.has(endpoint)) return
    if (!this.#peers.has(endpoint)) return
    if (!this.#routes.get(endpoint)?.connected) return
    const timer = setTimeout(() => {
      this.#renegotiationTimers.delete(endpoint)
      this.#renegotiationStalled(endpoint)
    }, this.#opts.renegotiationTimeoutMs ?? DEFAULT_RENEGOTIATION_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.#renegotiationTimers.set(endpoint, timer)
  }

  #clearRenegotiationTimer(endpoint: string): void {
    const timer = this.#renegotiationTimers.get(endpoint)
    if (timer !== undefined) clearTimeout(timer)
    this.#renegotiationTimers.delete(endpoint)
  }

  /**
   * A renegotiation on a connected pair never got its answer.
   *
   * The pair is not torn down and no new connection is made. A far end on the
   * old profile would be handed a fresh connection's m-line order to apply to
   * a session it already has, reject it, and be left worse off than the wedge
   * - which is the whole reason the healing step here is an ICE restart on
   * the connection that exists. A genuine rebuild waits for the connection
   * itself to report `failed`.
   */
  #renegotiationStalled(endpoint: string): void {
    if (this.#closed) return
    const peer = this.#peers.get(endpoint)
    if (!peer) return
    this.#diagnose({
      kind: 'renegotiation-stalled',
      device: endpoint,
      detail: 'a renegotiation on a connected pair went unanswered; restarting ICE on the existing connection',
    })
    peer.healStalledNegotiation()
  }

  /** What a signal this device just sent, or just received, says about
   *  whether a negotiation on a connected pair is outstanding. */
  #watchNegotiation(endpoint: string, body: SignalBody): void {
    if (body.type === 'offer') this.#armRenegotiationTimer(endpoint)
    else if (body.type === 'answer') this.#clearRenegotiationTimer(endpoint)
  }

  /**
   * A relay rejected a signal, so it never left this device.
   *
   * Two things follow. The failure is reported, because it used to be
   * swallowed whole and a pair that silently stopped negotiating was
   * indistinguishable from one that never had anything to say. And the
   * signal is sent again at once rather than waiting out a backoff step for
   * an attempt that did not happen.
   */
  #signalPublishFailed(device: string, body: SignalBody, error: unknown): void {
    this.#diagnose({ kind: 'signal-publish-failed', device, detail: `${body.type}: ${describeError(error)}` })
    if (this.#closed) return
    if (body.type !== 'offer' && body.type !== 'answer') return
    const now = Date.now()
    if (now - (this.#publishRetryAt.get(device) ?? 0) < PUBLISH_RETRY_MIN_MS) return
    this.#publishRetryAt.set(device, now)
    const peer = this.#peerFor(device)
    if (!peer) return
    peer.retransmitNow()
    this.#diagnose({ kind: 'signal-retransmitted', device, detail: body.type })
  }

  #diagnose(event: MeshDiagnostic): void {
    try {
      this.#opts.onDiagnostic?.(event)
    } catch {
      // A caller's logger is not allowed to be what breaks a call.
    }
  }

  /** A rung worked. */
  #endpointConnected(endpoint: string): void {
    const retiring = this.#retiringPeers.get(endpoint)
    if (retiring && retiring.settle === undefined) {
      retiring.settle = setTimeout(() => this.#closeRetiringPeer(endpoint, true), 1_000)
      ;(retiring.settle as unknown as { unref?: () => void }).unref?.()
    }
    this.#clearRouteTimer(endpoint)
    this.#clearCheckTimer(endpoint)
    this.#controllers.get(endpoint)?.connected()
    for (const [device, route] of this.#routes) {
      if (route.endpoint !== endpoint || route.connected) continue
      // A volunteer's own connection coming up - or back, after an ICE
      // restart - says nothing about whether it is carrying anybody. Only
      // carried media arriving does: see `#assistMediaArrived`.
      if (route.tier === 'assist') continue
      route.connected = true
      // A connection resets the rest: whatever was wrong is not wrong now.
      route.retries = 0
      this.#announceRoute(device, route)
    }
  }

  /** A rung did not work, or stopped working. Everything reached through it
   *  falls to the next one. */
  #endpointFailed(endpoint: string): void {
    if (this.#closed || this.#closingEndpoints.has(endpoint)) return
    this.#clearRouteTimer(endpoint)
    this.#clearCheckTimer(endpoint)
    // The connection on this rung is finished, whether it said so itself or
    // simply never came up. It has to go before the next rung is chosen: the
    // next rung may be the same endpoint over a different ICE configuration -
    // TURN, most of the time - and a peer left in the map would be mistaken
    // for that new connection and never replaced.
    const peer = this.#peers.get(endpoint)
    if (peer) this.#closePeer(endpoint, peer)
    // This endpoint may have been carrying pairs for us as well as being one
    // end of them, so stop counting on it either way.
    this.#stopRelayingFor(endpoint)
    for (const [device, route] of [...this.#routes]) {
      if (route.endpoint !== endpoint) continue
      this.#escalate(device)
    }
    this.#reconcile(this.#opts.session.participants())
  }

  /**
   * Move one device down the ladder: direct, then peer assist, then a named
   * forwarder, then TURN.
   *
   * The order is the whole of stage 6. Most pairs connect directly and cost
   * nobody anything; the ones that do not are carried by somebody who
   * volunteered before they are carried by a server anybody pays for. TURN
   * stays as the floor, which is not the same as being the default.
   */
  #escalate(device: string): void {
    const route = this.#routes.get(device)
    if (!route || route.exhausted) return

    if (route.tier === 'assist' && !route.failed.includes(route.endpoint)) {
      route.failed.push(route.endpoint)
    }
    // Off this volunteer, whatever comes next: it is told, and anything it
    // carried for us is taken off the screen before the next rung's media
    // arrives, so nobody is shown twice.
    if (route.tier === 'assist') this.#leaveAssist(device, true)
    route.connected = false

    // Peer assist, if anybody is offering and we can actually reach them.
    if (route.tier === 'direct' || route.tier === 'assist') {
      const assistant = this.#pickAssistant(device, route)
      if (assistant) {
        route.tier = 'assist'
        route.endpoint = assistant
        this.#announceRoute(device, route)
        this.#requestAssist(device, assistant)
        return
      }
    }

    // A forwarder the room descriptor names, if it has one we have not
    // already burned. This promotes the whole room rather than this one pair:
    // a forwarder that is in the path is in the path for everybody, and
    // pretending otherwise would mean two media topologies at once.
    if (route.tier !== 'forwarder' && route.tier !== 'turn') {
      const ref = this.#selectUsableForwarder()
      if (ref) {
        route.tier = 'forwarder'
        route.endpoint = normaliseHex(ref.pubkey as string)
        this.#announceRoute(device, route)
        if (this.#forwarding !== 'trying' && this.#forwarding !== 'up') this.#promote(ref)
        return
      }
    }

    // TURN. Last, and only ever last.
    if (route.tier !== 'turn') {
      route.tier = 'turn'
      route.endpoint = device
      this.#announceRoute(device, route)
      return
    }

    // Out of rungs. The room keeps going without this person's media, and
    // says so rather than leaving a tile spinning for ever - and then, after
    // a rest, tries again from the top. See `EXHAUSTED_RETRY_MS`.
    route.exhausted = true
    route.endpoint = device
    this.#announceRoute(device, route)
    this.#armRetryTimer(device)
  }

  #armRetryTimer(device: string): void {
    this.#clearRetryTimer(device)
    // §3.4: for a profile-2 pair the controller owns the rest between walks
    // of the ladder, jittered and without a terminal state - both devices are
    // in the roster, so the pair should be on a call and the client keeps
    // saying so.
    const controller = this.#controllers.get(device)
    if (controller?.active) {
      controller.exhausted()
      return
    }
    const base = this.#opts.exhaustedRetryMs ?? EXHAUSTED_RETRY_MS
    const retries = this.#routes.get(device)?.retries ?? 0
    const rest = Math.min(base * 2 ** retries, Math.max(base, this.#opts.maxExhaustedRetryMs ?? MAX_EXHAUSTED_RETRY_MS))
    const timer = setTimeout(() => {
      this.#retryTimers.delete(device)
      this.#retryRoute(device)
    }, rest)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.#retryTimers.set(device, timer)
  }

  #clearRetryTimer(device: string): void {
    const timer = this.#retryTimers.get(device)
    if (timer !== undefined) clearTimeout(timer)
    this.#retryTimers.delete(device)
  }

  /**
   * Start the ladder again for a device that had run out of rungs.
   *
   * A clean slate, deliberately: the volunteers that failed for this pair
   * are forgotten too, because whatever was wrong a rest ago - their uplink,
   * ours, the path between - may not be wrong now, and the worst a stale
   * exclusion can do is skip the one member who could have carried them.
   */
  #retryRoute(device: string): void {
    if (this.#closed) return
    const route = this.#routes.get(device)
    if (!route || !route.exhausted) return
    route.tier = this.#opts.initialTier ?? 'direct'
    route.endpoint = device
    route.connected = false
    route.exhausted = false
    route.failed = []
    route.retries += 1
    this.#announceRoute(device, route)
    this.#reconcile(this.#opts.session.participants())
  }

  /**
   * The volunteer this pair should route through, if there is one.
   *
   * Two conditions beyond what `selectAssistant` checks, both of them local:
   * the volunteer must be somebody we are *already* directly connected to,
   * because assist reuses that connection rather than opening another; and it
   * must not be one we have already tried for this device.
   */
  #pickAssistant(device: string, route: Route): string | null {
    // Asking is consenting to this device's media reaching the far end
    // through somebody else, so it is never done for a far end this device
    // does not send to.
    if (!this.#mayAsk(device)) return null
    const volunteers: AssistVolunteer[] = []
    for (const [candidate, offer] of this.#volunteers) {
      if (candidate === device) continue
      const theirs = this.#routes.get(candidate)
      if (!theirs || theirs.tier !== 'direct' || !theirs.connected) continue
      // Carried m-lines sit outside a profile-2 pair's fixed slots, and that
      // has not been shown to work on either side. Profile 1 only, for now.
      if (!(this.#peers.get(candidate) instanceof Peer)) continue
      volunteers.push({ device: candidate, offer })
    }
    return selectAssistant([this.#opts.localDevice, device], volunteers, { exclude: route.failed })?.device ?? null
  }

  #announceRoute(device: string, route: Route): void {
    try {
      this.#opts.onRoute?.(device, {
        tier: route.tier,
        endpoint: route.endpoint,
        connected: route.connected,
        exhausted: route.exhausted,
      })
    } catch {
      // A caller's render() is not allowed to take the room down.
    }
  }

  // -------------------------------------------------------------------------
  // Asking somebody to carry a pair, and being asked
  // -------------------------------------------------------------------------

  #send(to: string, body: Omit<SignalBody, 'roomId'>): void {
    let wrap: Event
    try {
      wrap = wrapSignal(
        { ...body, roomId: this.#opts.roomId } as SignalBody,
        { senderSk: this.#opts.deviceSk, recipientPubkey: to, expiresAt: this.#opts.expiresAt },
      )
    } catch (error) {
      // A key that is not a point cannot be written to. Said, not thrown:
      // this runs from timers and from a person pressing a switch.
      this.#diagnose({ kind: 'signal-publish-failed', device: to, detail: `${body.type}: ${describeError(error)}` })
      return
    }
    this.#opts.transport.publish(wrap).catch((error) =>
      this.#diagnose({ kind: 'signal-publish-failed', device: to, detail: `${body.type}: ${describeError(error)}` }),
    )
  }

  /**
   * Whether this device may ask anybody to carry it to `device`.
   *
   * Asking is consenting, per direction: the volunteer carries this device's
   * media to `device` because this device asked. So it is never done when
   * the room said not to (`assist`), and never for somebody this device's
   * audience rule refuses - an agent its person has kept from hearing them,
   * somebody they blocked - however the route ladder is going. Judged on the
   * audience rather than on what is being sent right now, so somebody with
   * their camera and microphone off still asks, and still receives.
   */
  #mayAsk(device: string): boolean {
    try {
      if (this.#opts.assist?.() === false) return false
    } catch {
      return false
    }
    const audience = this.#audience
    if (!audience) return true
    const participant = this.#deviceToParticipant.get(device)
    const view = this.#views.find((v) => v.participant === participant)
    if (!view) return false
    try {
      return audience(view)
    } catch {
      return false
    }
  }

  /** Whether `device`'s roster entry says it publishes a track in `role`. */
  #advertises(device: string, role?: TrackRole): boolean {
    for (const view of this.#views) {
      for (const advert of view.tracks) {
        if (advert.device === device && (role === undefined || advert.role === role)) return true
      }
    }
    return false
  }

  /** Whether this device is offering to carry, right now. A source that
   *  throws has not said yes. */
  #isOffering(): boolean {
    try {
      return this.#opts.offering?.() ?? true
    } catch {
      return false
    }
  }

  #requestAssist(device: string, assistant: string): void {
    this.#leaveAssist(device, false)
    this.#assisted.set(device, { volunteer: assistant, accepted: false, tracks: [] })
    this.#ask(device, assistant)
    // The request gets the same budget a connection attempt does, on a timer
    // of its own. It used to share the volunteer's route timer, and that
    // timer's failure closes the connection to the volunteer: a slow answer
    // tore down a working direct link to somebody who was only being asked.
    this.#armAssistTimer(device)
  }

  /** One request, saying this end reads `carry` - without which a volunteer
   *  refuses, because an end that cannot read it would show the far end's
   *  media under the volunteer's name. */
  #ask(device: string, assistant: string): void {
    this.#send(assistant, { type: 'assist', assist: device, readsCarry: true })
  }

  #armAssistTimer(device: string): void {
    const state = this.#assisted.get(device)
    if (!state) return
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (this.#assisted.get(device) !== state) return
      this.#assistFailed(device, state.accepted ? 'no carried media arrived' : 'the volunteer did not answer')
    }, this.#opts.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS)
    ;(state.timer as unknown as { unref?: () => void }).unref?.()
  }

  #clearAssistTimer(state: AssistState): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
  }

  /**
   * An accepted route with nothing yet arriving is owed its first media - but
   * only once the far end has something to send. A far end with its camera
   * and microphone off advertises nothing, and a clock started on that would
   * give up on a route that is working and simply quiet.
   */
  #armAssistTimersForMedia(): void {
    for (const [device, state] of this.#assisted) {
      if (!state.accepted || state.timer !== undefined) continue
      if (this.#routes.get(device)?.connected) continue
      if (!this.#advertises(device)) continue
      this.#armAssistTimer(device)
    }
  }

  /**
   * Keep asking while carried - see `ASSIST_RENEW_MS`. Each renewal checks
   * again that this device still sends to the far end, so consent taken back
   * stops the carrying even if the release itself never arrives.
   */
  #startRenewal(device: string, state: AssistState): void {
    if (state.renew !== undefined) return
    state.renew = setInterval(() => {
      if (this.#closed || this.#assisted.get(device) !== state) return
      if (!this.#mayAsk(device)) {
        this.#assistFailed(device, 'this device no longer sends to them')
        return
      }
      this.#ask(device, state.volunteer)
    }, this.#opts.assistRenewMs ?? ASSIST_RENEW_MS)
    ;(state.renew as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * This device has stopped being carried to `device` by its volunteer, for
   * whatever reason.
   *
   * Tracks that arrived through the volunteer are ended here, so the app
   * takes them off the screen: the next rung delivers the same person again,
   * and a stale copy beside the live one is somebody shown twice. The
   * volunteer is told unless it was the one that ended it, so it can give
   * the slot to somebody else instead of carrying media nobody is waiting
   * for. If that word is lost, the lease runs out instead.
   */
  #leaveAssist(device: string, tellVolunteer: boolean): void {
    const state = this.#assisted.get(device)
    if (!state) return
    this.#assisted.delete(device)
    this.#clearAssistTimer(state)
    if (state.sampler !== undefined) clearInterval(state.sampler)
    state.sampler = undefined
    if (state.renew !== undefined) clearInterval(state.renew)
    state.renew = undefined
    this.#endAssistTracks(state)
    this.#parked = this.#parked.filter((held) => held.endpoint !== state.volunteer || [...this.#assisted.values()].some((other) => other.volunteer === state.volunteer))
    if (tellVolunteer && !this.#closed) this.#send(state.volunteer, { type: 'assist', assist: device, accept: false, release: true })
  }

  #endAssistTracks(state: AssistState): void {
    for (const { track } of state.tracks) {
      try {
        track.stop()
        // `stop()` ends a track without saying so; the app listens for
        // `ended`, which is what a track that ends by itself fires.
        ;(track as unknown as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent?.(new globalThis.Event('ended') as unknown as Event)
      } catch {
        // A track that is already gone is the outcome wanted.
      }
    }
    state.tracks = []
  }

  /** A carried route did not work, or stopped working: off this volunteer,
   *  on to the next rung, and the direct peer back if that is where it goes. */
  #assistFailed(device: string, reason: string, byVolunteer = false): void {
    if (this.#closed) return
    const route = this.#routes.get(device)
    const state = this.#assisted.get(device)
    if (!route || route.tier !== 'assist' || !state) {
      this.#leaveAssist(device, !byVolunteer)
      return
    }
    this.#diagnose({ kind: 'route-assist-failed', device, detail: reason })
    if (byVolunteer) this.#leaveAssist(device, false)
    this.#escalate(device)
    this.#reconcile(this.#opts.session.participants())
  }

  /** The first carried media for `device` has arrived. That, and not the
   *  volunteer's yes, is what makes the route connected. */
  #assistMediaArrived(device: string): void {
    const route = this.#routes.get(device)
    const state = this.#assisted.get(device)
    if (!route || !state || route.tier !== 'assist' || route.endpoint !== state.volunteer || route.connected) return
    this.#clearAssistTimer(state)
    route.connected = true
    route.retries = 0
    this.#announceRoute(device, route)
  }

  /**
   * Watch what arrives on a carried route: first to count it connected,
   * then to notice when it stops.
   *
   * By the bytes each carried receiver reports, because nothing else tells
   * the truth here: the connection to the volunteer is up whatever the
   * volunteer does, and a remote track's `muted` does not reliably change
   * when the far end stops sending.
   */
  #watchAssist(device: string): void {
    const state = this.#assisted.get(device)
    if (!state || state.sampler !== undefined) return
    state.sampler = setInterval(() => void this.#sampleAssist(device, state), this.#opts.assistSampleMs ?? ASSIST_SAMPLE_MS)
    ;(state.sampler as unknown as { unref?: () => void }).unref?.()
    void this.#sampleAssist(device, state)
  }

  async #sampleAssist(device: string, state: AssistState): Promise<void> {
    const readings = await Promise.all(state.tracks.map(async (held) => ({ held, received: await bytesReceived(held.receiver) })))
    if (this.#closed || this.#assisted.get(device) !== state) return
    const route = this.#routes.get(device)
    if (!route || route.tier !== 'assist') return
    const now = Date.now()
    let measured = false
    let moved = false
    for (const { held, received } of readings) {
      if (received === undefined) continue
      measured = true
      // Each receiver against its own best, so one whose report has gone
      // cannot make the rest look stalled.
      if (received > held.bytes) {
        held.bytes = received
        held.progressAt = now
        moved = true
      }
    }
    if (!measured) {
      // A connection that will not report bytes - a test double, a Node
      // adapter - is judged by the only other sign there is.
      if (state.tracks.some(({ track }) => track.muted === false)) this.#assistMediaArrived(device)
      return
    }
    if (moved) this.#assistMediaArrived(device)
    if (!route.connected) return
    // Judged per role the far end advertises, on the newest track for it: a
    // camera that stops while the microphone flows is still a stall, and a
    // role nobody advertises any more is quiet, not stalled.
    const newest = new Map<TrackRole, (typeof state.tracks)[number]>()
    for (const held of state.tracks) if (held.role !== undefined) newest.set(held.role, held)
    const stallMs = this.#opts.assistStallMs ?? ASSIST_STALL_MS
    for (const [role, held] of newest) {
      if (!this.#advertises(device, role)) {
        held.progressAt = now
        continue
      }
      if (now - held.progressAt >= stallMs) {
        this.#assistFailed(device, `carried ${role} stopped arriving`)
        return
      }
    }
  }

  /**
   * The app saw a carried route go quiet before this mesh did - it samples
   * every connection anyway. Off this volunteer, as a stall found here would
   * be.
   */
  assistStalled(device: string): void {
    const target = normaliseHex(device)
    if (this.#routes.get(target)?.tier !== 'assist') return
    this.#assistFailed(target, 'carried media stopped arriving')
  }

  /** The answer to a request we made. */
  #handleAssistReply(from: string, far: string, accepted: boolean): void {
    const device = normaliseHex(far)
    const route = this.#routes.get(device)
    const state = this.#assisted.get(device)
    const ours = route?.tier === 'assist' && route.endpoint === from && state?.volunteer === from
    if (!ours || !state) {
      // A yes nobody here is waiting for: a request that outlived its
      // release, or a hold that ended after this device moved on. Whatever it
      // is, this device's consent is not current, so it is taken back now
      // rather than left to the lease.
      if (accepted) this.#releaseUnexpected(from, device)
      return
    }
    if (!accepted) {
      // A refusal, or a volunteer that has stopped carrying. Either way it
      // needs no telling.
      this.#assistFailed(device, 'the volunteer refused or stopped', true)
      return
    }
    if (state.accepted) return
    state.accepted = true
    this.#startRenewal(device, state)
    // Yes is not media. The volunteer may have held our request for up to
    // `ASSIST_HOLD_MS` and still has to renegotiate, so the first media gets
    // a fresh budget from here - when there is any to wait for.
    this.#clearAssistTimer(state)
    if (this.#advertises(device)) this.#armAssistTimer(device)
  }

  /** Tell a volunteer to stop carrying `device` for this device, at most
   *  once every few seconds per pair. */
  #releaseUnexpected(volunteer: string, device: string): void {
    const key = `${volunteer}|${device}`
    const now = Date.now()
    if (now - (this.#releasedAt.get(key) ?? -Infinity) < 5_000) return
    this.#releasedAt.set(key, now)
    while (this.#releasedAt.size > 64) {
      const oldest = this.#releasedAt.keys().next().value
      if (oldest === undefined) break
      this.#releasedAt.delete(oldest)
    }
    this.#send(volunteer, { type: 'assist', assist: device, accept: false, release: true })
  }

  // -------------------------------------------------------------------------
  // Being the volunteer
  // -------------------------------------------------------------------------

  /** The pairs this mesh is carrying. Not every pair in a shared registry. */
  #ownPairList(): RelayPair[] {
    return (this.#opts.relay?.pairs ?? []).filter((pair) => this.#ownPairs.has(pair.key))
  }

  /** Whether this device can carry `a` and `b` for each other right now. */
  #canCarry(a: string, b: string): boolean {
    const relay = this.#opts.relay
    if (!relay || relay.closed || !this.#isOffering()) return false
    // Without pumps a yes would be the very failure peer assist was paused
    // for: a pair told it is carried, and nothing moving.
    if (this.#opts.relayMedia?.ready !== true) return false
    if (b === '' || a === b || a === this.#opts.localDevice || b === this.#opts.localDevice) return false
    for (const end of [a, b]) {
      if (this.#routes.get(end)?.connected !== true || this.#routes.get(end)?.tier !== 'direct') return false
      if (!(this.#peers.get(end) instanceof Peer)) return false
    }
    return true
  }

  /**
   * Somebody has asked this device to carry a pair.
   *
   * Refused unless the asker reads `carry`, this device volunteered, can
   * pump frames, and is directly connected to both ends. Otherwise held
   * until the other end asks too, because each end's request is its consent
   * to its own media being carried: carrying A to B only because B asked
   * would send A's media somewhere A may have refused. A refusal is answered
   * at once, because the asker's alternative is waiting out a timeout. An
   * ask for a pair already carried renews that end's lease.
   */
  #handleAssistRequest(from: string, far: string, readsCarry: boolean): void {
    const relay = this.#opts.relay
    const other = normaliseHex(far)
    if (!relay || !readsCarry || !this.#canCarry(from, other)) {
      // A renewal refused - helping turned off, an end no longer reachable -
      // ends a pair already carried now, not when its lease runs out.
      const carried = relay?.get(from, other)
      if (carried && this.#ownPairs.has(carried.key)) this.#endPair(carried, [from, other], 'no longer able to carry')
      else this.#send(from, { type: 'assist', assist: other, accept: false })
      return
    }

    const existing = relay.get(from, other)
    if (existing && this.#ownPairs.has(existing.key)) {
      existing.ask(from)
      this.#leases.get(existing.key)?.set(from, Date.now())
      this.#send(from, { type: 'assist', assist: other, accept: true })
      this.#syncCarry()
      return
    }
    if (existing) {
      // Carried by another room session of this app. Not ours to answer for.
      this.#send(from, { type: 'assist', assist: other, accept: false })
      return
    }

    const key = assistPairKey(from, other)
    let pending = this.#pendingAsks.get(key)
    if (!pending) {
      const timer = setTimeout(() => this.#holdExpired(key), this.#opts.assistHoldMs ?? ASSIST_HOLD_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      pending = { a: from, b: other, asked: new Set(), timer }
      this.#pendingAsks.set(key, pending)
    }
    pending.asked.add(from)
    if (!pending.asked.has(other)) return

    clearTimeout(pending.timer)
    this.#pendingAsks.delete(key)
    const pair = relay.admit(from, other)
    if (!pair) {
      for (const end of [from, other]) this.#send(end, { type: 'assist', assist: end === from ? other : from, accept: false })
      return
    }
    pair.ask(from)
    pair.ask(other)
    this.#ownPairs.add(pair.key)
    const now = Date.now()
    this.#leases.set(pair.key, new Map([[from, now], [other, now]]))
    this.#armLeaseSweep()
    for (const end of [from, other]) this.#send(end, { type: 'assist', assist: end === from ? other : from, accept: true })
    try {
      this.#opts.onRelayStart?.(pair)
    } catch {
      // The indicator is the app's, and its mistakes are its own.
    }
    this.#syncCarry()
  }

  /** One end asked and the other never did. Refused, so the asker moves on
   *  before its own timer would have given up on us. */
  #holdExpired(key: string): void {
    const pending = this.#pendingAsks.get(key)
    if (!pending) return
    this.#pendingAsks.delete(key)
    if (this.#closed) return
    for (const end of pending.asked) this.#send(end, { type: 'assist', assist: end === pending.a ? pending.b : pending.a, accept: false })
  }

  /** Drop any pair an end has stopped asking for. See `ASSIST_LEASE_MS`. */
  #armLeaseSweep(): void {
    if (this.#leaseSweep !== undefined) return
    const lease = this.#opts.assistLeaseMs ?? ASSIST_LEASE_MS
    this.#leaseSweep = setInterval(() => {
      if (this.#closed) return
      const now = Date.now()
      // A pair another session dropped from the shared registry is not ours
      // to keep counting.
      const held = new Set((this.#opts.relay?.pairs ?? []).map((pair) => pair.key))
      for (const key of [...this.#ownPairs]) {
        if (held.has(key)) continue
        this.#ownPairs.delete(key)
        this.#leases.delete(key)
      }
      for (const pair of this.#ownPairList()) {
        const asks = this.#leases.get(pair.key)
        const lapsed = !asks || [pair.a, pair.b].some((end) => now - (asks.get(end) ?? -Infinity) > lease)
        if (lapsed) this.#endPair(pair, [pair.a, pair.b], 'an end stopped asking')
      }
      if (this.#ownPairs.size === 0) this.#stopLeaseSweep()
    }, Math.max(1, Math.floor(lease / 3)))
    ;(this.#leaseSweep as unknown as { unref?: () => void }).unref?.()
  }

  #stopLeaseSweep(): void {
    if (this.#leaseSweep !== undefined) clearInterval(this.#leaseSweep)
    this.#leaseSweep = undefined
  }

  /** One end of a pair has stopped using this device as its route. */
  #handleAssistRelease(from: string, far: string): void {
    const other = normaliseHex(far)
    const key = assistPairKey(from, other)
    const pending = this.#pendingAsks.get(key)
    if (pending) {
      pending.asked.delete(from)
      if (pending.asked.size === 0) {
        clearTimeout(pending.timer)
        this.#pendingAsks.delete(key)
      }
    }
    const pair = this.#opts.relay?.get(from, other)
    if (pair && this.#ownPairs.has(pair.key)) this.#endPair(pair, [other], 'released by one end')
  }

  /**
   * Stop carrying one pair: the pumps, the clock senders, the slot, and a
   * word to each end still listening so they move on now rather than when
   * the media runs dry.
   */
  #endPair(pair: RelayPair, tell: string[], reason: string): void {
    for (const [id, leg] of [...this.#legs]) if (leg.pairKey === pair.key) this.#closeLeg(id)
    for (const id of [...this.#refusedLegs.keys()]) if (id.startsWith(`${pair.key}|`)) this.#refusedLegs.delete(id)
    this.#ownPairs.delete(pair.key)
    this.#leases.delete(pair.key)
    this.#opts.relay?.drop(pair.a, pair.b)
    this.#diagnose({ kind: 'relay-pair-ended', device: pair.a, detail: `${pair.b.slice(0, 8)}: ${reason}` })
    try {
      this.#opts.onRelayStop?.(pair)
    } catch {
      // As above.
    }
    if (this.#ownPairs.size === 0) this.#stopLeaseSweep()
    if (this.#closed) return
    for (const end of tell) {
      const otherEnd = pair.other(end)
      if (otherEnd) this.#send(end, { type: 'assist', assist: otherEnd, accept: false })
    }
  }

  /** Stop carrying anything involving `device`, and tell the other end. */
  #stopRelayingFor(device: string): void {
    for (const [key, pending] of [...this.#pendingAsks]) {
      if (pending.a !== device && pending.b !== device) continue
      clearTimeout(pending.timer)
      this.#pendingAsks.delete(key)
      for (const end of pending.asked) {
        if (end !== device) this.#send(end, { type: 'assist', assist: device, accept: false })
      }
    }
    for (const pair of this.#ownPairList()) {
      if (pair.a !== device && pair.b !== device) continue
      const survivor = pair.other(device)
      this.#endPair(pair, survivor ? [survivor] : [], 'an end left or its connection failed')
    }
  }

  /**
   * Stop carrying everybody, and say so to every end - what turning "Help
   * other people connect" off does, mid-call.
   *
   * Before the relay registry is closed, so each pair is dropped through the
   * same path as any other ending: pumps and clock senders removed,
   * `onRelayStop` fired, both ends told. Closing the registry on its own
   * fired nothing and told nobody; the pair found out only when the roster
   * dropped the offer. The taps on this device's receivers are given back
   * too, since nothing will be carried from them.
   */
  stopRelaying(): void {
    for (const [key, pending] of [...this.#pendingAsks]) {
      clearTimeout(pending.timer)
      this.#pendingAsks.delete(key)
      for (const end of pending.asked) this.#send(end, { type: 'assist', assist: end === pending.a ? pending.b : pending.a, accept: false })
    }
    for (const pair of this.#ownPairList()) this.#endPair(pair, [pair.a, pair.b], 'this device stopped helping')
    // Consent is the device's, not this room's: anything else in the
    // registry goes too, and is reported, though its ends hear of it from
    // the session that admitted it, or when the media stops.
    for (const pair of this.#opts.relay?.pairs ?? []) {
      this.#opts.relay?.drop(pair.a, pair.b)
      try {
        this.#opts.onRelayStop?.(pair)
      } catch {
        // As above.
      }
    }
    this.#opts.relay?.close()
    try {
      this.#opts.relayMedia?.release?.()
    } catch {
      // Giving taps back is tidying, not consent.
    }
  }

  /**
   * Bring the legs this device carries into line with what it should carry.
   *
   * Desired state rather than events, because what a leg needs arrives in
   * any order: the pair is accepted, the source's track arrives on its own
   * connection, the roster says which role that track plays, the connection
   * to the other end is rebuilt. Each of those calls this, and this makes
   * the legs match: one per pair, per direction whose source asked (see
   * `RelayPair.directions`), per role the source is sending.
   */
  #syncCarry(): void {
    const relay = this.#opts.relay
    const pipeline = this.#opts.relayMedia
    const wanted = new Map<string, { pair: RelayPair; from: string; to: string; role: TrackRole; track: MediaStreamTrack; receiver: unknown }>()
    if (relay && pipeline && !this.#closed && this.#isOffering()) {
      // Start the pumps' worker and claim the receivers that arrived before
      // helping was turned on, so the first pair does not depend on attaching
      // a transform to a stream that is already flowing. The pipeline taps
      // each receiver once, and only once its worker is running.
      try {
        pipeline.warm?.()
        if (pipeline.prepare) {
          for (const media of this.#endpointMedia.values()) for (const { track, receiver } of media.values()) pipeline.prepare(receiver, track)
        }
      } catch {
        // An optimisation, as at arrival.
      }
    }
    if (relay && pipeline?.ready === true && !this.#closed) {
      for (const pair of this.#ownPairList()) {
        for (const [from, to] of pair.directions()) {
          // Latest track per role wins: a camera turned off and on again is a
          // new track on a new m-line, and only the new one is moving.
          const byRole = new Map<TrackRole, { track: MediaStreamTrack; receiver: unknown }>()
          for (const [trackId, source] of this.#endpointMedia.get(from) ?? []) {
            if (source.track.readyState === 'ended') continue
            const role = this.#sourceRole(from, trackId, source.track)
            if (role) byRole.set(role, source)
          }
          for (const [role, source] of byRole) wanted.set(`${pair.key}|${from}|${role}`, { pair, from, to, role, ...source })
        }
      }
    }

    for (const [id, leg] of [...this.#legs]) {
      const want = wanted.get(id)
      if (!want || want.track !== leg.source || this.#peers.get(leg.to) !== leg.peer) this.#closeLeg(id)
    }

    for (const [id, want] of wanted) {
      if (this.#legs.has(id)) continue
      // Refused once for this source: not again until the source changes,
      // or every signal would add and remove a clock.
      if (this.#refusedLegs.get(id) === want.track) continue
      const peer = this.#peers.get(want.to)
      if (!(peer instanceof Peer) || !pipeline) continue
      let towards = 0
      for (const leg of this.#legs.values()) if (leg.to === want.to) towards += 1
      if (towards >= MAX_CARRY_ENTRIES) continue
      let clock: MediaStreamTrack
      try {
        clock = want.track.clone()
      } catch {
        continue
      }
      const added = peer.carryTrack(clock)
      if (!added) {
        clock.stop()
        continue
      }
      const leg: CarriedLeg = { pairKey: want.pair.key, from: want.from, to: want.to, role: want.role, source: want.track, clock, peer, handle: null }
      this.#legs.set(id, leg)
      let handle: RelayLegHandle | null = null
      try {
        handle = pipeline.carry({
          pair: want.pair,
          from: want.from,
          to: want.to,
          role: want.role,
          source: { track: want.track, receiver: want.receiver },
          sink: { clock, sender: added.sender, transceiver: added.transceiver },
          fail: (reason) => this.#legFailed(id, reason),
        })
      } catch {
        handle = null
      }
      if (!handle) {
        this.#diagnose({ kind: 'relay-leg-refused', device: want.from, detail: `${want.role} towards ${want.to.slice(0, 8)}` })
        this.#refusedLegs.set(id, want.track)
        this.#closeLeg(id)
        continue
      }
      leg.handle = handle
    }
  }

  /**
   * Which of `from`'s advertised roles a track arriving on the direct
   * connection to `from` plays.
   *
   * By track id when the roster names it. Not always possible: measured in
   * Chromium, a receiver keeps the id it was given when its m-line was made,
   * so on an m-line this device offered first and the far end then sent on,
   * the id is this device's own and matches no advert. Then by kind, when
   * `from` advertises exactly one role of that kind - a microphone, a camera.
   * Two of one kind (a camera and a shared screen) cannot be told apart that
   * way, and are not carried rather than carried under the wrong name.
   */
  #sourceRole(from: string, trackId: string, track: MediaStreamTrack): TrackRole | undefined {
    const byId = this.#trackRoles.get(trackId)
    if (byId) return this.#trackOwner.get(trackId) === from ? byId : undefined
    const roles = new Set<TrackRole>()
    for (const view of this.#views) for (const advert of view.tracks) if (advert.device === from) roles.add(advert.role)
    const sameKind = [...roles].filter((role) => (role === 'mic' || role === 'screen-audio' ? 'audio' : 'video') === track.kind)
    return sameKind.length === 1 ? sameKind[0] : undefined
  }

  #closeLeg(id: string): void {
    const leg = this.#legs.get(id)
    if (!leg) return
    this.#legs.delete(id)
    try {
      leg.handle?.close()
    } catch {
      // The pipeline's worker may be gone already.
    }
    leg.peer.dropCarriedTrack(leg.clock)
    try {
      leg.clock.stop()
    } catch {
      // Already ended.
    }
  }

  /** The pipeline found it cannot carry a leg after all. The pair goes, and
   *  both ends are told, rather than leaving one direction dark. */
  #legFailed(id: string, reason: string): void {
    const leg = this.#legs.get(id)
    if (!leg) return
    const pair = this.#ownPairList().find((candidate) => candidate.key === leg.pairKey)
    if (!pair) {
      this.#closeLeg(id)
      return
    }
    this.#endPair(pair, [pair.a, pair.b], reason)
  }

  /** The `carry` map for an offer to `endpoint` from `peer`: every m-line on
   *  it that carries somebody else's media, and whose. */
  #carryFor(endpoint: string, peer: Peer): Record<string, CarryEntry> | undefined {
    let carry: Record<string, CarryEntry> | undefined
    for (const leg of this.#legs.values()) {
      if (leg.to !== endpoint || leg.peer !== peer) continue
      const mid = peer.midOf(leg.clock)
      if (mid === null) continue
      carry ??= {}
      carry[mid] = { device: leg.from, role: leg.role }
    }
    return carry
  }

  /**
   * Decide whether this room should be routing through a forwarder, and move
   * towards that answer.
   *
   * Capacity, never headcount: `needsForwarding` weighs a measured uplink
   * against what this device is actually being asked to send. Twenty people
   * on Opus voice never promote; two people sharing legible 1080p screens
   * can.
   */
  #evaluatePromotion(peers: number): void {
    // Two reasons a room wants a forwarder, and they are not the same
    // question. Capacity is the original one: this device cannot carry
    // `(N-1) x bitrate`. The other is a pair that has exhausted every rung
    // above the forwarder, which no capacity measurement will ever show -
    // so a room whose uplink is fine must not tear down the forwarder that
    // is the only thing connecting two of its members.
    const want = (this.#needsForwarding(peers) || this.#routesWantForwarder()) && !this.#audienceNarrows()

    if (!want) {
      // The room fits again - fewer people, or a screen share stopped. Give
      // the bandwidth back and return to direct connections.
      if (this.#forwarding !== 'off') {
        this.#teardownForwarder()
        this.#forwarding = 'off'
        for (const controller of this.#controllers.values()) controller.resume()
      }
      return
    }

    if (this.#forwarding === 'trying' || this.#forwarding === 'up') return

    const ref = this.#selectUsableForwarder()
    // No usable forwarder is an ordinary answer, not an error: the room stays
    // a mesh, which is what it always was for a small group. A room already
    // marked `failed` stays marked, so a caller can see that this is a
    // degraded room rather than an ordinary one.
    if (!ref) return

    this.#promote(ref)
  }

  /**
   * Whether this device is currently keeping its media from somebody in the
   * room.
   *
   * A forwarder fans out one copy to everybody it carries for, and it is
   * given the room id and never the room key, so it cannot be told to skip
   * anyone: the narrowing `publish` does per connection has no equivalent
   * there. A device whose person has said that agents may not hear them
   * therefore must not hand its media to a forwarder at all - doing so
   * would send it to the very member the switch exists to exclude, on the
   * strength of a bandwidth calculation nobody was shown.
   *
   * So the switch wins and the room stays a mesh for this device. That
   * costs it `(N-1) x bitrate`, which is the price of the promise, and it
   * is a price only the device that made the promise pays: everybody else
   * in the room promotes normally. A device already on a forwarder when
   * somebody turns the switch on comes back down at the next roster
   * change, which is what `#evaluatePromotion` does with `want === false`.
   */
  #audienceNarrows(): boolean {
    const audience = this.#audience
    if (!audience || this.#tracks.length === 0) return false
    for (const view of this.#views) {
      if (view.participant === this.#opts.localParticipant) continue
      try {
        if (!audience(view)) return true
      } catch {
        // A rule that throws has not said yes, and `#tracksFor` already
        // treats that as a refusal. Treat it as one here too, or a throwing
        // rule would quietly promote what it refuses to publish.
        return true
      }
    }
    return false
  }

  /** True while any device is on the forwarder rung of the ladder. */
  #routesWantForwarder(): boolean {
    for (const route of this.#routes.values()) if (route.tier === 'forwarder') return true
    return false
  }

  #needsForwarding(peers: number): boolean {
    const measured = this.#opts.uplink?.()
    if (!measured) return false
    const estimate: CapacityEstimate = { ...measured, peers }
    try {
      return needsForwarding(estimate)
    } catch {
      // `needsForwarding` throws on a measurement that is not one, so that a
      // NaN cannot silently answer "no" at the API boundary. Here it must
      // not: this runs inside a roster-change handler, where a throw takes
      // the whole room down. The room stays a mesh, which is the same
      // symptom the throw exists to make loud - and a mesh that is over
      // capacity is a worse call, not no call.
      return false
    }
  }

  /** The forwarder this room should use, or null. Refs with no pubkey are
   *  excluded before selection rather than after: there would be nobody to
   *  address a signal to, and letting one win the ordering would stall the
   *  room on a forwarder it can never reach. */
  #selectUsableForwarder(): ForwarderRef | null {
    // The reference Node forwarder deliberately has no room key. Without an
    // encoded-frame transform at both browser endpoints, though, it still
    // terminates DTLS-SRTP and can read the media it moves. Do not let an
    // authenticated descriptor turn that into an accidental privacy downgrade.
    try {
      if (this.#opts.forwarderMedia?.() !== true || !this.#opts.forwarderMediaPipeline) return null
    } catch {
      return null
    }
    const usable = this.#forwarders.filter(
      (ref) => ref.pubkey !== undefined && !this.#failedForwarders.has(normaliseHex(ref.pubkey)),
    )
    return selectForwarder(usable, this.#opts.preferForwarder)
  }

  /**
   * Open a connection to `ref` - and leave the direct mesh exactly as it is.
   *
   * This is the whole of "degraded, never broken". A room that closed its
   * direct peers here would be betting the call on a connection that has not
   * happened yet, and losing that bet is a room where nobody can hear
   * anybody. The peers come down in `#forwarderConnected`, once there is
   * something to come down in favour of.
   */
  #promote(ref: ForwarderRef): void {
    const device = normaliseHex(ref.pubkey as string)
    this.#forwarding = 'trying'
    this.#forwarderDevice = device
    const peer = this.#createPeer(device, true)
    this.#forwarderPeer = peer
    // A transform may refuse a sender after `addTrack()`. That peer has made
    // no SDP offer (Peer enforces that), so fail this forwarder immediately
    // and retain the working mesh instead of leaving the UI at “trying” for
    // its whole timeout.
    peer.start(this.#tracks).catch(() => this.#forwarderFailed())
    this.#drainSignals(device, peer)

    const timeout = this.#opts.forwarderTimeoutMs ?? DEFAULT_FORWARDER_TIMEOUT_MS
    this.#forwarderTimer = setTimeout(() => this.#forwarderFailed(), timeout)
    ;(this.#forwarderTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** The forwarder is genuinely up, so the direct peers are now redundant
   *  cost - each one is a copy of our own media we no longer have to send. */
  #forwarderConnected(): void {
    if (this.#forwarding !== 'trying') return
    this.#forwarding = 'up'
    this.#clearForwarderTimer()
    for (const peer of this.#peers.values()) peer.close()
    this.#peers.clear()
    this.#peerSids.clear()
    // §3.4: the per-pair controller suspends while a forwarder carries the
    // room. There is no direct connection left to measure, and a rest that
    // fired under a forwarder would ask for a peer the promotion just closed.
    for (const controller of this.#controllers.values()) controller.suspend()
  }

  /** The forwarder never came up, or dropped after it had. Back to a direct
   *  mesh, and do not try this one again this session. */
  #forwarderFailed(): void {
    if (this.#forwarding !== 'trying' && this.#forwarding !== 'up') return
    if (this.#forwarderDevice) this.#failedForwarders.add(this.#forwarderDevice)
    this.#teardownForwarder()
    this.#forwarding = 'failed'
    // Back to a direct mesh, so each profile-2 pair is its own watchdog again.
    for (const controller of this.#controllers.values()) controller.resume()
    // Anybody who was on the forwarder rung because their own connection had
    // failed drops to the last one. Everybody else is back to a direct mesh,
    // which is what `#reconcile` below restores.
    for (const [device, route] of [...this.#routes]) {
      if (route.tier === 'forwarder') this.#escalate(device)
    }
    // Reopens every direct peer the promotion closed. The room is paying
    // `(N-1) x bitrate` again, which is the degradation - but it is a call.
    this.#reconcile(this.#opts.session.participants())
  }

  #teardownForwarder(): void {
    this.#clearForwarderTimer()
    const peer = this.#forwarderPeer
    this.#forwarderPeer = undefined
    this.#forwarderDevice = undefined
    if (!peer) return
    // Guarded, because closing a real connection reports `closed` back
    // through `onConnectionState`, and that must not re-enter as though the
    // forwarder had dropped on its own.
    this.#tearingDownForwarder = true
    try {
      peer.close()
    } finally {
      this.#tearingDownForwarder = false
    }
  }

  #clearForwarderTimer(): void {
    if (this.#forwarderTimer !== undefined) clearTimeout(this.#forwarderTimer)
    this.#forwarderTimer = undefined
  }

  /**
   * Whether this pair speaks profile 2.
   *
   * Both ends, and both by their own account: this build has to have it
   * turned on, and the far end's roster entry - signed by that device and
   * encrypted to the room key - has to claim it. One end guessing is exactly
   * what the capability field exists to prevent, because a profile-2 offer
   * reaching a far end that cannot read `slots` is four m-lines it will bind
   * by kind and order and then never be able to explain.
   *
   * The roster is the ordinary answer and a signal carrying `gen` is the
   * other half of §2.3: a far end that has just reloaded into a profile-2
   * build speaks it before the room's next heartbeat says so, and answering
   * its offer with a profile-1 peer would lose the slot map. A pair that has
   * been caught speaking profile 1 (`#downgraded`) beats both, because that
   * is the direction that cannot be guessed wrong safely.
   */
  #speaksProfile2(device: string): boolean {
    if (this.#opts.callProfile !== 2) return false
    if (this.#downgraded.has(device)) return false
    return this.#deviceProfiles.get(device) === 2 || this.#profile2Evidence.has(device)
  }

  /**
   * A signal from this device carried a generation, so it speaks profile 2
   * whatever its roster entry has caught up to saying.
   *
   * If a profile-1 peer is already open for it, that peer is replaced at
   * once and handed the signal, exactly as `#downgradePeer` does in the other
   * direction: waiting for the roster would mean answering a slotted offer
   * from a connection that cannot bind it, and then being downgraded by the
   * far end in turn.
   */
  #noteProfile2Evidence(device: string, body: SignalBody): void {
    if (this.#closed || this.#quiet) return
    if (this.#opts.callProfile !== 2 || this.#downgraded.has(device)) return
    if (this.#deviceProfiles.get(device) === 2) return
    if (this.#profile2Evidence.has(device)) return
    if (!this.#deviceToParticipant.has(device)) return
    this.#profile2Evidence.add(device)
    this.#diagnose({ kind: 'signal-received', device, detail: `${body.type}: far end is on call profile 2; upgrading` })
    const existing = this.#peers.get(device)
    if (!existing || existing instanceof SlotPeer) return
    this.#closePeer(device, existing)
    const peer = this.#createEndpointPeer(device)
    this.#peers.set(device, peer)
    this.#rebalanceCamera()
    const sid = this.#deviceSids.get(device)
    if (sid === undefined) this.#peerSids.delete(device)
    else this.#peerSids.set(device, sid)
    this.#armRouteTimerIfNeeded(device)
    peer.start(this.#tracksFor(device)).catch(() => {})
  }

  /** The controller that owns this pair's lifecycle, made on first need.
   *  Only ever for a device the room actually holds a profile-2 pair with. */
  #controllerFor(device: string): PairController {
    const existing = this.#controllers.get(device)
    if (existing) return existing
    const controller = new PairController({
      device,
      advertised: () => this.#advertisedRoles(device),
      onNextTier: () => this.#nextRungForPair(device),
      onRestOver: () => this.#restartPair(device),
      onDiagnostic: (detail) => this.#diagnose({ kind: 'pair-ladder', device, detail }),
      rest: {
        baseMs: this.#opts.exhaustedRetryMs,
        maxMs: this.#opts.maxExhaustedRetryMs,
      },
      health: this.#opts.pairHealth,
    })
    if (this.#forwarding === 'up') controller.suspend()
    this.#controllers.set(device, controller)
    return controller
  }

  /** Whether this endpoint's own watchdog is the per-pair controller rather
   *  than a route timer. False while a forwarder carries the room, which is
   *  what puts the route ladder back in charge of the rungs it still owns. */
  #controlled(endpoint: string): boolean {
    return this.#controllers.get(endpoint)?.active === true
  }

  /**
   * Which slots this device's roster advert says are live.
   *
   * The advert is what turns "nothing is arriving in this slot" into a fault
   * rather than a fact: a camera that is off is an idle slot. It is up to
   * twenty seconds stale, which is exactly why it is only ever half of the
   * rule - the other half is the counters, and §4's liveness is the two of
   * them together.
   */
  #advertisedRoles(device: string): TrackRole[] {
    const roles: TrackRole[] = []
    for (const view of this.#views) {
      for (const advert of view.tracks) {
        if (advert.device !== device) continue
        // §2.1's decode rule: at most one advert per role per device.
        if (!roles.includes(advert.role)) roles.push(advert.role)
      }
    }
    return roles
  }

  /**
   * §3.4's step 3 for a profile-2 pair: direct to TURN, at a new generation.
   *
   * Only those two rungs. Assist and forwarder keep the route ladder's own
   * behaviour, and a pair already on TURN has nowhere left to go - which is
   * what `false` says, and what the controller answers with a rest.
   */
  #nextRungForPair(device: string): boolean {
    if (this.#closed) return false
    const route = this.#routes.get(device)
    if (!route || route.tier !== 'direct') return false
    route.tier = 'turn'
    route.endpoint = device
    route.connected = false
    this.#announceRoute(device, route)
    const peer = this.#peers.get(device)
    if (peer) this.#closePeer(device, peer)
    this.#reconcile(this.#opts.session.participants())
    return true
  }

  /**
   * A rest is over: this pair starts again from the top rung.
   *
   * The peer is closed explicitly rather than left to `#reconcile`, because
   * the device is still wanted and the endpoint set is unchanged - so nothing
   * else would replace a connection that has been failing for a minute.
   */
  #restartPair(device: string, retainMedia = false): void {
    if (this.#closed) return
    const route = this.#routes.get(device)
    if (!route) return
    route.tier = this.#opts.initialTier ?? 'direct'
    route.endpoint = device
    route.connected = false
    route.exhausted = false
    route.failed = []
    route.retries += 1
    this.#announceRoute(device, route)
    const peer = this.#peers.get(device)
    if (peer) this.#closePeer(device, peer, retainMedia)
    this.#reconcile(this.#opts.session.participants())
  }

  /**
   * A slot's own track has ended, so re-attaching it would only make the slot
   * look busy. The application is the only thing that can replace it.
   *
   * Reported rather than repaired here for the same reason `Mesh` does not
   * own `getUserMedia`: the media pipeline, the device choice and the
   * permission prompt are all the app's, and a protocol library that reached
   * for a camera would be a protocol library nobody could embed.
   */
  #recoverSlot(device: string, role: TrackRole): void {
    this.#diagnose({ kind: 'pair-ladder', device, detail: `the local ${role} track has ended; media recovery is the app's` })
    try {
      this.#opts.onSlotRecovery?.(device, role)
    } catch {
      // A caller's media pipeline is not allowed to take the room down.
    }
  }

  /** Every profile-2 pair's state, for the bug report. See §8, step S12. */
  pairDiagnostics(): PairDiagnostics[] {
    return [...this.#controllers.values()].map((controller) => controller.summary())
  }

  /** Replace endpoint allocations after credential rotation, or only the
   * named endpoint after its route fails. Keep SlotPeer's generation history
   * so delayed signals cannot revive an allocation using an expired login. */
  rebuildConnections(remoteDevice?: string): boolean {
    if (this.#closed || this.#quiet) return false
    for (const [device, peer] of [...this.#peers]) {
      if (remoteDevice !== undefined && device !== remoteDevice) continue
      if (peer instanceof SlotPeer) peer.rebuild()
      else this.#restartPair(device, true)
    }
    return true
  }

  /** The peer for an ordinary room device, on whichever profile the pair
   *  speaks. Never a forwarder: that path stays profile 1 in phase 1. */
  #createEndpointPeer(endpoint: string): NegotiatingPeer {
    const tier = this.#tierOfEndpoint(endpoint)
    if (!this.#speaksProfile2(endpoint)) return this.#createPeer(endpoint, false, tier)
    const controller = this.#controllerFor(endpoint)
    const peer = new SlotPeer({
      factory: this.#opts.factory,
      localDevice: this.#opts.localDevice,
      remoteDevice: endpoint,
      context: { tier, remoteDevice: endpoint },
      iceRestart: this.#opts.iceRestart,
      trackRole: this.#opts.trackRole,
      onSignal: (body) => {
        // The tier rides on the offer already - `SlotPeer` knows which rung
        // its connection was built on, and adopts the far end's when it
        // adopts a generation - so nothing is added here.
        const wrap = wrapSignal({ ...body, roomId: this.#opts.roomId }, { senderSk: this.#opts.deviceSk, recipientPubkey: endpoint, expiresAt: this.#opts.expiresAt })
        this.#opts.transport.publish(wrap).catch((error) => this.#signalPublishFailed(endpoint, body, error))
        this.#watchNegotiation(endpoint, body)
        this.#diagnose({ kind: 'signal-sent', device: endpoint, detail: body.type })
      },
      onTrack: (track, _receiver, role) => this.#onEndpointTrack(endpoint, track, role),
      onConnectionState: (state) => {
        this.#diagnose({ kind: 'connection-state-change', device: endpoint, detail: state })
        if (state === 'connected') this.#endpointConnected(endpoint)
        else if (state === 'failed' || state === 'closed') this.#endpointFailed(endpoint)
      },
      onDowngrade: (body) => this.#downgradePeer(endpoint, body),
      // The far end says a slot of ours is dead. Believed only where this
      // side cannot contradict it - see `SlotPeerOptions.outboundReceived`.
      outboundReceived: (role) => controller.outboundReceived(role),
      // And where the repair is impossible because the local track has
      // ended, only the application can answer: it owns the camera, the
      // microphone and the permission prompt.
      onSlotRecovery: (role) => this.#recoverSlot(endpoint, role),
    })
    controller.attach(peer)
    return peer
  }

  /**
   * The far end has stopped speaking profile 2 - it reloaded into an old
   * build, which on the wire is a signal with no `gen` on it.
   *
   * Rebuilt legacy-style at once rather than waited out: everything the
   * profile-2 peer would say from here is addressed to a connection and a
   * generation the far end has never heard of, so the pair would sit blind
   * until the route ladder gave up on it. The signal that gave the game away
   * is handed straight to the replacement, because it is an offer far more
   * often than not and it is the only thing either side has to work with.
   */
  #downgradePeer(endpoint: string, body: SignalBody): void {
    if (this.#closed) return
    this.#downgraded.add(endpoint)
    this.#profile2Evidence.delete(endpoint)
    // The pair is profile 1 from here, so the route ladder is its watchdog
    // again and the controller has nothing left to own.
    this.#controllers.get(endpoint)?.close()
    this.#controllers.delete(endpoint)
    const existing = this.#peers.get(endpoint)
    if (!existing) return
    this.#closePeer(endpoint, existing)
    this.#diagnose({ kind: 'signal-handling-failed', device: endpoint, detail: `${body.type}: far end is on call profile 1; rebuilding` })
    const peer = this.#createPeer(endpoint, false, this.#tierOfEndpoint(endpoint))
    this.#peers.set(endpoint, peer)
    this.#rebalanceCamera()
    const sid = this.#deviceSids.get(endpoint)
    if (sid === undefined) this.#peerSids.delete(endpoint)
    else this.#peerSids.set(endpoint, sid)
    this.#armRouteTimerIfNeeded(endpoint)
    peer.start(this.#tracksFor(endpoint)).catch(() => {})
    peer.handleSignal(body).catch((error) =>
      this.#diagnose({ kind: 'signal-handling-failed', device: endpoint, detail: `${body.type}: ${describeError(error)}` }),
    )
    if (body.type === 'offer') this.#armRouteTimerForOffer(endpoint)
    this.#syncCarry()
  }

  /**
   * The far end rebuilt its connection to this device and is offering from
   * the new one. Meet it on a new connection of ours.
   *
   * Nothing on the roster says so. A web client whose page session is
   * unchanged publishes the same `sid`, and an Android one publishes none, so
   * `#sessionChanged` sees nothing and the old peer is kept - and the offer
   * lands on a connection whose session it does not belong to. Measured on a
   * real call: a phone that rejoined offered from a fresh connection, a
   * browser applied it to its stale one, and the browser's answer marked
   * every section not sending. The browser believed its tracks were already
   * negotiated, so nothing ever offered them again, and that person was
   * never heard while they still heard everybody.
   *
   * So the old peer goes and a new one is built exactly as `#downgradePeer`
   * builds one: this side's tracks first, by the same audience rule, then the
   * offer, so the answer carries them. The route loses its claim to be
   * connected, which belonged to the old connection, so the new one gets a
   * watchdog. The app keys everything it holds per person - volume, the
   * speaking ring, roles, tiles - by device and follows a new track object on
   * the same key, as it already does after any other rebuild.
   */
  #replaceForRemoteSession(endpoint: string, stale: Peer, offer: SignalBody, candidates: SignalBody[], retired?: string): void {
    if (this.#closed || this.#quiet) return
    // Only the endpoint's current peer may be replaced this way: an old one
    // finishing a queued signal after some other rebuild has nothing to give.
    if (this.#peers.get(endpoint) !== stale) return
    if (retired !== undefined) {
      const seen = this.#retiredRemoteSessions.get(endpoint) ?? new Set<string>()
      seen.add(retired)
      while (seen.size > MAX_RETIRED_REMOTE_SESSIONS) {
        const oldest = seen.values().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
      this.#retiredRemoteSessions.set(endpoint, seen)
    }
    this.#diagnose({ kind: 'signal-received', device: endpoint, detail: 'offer: far end started a new session; rebuilding' })
    this.#closePeer(endpoint, stale, true)
    for (const [device, route] of this.#routes) {
      if (route.endpoint !== endpoint || !route.connected) continue
      route.connected = false
      this.#announceRoute(device, route)
    }
    const peer = this.#createPeer(endpoint, false, this.#tierOfEndpoint(endpoint))
    this.#peers.set(endpoint, peer)
    this.#rebalanceCamera()
    const sid = this.#deviceSids.get(endpoint)
    if (sid === undefined) this.#peerSids.delete(endpoint)
    else this.#peerSids.set(endpoint, sid)
    this.#armRouteTimerIfNeeded(endpoint)
    peer.start(this.#tracksFor(endpoint)).catch(() => {})
    for (const body of [offer, ...candidates]) {
      peer.handleSignal(body).catch((error) =>
        this.#diagnose({ kind: 'signal-handling-failed', device: endpoint, detail: `${body.type}: ${describeError(error)}` }),
      )
    }
    this.#armRouteTimerForOffer(endpoint)
    this.#syncCarry()
  }

  #createPeer(remoteDevice: string, forwarder = false, tier: RouteTier = 'direct'): Peer {
    const retired = this.#retiredRemoteSessions.get(remoteDevice) ?? new Set<string>()
    if (!forwarder) this.#retiredRemoteSessions.set(remoteDevice, retired)
    const peer: Peer = new Peer({
      factory: this.#opts.factory,
      localDevice: this.#opts.localDevice,
      remoteDevice,
      nextOfferSequence: () => {
        const sequence = (this.#legacyOfferSequences.get(remoteDevice) ?? 0) + 1
        if (!Number.isSafeInteger(sequence)) throw new Error('call offer identifiers exhausted')
        this.#legacyOfferSequences.set(remoteDevice, sequence)
        return sequence
      },
      context: { tier: forwarder ? 'forwarder' : tier, remoteDevice },
      iceRestart: this.#opts.iceRestart,
      offerRetry: this.#opts.offerRetry,
      onSignal: (body) => {
        // An offer says which rung it was made on, so the far end can meet
        // it there - see `SignalBody.tier` and `#followRung`.
        const rung = !forwarder && body.type === 'offer' ? { tier } : {}
        // And, when this device is carrying somebody to this endpoint, which
        // m-lines are whose: the far end cannot tell any other way.
        const carried = !forwarder && body.type === 'offer' ? this.#carryFor(remoteDevice, peer) : undefined
        const wrap = wrapSignal(
          { ...body, ...rung, ...(carried ? { carry: carried } : {}), roomId: this.#opts.roomId },
          { senderSk: this.#opts.deviceSk, recipientPubkey: remoteDevice, expiresAt: this.#opts.expiresAt },
        )
        // Not fire and forget any more. A relay that rejects a publish has
        // taken this device's only copy of a signal the far end will never
        // know to ask for, and the empty `catch` that used to be here is why
        // that looked exactly like a pair with nothing to say.
        this.#opts.transport.publish(wrap).catch((error) => this.#signalPublishFailed(remoteDevice, body as SignalBody, error))
        if (!forwarder) {
          this.#watchNegotiation(remoteDevice, body as SignalBody)
          if ((body as SignalBody).type === 'ice') this.#candidateCrossed(remoteDevice)
          this.#diagnose({ kind: 'signal-sent', device: remoteDevice, detail: (body as SignalBody).type })
        }
      },
      onTrack: (track, receiver, _role, mid) => {
        if (forwarder) this.#onForwardedTrack(track, receiver)
        else this.#onEndpointTrack(remoteDevice, track, undefined, receiver, mid)
      },
      onSender: forwarder
        ? (track, sender) => this.#protectForwarderSender(sender, track)
        : undefined,
      // A forwarder never offers, so this side has to - even with nothing to
      // send, which is how a device with its camera and microphone off is
      // admitted at all.
      mustOfferFirst: forwarder,
      // `disconnected` is deliberately not a failure here. The peer owns
      // it: a connection that was up is given a grace and an ICE restart
      // before it is reported failed, so a router hiccup does not cost a
      // pair a volunteer, a forwarder and then TURN. What reaches the mesh
      // as `failed` has already been given that chance.
      onConnectionState: forwarder
        ? (state: RTCPeerConnectionState) => {
            if (this.#tearingDownForwarder) return
            if (state === 'connected') this.#forwarderConnected()
            else if (state === 'failed' || state === 'closed') this.#forwarderFailed()
          }
        : (state: RTCPeerConnectionState) => {
            if (this.#peers.get(remoteDevice) !== peer) return
            this.#diagnose({ kind: 'connection-state-change', device: remoteDevice, detail: state })
            if (state === 'connected') this.#endpointConnected(remoteDevice)
            else if (state === 'failed' || state === 'closed') this.#endpointFailed(remoteDevice)
            // Checks have begun. See `DEFAULT_DIRECT_CHECK_TIMEOUT_MS`.
            else if (state === 'connecting' && this.#peers.get(remoteDevice) === peer) this.#armCheckTimer(remoteDevice)
          },
      onRemoteRestart: forwarder
        ? undefined
        : (offer, candidates, retiredSession) => this.#replaceForRemoteSession(remoteDevice, peer, offer, candidates, retiredSession),
      retiredRemoteSessions: forwarder ? undefined : retired,
    })
    return peer
  }

  /**
   * Attribute a track that arrived on an ordinary endpoint.
   *
   * Almost always the endpoint's own media, which is what a direct connection
   * means. The exception is a volunteer carrying somebody else's: then the
   * volunteer's own offer names the m-line in `carry`, and it is attributed
   * to that person only if this device asked that volunteer to carry exactly
   * them and their roster entry - signed by them, encrypted to the room key -
   * says they publish that role. A carried m-line is never shown as the
   * volunteer's own.
   */
  #onEndpointTrack(endpoint: string, track: MediaStreamTrack, role?: TrackRole, receiver?: unknown, mid?: string): void {
    const verdict = this.#attribute(endpoint, track, receiver, mid)
    if (verdict === 'park') {
      this.#parked.push({ endpoint, track, receiver, ...(mid !== undefined ? { mid } : {}) })
      while (this.#parked.length > MAX_PARKED_TRACKS) this.#parked.shift()
      return
    }
    if (verdict === 'own') this.#ownTrack(endpoint, track, receiver, role)
  }

  /** The endpoint's own media. Kept, while this device is volunteering, as
   *  something a carried leg may later tap. */
  #ownTrack(endpoint: string, track: MediaStreamTrack, receiver: unknown, role?: TrackRole): void {
    if (this.#opts.relay && role === undefined && this.#peers.get(endpoint) instanceof Peer) {
      const media = this.#endpointMedia.get(endpoint) ?? new Map<string, { track: MediaStreamTrack; receiver: unknown }>()
      media.delete(track.id)
      media.set(track.id, { track, receiver })
      this.#endpointMedia.set(endpoint, media)
      // Claimed now, offering or not. Measured in Chromium 151: a receiver
      // transform attached after media has started gets no frames at all,
      // audio or video, key-frame request or not, while the decoder carries
      // on underneath. Helping is off at every join, so it is always turned
      // on after these receivers exist; a tap put on then would carry
      // nothing. The pipeline decides whether this device could ever help.
      try {
        this.#opts.relayMedia?.prepare?.(receiver, track)
      } catch {
        // A pipeline that cannot claim it only means this one is not carried.
      }
      this.#syncCarry()
    }
    this.#emitTrack(endpoint, track, 'direct', role)
  }

  /**
   * Whose a track on `endpoint`'s connection is: `carried` (and already
   * emitted as that person's), `own` (the endpoint's), `park` (cannot be
   * told yet), or `drop`.
   *
   * Parked rather than guessed when the endpoint is carrying somebody for
   * this device: the far end's roster advert may be a moment behind the
   * volunteer's offer, and an m-line the volunteer switched on in an answer
   * reaches here with no `carry` map at all. Shown as the volunteer's, either
   * would put one person's camera on another person's tile.
   */
  #attribute(endpoint: string, track: MediaStreamTrack, receiver: unknown, mid: string | undefined, parked = false): 'carried' | 'own' | 'park' | 'drop' {
    const carryMap = this.#carryIn.get(endpoint)
    const entry = mid !== undefined && carryMap && Object.hasOwn(carryMap, mid) ? carryMap[mid] : undefined
    if (entry) {
      const state = this.#assisted.get(entry.device)
      const route = this.#routes.get(entry.device)
      if (route?.tier !== 'assist' || route.endpoint !== endpoint || state?.volunteer !== endpoint) return 'drop'
      if (!this.#advertises(entry.device, entry.role)) return 'park'
      this.#carried(entry.device, state, track, receiver, entry.role)
      return 'carried'
    }
    const owner = this.#trackOwner.get(track.id)
    if (owner !== undefined && owner !== endpoint) {
      const route = this.#routes.get(owner)
      const state = this.#assisted.get(owner)
      if (route?.tier === 'assist' && route.endpoint === endpoint && state?.volunteer === endpoint) {
        // A carrier that can choose its track ids - not a browser - and the
        // roster agrees. The same checks as `carry`, by another name.
        this.#carried(owner, state, track, receiver, this.#trackRoles.get(track.id))
        return 'carried'
      }
    }
    if (owner === endpoint) return 'own'
    const carriesForUs = [...this.#assisted.values()].some((state) => state.volunteer === endpoint)
    if (carriesForUs) return 'park'
    // Nobody is being carried through this endpoint, so it is its own -
    // unless it was parked as possibly carried, which it now cannot be.
    return parked ? 'drop' : 'own'
  }

  /** Try every parked track again: the roster, the `carry` map or the route
   *  may have caught up. */
  #recheckParked(): void {
    if (this.#parked.length === 0) return
    const parked = this.#parked
    this.#parked = []
    for (const held of parked) {
      if (held.track.readyState === 'ended') continue
      const verdict = this.#attribute(held.endpoint, held.track, held.receiver, held.mid, true)
      if (verdict === 'park') this.#parked.push(held)
      else if (verdict === 'own') this.#ownTrack(held.endpoint, held.track, held.receiver)
    }
  }

  /** A track carried for `device` has arrived through its volunteer. */
  #carried(device: string, state: AssistState, track: MediaStreamTrack, receiver: unknown, role?: TrackRole): void {
    if (!state.tracks.some((held) => held.track === track)) {
      // A fresh track gets the whole stall window from its arrival.
      state.tracks.push({ track, receiver, ...(role !== undefined ? { role } : {}), bytes: 0, progressAt: Date.now() })
    }
    this.#emitTrack(device, track, 'assist', role)
    this.#watchAssist(device)
  }

  /**
   * Attribute a track that arrived over the forwarder.
   *
   * Every forwarded track arrives on the same connection, so the connection
   * says nothing about who sent it. The roster does: it is signed by the
   * publishing device and encrypted to the room key, so the forwarder can
   * neither write it nor read it. A track the roster does not advertise is
   * **dropped**, never attributed - not to the forwarder, which is not a
   * participant and has no place in anybody's view of the room, and not to
   * nobody, which would put an unlabelled tile on screen.
   *
   * What the forwarder still chooses is which stream carries which track id,
   * so this is a hint. `deriveMediaKey`'s per-sender binding is what settles
   * it: a relabelled stream does not decrypt.
   */
  #onForwardedTrack(track: MediaStreamTrack, receiver: unknown): void {
    const device = this.#trackOwner.get(track.id)
    if (!device) return
    try {
      if (this.#opts.forwarderMediaPipeline?.protectReceiver(receiver, device, track) !== true) return
    } catch {
      return
    }
    this.#emitTrack(device, track, 'forwarder')
  }

  /** Attach protection before an offer can carry a local sender to the
   * forwarder. An exception is a refusal: media security is fail-closed. */
  #protectForwarderSender(sender: unknown, track: MediaStreamTrack): boolean {
    try {
      return this.#opts.forwarderMediaPipeline?.protectSender(sender, this.#opts.localDevice, track) === true
    } catch {
      return false
    }
  }

  #emitTrack(device: string, track: MediaStreamTrack, via: 'direct' | 'assist' | 'forwarder', role?: TrackRole): void {
    const participant = this.#deviceToParticipant.get(device)
    if (!participant) return
    const remote: RemoteTrack = { participant, device, track, via }
    if (role !== undefined) remote.role = role
    const retiring = this.#retiringPeers.get(device)
    if (retiring) {
      // Leave the old media attached until the replacement can render it.
      // Keep only the latest receiver for a given kind/role during retries.
      const index = retiring.tracks.findIndex(value => value.track.kind === track.kind && value.role === role)
      if (index < 0) retiring.tracks.push(remote)
      else retiring.tracks[index] = remote
      return
    }
    for (const listener of this.#trackListeners) listener(remote)
  }

  /** Never throws - this runs inside a relay subscription handler where a
   *  throw would take down the whole room. Assist and annotation messages
   *  are admitted from their own roster maps before peer lookup; ordinary
   *  SDP/ICE for a device with no current peer is bounded and held or
   *  ignored by the negotiation path below. */
  #onSignalEvent(event: Event): void {
    const now = this.#now()

    // Deduplication first, because it is the cheapest check and the most
    // common case it catches - the same wrap arriving from every relay we
    // published to - costs a NIP-44 decryption otherwise.
    if (!this.#guard.admitEvent(event.id) || !this.#guard.admitUnwrap(now)) return

    const unwrapped = unwrapSignalEvent(event, {
      recipientSk: this.#opts.deviceSk,
      roomId: this.#opts.roomId,
      now,
    })
    if (!unwrapped || !this.#guard.admitEvent(`inner:${unwrapped.id}`)) return

    // Rate limiting last, and against the *sending device* rather than the
    // wrap's pubkey: every wrap is signed by a fresh ephemeral key, so the
    // only stable identity a budget can be held against is the one inside.
    if (unwrapped.body.type === 'annotation') {
      if (!this.#annotationDevices.has(unwrapped.from) || !this.#annotationGuard.admitSender(unwrapped.from, now)) return
    } else if (unwrapped.body.type === 'relay-test' || unwrapped.body.type === 'relay-test-result') {
      if (!this.#annotationDevices.has(unwrapped.from) || !this.#relayTestGuard.admitSender(unwrapped.from, now)) return
    } else if (!this.#guard.admitSender(unwrapped.from, now)) return

    this.#diagnose({ kind: 'signal-received', device: unwrapped.from, detail: unwrapped.body.type })

    if (unwrapped.body.type === 'assist') {
      // Assist requests act immediately rather than waiting for a Peer, so
      // they need their own membership check. Ordinary SDP/ICE from an
      // unknown sender is only held in a bounded queue and can run solely if
      // an admitted roster entry later creates that sender's peer.
      if (!this.#deviceToParticipant.has(unwrapped.from)) return
      const far = unwrapped.body.assist
      if (typeof far !== 'string' || far === '') return
      if (unwrapped.body.release === true) this.#handleAssistRelease(unwrapped.from, far)
      else if (unwrapped.body.accept === undefined) this.#handleAssistRequest(unwrapped.from, far, unwrapped.body.readsCarry === true)
      else this.#handleAssistReply(unwrapped.from, far, unwrapped.body.accept === true)
      return
    }

    if (unwrapped.body.type === 'annotation') {
      const participant = this.#annotationDevices.get(unwrapped.from)
      const annotation = unwrapped.body.annotation
      if (!participant || !annotation) return
      for (const listener of this.#annotationListeners) {
        try {
          listener({ participant, device: unwrapped.from, annotation })
        } catch {
          // Drawing UI cannot disturb signalling or the call.
        }
      }
      return
    }

    if (unwrapped.body.type === 'relay-test' || unwrapped.body.type === 'relay-test-result') {
      // Admitted by the roster above, never by a peer: a host and its tester
      // usually have no connection open to each other.
      const participant = this.#annotationDevices.get(unwrapped.from)
      if (!participant || !unwrapped.body.relayTest) return
      const message = { participant, device: unwrapped.from, createdAt: unwrapped.createdAt, type: unwrapped.body.type, relayTest: unwrapped.body.relayTest } as RemoteRelayTest
      for (const listener of this.#relayTestListeners) {
        try {
          listener(message)
        } catch {
          // A test cannot disturb signalling or the call.
        }
      }
      return
    }

    if (unwrapped.body.type === 'offer' && unwrapped.body.tier === 'turn') this.#followRung(unwrapped.from)
    // Before the offer is applied, because applying it is what fires
    // `ontrack` for the m-lines it names. Every offer replaces the map: one
    // with no `carry` says this sender carries nobody to us any more.
    if (unwrapped.body.type === 'offer') {
      if (unwrapped.body.carry) {
        this.#carryIn.set(unwrapped.from, unwrapped.body.carry)
        // Carrying somebody to this device that it is not asking for - a
        // release that was lost, a hold that outlived it - is consent this
        // device no longer gives. Taken back at once.
        for (const entry of Object.values(unwrapped.body.carry)) {
          const state = this.#assisted.get(entry.device)
          if (state?.volunteer !== unwrapped.from) this.#releaseUnexpected(unwrapped.from, entry.device)
        }
      } else this.#carryIn.delete(unwrapped.from)
    }

    // §2.3's roster-lag rule, and it has to run before the peer is looked up:
    // the whole point is that the peer this signal reaches may be the wrong
    // kind for the far end that sent it.
    if (unwrapped.body.gen !== undefined) this.#noteProfile2Evidence(unwrapped.from, unwrapped.body)

    const peer = this.#peerFor(unwrapped.from)
    if (!peer) {
      // Stood down: this page session is not the one the far end is
      // negotiating with, so it neither answers nor keeps the signal to
      // answer later - see `standDown`. Held, it would be drained into a
      // fresh connection as a description of one that is already gone.
      if (!this.#quiet) this.#holdSignal(unwrapped.from, unwrapped.body, unwrapped.createdAt)
      return
    }
    // A rejection here is a description the connection would not take, which
    // is the one failure mode that produces no answer and no error anywhere.
    // It stays out of the subscription handler's way and goes to diagnostics
    // instead of nowhere.
    peer.handleSignal(unwrapped.body).catch((error) =>
      this.#diagnose({
        kind: 'signal-handling-failed',
        device: unwrapped.from,
        detail: `${unwrapped.body.type}: ${describeError(error)}`,
      }),
    )
    if (unwrapped.body.type === 'offer') this.#armRouteTimerForOffer(unwrapped.from)
    this.#watchNegotiation(unwrapped.from, unwrapped.body)
    if (unwrapped.body.type === 'ice') this.#candidateCrossed(unwrapped.from)
  }

  /**
   * The far end has reached TURN and is offering from there. Meet it.
   *
   * Only from the direct rung, and only while that rung has not connected:
   * a pair that is connected directly has no reason to move, and a pair
   * being carried by a volunteer is reached at the volunteer's address, not
   * this one. The direct connection is closed first, so the peer opened on
   * the TURN rung - which is what the offer is answered on - is the only
   * one this device holds for the far end, exactly as after its own timer
   * would have escalated it. `#escalate` is deliberately not used: it would
   * try a volunteer or a forwarder first, and the far end is on neither.
   */
  #followRung(device: string): void {
    const route = this.#routes.get(device)
    if (!route || route.connected) return
    // A route through a volunteer that never brought anything is no reason
    // to stay put when the far end has moved on: with an old volunteer that
    // ignores `release` and a far end with nothing to send, nothing else
    // would ever move it.
    if (route.tier === 'assist') this.#leaveAssist(device, true)
    else if (route.tier !== 'direct') return
    const peer = this.#peers.get(device)
    if (peer) this.#closePeer(device, peer)
    route.tier = 'turn'
    route.endpoint = device
    route.connected = false
    this.#announceRoute(device, route)
    this.#reconcile(this.#opts.session.participants())
  }

  /**
   * The peer a signal from this device belongs to.
   *
   * The forwarder is one too. It is deliberately not in `#peers` - it is not
   * a member of the room and must never be treated as one by anything that
   * walks that map - but it is still a connection this device opened and
   * still the far end of a negotiation. Looking only in `#peers` meant the
   * forwarder's answer to our offer was dropped, and since a forwarder never
   * offers ("only an offer is an arrival"), that answer was the whole
   * negotiation.
   */
  #peerFor(device: string): NegotiatingPeer | undefined {
    if (this.#forwarderPeer && this.#forwarderDevice === device) return this.#forwarderPeer
    return this.#peers.get(device)
  }

  /**
   * Hold a signal for a device we have no peer for yet.
   *
   * Not the same thing as a signal we do not want. Both ends of a pair learn
   * about each other from the same roster event, and whichever one reconciles
   * first opens its connection and offers immediately - into a far end that
   * is, for a few tens of milliseconds, still building the peer that offer
   * belongs to. Dropping it there is not a near miss: the offerer has already
   * set its local description and sits in `have-local-offer` waiting for an
   * answer nobody will ever send, and nothing re-sends an offer. Measured in
   * a browser, the pair then sat dead until the route timer gave up on it ten
   * seconds later and rebuilt it a rung lower - and a route timer that fires
   * on the *other* side in that same window would tear down the connection
   * that finally worked. Two people watched a blank tile for ten seconds, and
   * a third of the time never got a picture at all.
   *
   * So the early ones wait. `#reconcile` drains them the moment the peer they
   * were addressed to exists, which is the whole of the fix: the roster still
   * decides who this device peers with, and nothing here opens a connection
   * to anybody it does not already want one with.
   */
  #holdSignal(device: string, body: SignalBody, createdAt: number): void {
    const held = this.#pendingSignals.get(device) ?? []
    held.push({ body, createdAt })
    // Bounded twice, because both are unbounded otherwise: a device that
    // never joins would hold its signals for ever, and any sender can name
    // a device that does not exist.
    while (held.length > MAX_HELD_SIGNALS_PER_DEVICE) held.shift()
    this.#pendingSignals.set(device, held)
    while (this.#pendingSignals.size > MAX_HELD_SIGNAL_DEVICES) {
      const oldest = this.#pendingSignals.keys().next().value
      if (oldest === undefined) break
      this.#pendingSignals.delete(oldest)
    }
  }

  /** Hand a new peer whatever arrived for it before it existed, oldest
   *  first, dropping anything that has since gone stale by the same rule
   *  `unwrapSignal` applies on the way in. */
  #drainSignals(device: string, peer: NegotiatingPeer): void {
    const held = this.#pendingSignals.get(device)
    if (!held) return
    this.#pendingSignals.delete(device)
    const now = this.#now()
    let offered = false
    for (const { body, createdAt } of held) {
      if (Math.abs(now - createdAt) > SIGNAL_MAX_AGE_SECONDS) {
        this.#diagnose({ kind: 'signal-dropped-as-stale', device, detail: body.type })
        continue
      }
      peer.handleSignal(body).catch((error) =>
        this.#diagnose({ kind: 'signal-handling-failed', device, detail: `${body.type}: ${describeError(error)}` }),
      )
      if (body.type === 'offer') offered = true
    }
    if (offered) this.#armRouteTimerForOffer(device)
  }
}
