import type { Event } from 'nostr-tools/pure'
import { Peer } from './peer.js'
import type { NegotiatingPeer, PeerFactory } from './peer.js'
import { SlotPeer } from './slot-peer.js'
import { PairController } from './pair-controller.js'
import type { PairDiagnostics } from './pair-controller.js'
import type { RoleResolver } from './peer-slots.js'
import { wrapSignal, unwrapSignalEvent, SIGNAL_MAX_AGE_SECONDS } from './signal.js'
import type { ScreenAnnotation, SignalBody } from './signal.js'
import { SignalGuard } from './signal-guard.js'
import { KINDS } from './kinds.js'
import type { RelayTransport } from './relay-pool.js'
import type { ParticipantView } from './session.js'
import { needsForwarding, selectForwarder } from './forwarder.js'
import type { CapacityEstimate, ForwarderRef } from './forwarder.js'
import { selectAssistant } from './peer-assist.js'
import type { AssistVolunteer } from './peer-assist.js'
import type { PeerRelay, RelayPair } from './peer-relay.js'
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
  /** Called when this device takes on a pair to carry. The app wires the
   *  actual frame pumps against its real connections - see `peer-relay.ts` -
   *  because `RTCPeerConnectionLike` deliberately does not expose senders and
   *  receivers, and neither should a protocol library. */
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
   * `assist` and `forwarder` are attributed by matching the track against the
   * roster's own signed, room-key-encrypted adverts - because through either
   * of them somebody else's media arrives on a connection to a third party,
   * and it is that third party who chooses which stream carries which id.
   *
   * That match is a *hint*, and the app must not treat it as more than one:
   * what settles attribution is which member's media key opens the frames
   * (`deriveMediaKey`, `resolveFrameSender`). A relay - ours, a stranger's
   * laptop, anybody's - that relabels one member's stream as another's
   * produces frames that will not decrypt.
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
   * Absent for a profile-1 peer, and for a forwarded or assisted track, where
   * the roster advert remains the only hint there is.
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
export class Mesh {
  readonly #opts: MeshOptions
  readonly #peers = new Map<string, NegotiatingPeer>()
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
  readonly #annotationListeners = new Set<(annotation: RemoteAnnotation) => void>()
  /** Staleness, deduplication and rate limiting - the three rules §3 of the
   *  design says signalling reuses from NIP-AC. */
  readonly #guard = new SignalGuard()
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
  /** Signals that arrived for a device this mesh has no peer for yet, by
   *  sending device, oldest first. See `#holdSignal`. */
  readonly #pendingSignals = new Map<string, { body: SignalBody; at: number }[]>()
  /** One timer per endpoint, bounding how long a rung gets. */
  readonly #routeTimers = new Map<string, ReturnType<typeof setTimeout>>()
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

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubSession()
    this.#unsubSignal()
    this.#teardownForwarder()
    for (const endpoint of [...this.#routeTimers.keys()]) this.#clearRouteTimer(endpoint)
    for (const endpoint of [...this.#renegotiationTimers.keys()]) this.#clearRenegotiationTimer(endpoint)
    for (const device of [...this.#retryTimers.keys()]) this.#clearRetryTimer(device)
    this.#publishRetryAt.clear()
    this.#opts.relay?.close()
    this.#routes.clear()
    this.#volunteers.clear()
    this.#pendingSignals.clear()
    for (const peer of this.#peers.values()) peer.close()
    this.#peers.clear()
    this.#peerSids.clear()
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
    try {
      this.#opts.forwarderMediaPipeline?.close?.()
    } catch {
      // A browser worker that is already gone is not a reason to leave the
      // room's relay subscriptions or peer connections alive.
    }
  }

  /** Reconcile the peer set against a roster snapshot: close peers for
   *  devices no longer present, open peers for newly-seen remote devices,
   *  including our other devices, but never this device itself. */
  #reconcile(views: ParticipantView[]): void {
    if (this.#closed) return

    this.#views = views
    const wantedDevices = new Map<string, string>() // device -> participant
    const annotationDevices = new Map<string, string>() // every other admitted room device
    this.#trackOwner.clear()
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
        wantedDevices.set(device, view.participant)
      }
      // Track adverts are kept for every remote device whether or not it has
      // a direct peer, because when a forwarder is carrying the room none of
      // them do and this map is the only attribution there is.
      for (const advert of view.tracks) {
        if (advert.device === this.#opts.localDevice) continue
        this.#trackOwner.set(advert.trackId, advert.device)
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

    if (!direct) return

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
        this.#routes.delete(device)
        this.#clearRetryTimer(device)
        // The pair itself has gone, which is the one thing that ends a
        // profile-2 pair's controller: §3.4's "while both devices are in the
        // roster" is exactly this check.
        this.#controllers.get(device)?.close()
        this.#controllers.delete(device)
        this.#profile2Evidence.delete(device)
        // We may have been carrying this device for somebody. Holding the
        // slot open would cost a slot we could give somebody else.
        this.#stopRelayingFor(device)
      }
    }

    for (const device of wantedDevices.keys()) {
      if (this.#routes.has(device)) continue
      this.#routes.set(device, { tier: 'direct', endpoint: device, connected: false, exhausted: false, failed: [], retries: 0 })
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

  #closePeer(endpoint: string, peer: NegotiatingPeer): void {
    this.#peers.delete(endpoint)
    this.#peerSids.delete(endpoint)
    // Detached, not closed: the controller outlives any one connection, and
    // a rebuild's peer is attached to the same one a moment later.
    if (this.#controllers.get(endpoint)?.peer === peer) this.#controllers.get(endpoint)!.detach()
    this.#clearRouteTimer(endpoint)
    this.#clearRenegotiationTimer(endpoint)
    this.#publishRetryAt.delete(endpoint)
    this.#closingEndpoints.add(endpoint)
    try {
      peer.close()
    } finally {
      this.#closingEndpoints.delete(endpoint)
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
    this.#clearRouteTimer(endpoint)
    this.#controllers.get(endpoint)?.connected()
    for (const [device, route] of this.#routes) {
      if (route.endpoint !== endpoint || route.connected) continue
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
    route.tier = 'direct'
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
    const volunteers: AssistVolunteer[] = []
    for (const [candidate, offer] of this.#volunteers) {
      if (candidate === device) continue
      const theirs = this.#routes.get(candidate)
      if (!theirs || theirs.tier !== 'direct' || !theirs.connected) continue
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
    const wrap = wrapSignal(
      { ...body, roomId: this.#opts.roomId } as SignalBody,
      { senderSk: this.#opts.deviceSk, recipientPubkey: to },
    )
    this.#opts.transport.publish(wrap).catch((error) =>
      this.#diagnose({ kind: 'signal-publish-failed', device: to, detail: `${body.type}: ${describeError(error)}` }),
    )
  }

  #requestAssist(device: string, assistant: string): void {
    this.#send(assistant, { type: 'assist', assist: device })
    // The request gets the same budget a connection attempt does. A volunteer
    // that never answers is a volunteer that has gone, and waiting on it is
    // indistinguishable to the person watching a blank tile.
    this.#armRouteTimer(assistant)
  }

  /**
   * Somebody has asked this device to carry a pair.
   *
   * Refused unless this device volunteered - `relay` is only present because
   * a person turned it on - and unless both ends are people we are actually
   * connected to, since a pair we cannot reach is one we cannot carry. A
   * refusal is answered at once rather than ignored, because the asker's
   * alternative is waiting out a timeout before trying the next rung.
   */
  #handleAssistRequest(from: string, far: string): void {
    const relay = this.#opts.relay
    const other = normaliseHex(far)
    const reachable = (device: string): boolean => this.#routes.get(device)?.connected === true

    const offering = this.#opts.offering?.() ?? true
    if (!relay || !offering || other === '' || other === from || !reachable(from) || !reachable(other)) {
      this.#send(from, { type: 'assist', assist: other, accept: false })
      return
    }

    const pair = relay.admit(from, other)
    this.#send(from, { type: 'assist', assist: other, accept: pair !== null })
    if (!pair) return
    try {
      this.#opts.onRelayStart?.(pair)
    } catch {
      // Wiring frames is the app's job and its mistakes are its own.
    }
  }

  /** The answer to a request we made. */
  #handleAssistReply(from: string, far: string, accepted: boolean): void {
    const route = this.#routes.get(normaliseHex(far))
    if (!route || route.tier !== 'assist' || route.endpoint !== from) return
    if (accepted) {
      this.#clearRouteTimer(from)
      // The connection to this volunteer is already up - that was a condition
      // of choosing it - so the route is working the moment it says yes.
      route.connected = true
      this.#announceRoute(normaliseHex(far), route)
      return
    }
    this.#escalate(normaliseHex(far))
    this.#reconcile(this.#opts.session.participants())
  }

  /** Stop carrying anything involving `device`, and say so. */
  #stopRelayingFor(device: string): void {
    const relay = this.#opts.relay
    if (!relay) return
    for (const pair of relay.pairs) {
      if (pair.a !== device && pair.b !== device) continue
      relay.drop(pair.a, pair.b)
      try {
        this.#opts.onRelayStop?.(pair)
      } catch {
        // As above.
      }
    }
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
      onRestOver: () => this.#retryRoute(device),
      onDiagnostic: (detail) => this.#diagnose({ kind: 'pair-ladder', device, detail }),
      rest: {
        baseMs: this.#opts.exhaustedRetryMs,
        maxMs: this.#opts.maxExhaustedRetryMs,
      },
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

  /** Every profile-2 pair's state, for the bug report. See §8, step S12. */
  pairDiagnostics(): PairDiagnostics[] {
    return [...this.#controllers.values()].map((controller) => controller.summary())
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
        const wrap = wrapSignal({ ...body, roomId: this.#opts.roomId }, { senderSk: this.#opts.deviceSk, recipientPubkey: endpoint })
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
    const sid = this.#deviceSids.get(endpoint)
    if (sid === undefined) this.#peerSids.delete(endpoint)
    else this.#peerSids.set(endpoint, sid)
    this.#armRouteTimerIfNeeded(endpoint)
    peer.start(this.#tracksFor(endpoint)).catch(() => {})
    peer.handleSignal(body).catch((error) =>
      this.#diagnose({ kind: 'signal-handling-failed', device: endpoint, detail: `${body.type}: ${describeError(error)}` }),
    )
    if (body.type === 'offer') this.#armRouteTimerForOffer(endpoint)
  }

  #createPeer(remoteDevice: string, forwarder = false, tier: RouteTier = 'direct'): Peer {
    return new Peer({
      factory: this.#opts.factory,
      localDevice: this.#opts.localDevice,
      remoteDevice,
      context: { tier: forwarder ? 'forwarder' : tier, remoteDevice },
      iceRestart: this.#opts.iceRestart,
      offerRetry: this.#opts.offerRetry,
      onSignal: (body) => {
        // An offer says which rung it was made on, so the far end can meet
        // it there - see `SignalBody.tier` and `#followRung`.
        const rung = !forwarder && body.type === 'offer' ? { tier } : {}
        const wrap = wrapSignal(
          { ...body, ...rung, roomId: this.#opts.roomId },
          { senderSk: this.#opts.deviceSk, recipientPubkey: remoteDevice },
        )
        // Not fire and forget any more. A relay that rejects a publish has
        // taken this device's only copy of a signal the far end will never
        // know to ask for, and the empty `catch` that used to be here is why
        // that looked exactly like a pair with nothing to say.
        this.#opts.transport.publish(wrap).catch((error) => this.#signalPublishFailed(remoteDevice, body as SignalBody, error))
        if (!forwarder) {
          this.#watchNegotiation(remoteDevice, body as SignalBody)
          this.#diagnose({ kind: 'signal-sent', device: remoteDevice, detail: (body as SignalBody).type })
        }
      },
      onTrack: (track, receiver) => {
        if (forwarder) this.#onForwardedTrack(track, receiver)
        else this.#onEndpointTrack(remoteDevice, track)
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
            this.#diagnose({ kind: 'connection-state-change', device: remoteDevice, detail: state })
            if (state === 'connected') this.#endpointConnected(remoteDevice)
            else if (state === 'failed' || state === 'closed') this.#endpointFailed(remoteDevice)
          },
    })
  }

  /**
   * Attribute a track that arrived on an ordinary endpoint.
   *
   * Almost always the endpoint's own media, which is what a direct connection
   * means. The exception is a volunteer carrying somebody else's: then the
   * roster - signed by the publishing device, encrypted to the room key,
   * neither writable nor readable by the volunteer - says whose it is, and
   * the route says we asked that volunteer to carry exactly that person.
   * Both have to agree before a track is attributed to anybody but the
   * endpoint it arrived on.
   */
  #onEndpointTrack(endpoint: string, track: MediaStreamTrack, role?: TrackRole): void {
    const owner = this.#trackOwner.get(track.id)
    if (owner !== undefined && owner !== endpoint) {
      const route = this.#routes.get(owner)
      if (route?.tier === 'assist' && route.endpoint === endpoint) {
        // A volunteer's connection carries somebody else's media, so its
        // slots are the volunteer's and say nothing about whose track this
        // is. The advert is the only hint there is on that path.
        this.#emitTrack(owner, track, 'assist')
        return
      }
    }
    this.#emitTrack(endpoint, track, 'direct', role)
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
    if (!this.#guard.admitSender(unwrapped.from, now)) return

    this.#diagnose({ kind: 'signal-received', device: unwrapped.from, detail: unwrapped.body.type })

    if (unwrapped.body.type === 'assist') {
      // Assist requests act immediately rather than waiting for a Peer, so
      // they need their own membership check. Ordinary SDP/ICE from an
      // unknown sender is only held in a bounded queue and can run solely if
      // an admitted roster entry later creates that sender's peer.
      if (!this.#deviceToParticipant.has(unwrapped.from)) return
      const far = unwrapped.body.assist
      if (typeof far !== 'string' || far === '') return
      if (unwrapped.body.accept === undefined) this.#handleAssistRequest(unwrapped.from, far)
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

    if (unwrapped.body.type === 'offer' && unwrapped.body.tier === 'turn') this.#followRung(unwrapped.from)

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
      if (!this.#quiet) this.#holdSignal(unwrapped.from, unwrapped.body, now)
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
    if (!route || route.tier !== 'direct' || route.connected) return
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
  #holdSignal(device: string, body: SignalBody, now: number): void {
    const held = this.#pendingSignals.get(device) ?? []
    held.push({ body, at: now })
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
    const cutoff = this.#now() - SIGNAL_MAX_AGE_SECONDS
    let offered = false
    for (const { body, at } of held) {
      if (at < cutoff) {
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
