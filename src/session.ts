import { getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { deriveRoom } from './room.js'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'
import { hexEquals, normaliseHex } from './hex.js'
import type { ParticipantIdentity } from './identity.js'
import { sanitiseDisplayName } from './display-name.js'
import { encodeRosterEvent, decodeRosterEvent } from './roster.js'
import { resolveSingularRoles } from './roles.js'
import { KINDS } from './kinds.js'
import { evaluateAccess, evaluateAgentAccess } from './access.js'
import { normaliseAgentOwnership, verifyAgentOwnership } from './ownership.js'
import { Mesh } from './mesh.js'
import type { PeerFactory } from './peer.js'
import type { ForwardingState, RemoteTrack, RouteView } from './mesh.js'
import type { PeerRelay, RelayPair } from './peer-relay.js'
import { encodeDescriptorEvent, decodeDescriptorEvent } from './descriptor.js'
import { ChatLog } from './chat.js'
import type { EpochRoot } from './chat.js'
import {
  EpochRefusedError,
  decodeRekeyEvent,
  deriveEpoch,
  encodeRekeyEvent,
  generateEpochSecret,
  peekRekeyEvent,
  requestRoomEpoch,
} from './epoch.js'
import type { EpochKeys, EpochRefusal, RekeyNotice, RoomEpoch } from './epoch.js'
import type { RelayTransport } from './relay-pool.js'
import type {
  AgentOwnership,
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
  /** Whose agent this is, from a proof this session verified on one of its
   *  devices' entries. Absent for a person, and for an agent nobody has
   *  claimed. See `AgentOwnership`. */
  owner?: { principal: string; label?: string }
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
  /** This agent's ownership proof, carried on every roster entry and chat
   *  message. Checked here against the participant; a proof that names
   *  somebody else is a setup mistake and is refused at construction. */
  owner?: AgentOwnership
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
  /**
   * The epoch to join in. Omit for epoch 0: the room as the link gives it.
   * A keeper reopening a room it has rekeyed passes the epoch it holds; a
   * joiner never passes one, because it is told by the authority. See
   * `epoch.ts`.
   */
  epoch?: RoomEpoch
  /**
   * The room's authority: the root inviter pubkey pinned in the link. A
   * rekey signed by it is followed, and a request for the current epoch is
   * addressed to it. Omit it - a legacy secret link has none - and the
   * session stays in the epoch it joined in for its whole life.
   */
  authority?: string
  /**
   * The epoch the responder that admitted this device said the room is at
   * (`RoomAdmission.epoch`). Above the epoch this session holds, it asks
   * the authority before it says anything; at or below, it announces at
   * once. Omit when nobody said, and the session waits `epochSettleMs` for
   * the rekey events a relay replays before deciding.
   */
  expectedEpoch?: number
  /** How long to wait for replayed rekeys when `expectedEpoch` is unknown,
   *  in milliseconds. Zero in tests. */
  epochSettleMs?: number
  /** How long to wait for the authority to answer an epoch request. */
  epochRequestTimeoutMs?: number
  /** Called on every epoch this session moves to, with what the rekey said:
   *  the number, who was removed and by whom. Also on this session's own
   *  rekeys, when it is the authority. */
  onEpoch?: (notice: RekeyNotice) => void
  /** Called when this participant was removed: a rekey named it, or the
   *  authority refused it the current epoch. The session stays where it
   *  is, which is an epoch nobody else is in any more; the caller should
   *  leave. */
  onRemoved?: (notice: { epoch: number; by?: string }) => void
  /** Called when the room was closed by its authority. As above. */
  onClosed?: (notice: { epoch: number; by?: string }) => void
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

/** How long a joiner that was told nothing about the room's epoch waits for
 *  a relay to replay the rekey events before announcing. Long enough for a
 *  relay round trip; short enough not to be the slow part of joining. */
export const DEFAULT_EPOCH_SETTLE_MS = 1_500

/** How long a joiner waits for the authority to answer an epoch request. A
 *  keeper is always on; a creator's browser that is not open cannot answer,
 *  and the join fails with a reason rather than hanging. */
export const DEFAULT_EPOCH_REQUEST_TIMEOUT_MS = 20_000

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
  /** This agent's verified ownership proof, when it has one. */
  readonly #owner?: AgentOwnership
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
  /** The epoch this session is in: its secret, and the id and key
   *  everything rides under. Epoch 0 is the room itself. */
  #epochSecret: RoomEpoch
  #epoch: EpochKeys
  /** Participants removed at any epoch this session has seen. Their entries
   *  are refused whatever key they arrive under, which is belt and braces:
   *  they cannot produce one under the current key at all. */
  readonly #removed = new Set<string>()
  /** Rekeys heard for epochs ahead of this one, by epoch, until this session
   *  reaches the epoch each is sealed to. */
  readonly #pendingRekeys = new Map<number, Event>()
  #unsubRekey?: () => void
  /** One epoch request in flight at a time. */
  #catchingUp?: Promise<void>
  #closed = false
  /** Set while joining when a rekey said this participant is out, or the
   *  room is closed, so `join()` can say so rather than carry on. */
  #refusedWhileJoining?: EpochRefusal

  constructor(opts: RoomSessionOptions) {
    const { roomId, roomKey } = deriveRoom(opts.secret)
    this.roomId = roomId
    this.#roomKey = roomKey
    this.#opts = opts
    this.#epochSecret = opts.epoch && opts.epoch.epoch > 0 ? opts.epoch : { epoch: 0, secret: opts.secret }
    this.#epoch = deriveEpoch(this.#epochSecret)
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.device = getPublicKey(opts.deviceSk)
    this.#name = sanitiseDisplayName(opts.name)
    this.#assist = opts.assist

    const participant = opts.identity ? normaliseHex(opts.identity.pubkey) : undefined
    if (opts.owner) {
      const proof = normaliseAgentOwnership(opts.owner)
      const agent = participant ?? verifyDeviceCredential(opts.credential!, { roomId, now: this.#now() })
      const named = typeof agent === 'string' ? agent : agent.ok ? agent.participant : ''
      const verdict = proof ? verifyAgentOwnership(proof, { agent: named, now: this.#now() }) : { ok: false as const, reason: 'malformed' }
      if (!proof || !verdict.ok) throw new Error(`ownership proof rejected: ${verdict.ok ? 'malformed' : verdict.reason}`)
      this.#owner = proof
    }

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
      // The same courtesy for the agent rule: an agent with no proof will
      // be refused by everybody, so it is told now. Whether its principal
      // is here cannot be known before the roster is read.
      if (this.#opts.policy.agents === 'owned-by-members' && this.#opts.agent === true && !this.#owner) {
        throw new Error('this room admits only agents whose principal is a member, and this agent carries no ownership proof')
      }
    }

    const device = this.device
    // A secondary device uses the credential it was issued; only a primary,
    // which is the only endpoint holding the participant key, can mint one.
    const credential = this.#credential ?? (await this.issueDeviceCredential(device, this.#credentialTtl()))

    this.#self = { credential, tracks, claims }

    // Before anything is said: which epoch is the room in? A rekey is a
    // durable event by the public room id, so a relay replays every one
    // the moment this subscription opens, and the responder that admitted
    // this device may have said which epoch it is at. Announcing under a
    // key the room has left would show this device - its participant, its
    // name, its tracks - to exactly the people the room removed, and let
    // them connect, until the rekey was noticed. So the roster is not
    // subscribed, and nothing is published, until this has settled.
    if (this.#opts.authority) {
      this.#unsubRekey = this.#opts.transport.subscribe(
        [{ kinds: [KINDS.ROOM_REKEY], '#d': [this.roomId], authors: [this.#opts.authority] }],
        (event) => this.#ingestRekey(event),
      )
      try {
        await this.#settleEpoch()
      } catch (err) {
        this.#unsubRekey?.()
        this.#unsubRekey = undefined
        this.#self = undefined
        throw err
      }
    }

    this.#unsub = this.#opts.transport.subscribe(
      [{ kinds: [KINDS.ROSTER], '#d': [this.#epoch.id] }],
      (event) => this.#ingest(event),
    )

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
      [{ kinds: [KINDS.DESCRIPTOR], '#d': [this.#epoch.id] }],
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
      this.#unsubRekey?.()
      this.#unsubRekey = undefined
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
      ...(this.#epochRoot() ? { epoch: this.#epochRoot() } : {}),
      ...(this.#ownerToCarry() ? { owner: this.#ownerToCarry() } : {}),
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

  /** The proof this device puts on what it publishes: only when it says it
   *  is an agent, because a proof is a statement about one. */
  #ownerToCarry(): AgentOwnership | undefined {
    return this.#opts.agent === true ? this.#owner : undefined
  }

  /** Whether a participant is in this session's roster, as the agent rule
   *  asks. This session's own participant is, whatever the roster says. */
  #isMember(participant: string): boolean {
    if (participant === this.participant) return true
    for (const entry of this.#entries.values()) if (entry.participant === participant) return true
    return false
  }

  // -------------------------------------------------------------------------
  // Epochs. See `epoch.ts` for what one is and why.
  // -------------------------------------------------------------------------

  /** The epoch this session is in. */
  get epoch(): number {
    return this.#epoch.epoch
  }

  /** Participants removed from this room, at any epoch this session saw. */
  get removed(): ReadonlySet<string> {
    return this.#removed
  }

  /** True once the room's authority closed it. */
  get closed(): boolean {
    return this.#closed
  }

  /**
   * Mark participants removed without a rekey: what a keeper reopening a
   * room from its state does, so the people it removed last week are
   * refused before the roster has said a word. Entries already held for
   * them go now.
   */
  forgetParticipants(participants: readonly string[]): void {
    let changed = false
    for (const raw of participants) {
      const p = normaliseHex(raw)
      this.#removed.add(p)
      for (const [device, entry] of this.#entries) {
        if (entry.participant !== p) continue
        this.#entries.delete(device)
        this.#seenAt.delete(device)
        changed = true
      }
    }
    if (changed) this.#notify()
  }

  /** The current epoch's secret. What a keeper persists and hands to a
   *  member that asks; nothing else should want it. */
  currentEpoch(): RoomEpoch {
    return { epoch: this.#epochSecret.epoch, secret: this.#epochSecret.secret.slice() }
  }

  /** The id and key the roster and chat ride under now. */
  epochKeys(): EpochKeys {
    return { epoch: this.#epoch.epoch, id: this.#epoch.id, key: this.#epoch.key.slice() }
  }

  /** What the codecs are told: nothing in epoch 0, so the wire stays byte
   *  for byte what it was before epochs existed. */
  #epochRoot(): EpochRoot | undefined {
    return this.#epoch.epoch === 0 ? undefined : { id: this.#epoch.id, key: this.#epoch.key }
  }

  /**
   * Decide which epoch to announce in, before announcing. Told the room is
   * ahead, ask the authority now. Told nothing, wait for what the relay
   * replays; a rekey this device cannot read from where it stands is the
   * same instruction to ask. Told the room is where this device is, or
   * behind it, say nothing and get on.
   */
  async #settleEpoch(): Promise<void> {
    const expected = this.#opts.expectedEpoch
    if (expected === undefined) {
      const settle = this.#opts.epochSettleMs ?? DEFAULT_EPOCH_SETTLE_MS
      if (settle > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, settle)
          ;(timer as unknown as { unref?: () => void }).unref?.()
        })
      }
    }
    const ask = this.#drainRekeys()
    if (this.#refusedWhileJoining) throw new EpochRefusedError(this.#refusedWhileJoining)
    if (ask || (expected !== undefined && expected > this.#epoch.epoch)) await this.#catchUp()
    if (this.#refusedWhileJoining) throw new EpochRefusedError(this.#refusedWhileJoining)
  }

  /** Whether a rekey has been heard for an epoch past this one. */
  #behind(): boolean {
    for (const epoch of this.#pendingRekeys.keys()) if (epoch > this.#epoch.epoch) return true
    return false
  }

  /** Never throws: a relay subscription handler. */
  #ingestRekey(event: Event): void {
    if (!this.#opts.authority) return
    const epoch = peekRekeyEvent(event, { roomId: this.roomId, authority: this.#opts.authority })
    if (epoch === null || epoch <= this.#epoch.epoch) return
    this.#pendingRekeys.set(epoch, event)
    // During join the settle step drains; after it, every rekey is acted on
    // the moment it arrives.
    if (this.#unsub && this.#drainRekeys()) this.#catchUp().catch(() => {})
  }

  /**
   * Apply every pending rekey this device can read, in order. Returns true
   * when the authority has to be asked about what is left: a rekey sealed
   * to an epoch this device is not at, or one it can read that carries no
   * copy for it. A rekey is sealed to the epoch it leaves, so a device that
   * missed one cannot read the next either, and the authority's answer is
   * what gets it back in step.
   */
  #drainRekeys(): boolean {
    if (this.#closed || this.#left) return false
    for (;;) {
      const next = this.#pendingRekeys.get(this.#epoch.epoch + 1)
      if (!next) return this.#behind()
      this.#pendingRekeys.delete(this.#epoch.epoch + 1)
      const notice = decodeRekeyEvent(next, {
        roomId: this.roomId,
        authority: this.#opts.authority!,
        current: this.#epoch,
        deviceSk: this.#opts.deviceSk,
      })
      if (!notice) return true
      if (notice.closed) {
        this.#closed = true
        if (!this.#unsub) this.#refusedWhileJoining = 'closed'
        this.#opts.onClosed?.({ epoch: notice.epoch, by: notice.by })
        return false
      }
      if (!notice.secret) {
        if (notice.removed.includes(this.participant)) {
          for (const p of notice.removed) this.#removed.add(p)
          if (!this.#unsub) this.#refusedWhileJoining = 'removed'
          this.#opts.onRemoved?.({ epoch: notice.epoch, by: notice.by })
          return false
        }
        // Not removed, but not in the room when the authority rekeyed: a
        // device that joined between the roster it read and the event, or
        // one arriving now.
        return true
      }
      this.#moveToEpoch({ epoch: notice.epoch, secret: notice.secret }, notice)
    }
  }

  /** Ask the authority for the current epoch. Single flight; rejects on a
   *  refusal, which `join()` surfaces and a live session reports through
   *  `onRemoved`/`onClosed`. */
  #catchUp(): Promise<void> {
    if (this.#catchingUp) return this.#catchingUp
    const run = async (): Promise<void> => {
      const self = this.#self
      const authority = this.#opts.authority
      if (!self || !authority || this.#closed || this.#left) return
      try {
        const grant = await requestRoomEpoch({
          transport: this.#opts.transport,
          roomId: this.roomId,
          authority,
          deviceSk: this.#opts.deviceSk,
          credential: self.credential,
          proof: this.#opts.proof,
          now: this.#now,
          timeoutMs: this.#opts.epochRequestTimeoutMs ?? DEFAULT_EPOCH_REQUEST_TIMEOUT_MS,
        })
        if (this.#left) return
        for (const p of grant.removed) this.#removed.add(p)
        if (grant.epoch.epoch > this.#epoch.epoch) {
          const epoch = grant.epoch as RoomEpoch
          this.#moveToEpoch(epoch, { epoch: epoch.epoch, removed: grant.removed, closed: false, at: this.#now() })
        }
        // Anything past what the authority handed over is readable now.
        for (const epoch of [...this.#pendingRekeys.keys()]) if (epoch <= this.#epoch.epoch) this.#pendingRekeys.delete(epoch)
      } catch (err) {
        if (err instanceof EpochRefusedError) this.#refused(err.refused)
        throw err
      }
    }
    this.#catchingUp = run().finally(() => {
      this.#catchingUp = undefined
      if (this.#unsub && this.#behind() && this.#drainRekeys()) this.#catchUp().catch(() => {})
    })
    return this.#catchingUp
  }

  #refused(why: EpochRefusal): void {
    if (!this.#unsub) this.#refusedWhileJoining = why
    if (why === 'closed') {
      this.#closed = true
      this.#opts.onClosed?.({ epoch: this.#epoch.epoch })
    } else {
      this.#removed.add(this.participant)
      this.#opts.onRemoved?.({ epoch: this.#epoch.epoch })
    }
  }

  /**
   * Enter an epoch: derive its id and key, drop the removed, move every
   * subscription and every log over, and restate this device under the new
   * key so everybody who followed the same rekey hears it there. Entries of
   * members who were kept are kept too, and their media with them; one that
   * never restates itself under the new key lapses on the ordinary timeout.
   */
  #moveToEpoch(next: RoomEpoch, notice: RekeyNotice): void {
    this.#epochSecret = next
    this.#epoch = deriveEpoch(next)
    for (const p of notice.removed) this.#removed.add(p)
    for (const [device, entry] of this.#entries) {
      if (!this.#removed.has(entry.participant)) continue
      this.#entries.delete(device)
      this.#seenAt.delete(device)
    }
    if (this.#unsub) {
      this.#unsub()
      this.#unsub = this.#opts.transport.subscribe(
        [{ kinds: [KINDS.ROSTER], '#d': [this.#epoch.id] }],
        (event) => this.#ingest(event),
      )
    }
    if (this.#unsubDescriptor) {
      this.#unsubDescriptor()
      this.#unsubDescriptor = this.#opts.transport.subscribe(
        [{ kinds: [KINDS.DESCRIPTOR], '#d': [this.#epoch.id] }],
        (event) => this.#ingestDescriptor(event),
      )
    }
    const root = this.#epochRoot()!
    this.#chat?.rekey(root)
    for (const log of this.#channels.values()) log.rekey(root)
    try {
      this.#opts.onEpoch?.(notice)
    } catch {
      // A caller's problem, not the room's.
    }
    if (this.#unsub) {
      this.#publishEntry(true).catch(() => {})
      this.#notify()
    }
  }

  /**
   * Move the room to its next epoch. Only the authority can: the event is
   * signed by the root inviter key, and every other member checks that.
   *
   * The new secret is sealed to every device in this session's roster
   * except the removed participants' and this device's own; whoever is not
   * in the roster now - offline, or arriving later - asks the authority for
   * it and is answered on proof of who they are, see `hostRoomEpoch`.
   * `closed` seals it to nobody: the room ends here.
   */
  async rekey(opts: { authoritySk: Uint8Array; removed?: string[]; by?: string; closed?: boolean }): Promise<RekeyNotice> {
    if (!this.#self) throw new Error('join the room before rekeying it')
    if (this.#closed) throw new Error('this room has been closed')
    const authority = getPublicKey(opts.authoritySk)
    if (this.#opts.authority && !hexEquals(authority, this.#opts.authority)) throw new Error('only the room authority can rekey it')
    const removed = [...new Set((opts.removed ?? []).map(normaliseHex))].sort()
    const next: RoomEpoch = { epoch: this.#epoch.epoch + 1, secret: generateEpochSecret() }
    const recipients = [...this.#entries.values()]
      .filter((e) => e.device !== this.device && !removed.includes(e.participant) && !this.#removed.has(e.participant))
      .map((e) => e.device)
    const now = this.#now()
    const event = encodeRekeyEvent({
      roomId: this.roomId,
      authoritySk: opts.authoritySk,
      current: this.#epoch,
      next,
      recipients,
      removed,
      by: opts.by,
      closed: opts.closed,
      now,
    })
    await this.#opts.transport.publish(event)
    const notice: RekeyNotice = {
      epoch: next.epoch,
      removed,
      ...(opts.by !== undefined ? { by: normaliseHex(opts.by) } : {}),
      closed: opts.closed === true,
      secret: next.secret,
      at: now,
    }
    if (opts.closed) {
      this.#closed = true
      try {
        this.#opts.onEpoch?.(notice)
        this.#opts.onClosed?.({ epoch: next.epoch, by: notice.by })
      } catch {
        // A caller's problem, not the room's.
      }
      return notice
    }
    this.#moveToEpoch(next, notice)
    return notice
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
      { roomId: this.roomId, roomKey: this.#roomKey, deviceSk: this.#opts.deviceSk, ...(this.#epochRoot() ? { epoch: this.#epochRoot() } : {}) },
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
      ...(this.#epochRoot() ? { epoch: this.#epochRoot() } : {}),
    })
    if (!descriptor) return
    if (this.#removed.has(descriptor.participant)) return
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
      ...(this.#ownerToCarry() ? { owner: this.#ownerToCarry() } : {}),
      ...(assist ? { assist } : {}),
      ...(this.#opts.proof ? { proof: this.#opts.proof } : {}),
      ...(reply ? { reply: true } : {}),
      ...(left ? { left: true } : {}),
    }
    const event = encodeRosterEvent(entry, {
      roomId: this.roomId,
      roomKey: this.#roomKey,
      deviceSk: this.#opts.deviceSk,
      ...(this.#epochRoot() ? { epoch: this.#epochRoot() } : {}),
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
    // Under the agent rule, an agent goes with its principal: the proof
    // said whose it was, and that person is not here any more.
    if (this.#opts.policy?.agents === 'owned-by-members') {
      for (const [device, entry] of this.#entries) {
        if (device === this.device) continue
        if (evaluateAgentAccess(this.#opts.policy, entry, (p) => this.#isMember(p)).admitted) continue
        this.#entries.delete(device)
        this.#seenAt.delete(device)
        changed = true
      }
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
      ...(this.#epochRoot() ? { epoch: this.#epochRoot() } : {}),
      ...(this.#ownerToCarry() ? { owner: this.#ownerToCarry() } : {}),
    })
    this.#channels.set(name, log)
    return log
  }

  #ingest(event: Event): void {
    const entry = decodeRosterEvent(event, {
      roomId: this.roomId,
      roomKey: this.#roomKey,
      now: this.#now(),
      ...(this.#epochRoot() ? { epoch: this.#epochRoot() } : {}),
    })
    if (!entry) return
    // Removed is removed, whatever key an entry arrived under.
    if (this.#removed.has(entry.participant)) return

    // Every member evaluates every other member's tier for itself. The
    // joiner's own self-check at join() is a courtesy that fails fast; it
    // proves nothing to anybody else, because a modified client - or one
    // simply constructed without a policy - skips it entirely. This is where
    // the gate is actually enforced.
    if (this.#opts.policy) {
      const verdict = evaluateAccess(this.#opts.policy, entry.participant, entry.proof, this.#now(), this.roomId)
      if (!verdict.admitted) return
      // The agent rule, enforced where every rule is: at every reader.
      // `entry.owner` is here only if `decodeRosterEvent` verified it.
      // Our own entry echoing back is exempt: we know we are here.
      if (entry.device !== this.device && !evaluateAgentAccess(this.#opts.policy, entry, (p) => this.#isMember(p)).admitted) return
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
      // Verified at decode, or not here at all. One proof per person is
      // enough: every device of one agent names the same principal.
      if (entry.owner && !view.owner) {
        view.owner = { principal: entry.owner.principal, ...(entry.owner.label !== undefined ? { label: entry.owner.label } : {}) }
      }
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
    this.#unsubRekey?.()
    this.#unsubRekey = undefined
    this.#pendingRekeys.clear()
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
