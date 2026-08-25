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

const CREDENTIAL_TTL_SECONDS = 12 * 60 * 60
const DEFAULT_ANNOUNCE_JITTER_MS = 500

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

/** The timings that govern presence. All of them are tunable guesses; none of
 *  them changes what is correct. Matches the Android client's `SessionTiming`. */
export interface SessionTiming {
  heartbeatIntervalMs?: number
  presenceTtlSeconds?: number
  sweepIntervalMs?: number
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
  #unsub?: () => void
  #mesh?: Mesh
  #chat?: ChatLog
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
  #left = false
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
    const credential = this.#credential ?? (await this.issueDeviceCredential(device))

    this.#self = { credential, tracks, claims }
    await this.#publishEntry(false)

    this.#chat = new ChatLog({
      transport: this.#opts.transport,
      roomId: this.roomId,
      roomKey: this.#roomKey,
      credential,
      deviceSk: this.#opts.deviceSk,
      name: this.#name,
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
    }

    // Subscribed after the mesh exists, so a descriptor that arrives in the
    // same tick has somewhere to go. Ephemeral, like the roster: nothing is
    // replayed to a device that subscribes later, so a room that has gone
    // quiet has no forwarder list until somebody restates one.
    this.#unsubDescriptor = this.#opts.transport.subscribe(
      [{ kinds: [KINDS.DESCRIPTOR], '#d': [this.roomId] }],
      (event) => this.#ingestDescriptor(event),
    )
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
   */
  async setAssist(next: (() => AssistOffer | null) | AssistOffer | null): Promise<void> {
    this.#assist = typeof next === 'function' ? next : () => next
    // Stops carrying anybody before announcing that we no longer will, so
    // there is no window in which the room believes an offer this device has
    // already withdrawn.
    if (this.#assist() === null) this.#opts.relay?.close()
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

  async #publishEntry(reply: boolean): Promise<void> {
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
      ...(assist ? { assist } : {}),
      ...(this.#opts.proof ? { proof: this.#opts.proof } : {}),
      ...(reply ? { reply: true } : {}),
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
      const lapsed = entry.updatedAt < cutoff
      const credentialExpired = !verifyDeviceCredential(entry.credential, { roomId: this.roomId, now }).ok
      if (!lapsed && !credentialExpired) continue
      this.#entries.delete(device)
      // Forgetting a departed device is what lets a genuine rejoin be
      // answered again later without reopening the announce loop: they are
      // gone, so the next thing we hear from them really is an arrival.
      changed = true
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

  /** Publish live media tracks to every remote device's peer connection.
   *  Own other devices never receive them, because they never get a peer
   *  connection in the first place - see `Mesh`. A no-op until `join()` has
   *  set up media, and if no `factory` was supplied at all. */
  publishTracks(tracks: MediaStreamTrack[]): void {
    this.#mesh?.publish(tracks)
  }

  /** Remote media tracks, attributed to the participant they came from -
   *  never the device - which is the whole point of grouping devices into
   *  one view. A no-op subscription if media was never set up. */
  onRemoteTrack(cb: (t: RemoteTrack) => void): () => void {
    return this.#mesh?.onRemoteTrack(cb) ?? (() => {})
  }

  /** The room's chat log. Only available after a successful `join()` - chat
   *  is a room capability, gated by the same access check as everything
   *  else. */
  get chat(): ChatLog {
    if (!this.#chat) throw new Error('join the room before using chat')
    return this.#chat
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

    this.#entries.set(entry.device, entry)

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

  leave(): void {
    // The wire format has no departure message, so the last thing this device
    // says is an entry claiming nothing and publishing nothing. That releases
    // a singular role at once rather than making the room wait out the
    // presence timeout, and a device that is simply switched off is removed
    // by that timeout anyway - so there is only one path to test.
    if (this.#self && !this.#left) {
      this.#self = { ...this.#self, tracks: [], claims: {} }
      // Flagged the same way an answer is, because a farewell is not an
      // arrival either: without it, the last thing a leaving device does is
      // provoke every remaining device into re-announcing at it.
      this.#publishEntry(true).catch(() => {})
    }

    this.#left = true
    if (this.#replyTimer !== undefined) clearTimeout(this.#replyTimer)
    this.#replyTimer = undefined
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = undefined
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer)
    this.#sweepTimer = undefined
    this.#unsub?.()
    this.#unsubDescriptor?.()
    this.#unsubDescriptor = undefined
    this.#mesh?.close()
    this.#chat?.close()
    this.#listeners.clear()
    this.#entries.clear()
  }
}
