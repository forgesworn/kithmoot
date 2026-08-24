import { getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { deriveRoom } from './room.js'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'
import { encodeRosterEvent, decodeRosterEvent } from './roster.js'
import { resolveSingularRoles } from './roles.js'
import { KINDS } from './kinds.js'
import { evaluateAccess } from './access.js'
import { Mesh } from './mesh.js'
import type { PeerFactory } from './peer.js'
import type { RemoteTrack } from './mesh.js'
import { ChatLog } from './chat.js'
import type { RelayTransport } from './relay-pool.js'
import type {
  DeviceCredential,
  KindredProof,
  RoomPolicy,
  RosterEntry,
  SingularRole,
  TrackAdvert,
} from './types.js'

/** One person, however many devices they brought. */
export interface ParticipantView {
  participant: string
  devices: string[]
  tracks: Array<TrackAdvert & { device: string }>
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
  /** Upper bound on the random delay before answering a new arrival, in
   *  milliseconds. Jitter is what stops twenty devices answering the
   *  twenty-first in the same instant. Zero makes it deterministic, which
   *  is what tests want. */
  announceJitterMs?: number
  /** Presence timings. Omit for the defaults. */
  timing?: SessionTiming
}

/**
 * The primary device: the one endpoint that holds the participant key. It
 * mints its own credential at join and can issue credentials for the
 * participant's other devices via `issueDeviceCredential`.
 */
export interface PrimaryRoomSessionOptions extends RoomSessionBaseOptions {
  participantSk: Uint8Array
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
  participantSk?: never
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
   *  participant key's pubkey; on a secondary it is read off the credential,
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
  /** At most one answer in flight: twenty devices arriving at once must
   *  produce one re-announce from us, not twenty. */
  #replyTimer?: ReturnType<typeof setTimeout>
  #heartbeatTimer?: ReturnType<typeof setInterval>
  #sweepTimer?: ReturnType<typeof setInterval>
  #left = false

  constructor(opts: RoomSessionOptions) {
    const { roomId, roomKey } = deriveRoom(opts.secret)
    this.roomId = roomId
    this.#roomKey = roomKey
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.device = getPublicKey(opts.deviceSk)

    if (opts.participantSk) {
      this.participant = getPublicKey(opts.participantSk)
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
   * participant's devices. Only a primary device can: minting requires the
   * participant key, and a secondary deliberately does not have it.
   *
   * This is what a pairing flow transfers - never the participant key
   * itself. See `pairing.ts`.
   */
  issueDeviceCredential(devicePubkey: string, ttlSeconds = CREDENTIAL_TTL_SECONDS): DeviceCredential {
    const participantSk = this.#opts.participantSk
    if (!participantSk) throw new Error('this device has no participant key, so it cannot issue credentials')
    return createDeviceCredential({
      participantSk,
      devicePubkey,
      roomId: this.roomId,
      expiresAt: this.#now() + ttlSeconds,
    })
  }

  async join(tracks: TrackAdvert[], claims: Partial<Record<SingularRole, number>>): Promise<void> {
    if (this.#opts.policy) {
      const verdict = evaluateAccess(this.#opts.policy, this.participant, this.#opts.proof, this.#now())
      if (!verdict.admitted) throw new Error(verdict.reason)
    }

    this.#unsub = this.#opts.transport.subscribe(
      [{ kinds: [KINDS.ROSTER], '#d': [this.roomId] }],
      (event) => this.#ingest(event),
    )

    const device = this.device
    // A secondary device uses the credential it was issued; only a primary,
    // which is the only endpoint holding the participant key, can mint one.
    const credential = this.#credential ?? this.issueDeviceCredential(device)

    this.#self = { credential, tracks, claims }
    await this.#publishEntry(false)

    this.#chat = new ChatLog({
      transport: this.#opts.transport,
      roomId: this.roomId,
      roomKey: this.#roomKey,
      credential,
      deviceSk: this.#opts.deviceSk,
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
      })
    }
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

    const entry: RosterEntry = {
      participant: this.participant,
      device: this.device,
      credential: self.credential,
      tracks: self.tracks,
      claims: self.claims,
      updatedAt: this.#now(),
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
      const verdict = evaluateAccess(this.#opts.policy, entry.participant, entry.proof, this.#now())
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

    for (const entry of entries) {
      let view = byParticipant.get(entry.participant)
      if (!view) {
        view = { participant: entry.participant, devices: [], tracks: [] }
        byParticipant.set(entry.participant, view)
      }
      view.devices.push(entry.device)
      for (const track of entry.tracks) view.tracks.push({ ...track, device: entry.device })
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
    this.#mesh?.close()
    this.#chat?.close()
    this.#listeners.clear()
    this.#entries.clear()
  }
}
