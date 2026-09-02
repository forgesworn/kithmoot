import { finalizeEvent, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { KINDS } from './kinds.js'
import { verifyDeviceCredential } from './credential.js'
import { verifyEventUncached } from './verify.js'
import { hexEquals, normaliseHex } from './hex.js'
import { MAX_FUTURE_SKEW_SECONDS } from './roster.js'
import { evaluateAccess } from './access.js'
import type { ForwarderRef, IceServerRef, RoomDescriptor, RoomPolicy } from './types.js'

export interface EncodeDescriptorOptions {
  roomId: string
  roomKey: Uint8Array
  deviceSk: Uint8Array
  /** The epoch to publish in. Omit for epoch 0. See `epoch.ts`. */
  epoch?: { id: string; key: Uint8Array }
}

/**
 * Project a forwarder entry onto exactly the fields a forwarder reference is
 * allowed to have.
 *
 * This is the mechanism behind the stage's central claim, and it is
 * deliberately a projection rather than a validation: a check that rejects a
 * forwarder entry carrying a `roomKey` field only helps if somebody
 * remembered to write the check for that particular field name, whereas
 * copying out three named fields cannot carry a fourth whatever it is
 * called. A forwarder is given the room *id*; there is no shape of this
 * function in which it is handed the room *key*.
 *
 * Applied on the way out as well as on the way in. On the way out it stops a
 * caller's own object - a config blob with the room secret sitting next to
 * the forwarder list - being serialised wholesale into the ciphertext. On the
 * way in it stops a second implementation's extra fields reaching this one's
 * callers.
 */
function projectForwarder(raw: unknown): ForwarderRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { url, pubkey, label } = raw as Partial<ForwarderRef>
  if (typeof url !== 'string' || url === '') return null
  const ref: ForwarderRef = { url }
  // Normalised here, at the boundary, so `selectForwarder`'s ordering and
  // preference matching never has to care what case it arrived in.
  if (typeof pubkey === 'string') ref.pubkey = normaliseHex(pubkey)
  if (typeof label === 'string') ref.label = label
  return ref
}

/** As `projectForwarder`, for the ICE server list. */
function projectIceServer(raw: unknown): IceServerRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { urls, username, credential } = raw as Partial<IceServerRef>
  if (!Array.isArray(urls) || urls.length === 0) return null
  if (!urls.every((u) => typeof u === 'string' && u !== '')) return null
  const server: IceServerRef = { urls: [...urls] }
  if (typeof username === 'string') server.username = username
  if (typeof credential === 'string') server.credential = credential
  return server
}

function projectList<T>(raw: unknown, project: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const entry of raw) {
    const projected = project(entry)
    // One malformed entry costs that entry, never the descriptor. A room
    // whose forwarder list is half-readable should use the half it can read.
    if (projected) out.push(projected)
  }
  return out
}

/**
 * Encode the room's forwarder and ICE configuration as an event encrypted to
 * the room key.
 *
 * Only the room id is on the wire; the forwarder addresses, the participant
 * and the credential are all inside the ciphertext, so a relay learns no more
 * from a descriptor than it does from a roster entry.
 */
export function encodeDescriptorEvent(descriptor: RoomDescriptor, opts: EncodeDescriptorOptions): Event {
  const payload: RoomDescriptor = {
    device: normaliseHex(descriptor.device),
    participant: normaliseHex(descriptor.participant),
    credential: descriptor.credential,
    ...(descriptor.proof ? { proof: descriptor.proof } : {}),
    forwarders: projectList(descriptor.forwarders, projectForwarder),
    iceServers: projectList(descriptor.iceServers, projectIceServer),
    updatedAt: descriptor.updatedAt,
  }
  const root = opts.epoch ?? { id: opts.roomId, key: opts.roomKey }
  return finalizeEvent(
    {
      kind: KINDS.DESCRIPTOR,
      created_at: descriptor.updatedAt,
      tags: [['d', root.id]],
      content: nip44.v2.encrypt(JSON.stringify(payload), root.key),
    },
    opts.deviceSk,
  )
}

export interface DecodeDescriptorOptions {
  /** The room the publisher's credential is checked against. */
  roomId: string
  roomKey: Uint8Array
  /** Unix seconds. */
  now: number
  policy?: RoomPolicy
  /** The epoch to read. Omit for epoch 0. */
  epoch?: { id: string; key: Uint8Array }
}

/**
 * Decode and fully verify a room descriptor.
 *
 * Returns null for anything that does not check out - wrong key, wrong room,
 * bad signature, an uncredentialled or expired publisher, a timestamp beyond
 * clock skew, malformed payload. It never throws, because it runs inside a
 * relay subscription handler where a throw would take down the whole room.
 */
export function decodeDescriptorEvent(event: Event, opts: DecodeDescriptorOptions): RoomDescriptor | null {
  try {
    if (event.kind !== KINDS.DESCRIPTOR) return null
    const root = opts.epoch ?? { id: opts.roomId, key: opts.roomKey }
    const roomTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (roomTag === undefined || !hexEquals(roomTag, root.id)) return null
    if (!verifyEventUncached(event)) return null

    const raw = JSON.parse(nip44.v2.decrypt(event.content, root.key)) as Partial<RoomDescriptor>
    if (typeof raw.device !== 'string' || typeof raw.participant !== 'string') return null
    if (raw.credential === undefined || raw.credential === null) return null

    const descriptor: RoomDescriptor = {
      device: normaliseHex(raw.device),
      participant: normaliseHex(raw.participant),
      credential: raw.credential,
      ...(raw.proof ? { proof: raw.proof } : {}),
      forwarders: projectList(raw.forwarders, projectForwarder),
      iceServers: projectList(raw.iceServers, projectIceServer),
      updatedAt: raw.updatedAt as number,
    }

    // The device that signed this event must be the device it names.
    if (!hexEquals(descriptor.device, event.pubkey)) return null

    // `updatedAt` is what orders two descriptors, so a device stamping the
    // year 3000 would pin its own forwarder list in place for good - the
    // same pin the roster's skew bound exists to close, on the same terms.
    if (!Number.isFinite(descriptor.updatedAt)) return null
    if (descriptor.updatedAt > opts.now + MAX_FUTURE_SKEW_SECONDS) return null

    const verdict = verifyDeviceCredential(descriptor.credential, { roomId: opts.roomId, now: opts.now })
    if (!verdict.ok) return null
    if (!hexEquals(verdict.device, event.pubkey)) return null
    if (!hexEquals(verdict.participant, descriptor.participant)) return null

    if (opts.policy) {
      const access = evaluateAccess(opts.policy, descriptor.participant, descriptor.proof, opts.now, opts.roomId)
      if (!access.admitted) return null
    }

    return descriptor
  } catch {
    return null
  }
}
