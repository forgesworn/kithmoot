import type { Event } from 'nostr-tools/pure'
import { Peer } from './peer.js'
import type { PeerFactory } from './peer.js'
import { wrapSignal, unwrapSignal } from './signal.js'
import { SignalGuard } from './signal-guard.js'
import { KINDS } from './kinds.js'
import type { RelayTransport } from './relay-pool.js'
import type { ParticipantView } from './session.js'

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
}

export interface RemoteTrack {
  participant: string
  device: string
  track: MediaStreamTrack
}

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
  readonly #trackListeners = new Set<(t: RemoteTrack) => void>()
  /** Staleness, deduplication and rate limiting - the three rules §3 of the
   *  design says signalling reuses from NIP-AC. */
  readonly #guard = new SignalGuard()
  readonly #now: () => number
  #tracks: MediaStreamTrack[] = []
  readonly #unsubSession: () => void
  readonly #unsubSignal: () => void
  #closed = false

  constructor(opts: MeshOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))

    this.#unsubSignal = opts.transport.subscribe(
      [{ kinds: [KINDS.SIGNAL_WRAP], '#p': [opts.localDevice] }],
      (event) => this.#onSignalEvent(event),
    )

    this.#unsubSession = opts.session.onChange((views) => this.#reconcile(views))
    this.#reconcile(opts.session.participants())
  }

  /** Publish tracks to every current peer. Own devices never receive them,
   *  because they never have a peer connection in the first place. */
  publish(tracks: MediaStreamTrack[]): void {
    this.#tracks = tracks
    for (const peer of this.#peers.values()) peer.start(tracks).catch(() => {})
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
    for (const peer of this.#peers.values()) peer.close()
    this.#peers.clear()
    this.#deviceToParticipant.clear()
    this.#trackListeners.clear()
  }

  /** Reconcile the peer set against a roster snapshot: close peers for
   *  devices no longer present, open peers for newly-seen remote devices,
   *  and never touch our own participant's devices either way. */
  #reconcile(views: ParticipantView[]): void {
    const wantedDevices = new Map<string, string>() // device -> participant
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
    }

    for (const [device, peer] of this.#peers) {
      if (wantedDevices.has(device)) continue
      peer.close()
      this.#peers.delete(device)
      this.#deviceToParticipant.delete(device)
    }

    for (const [device, participant] of wantedDevices) {
      if (this.#peers.has(device)) continue
      this.#deviceToParticipant.set(device, participant)
      const peer = this.#createPeer(device)
      this.#peers.set(device, peer)
      peer.start(this.#tracks).catch(() => {})
    }
  }

  #createPeer(remoteDevice: string): Peer {
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
        const participant = this.#deviceToParticipant.get(remoteDevice)
        if (!participant) return
        for (const listener of this.#trackListeners) listener({ participant, device: remoteDevice, track })
      },
    })
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
