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

    const entry: RosterEntry = {
      participant: this.participant,
      device,
      credential,
      tracks,
      claims,
      updatedAt: this.#now(),
    }

    const event = encodeRosterEvent(entry, {
      roomId: this.roomId,
      roomKey: this.#roomKey,
      deviceSk: this.#opts.deviceSk,
    })
    await this.#opts.transport.publish(event)

    this.#chat = new ChatLog({
      transport: this.#opts.transport,
      roomId: this.roomId,
      roomKey: this.#roomKey,
      credential,
      deviceSk: this.#opts.deviceSk,
      now: this.#now,
    })

    if (this.#opts.factory) {
      this.#mesh = new Mesh({
        session: this,
        factory: this.#opts.factory,
        localDevice: device,
        localParticipant: entry.participant,
        deviceSk: this.#opts.deviceSk,
        transport: this.#opts.transport,
        roomId: this.roomId,
      })
    }
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

    const existing = this.#entries.get(entry.device)
    if (existing && existing.updatedAt > entry.updatedAt) return

    this.#entries.set(entry.device, entry)
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
    this.#unsub?.()
    this.#mesh?.close()
    this.#chat?.close()
    this.#listeners.clear()
    this.#entries.clear()
  }
}
