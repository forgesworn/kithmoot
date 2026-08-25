import type { Event } from 'nostr-tools/pure'
import { Peer } from './peer.js'
import type { PeerFactory } from './peer.js'
import { wrapSignal, unwrapSignal } from './signal.js'
import { SignalGuard } from './signal-guard.js'
import { KINDS } from './kinds.js'
import type { RelayTransport } from './relay-pool.js'
import type { ParticipantView } from './session.js'
import { needsForwarding, selectForwarder } from './forwarder.js'
import type { CapacityEstimate, ForwarderRef } from './forwarder.js'
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
  /** Forwarders the room descriptor names. Swappable at runtime; see
   *  `setForwarders`. */
  forwarders?: ForwarderRef[]
  /** A forwarder pubkey or url to prefer over the deterministic ordering. */
  preferForwarder?: string
  /** How long a forwarder has to connect before the room gives up on it and
   *  stays a mesh. See `DEFAULT_FORWARDER_TIMEOUT_MS`. */
  forwarderTimeoutMs?: number
}

export interface RemoteTrack {
  participant: string
  device: string
  track: MediaStreamTrack
  /**
   * How this track reached us.
   *
   * `direct` is attributed by which peer connection it arrived on, which
   * nothing but the two endpoints controls. `forwarder` is attributed by
   * matching the track against the roster's own signed, room-key-encrypted
   * adverts - because through a forwarder every track arrives on the same
   * connection, and the forwarder chooses which stream carries which id.
   *
   * That match is a *hint*, and the app must not treat it as more than one:
   * what settles attribution is which member's media key opens the frames
   * (`deriveMediaKey`, `resolveFrameSender`). A forwarder that relabels one
   * member's stream as another's produces frames that will not decrypt.
   */
  via: 'direct' | 'forwarder'
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
  readonly #unsubSession: () => void
  readonly #unsubSignal: () => void
  #closed = false

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
  publish(tracks: MediaStreamTrack[]): void {
    this.#tracks = tracks
    for (const peer of this.#peers.values()) peer.start(tracks).catch(() => {})
    this.#forwarderPeer?.start(tracks).catch(() => {})
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

    // Decided before any peer is opened or closed, because the answer governs
    // both. `wantedDevices.size` is the `(N-1)` in `(N-1) x bitrate`: the
    // devices this one would have to send its own media to.
    this.#evaluatePromotion(wantedDevices.size)

    const direct = this.#forwarding !== 'up'

    for (const [device, peer] of this.#peers) {
      if (direct && wantedDevices.has(device)) continue
      peer.close()
      this.#peers.delete(device)
    }

    if (!direct) return

    for (const [device] of wantedDevices) {
      if (this.#peers.has(device)) continue
      const peer = this.#createPeer(device)
      this.#peers.set(device, peer)
      peer.start(this.#tracks).catch(() => {})
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
    const want = this.#needsForwarding(peers)

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

  #createPeer(remoteDevice: string, forwarder = false): Peer {
    return new Peer({
      factory: this.#opts.factory,
      localDevice: this.#opts.localDevice,
      remoteDevice,
      onSignal: (body) => {
        const wrap = wrapSignal(
          { ...body, roomId: this.#opts.roomId },
          { senderSk: this.#opts.deviceSk, recipientPubkey: remoteDevice },
        )
        this.#opts.transport.publish(wrap).catch(() => {})
      },
      onTrack: (track) => {
        if (forwarder) this.#onForwardedTrack(track)
        else this.#emitTrack(remoteDevice, track, 'direct')
      },
      ...(forwarder
        ? {
            onConnectionState: (state: RTCPeerConnectionState) => {
              if (this.#tearingDownForwarder) return
              if (state === 'connected') this.#forwarderConnected()
              else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                this.#forwarderFailed()
              }
            },
          }
        : {}),
    })
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

  #emitTrack(device: string, track: MediaStreamTrack, via: 'direct' | 'forwarder'): void {
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

    const peer = this.#peers.get(unwrapped.from)
    if (!peer) return
    peer.handleSignal(unwrapped.body).catch(() => {})
  }
}
