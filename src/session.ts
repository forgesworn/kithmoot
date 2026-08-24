import { getPublicKey } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { encodeRosterEvent, decodeRosterEvent } from './roster.js'
import { resolveSingularRoles } from './roles.js'
import { KINDS } from './kinds.js'
import { evaluateAccess } from './access.js'
import { Mesh } from './mesh.js'
import type { PeerFactory } from './peer.js'
import type { RemoteTrack } from './mesh.js'
import { ChatLog } from './chat.js'
import type { RelayTransport } from './relay-pool.js'
import type { KindredProof, RoomPolicy, RosterEntry, SingularRole, TrackAdvert } from './types.js'

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

export interface RoomSessionOptions {
  transport: RelayTransport
  secret: Uint8Array
  participantSk: Uint8Array
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
  #roomKey: Uint8Array
  #opts: RoomSessionOptions
  #now: () => number
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
  }

  async join(tracks: TrackAdvert[], claims: Partial<Record<SingularRole, number>>): Promise<void> {
    if (this.#opts.policy) {
      const verdict = evaluateAccess(
        this.#opts.policy,
        getPublicKey(this.#opts.participantSk),
        this.#opts.proof,
        this.#now(),
      )
      if (!verdict.admitted) throw new Error(verdict.reason)
    }

    this.#unsub = this.#opts.transport.subscribe(
      [{ kinds: [KINDS.ROSTER], '#d': [this.roomId] }],
      (event) => this.#ingest(event),
    )

    const device = getPublicKey(this.#opts.deviceSk)
    const credential = createDeviceCredential({
      participantSk: this.#opts.participantSk,
      devicePubkey: device,
      roomId: this.roomId,
      expiresAt: this.#now() + CREDENTIAL_TTL_SECONDS,
    })

    const entry: RosterEntry = {
      participant: getPublicKey(this.#opts.participantSk),
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
      participant: entry.participant,
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
    const views = this.participants()
    for (const listener of this.#listeners) listener(views)
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
