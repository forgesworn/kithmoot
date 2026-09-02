import type { Event } from 'nostr-tools/pure'
import { Peer } from './peer.js'
import type { PeerFactory } from './peer.js'
import { wrapSignal, unwrapSignal, SIGNAL_MAX_AGE_SECONDS } from './signal.js'
import type { SignalBody } from './signal.js'
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
import type { AssistOffer } from './types.js'
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
   *  is sent again, and how many times. See `PeerOptions.offerRetry`. */
  offerRetry?: { intervalMs?: number; max?: number }
  /** Forwarders the room descriptor names. Swappable at runtime; see
   *  `setForwarders`. */
  forwarders?: ForwarderRef[]
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
  /** How long an exhausted route rests before the ladder is retried from
   *  the top. See `EXHAUSTED_RETRY_MS`. */
  exhaustedRetryMs?: number
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
 * Devices belonging to our own participant are deliberately excluded: they
 * coordinate over the room channel, never over media - otherwise a phone
 * would open a connection to its own laptop and upload its screen share
 * straight back to itself.
 *
 * A remote track is always reported against the device's *participant*,
 * never the device itself: two devices of one remote person yield two peer
 * connections but must read as one person in attribution, which is the
 * entire product.
 */
export class Mesh {
  readonly #opts: MeshOptions
  readonly #peers = new Map<string, Peer>()
  readonly #deviceToParticipant = new Map<string, string>()
  /** Track id -> the device the roster says publishes it. The only
   *  attribution available for a track that arrives over a forwarder, since
   *  every one of them arrives on the same connection. */
  readonly #trackOwner = new Map<string, string>()
  readonly #trackListeners = new Set<(t: RemoteTrack) => void>()
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
    for (const [endpoint, peer] of this.#peers) {
      peer.start(this.#tracksFor(endpoint)).catch(() => {})
      // A connection that was idle because nobody had anything to send now
      // has something, and its rung gets its budget from here.
      this.#armRouteTimerIfNeeded(endpoint)
    }
    this.#forwarderPeer?.start(tracks).catch(() => {})
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

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubSession()
    this.#unsubSignal()
    this.#teardownForwarder()
    for (const endpoint of [...this.#routeTimers.keys()]) this.#clearRouteTimer(endpoint)
    for (const device of [...this.#retryTimers.keys()]) this.#clearRetryTimer(device)
    this.#opts.relay?.close()
    this.#routes.clear()
    this.#volunteers.clear()
    this.#pendingSignals.clear()
    for (const peer of this.#peers.values()) peer.close()
    this.#peers.clear()
    this.#deviceToParticipant.clear()
    this.#trackOwner.clear()
    this.#trackListeners.clear()
  }

  /** Reconcile the peer set against a roster snapshot: close peers for
   *  devices no longer present, open peers for newly-seen remote devices,
   *  and never touch our own participant's devices either way. */
  #reconcile(views: ParticipantView[]): void {
    if (this.#closed) return

    this.#views = views
    const wantedDevices = new Map<string, string>() // device -> participant
    this.#trackOwner.clear()
    for (const view of views) {
      // Every device of our own participant is skipped, whether or not our
      // own roster entry has come back from the relay yet.
      if (view.participant === this.#opts.localParticipant) continue
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
        if (view.participant === this.#opts.localParticipant) continue
        if (advert.device === this.#opts.localDevice) continue
        this.#trackOwner.set(advert.trackId, advert.device)
      }
    }

    // The roster is the whole answer to who is here, so this map tracks it
    // rather than the peer set - a forwarded track's device has to resolve to
    // a participant even though it has no direct peer.
    this.#deviceToParticipant.clear()
    for (const [device, participant] of wantedDevices) this.#deviceToParticipant.set(device, participant)

    this.#collectVolunteers(views)
    this.#reconcileRoutes(wantedDevices)

    // Decided before any peer is opened or closed, because the answer governs
    // both. `wantedDevices.size` is the `(N-1)` in `(N-1) x bitrate`: the
    // devices this one would have to send its own media to.
    this.#evaluatePromotion(wantedDevices.size)

    const direct = this.#forwarding !== 'up'

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
      if (endpoints.has(endpoint)) continue
      this.#closePeer(endpoint, peer)
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
      const peer = this.#createPeer(endpoint, false, this.#tierOfEndpoint(endpoint))
      this.#peers.set(endpoint, peer)
      this.#armRouteTimerIfNeeded(endpoint)
      peer.start(this.#tracksFor(endpoint)).catch(() => {})
      // After `start`, never before: the offer waiting here is answered by
      // the peer, and the answer has to carry our own tracks. Both are
      // queued on the peer, so this ordering is what puts them in it.
      this.#drainSignals(endpoint, peer)
    }
  }

  /**
   * Whether a connection to this endpoint has anything to carry, in either
   * direction: tracks of ours it is due, or tracks the roster says the far
   * end publishes.
   *
   * A pair with nothing to carry never negotiates - neither side offers,
   * because an offer with no media in it negotiates nothing - and so never
   * connects, and used to be treated as a rung that failed. Two people with
   * their cameras off, or a person and an agent that is here to read the
   * chat, walked the whole ladder to TURN and were declared unreachable,
   * every thirty seconds, for as long as they were in the room together.
   * The connection is kept - it costs nothing idle, and it is where the
   * media will go the moment either side has some - but the clock on it
   * does not start until there is something for it to carry.
   */
  #needsMedia(endpoint: string): boolean {
    if (this.#tracksFor(endpoint).length > 0) return true
    const participant = this.#deviceToParticipant.get(endpoint)
    const view = this.#views.find((v) => v.participant === participant)
    return view?.tracks.some((t) => t.device === endpoint) ?? false
  }

  #armRouteTimerIfNeeded(endpoint: string): void {
    if (this.#routeTimers.has(endpoint)) return
    if (this.#routes.get(endpoint)?.connected) return
    if (!this.#needsMedia(endpoint)) return
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
        // We may have been carrying this device for somebody. Holding the
        // slot open would cost a slot we could give somebody else.
        this.#stopRelayingFor(device)
      }
    }

    for (const device of wantedDevices.keys()) {
      if (this.#routes.has(device)) continue
      this.#routes.set(device, { tier: 'direct', endpoint: device, connected: false, exhausted: false, failed: [] })
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

  #closePeer(endpoint: string, peer: Peer): void {
    this.#peers.delete(endpoint)
    this.#clearRouteTimer(endpoint)
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

  /** A rung worked. */
  #endpointConnected(endpoint: string): void {
    this.#clearRouteTimer(endpoint)
    for (const [device, route] of this.#routes) {
      if (route.endpoint !== endpoint || route.connected) continue
      route.connected = true
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
    const timer = setTimeout(() => {
      this.#retryTimers.delete(device)
      this.#retryRoute(device)
    }, this.#opts.exhaustedRetryMs ?? EXHAUSTED_RETRY_MS)
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
    this.#opts.transport.publish(wrap).catch(() => {})
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
    const want = this.#needsForwarding(peers) || this.#routesWantForwarder()

    if (!want) {
      // The room fits again - fewer people, or a screen share stopped. Give
      // the bandwidth back and return to direct connections.
      if (this.#forwarding !== 'off') {
        this.#teardownForwarder()
        this.#forwarding = 'off'
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
    peer.start(this.#tracks).catch(() => {})
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
  }

  /** The forwarder never came up, or dropped after it had. Back to a direct
   *  mesh, and do not try this one again this session. */
  #forwarderFailed(): void {
    if (this.#forwarding !== 'trying' && this.#forwarding !== 'up') return
    if (this.#forwarderDevice) this.#failedForwarders.add(this.#forwarderDevice)
    this.#teardownForwarder()
    this.#forwarding = 'failed'
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
        this.#opts.transport.publish(wrap).catch(() => {})
      },
      onTrack: (track) => {
        if (forwarder) this.#onForwardedTrack(track)
        else this.#onEndpointTrack(remoteDevice, track)
      },
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
  #onEndpointTrack(endpoint: string, track: MediaStreamTrack): void {
    const owner = this.#trackOwner.get(track.id)
    if (owner !== undefined && owner !== endpoint) {
      const route = this.#routes.get(owner)
      if (route?.tier === 'assist' && route.endpoint === endpoint) {
        this.#emitTrack(owner, track, 'assist')
        return
      }
    }
    this.#emitTrack(endpoint, track, 'direct')
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
  #onForwardedTrack(track: MediaStreamTrack): void {
    const device = this.#trackOwner.get(track.id)
    if (!device) return
    this.#emitTrack(device, track, 'forwarder')
  }

  #emitTrack(device: string, track: MediaStreamTrack, via: 'direct' | 'assist' | 'forwarder'): void {
    const participant = this.#deviceToParticipant.get(device)
    if (!participant) return
    for (const listener of this.#trackListeners) listener({ participant, device, track, via })
  }

  /** Never throws - this runs inside a relay subscription handler where a
   *  throw would take down the whole room. A signal for a device we do not
   *  currently have a peer for (stale, unknown, or already removed) is
   *  simply ignored. */
  #onSignalEvent(event: Event): void {
    const now = this.#now()

    // Deduplication first, because it is the cheapest check and the most
    // common case it catches - the same wrap arriving from every relay we
    // published to - costs a NIP-44 decryption otherwise.
    if (!this.#guard.admitEvent(event.id)) return

    const unwrapped = unwrapSignal(event, {
      recipientSk: this.#opts.deviceSk,
      roomId: this.#opts.roomId,
      now,
    })
    if (!unwrapped) return

    // Rate limiting last, and against the *sending device* rather than the
    // wrap's pubkey: every wrap is signed by a fresh ephemeral key, so the
    // only stable identity a budget can be held against is the one inside.
    if (!this.#guard.admitSender(unwrapped.from, now)) return

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

    if (unwrapped.body.type === 'offer' && unwrapped.body.tier === 'turn') this.#followRung(unwrapped.from)

    const peer = this.#peerFor(unwrapped.from)
    if (!peer) {
      this.#holdSignal(unwrapped.from, unwrapped.body, now)
      return
    }
    peer.handleSignal(unwrapped.body).catch(() => {})
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
  #peerFor(device: string): Peer | undefined {
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
  #drainSignals(device: string, peer: Peer): void {
    const held = this.#pendingSignals.get(device)
    if (!held) return
    this.#pendingSignals.delete(device)
    const cutoff = this.#now() - SIGNAL_MAX_AGE_SECONDS
    for (const { body, at } of held) {
      if (at < cutoff) continue
      peer.handleSignal(body).catch(() => {})
    }
  }
}
