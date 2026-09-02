import { getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { deriveRoom } from './room.js'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'
import { normaliseHex } from './hex.js'
import type { ParticipantIdentity } from './identity.js'
import { sanitiseDisplayName } from './display-name.js'
import { encodeRosterEvent, decodeRosterEvent } from './roster.js'
import { resolveSingularRoles } from './roles.js'
import { KINDS } from './kinds.js'
import { evaluateAccess } from './access.js'
import { Mesh } from './mesh.js'
import type { PeerFactory } from './peer.js'
import type { ForwardingState, RemoteTrack, RouteView } from './mesh.js'
import type { PeerRelay, RelayPair } from './peer-relay.js'
import { encodeDescriptorEvent, decodeDescriptorEvent } from './descriptor.js'
import { ChatLog } from './chat.js'
import type { RelayTransport } from './relay-pool.js'
import type {
  AssistOffer,
  DeviceCredential,
  ForwarderRef,
  IceServerRef,
  KindredProof,
  RoomDescriptor,
  RoomPolicy,
  RosterEntry,
  SingularRole,
  TrackAdvert,
} from './types.js'

/** One person, however many devices they brought. */
export interface ParticipantView {
  participant: string
  /**
   * What this person calls themselves, sanitised - see
   * `sanitiseDisplayName`. Undefined when they never typed one, which is a
   * perfectly ordinary way to be in a room.
   *
   * Self-asserted and unverified, whatever it says. Render it beside
   * `participant`, never instead of it: two people are free to call
   * themselves the same thing, and one of them may have picked the name on
   * purpose.
   */
  name?: string
  devices: string[]
  tracks: Array<TrackAdvert & { device: string }>
  /**
   * Offers this person's devices have made to relay for the room.
   *
   * Absent when none of them is offering, which is the ordinary case and
   * which keeps `ParticipantView` the shape it has always been for callers
   * that do not care. Self-asserted like everything else a device publishes:
   * see `AssistOffer`.
   */
  assist?: Array<AssistOffer & { device: string }>
  /** True when any of this participant's devices declares itself an
   *  automated participant - see `RosterEntry.agent`. */
  agent?: boolean
  /** The single device holding the microphone, if any. */
  mic?: string
  /** The single device playing the room's audio, if any. */
  monitor?: string
}

export interface RoomSessionBaseOptions {
  transport: RelayTransport
  secret: Uint8Array
  /** This endpoint's own key. Never the participant's. */
  deviceSk: Uint8Array
  /** Injectable clock, in unix seconds. Defaults to the real one. */
  now?: () => number
  /** Builds an `RTCPeerConnectionLike` for each remote device. Omit to run
   *  the session with no media - roster, access and chat still work, but
   *  `publishTracks`/`onRemoteTrack` become no-ops. */
  factory?: PeerFactory
  /** The room's admission rule. Omit for an open room. */
  policy?: RoomPolicy
  /** This participant's kindred proof, checked against `policy` at join. */
  proof?: KindredProof
  /**
   * What to call this participant in the room. Sanitised here, so a caller
   * can pass a field straight off a form without laundering it first, and
   * sanitised again by every reader - see `sanitiseDisplayName`.
   *
   * Omit it and the entry carries no name at all, which is exactly what the
   * wire looked like before names existed.
   */
  name?: string
  /** Declare this device an automated participant on every entry it
   *  publishes. See `RosterEntry.agent`. */
  agent?: boolean
  /** Upper bound on the random delay before answering a new arrival, in
   *  milliseconds. Jitter is what stops twenty devices answering the
   *  twenty-first in the same instant. Zero makes it deterministic, which
   *  is what tests want. */
  announceJitterMs?: number
  /** Presence timings. Omit for the defaults. */
  timing?: SessionTiming
  /**
   * This device's measured uplink and per-peer send bitrate, passed straight
   * to the mesh. Omit it and the room never promotes to a forwarder - see
   * `MeshOptions.uplink` for why that is the right default.
   */
  uplink?: () => { uplinkBps: number; perPeerBps: number } | null
  /**
   * Forwarders to start with, before any descriptor has been heard.
   *
   * The room's own descriptor supersedes this the moment one arrives. It
   * exists because the descriptor is an ephemeral kind, exactly like the
   * roster: a device joining later is never sent what it missed, so a room
   * that has gone quiet has no forwarder list until somebody restates one.
   */
  forwarders?: ForwarderRef[]
  /** A forwarder pubkey or url to prefer over the deterministic ordering. */
  preferForwarder?: string
  /** How long a forwarder has to connect before the room falls back to a
   *  direct mesh. */
  forwarderTimeoutMs?: number
  /** How long one rung of the route ladder gets. See
   *  `DEFAULT_ROUTE_TIMEOUT_MS`. */
  routeTimeoutMs?: number
  /** How long the TURN rung gets. See `DEFAULT_TURN_ROUTE_TIMEOUT_MS`. */
  turnRouteTimeoutMs?: number
  /**
   * This device's standing offer to relay for the room, consulted on every
   * publish.
   *
   * A function rather than a value because the offer moves: the load figure
   * changes as pairs come and go, and the whole thing becomes null the
   * instant somebody revokes. Consulted on every heartbeat, so a stale offer
   * is at most one heartbeat old; `setAssist` shortens that to nothing when
   * it matters.
   *
   * Omit it and this device never offers, which is the right default: nothing
   * should spend a person's bandwidth because a library thought it a good
   * idea. See `assistDecision`.
   */
  assist?: () => AssistOffer | null
  /** This device's relay registry, when it is volunteering. Handed straight
   *  to the mesh - see `MeshOptions.relay`. */
  relay?: PeerRelay
  /** Called when this device takes on, or stops carrying, a pair. */
  onRelayStart?: (pair: RelayPair) => void
  onRelayStop?: (pair: RelayPair) => void
  /** Called when a remote device's route changes rung. */
  onRoute?: (device: string, route: RouteView) => void
}

/**
 * The primary device: the one endpoint that can sign for the participant. It
 * mints its own credential at join and can issue credentials for the
 * participant's other devices via `issueDeviceCredential`.
 *
 * "Can sign for" rather than "holds the key", because both are primary: a
 * key generated and held here (`localIdentity`), or an external signer -
 * an extension, a bunker, a phone - where this app never sees the secret at
 * all. See `ParticipantIdentity`.
 */
export interface PrimaryRoomSessionOptions extends RoomSessionBaseOptions {
  identity: ParticipantIdentity
  credential?: never
}

/**
 * A secondary device: its own key plus a room-scoped, expiring credential
 * issued elsewhere. The participant key is never present, which is what the
 * design means by "a device never holds the participant key" - a device
 * compromised here loses one room until the credential expires, not the
 * person's whole Nostr identity for ever.
 */
export interface SecondaryRoomSessionOptions extends RoomSessionBaseOptions {
  credential: DeviceCredential
  identity?: never
}

export type RoomSessionOptions = PrimaryRoomSessionOptions | SecondaryRoomSessionOptions

export interface PublishOptions {
  /** Which remote participants receive the tracks. Omit for everybody.
   *  See `RoomSession.publishTracks`. */
  audience?: (participant: ParticipantView) => boolean
}

const CREDENTIAL_TTL_SECONDS = 12 * 60 * 60
const DEFAULT_ANNOUNCE_JITTER_MS = 500

/**
 * How far through its credential's life a primary device mints the next one.
 *
 * A credential is minted once, at join, and lasts twelve hours. A room that
 * stays open longer than that - a standing room with people and their agents
 * in it for days - used to lose every member at the twelve-hour mark: their
 * heartbeats still arrived, and were refused, because the credential inside
 * them had expired. So a device that can sign for its participant re-mints
 * halfway through, well before anybody's clock could disagree about whether
 * the old one is still good, and restates itself under the new one. A
 * secondary device cannot: its credential was issued by the primary, and a
 * new one is a new pairing.
 */
export const CREDENTIAL_RENEWAL_FRACTION = 0.5

/** How long to wait before trying a renewal again after a signer refused or
 *  a relay was down. Short, because the clock is running on the old one. */
const CREDENTIAL_RENEWAL_RETRY_MS = 60_000

/**
 * How long a device stays in the roster after its last announcement.
 *
 * The roster is an ephemeral kind published as it happens, so presence is
 * only ever as current as the last thing a device said. Without a lapse an
 * entry is kept for ever: a laptop closed an hour ago is still listed, still
 * rendered, and still holds a `Mesh` peer connection that will never connect.
 * Comfortably more than three heartbeats, so one dropped relay message does
 * not evict a device that is plainly still here.
 */
export const PRESENCE_TTL_SECONDS = 75

/** How often a device restates that it is still here. */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** How often lapsed entries are swept. */
export const SWEEP_INTERVAL_MS = 5_000

/** How long `leave()` waits for its farewell to be acknowledged. */
export const FAREWELL_BOUND_MS = 3_000

/** The timings that govern presence. All of them are tunable guesses; none of
 *  them changes what is correct. Matches the Android client's `SessionTiming`. */
export interface SessionTiming {
  heartbeatIntervalMs?: number
  presenceTtlSeconds?: number
  sweepIntervalMs?: number
  /** How long the credential a primary device mints for itself lasts, and
   *  therefore how often it is renewed. Defaults to twelve hours. */
  credentialTtlSeconds?: number
}

/**
 * A device's presence in one room, grouped with the other devices its
 * participant has joined from.
 *
 * The whole claim of the product lives in `participants()`: a phone and a
 * laptop that belong to the same person appear as one view with the union of
 * their tracks, never as two strangers.
 */
export class RoomSession {
  readonly roomId: string
  /** This endpoint's pubkey. */
  readonly device: string
  /** The person this endpoint speaks for. On a primary device this is the
   *  identity's pubkey; on a secondary it is read off the credential,
   *  which is the only thing that could have told us. */
  readonly participant: string
  #roomKey: Uint8Array
  #opts: RoomSessionOptions
  #now: () => number
  /** Set only on a secondary device: the credential it was handed. A primary
   *  mints a fresh one at join. */
  #credential?: DeviceCredential
  #entries = new Map<string, RosterEntry>()
  #listeners = new Set<(views: ParticipantView[]) => void>()
  /**
   * Remote-track subscribers, held HERE rather than on the mesh.
   *
   * The mesh does not exist until `join()` builds it, so forwarding a
   * subscription straight through meant a caller who subscribed first got a
   * no-op and never heard a track again. Wiring up handlers before going on
   * the network is the natural order and the only one with no window for a
   * track to arrive unheard, so it is the session that has to remember them.
   * See the regression test in session.test.ts.
   */
  readonly #trackListeners = new Set<(t: RemoteTrack) => void>()
  #unsub?: () => void
  #mesh?: Mesh
  #chat?: ChatLog
  /** Side channels opened on demand - see `channel()`. */
  readonly #channels = new Map<string, ChatLog>()
  /** What this device is currently advertising, so an answer to a new
   *  arrival carries the same state as the announcement did. */
  #self?: { credential: DeviceCredential; tracks: TrackAdvert[]; claims: Partial<Record<SingularRole, number>> }
  /** This participant's own name, sanitised once at construction. */
  readonly #name?: string
  /** Where the current assist offer comes from. Starts as whatever the
   *  caller passed, and is replaced wholesale by `setAssist`. */
  #assist?: () => AssistOffer | null
  /** At most one answer in flight: twenty devices arriving at once must
   *  produce one re-announce from us, not twenty. */
  #replyTimer?: ReturnType<typeof setTimeout>
  #heartbeatTimer?: ReturnType<typeof setInterval>
  #sweepTimer?: ReturnType<typeof setInterval>
  #renewalTimer?: ReturnType<typeof setTimeout>
  #left = false
  /**
   * When each remote device was last HEARD from, by this device's own clock.
   *
   * Presence used to lapse on the sender's `updatedAt`, which is the
   * sender's clock. A phone whose clock ran a couple of minutes slow was
   * therefore lapsed the moment it arrived, evicted at the next sweep, its
   * peer connection closed and its tile torn down - and then re-admitted as
   * a fresh arrival on its next heartbeat, twenty seconds later, to go
   * through the whole thing again. Video that "kept dropping", on a clock
   * that was merely wrong. `updatedAt` still orders two entries from one
   * device, which is a comparison between that device's own stamps; how
   * long ago it was last heard is a question about our clock, and is
   * answered here.
   */
  readonly #seenAt = new Map<string, number>()
  /** Devices that said goodbye, and when. An entry stamped at or before a
   *  device's farewell is one a slower relay delivered late, and is not a
   *  return; one stamped after it is a genuine rejoin, and is an arrival
   *  again. Forgotten once the presence timeout has passed, by which point
   *  the late entry would have lapsed anyway. */
  readonly #departed = new Map<string, number>()
  #unsubDescriptor?: () => void
  /** The newest valid descriptor heard for this room. Last writer wins,
   *  ordered on `updatedAt` - see `RoomDescriptor`. */
  #descriptor?: RoomDescriptor

  constructor(opts: RoomSessionOptions) {
    const { roomId, roomKey } = deriveRoom(opts.secret)
    this.roomId = roomId
    this.#roomKey = roomKey
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.device = getPublicKey(opts.deviceSk)
    this.#name = sanitiseDisplayName(opts.name)
    this.#assist = opts.assist

    if (opts.identity) {
      // A pubkey handed over by an external signer is a hex string off a
      // boundary like any other - canonicalise it here so every later
      // comparison against a roster entry or a credential is correct by
      // construction. See `hex.ts`'s `normaliseHex`.
      this.participant = normaliseHex(opts.identity.pubkey)
      return
    }

    // Fail here rather than at join: a credential for the wrong room, the
    // wrong device or a lapsed window is a setup mistake, and the session has
    // no identity to operate under until it is fixed.
    const verdict = verifyDeviceCredential(opts.credential, { roomId, now: this.#now() })
    if (!verdict.ok) throw new Error(`device credential rejected: ${verdict.reason}`)
    if (verdict.device !== this.device) throw new Error('device credential names a different device')
    this.participant = verdict.participant
    this.#credential = opts.credential
  }

  /**
   * Mint a room-scoped, expiring credential authorising another of this
   * participant's devices. Only a primary device can: minting needs a
   * signature from the participant, and a secondary deliberately cannot
   * produce one.
   *
   * Asynchronous because the signer may be somewhere else entirely - see
   * `ParticipantIdentity`.
   *
   * This is what a pairing flow transfers - never the participant key
   * itself. See `pairing.ts`.
   */
  async issueDeviceCredential(
    devicePubkey: string,
    ttlSeconds = CREDENTIAL_TTL_SECONDS,
  ): Promise<DeviceCredential> {
    const identity = this.#opts.identity
    if (!identity) throw new Error('this device cannot sign for the participant, so it cannot issue credentials')
    return createDeviceCredential({
      identity,
      devicePubkey,
      roomId: this.roomId,
      expiresAt: this.#now() + ttlSeconds,
      now: this.#now,
    })
  }

  async join(tracks: TrackAdvert[], claims: Partial<Record<SingularRole, number>>): Promise<void> {
    if (this.#opts.policy) {
      const verdict = evaluateAccess(this.#opts.policy, this.participant, this.#opts.proof, this.#now(), this.roomId)
      if (!verdict.admitted) throw new Error(verdict.reason)
    }

    this.#unsub = this.#opts.transport.subscribe(
      [{ kinds: [KINDS.ROSTER], '#d': [this.roomId] }],
      (event) => this.#ingest(event),
    )

    const device = this.device
    // A secondary device uses the credential it was issued; only a primary,
    // which is the only endpoint holding the participant key, can mint one.
    const credential = this.#credential ?? (await this.issueDeviceCredential(device, this.#credentialTtl()))

    this.#self = { credential, tracks, claims }

    // Listening BEFORE announcing, and the order is load-bearing.
    //
    // Everybody already in the room answers an arrival by opening a
    // connection to it and offering - at once, the instant the announcement
    // reaches them. The mesh is what hears that offer, and a signal is an
    // ephemeral event: a relay delivers it to whoever is subscribed when it
    // arrives and keeps it for nobody. Building the mesh after `#publishEntry`
    // resolved meant building it after every relay had acknowledged the
    // announcement, which is a full round trip after the announcement was
    // already broadcast - and on real relays, comfortably after the first
    // offer had come and gone. On a real call over public relays the person
    // who started the room could see and hear whoever joined, and the joiner
    // saw and heard nothing, because the offer carrying the host's media had
    // been sent to a subscription that did not yet exist. The CI relay, with
    // its sub-millisecond round trip, never shows it; the regression test in
    // session.test.ts acknowledges late the way a real relay pool does.
    if (this.#opts.factory) {
      this.#mesh = new Mesh({
        session: this,
        factory: this.#opts.factory,
        localDevice: device,
        localParticipant: this.participant,
        deviceSk: this.#opts.deviceSk,
        transport: this.#opts.transport,
        roomId: this.roomId,
        now: this.#now,
        uplink: this.#opts.uplink,
        forwarders: this.#opts.forwarders,
        preferForwarder: this.#opts.preferForwarder,
        forwarderTimeoutMs: this.#opts.forwarderTimeoutMs,
        routeTimeoutMs: this.#opts.routeTimeoutMs,
        turnRouteTimeoutMs: this.#opts.turnRouteTimeoutMs,
        relay: this.#opts.relay,
        // Consent, checked at the moment of the request rather than at
        // construction: a person who has revoked stops carrying people at
        // once, and one who never opted in is never asked to start.
        offering: () => {
          try {
            return this.#assist?.() != null
          } catch {
            return false
          }
        },
        onRelayStart: this.#opts.onRelayStart,
        onRelayStop: this.#opts.onRelayStop,
        onRoute: this.#opts.onRoute,
      })

      // One subscription on the mesh, fanned out to whoever asked - including
      // everyone who asked before this mesh existed. Snapshotted so a
      // listener that unsubscribes while being called cannot disturb the
      // iteration, and a throwing listener cannot swallow the track for the
      // ones after it: a tile that fails to render must not silence the room.
      this.#mesh.onRemoteTrack((t) => {
        for (const cb of [...this.#trackListeners]) {
          try {
            cb(t)
          } catch {
            // A subscriber's problem, not the room's.
          }
        }
      })
    }

    // Subscribed after the mesh exists, so a descriptor that arrives in the
    // same tick has somewhere to go. Ephemeral, like the roster: nothing is
    // replayed to a device that subscribes later, so a room that has gone
    // quiet has no forwarder list until somebody restates one.
    this.#unsubDescriptor = this.#opts.transport.subscribe(
      [{ kinds: [KINDS.DESCRIPTOR], '#d': [this.roomId] }],
      (event) => this.#ingestDescriptor(event),
    )

    try {
      await this.#publishEntry(false)
    } catch (err) {
      // Nobody heard us, so nothing of ours may stay on the network: a mesh
      // that never joined must not answer offers, and a subscription with no
      // session behind it is a leak.
      this.#unsub?.()
      this.#unsub = undefined
      this.#unsubDescriptor?.()
      this.#unsubDescriptor = undefined
      this.#mesh?.close()
      this.#mesh = undefined
      this.#self = undefined
      throw err
    }

    this.#chat = new ChatLog({
      transport: this.#opts.transport,
      roomId: this.roomId,
      roomKey: this.#roomKey,
      credential,
      deviceSk: this.#opts.deviceSk,
      name: this.#name,
      policy: this.#opts.policy,
      proof: this.#opts.proof,
      now: this.#now,
    })

    // Presence is live state, so it has to be restated and it has to lapse -
    // see `PRESENCE_TTL_SECONDS`. Both timers are unreferenced where the
    // runtime allows it, because a library keeping a Node process alive after
    // its caller has finished is a bug in the library.
    this.#heartbeatTimer = this.#every(
      this.#opts.timing?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      () => {
        this.#publishEntry(false).catch(() => {})
      },
    )
    this.#sweepTimer = this.#every(this.#opts.timing?.sweepIntervalMs ?? SWEEP_INTERVAL_MS, () => {
      if (this.#evictLapsed()) this.#notify()
    })
    if (this.#opts.identity) this.#scheduleRenewal(this.#credentialTtl() * CREDENTIAL_RENEWAL_FRACTION * 1000)
  }

  #credentialTtl(): number {
    return this.#opts.timing?.credentialTtlSeconds ?? CREDENTIAL_TTL_SECONDS
  }

  #scheduleRenewal(afterMs: number): void {
    if (this.#renewalTimer !== undefined) clearTimeout(this.#renewalTimer)
    const timer = setTimeout(() => {
      this.#renewalTimer = undefined
      this.#renewCredential().catch(() => {})
    }, afterMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.#renewalTimer = timer
  }

  /**
   * Mint the next credential and restate this device under it.
   *
   * See `CREDENTIAL_RENEWAL_FRACTION`. Restated as an answer rather than an
   * arrival, because nothing has arrived: everybody already knows this
   * device, and the entry is only carrying a fresher proof of the same
   * fact. A signer that refuses, or a relay that is down, costs a retry
   * rather than the room - the old credential is still good for a while.
   */
  async #renewCredential(): Promise<void> {
    if (this.#left || !this.#self || !this.#opts.identity) return
    try {
      const credential = await this.issueDeviceCredential(this.device, this.#credentialTtl())
      if (this.#left || !this.#self) return
      this.#self = { ...this.#self, credential }
      this.#chat?.setCredential(credential)
      for (const log of this.#channels.values()) log.setCredential(credential)
      await this.#publishEntry(true)
      this.#scheduleRenewal(this.#credentialTtl() * CREDENTIAL_RENEWAL_FRACTION * 1000)
    } catch {
      this.#scheduleRenewal(Math.min(CREDENTIAL_RENEWAL_RETRY_MS, this.#credentialTtl() * 1000))
    }
  }

  /** The credential this device is currently presenting. Fresh from join,
   *  and renewed on a primary device before it lapses. */
  get credential(): DeviceCredential | undefined {
    return this.#self?.credential
  }

  /**
   * Turn this device's offer to relay on, off, or over to a new source, and
   * say so at once.
   *
   * Revocation is the case that matters and the reason this republishes
   * immediately rather than waiting for the next heartbeat: somebody who
   * has decided to stop giving their bandwidth away should stop giving it
   * away now. It takes nothing else with it - their own call carries on, the
   * room carries on, and the pairs that were being carried fall to the next
   * rung the same way they would if the laptop had been closed.
   *
   * Passing an offer pins it; passing a function lets the load figure move on
   * its own; passing null withdraws.
   *
   * Turning it back on is symmetrical, and has to be: somebody who revokes
   * and changes their mind later would otherwise advertise an offer their own
   * relay would refuse, which is the one thing worse than not offering.
   */
  async setAssist(next: (() => AssistOffer | null) | AssistOffer | null): Promise<void> {
    this.#assist = typeof next === 'function' ? next : () => next
    // Stops carrying anybody before announcing that we no longer will, so
    // there is no window in which the room believes an offer this device has
    // already withdrawn.
    if (this.#assist() === null) this.#opts.relay?.close()
    else this.#opts.relay?.reopen()
    if (this.#self && !this.#left) await this.#publishEntry(true)
  }

  /** How each remote device is currently being reached. Empty when media was
   *  never set up. */
  get routes(): Map<string, RouteView> {
    return this.#mesh?.routes ?? new Map()
  }

  /** How many pairs this device is carrying for other people. */
  get relaying(): number {
    return this.#mesh?.relaying ?? 0
  }

  /** Whether this room is routing through a forwarder. `off` when media was
   *  never set up. See `ForwardingState`. */
  get forwarding(): ForwardingState {
    return this.#mesh?.forwarding ?? 'off'
  }

  /** The forwarder currently being used or attempted, if any. */
  get forwarderDevice(): string | undefined {
    return this.#mesh?.forwarderDevice
  }

  /** The room's current configuration, as the newest valid descriptor states
   *  it. Undefined until one has been heard. */
  get descriptor(): RoomDescriptor | undefined {
    return this.#descriptor
  }

  /**
   * Publish the room's forwarder and ICE configuration.
   *
   * Any member may: the descriptor is signed by a credentialled device and
   * ordered on `updatedAt`, so the worst a member can do by winning that race
   * is choose whose bandwidth pays. It cannot cost the room its privacy,
   * because a forwarder is named by url and pubkey and is never given the
   * room key - see `RoomDescriptor`.
   */
  async publishDescriptor(config: {
    forwarders?: ForwarderRef[]
    iceServers?: IceServerRef[]
    /** Unix seconds. Defaults to now; exposed so a caller can supersede a
     *  descriptor whose publisher's clock ran ahead. */
    updatedAt?: number
  }): Promise<void> {
    const self = this.#self
    if (!self) throw new Error('join the room before publishing its descriptor')

    const event = encodeDescriptorEvent(
      {
        device: this.device,
        participant: this.participant,
        credential: self.credential,
        ...(this.#opts.proof ? { proof: this.#opts.proof } : {}),
        forwarders: config.forwarders ?? [],
        iceServers: config.iceServers ?? [],
        updatedAt: config.updatedAt ?? this.#now(),
      },
      { roomId: this.roomId, roomKey: this.#roomKey, deviceSk: this.#opts.deviceSk },
    )
    await this.#opts.transport.publish(event)
  }

  /** Never throws - this runs inside a relay subscription handler.
   *  `decodeDescriptorEvent` returns null for anything that does not check
   *  out: wrong room, wrong key, bad signature, an uncredentialled publisher,
   *  a timestamp past clock skew. */
  #ingestDescriptor(event: Event): void {
    const descriptor = decodeDescriptorEvent(event, {
      roomId: this.roomId,
      roomKey: this.#roomKey,
      now: this.#now(),
      policy: this.#opts.policy,
    })
    if (!descriptor) return
    // Ordered on `updatedAt`, not on arrival: relays deliver out of order,
    // and a stale descriptor turning up late must not repoint a room that has
    // already moved on.
    if (this.#descriptor && this.#descriptor.updatedAt > descriptor.updatedAt) return

    this.#descriptor = descriptor
    this.#mesh?.setForwarders(descriptor.forwarders)
  }

  /**
   * Re-publish this device's roster entry.
   *
   * The roster is an ephemeral kind, so nothing a relay holds is replayed to
   * a device that subscribes later: the only way a newcomer learns who is
   * already here is for those devices to say so again. `join()` announces;
   * this is how a device answers, and callers can use it to advertise a
   * changed track list too.
   */
  async announce(): Promise<void> {
    await this.#publishEntry(false)
  }

  async #publishEntry(reply: boolean, left = false): Promise<void> {
    const self = this.#self
    if (!self || this.#left) return

    // Asked fresh every time. The load figure moves as pairs come and go, and
    // a revoked offer must stop being published on the very next thing this
    // device says rather than at some later refresh. A caller whose source
    // throws is treated as not offering, because the safe reading of "I do
    // not know" is "do not spend their bandwidth".
    let assist: AssistOffer | null = null
    try {
      assist = this.#assist?.() ?? null
    } catch {
      assist = null
    }

    const entry: RosterEntry = {
      participant: this.participant,
      device: this.device,
      credential: self.credential,
      tracks: self.tracks,
      claims: self.claims,
      updatedAt: this.#now(),
      ...(this.#name !== undefined ? { name: this.#name } : {}),
      ...(this.#opts.agent === true ? { agent: true } : {}),
      ...(assist ? { assist } : {}),
      ...(this.#opts.proof ? { proof: this.#opts.proof } : {}),
      ...(reply ? { reply: true } : {}),
      ...(left ? { left: true } : {}),
    }
    const event = encodeRosterEvent(entry, {
      roomId: this.roomId,
      roomKey: this.#roomKey,
      deviceSk: this.#opts.deviceSk,
    })
    await this.#opts.transport.publish(event)
  }

  #every(intervalMs: number, run: () => void): ReturnType<typeof setInterval> {
    const timer = setInterval(run, intervalMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  }

  /**
   * Drop every entry that has lapsed: one that has not been restated inside
   * the presence window, and one whose credential has expired since it was
   * ingested - a credential is checked at ingest, and ingest was hours ago.
   *
   * Our own entry is never swept: we know perfectly well that we are here,
   * and evicting ourselves between heartbeats would make the room flicker.
   */
  #evictLapsed(): boolean {
    const now = this.#now()
    const cutoff = now - (this.#opts.timing?.presenceTtlSeconds ?? PRESENCE_TTL_SECONDS)
    let changed = false

    for (const [device, entry] of this.#entries) {
      if (device === this.device) continue
      let lapsed = (this.#seenAt.get(device) ?? entry.updatedAt) < cutoff
      // Media still flowing from a device is stronger evidence that it is
      // here than a heartbeat carried by a third party's relay. A tab in the
      // background has its timers throttled; a relay drops a socket and
      // takes a while to come back; a phone's radio hands over between
      // cells. Through every one of those the peer connection carries on,
      // and closing it because the relay went quiet was the room tearing
      // down a working call to chase a rumour. So a device whose connection
      // reports itself up is heard from by that fact. The connection is the
      // authority on its own health: when it really goes, ICE says so within
      // a few tens of seconds, the route stops reading connected, and the
      // ordinary timeout takes over from there.
      if (lapsed && this.#mesh?.routes.get(device)?.connected) {
        this.#seenAt.set(device, now)
        lapsed = false
      }
      const credentialExpired = !verifyDeviceCredential(entry.credential, { roomId: this.roomId, now }).ok
      if (!lapsed && !credentialExpired) continue
      this.#entries.delete(device)
      this.#seenAt.delete(device)
      // Forgetting a departed device is what lets a genuine rejoin be
      // answered again later without reopening the announce loop: they are
      // gone, so the next thing we hear from them really is an arrival.
      changed = true
    }
    // A farewell only needs remembering for as long as an entry from before
    // it could still be delivered and still be fresh.
    for (const [device, leftAt] of this.#departed) {
      if (leftAt < cutoff) this.#departed.delete(device)
    }

    return changed
  }

  /** Schedule one answer to a new arrival, jittered. Coalesced: an answer
   *  already pending covers every device that arrives before it fires. */
  #scheduleReply(): void {
    if (this.#replyTimer !== undefined || this.#left || !this.#self) return
    const jitter = this.#opts.announceJitterMs ?? DEFAULT_ANNOUNCE_JITTER_MS
    this.#replyTimer = setTimeout(
      () => {
        this.#replyTimer = undefined
        this.#publishEntry(true).catch(() => {})
      },
      Math.floor(Math.random() * jitter),
    )
  }

  /**
   * Restate what this device is publishing and claiming, and say so at once.
   *
   * The adverts handed to `join()` used to be the adverts for the whole
   * session: a camera turned on ten minutes in was sent to every peer but
   * never appeared in the roster, so everybody else's view of this device
   * said it published nothing, and a volunteer carrying it had no track id
   * to attribute what it forwarded. Restated as an answer, because nothing
   * has arrived - everybody already knows this device.
   */
  async advertise(tracks: TrackAdvert[], claims: Partial<Record<SingularRole, number>>): Promise<void> {
    if (!this.#self || this.#left) return
    this.#self = { ...this.#self, tracks, claims }
    await this.#publishEntry(true)
  }

  /**
   * Publish live media tracks to every remote device's peer connection.
   *
   * Own other devices never receive them, because they never get a peer
   * connection in the first place - see `Mesh`. A no-op until `join()` has
   * set up media, and if no `factory` was supplied at all.
   *
   * `audience` is who gets them. Left out, everybody does. Given, it is
   * asked about every remote participant - now, and again for anybody who
   * arrives later - and a participant it refuses is sent nothing, which on
   * that connection means the tracks are removed, not muted: the media
   * never leaves this device for them. That is what lets a person keep an
   * agent in the room and still have a conversation it cannot hear. It
   * holds for media this device sends directly; a forwarder fans out to
   * everybody it carries for, and this cannot narrow that.
   */
  publishTracks(tracks: MediaStreamTrack[], opts: PublishOptions = {}): void {
    this.#mesh?.publish(tracks, opts.audience)
  }

  /** Remote media tracks, attributed to the participant they came from -
   *  never the device - which is the whole point of grouping devices into
   *  one view.
   *
   *  Safe to call at any point in a session's life, and the sensible moment
   *  is BEFORE `join()`: the subscription is held here rather than on the
   *  mesh `join()` builds, so there is no window in which a track can arrive
   *  with nobody listening. Never fires if no `factory` was supplied, which
   *  is a session that was never going to carry media. */
  onRemoteTrack(cb: (t: RemoteTrack) => void): () => void {
    this.#trackListeners.add(cb)
    return () => {
      this.#trackListeners.delete(cb)
    }
  }

  /** The room's chat log. Only available after a successful `join()` - chat
   *  is a room capability, gated by the same access check as everything
   *  else. */
  get chat(): ChatLog {
    if (!this.#chat) throw new Error('join the room before using chat')
    return this.#chat
  }

  /**
   * A named side channel of this room: the same durable, room-key-rooted
   * chat, under an id and a key derived from the room key for that name,
   * so it rides beside the main conversation rather than in it.
   *
   * Every member can open every channel - a channel is a place to talk,
   * not a secret from the room. What it is for is agents co-ordinating
   * among themselves without filling the people's chat, and a transcript
   * that the people can open when they want it and close when they do not.
   * The people who hold the room key can always read what their agents say
   * to each other, by design: an agent acting for somebody is not owed a
   * conversation its principal cannot see. See `deriveChannel`.
   */
  channel(name: string): ChatLog {
    if (!this.#chat) throw new Error('join the room before using a channel')
    const existing = this.#channels.get(name)
    if (existing) return existing
    const log = new ChatLog({
      transport: this.#opts.transport,
      roomId: this.roomId,
      roomKey: this.#roomKey,
      channel: name,
      credential: this.#self!.credential,
      deviceSk: this.#opts.deviceSk,
      name: this.#name,
      policy: this.#opts.policy,
      proof: this.#opts.proof,
      now: this.#now,
    })
    this.#channels.set(name, log)
    return log
  }

  #ingest(event: Event): void {
    const entry = decodeRosterEvent(event, {
      roomId: this.roomId,
      roomKey: this.#roomKey,
      now: this.#now(),
    })
    if (!entry) return

    // Every member evaluates every other member's tier for itself. The
    // joiner's own self-check at join() is a courtesy that fails fast; it
    // proves nothing to anybody else, because a modified client - or one
    // simply constructed without a policy - skips it entirely. This is where
    // the gate is actually enforced.
    if (this.#opts.policy) {
      const verdict = evaluateAccess(this.#opts.policy, entry.participant, entry.proof, this.#now(), this.roomId)
      if (!verdict.admitted) return
    }

    const existing = this.#entries.get(entry.device)
    if (existing && existing.updatedAt > entry.updatedAt) return

    // Stamped before the presence window opened: not presence, whoever
    // sent it. The roster rides an ephemeral kind that relays are not meant
    // to keep, and in practice every relay this project has been pointed
    // at keeps it and replays the last few dozen entries to a new
    // subscriber - the final heartbeat of every device that ever died
    // without saying goodbye, minutes or hours old. Judged by when it was
    // heard, such an entry would be a live device for the whole timeout,
    // with a peer connection opened to it and a tile on screen. So an
    // entry is admitted only if the device that stamped it did so inside
    // the window; from then on it lives by when it is heard (`#seenAt`)
    // and by whether its media is flowing. The price is stated: a device
    // whose clock runs more than the window behind ours is never admitted,
    // where it used to be admitted and evicted five seconds later, for
    // ever. Refused is honest; flickering was not.
    if (entry.updatedAt < this.#now() - (this.#opts.timing?.presenceTtlSeconds ?? PRESENCE_TTL_SECONDS)) return

    if (entry.left) {
      // A farewell. The device goes now, not when its presence lapses, and
      // the moment it left is kept so a slower relay delivering something it
      // said earlier cannot put it back in the room.
      if (entry.device === this.device) return
      this.#departed.set(entry.device, entry.updatedAt)
      if (!existing) return
      this.#entries.delete(entry.device)
      this.#seenAt.delete(entry.device)
      this.#notify()
      return
    }

    const leftAt = this.#departed.get(entry.device)
    if (leftAt !== undefined) {
      // Stamped at or before the farewell: delivered late, not come back.
      if (entry.updatedAt <= leftAt) return
      // Stamped after it: they really are back, and this is an arrival.
      this.#departed.delete(entry.device)
    }

    this.#entries.set(entry.device, entry)
    if (entry.device !== this.device) this.#seenAt.set(entry.device, this.#now())

    // A device we had not seen before has arrived, so tell it we are here.
    // Never for our own entry echoing back, never for a device we already
    // knew, and never in answer to somebody else's answer - each of those
    // would be an answer to something that was not an arrival, and the last
    // of them would not terminate.
    if (!existing && !entry.reply && entry.device !== this.device) this.#scheduleReply()

    this.#notify()
  }

  /** decodeRosterEvent is written never to throw because this runs inside a
   *  relay subscription handler; a throwing caller callback would undo all of
   *  that, so listeners are guarded here too. */
  #notify(): void {
    const views = this.participants()
    for (const listener of this.#listeners) {
      try {
        listener(views)
      } catch {
        // A caller's render() is not allowed to close the room.
      }
    }
  }

  participants(): ParticipantView[] {
    // Swept on read as well as on a timer, so a caller reading the roster
    // never sees a device that lapsed since the last sweep. No notification
    // from here: the caller is reading the fresh answer already.
    this.#evictLapsed()
    const entries = [...this.#entries.values()]
    const roles = resolveSingularRoles(entries)
    const byParticipant = new Map<string, ParticipantView>()
    /** When the name currently held for a participant was last restated. */
    const nameStamp = new Map<string, number>()

    for (const entry of entries) {
      let view = byParticipant.get(entry.participant)
      if (!view) {
        view = { participant: entry.participant, devices: [], tracks: [] }
        byParticipant.set(entry.participant, view)
      }
      // One name per person, not one per device. A participant's devices
      // normally agree; when they do not - a name changed on the phone and
      // not yet on the laptop - the most recently restated entry wins, so
      // every member of the room settles on the same answer rather than on
      // whichever entry happened to arrive first.
      if (entry.name !== undefined && (view.name === undefined || entry.updatedAt >= (nameStamp.get(entry.participant) ?? 0))) {
        view.name = entry.name
        nameStamp.set(entry.participant, entry.updatedAt)
      }
      view.devices.push(entry.device)
      if (entry.agent === true) view.agent = true
      for (const track of entry.tracks) view.tracks.push({ ...track, device: entry.device })
      // Per device, not per person: two of somebody's devices can be in the
      // same room and only one of them publicly reachable, and it is that one
      // a pair would be carried by.
      if (entry.assist) {
        view.assist = view.assist ?? []
        view.assist.push({ ...entry.assist, device: entry.device })
      }
    }

    for (const [participant, assigned] of roles) {
      const view = byParticipant.get(participant)
      if (!view) continue
      view.mic = assigned.mic
      view.monitor = assigned.monitor
    }

    return [...byParticipant.values()]
  }

  onChange(cb: (views: ParticipantView[]) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  /**
   * Say goodbye and close everything.
   *
   * Resolves once the farewell has been accepted by a relay or refused by
   * every one of them, and never rejects. A process that exits the instant
   * `leave()` returns has not said goodbye: the publish is a socket write
   * that has not happened yet, and the room waits out the presence timeout
   * for a device that meant to leave politely. Await it before exiting.
   * Everything else here is immediate.
   */
  leave(): Promise<void> {
    // The last thing this device says is an entry claiming nothing,
    // publishing nothing, and marked `left`. That releases a singular role
    // and takes the tile off everybody's screen at once, rather than making
    // the room wait out the presence timeout - and, more expensively, making
    // every other device escalate its route ladder chasing a peer that has
    // gone. A device that is simply switched off is removed by that timeout
    // anyway - so there is only one path to test.
    let farewell: Promise<void> = Promise.resolve()
    if (this.#self && !this.#left) {
      this.#self = { ...this.#self, tracks: [], claims: {} }
      // Flagged the same way an answer is, because a farewell is not an
      // arrival either: without it, the last thing a leaving device does is
      // provoke every remaining device into re-announcing at it. And flagged
      // `left`, so everybody else drops this device now rather than when its
      // presence lapses - see `RosterEntry.left`.
      //
      // Bounded, because a relay that never acknowledges must not hold a
      // caller that is trying to go: measured, a farewell to a relay that
      // was mid-reconnect kept a test process alive for a quarter of an
      // hour. Past the bound the goodbye is simply lost, and the room evicts
      // this device on the timeout as it always did.
      const publish = this.#publishEntry(true, true).catch(() => {})
      const bound = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FAREWELL_BOUND_MS)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      })
      farewell = Promise.race([publish, bound])
    }

    this.#left = true
    if (this.#replyTimer !== undefined) clearTimeout(this.#replyTimer)
    this.#replyTimer = undefined
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = undefined
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer)
    this.#sweepTimer = undefined
    if (this.#renewalTimer !== undefined) clearTimeout(this.#renewalTimer)
    this.#renewalTimer = undefined
    this.#unsub?.()
    this.#unsubDescriptor?.()
    this.#unsubDescriptor = undefined
    this.#mesh?.close()
    this.#chat?.close()
    for (const log of this.#channels.values()) log.close()
    this.#channels.clear()
    this.#listeners.clear()
    this.#entries.clear()
    this.#seenAt.clear()
    return farewell
  }
}
