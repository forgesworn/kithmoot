import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { getPublicKey } from 'nostr-tools/pure'
import { hexEquals, normaliseHex } from './hex.js'
import type { ParticipantIdentity } from './identity.js'
import { MAX_CHANNEL_NAME_LENGTH } from './chat.js'
import { MAX_MESSAGE_ID_LENGTH } from './messages.js'

/**
 * Where a person has read to, per room and per channel, on the wire once
 * per participant so that unread is the same on every device that holds
 * their identity. The design is `docs/messages.md`.
 *
 * The record is a NIP-78 application-data event signed by the participant
 * key, replaceable per room by a `d` tag derived from the room's key, and
 * encrypted to the participant's own key. That is the bookmark pattern,
 * and it inherits the bookmarks' limit: a signer with no NIP-44 cannot
 * publish one.
 */
export const READ_POSITION_KIND = 30078
export const READ_POSITION_LABEL = 'kithmoot.read.v1'
const READ_POSITION_ID_INFO = 'kithmoot/v1/read-position-id'

/** The `d` tag for a room: from the room's epoch-0 key, which every member
 *  holds and no relay does, so a relay cannot tie the record to a room id
 *  it carries. Members can compute it, and learn that a participant keeps
 *  a position for the room; they cannot read it. */
export function readPositionId(roomKey: Uint8Array): string {
  const bytes = hkdf(sha256, roomKey, undefined, READ_POSITION_ID_INFO, 32)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ReadPosition {
  /** The `sentAt` of the last message read. What unread compares against. */
  at: number
  /** Its id, to break a tie between messages sent in the same second. */
  id?: string
}

/** Channel name to position. The main chat is `''`. */
export type ReadPositions = Record<string, ReadPosition>

export interface ReadPositionRecord {
  room: string
  read: ReadPositions
}

/**
 * NIP-44 to self. A local identity does it with its key; a signer does it
 * with its own pubkey as the peer, which is what NIP-07 and NIP-46 offer.
 */
export interface SelfCrypt {
  encrypt(plaintext: string): Promise<string>
  decrypt(ciphertext: string): Promise<string>
}

export function localSelfCrypt(participantSk: Uint8Array): SelfCrypt {
  const key = nip44.v2.utils.getConversationKey(participantSk, getPublicKey(participantSk))
  return {
    async encrypt(plaintext) { return nip44.v2.encrypt(plaintext, key) },
    async decrypt(ciphertext) { return nip44.v2.decrypt(ciphertext, key) },
  }
}

export function signerSelfCrypt(signer: {
  pubkey: string
  nip44: { encrypt(peer: string, plaintext: string): Promise<string>; decrypt(peer: string, ciphertext: string): Promise<string> }
}): SelfCrypt {
  return {
    encrypt: (plaintext) => signer.nip44.encrypt(signer.pubkey, plaintext),
    decrypt: (ciphertext) => signer.nip44.decrypt(signer.pubkey, ciphertext),
  }
}

export interface EncodeReadPositionOptions {
  roomId: string
  roomKey: Uint8Array
  identity: ParticipantIdentity
  crypt: SelfCrypt
  /** Unix seconds. Replaceable events resolve on this, so a device that
   *  is behind must not publish with a later stamp than one ahead of it;
   *  callers merge first (`mergeReadPositions`) and publish once. */
  createdAt: number
}

/** The plaintext, in the one canonical shape both implementations write. */
export function readPositionPlaintext(record: ReadPositionRecord): string {
  const read: ReadPositions = {}
  for (const channel of Object.keys(record.read).sort()) {
    const p = record.read[channel]!
    read[channel] = p.id === undefined ? { at: p.at } : { at: p.at, id: p.id }
  }
  return JSON.stringify({ v: 1, room: normaliseHex(record.room), read })
}

export async function encodeReadPositions(read: ReadPositions, opts: EncodeReadPositionOptions): Promise<Event> {
  const content = await opts.crypt.encrypt(readPositionPlaintext({ room: opts.roomId, read }))
  return opts.identity.signEvent({
    kind: READ_POSITION_KIND,
    created_at: opts.createdAt,
    tags: [['d', readPositionId(opts.roomKey)], ['l', READ_POSITION_LABEL]],
    content,
  })
}

/** Sign locally, for a caller that holds the key. The identity path above
 *  is what the app uses; this is what a keeper or a test uses. */
export function encodeReadPositionsLocal(read: ReadPositions, opts: Omit<EncodeReadPositionOptions, 'identity' | 'crypt'> & { participantSk: Uint8Array }): Event {
  const key = nip44.v2.utils.getConversationKey(opts.participantSk, getPublicKey(opts.participantSk))
  return finalizeEvent({
    kind: READ_POSITION_KIND,
    created_at: opts.createdAt,
    tags: [['d', readPositionId(opts.roomKey)], ['l', READ_POSITION_LABEL]],
    content: nip44.v2.encrypt(readPositionPlaintext({ room: opts.roomId, read }), key),
  }, opts.participantSk)
}

export interface DecodeReadPositionOptions {
  /** Whose record this must be. Anybody else's is refused before it is
   *  opened: the author is on the envelope. */
  participant: string
  roomId: string
  roomKey: Uint8Array
  crypt: SelfCrypt
}

/**
 * Read a record, or null. Never throws: this runs on whatever a relay
 * hands back for the subscription, which is anybody's.
 */
export async function decodeReadPositions(event: Event, opts: DecodeReadPositionOptions): Promise<ReadPositionRecord | null> {
  try {
    if (event.kind !== READ_POSITION_KIND) return null
    if (!hexEquals(event.pubkey, opts.participant)) return null
    const d = event.tags.find((t) => t[0] === 'd')?.[1]
    if (d === undefined || !hexEquals(d, readPositionId(opts.roomKey))) return null
    if (!event.tags.some((t) => t[0] === 'l' && t[1] === READ_POSITION_LABEL)) return null
    if (!verifyEvent(event)) return null
    const body = JSON.parse(await opts.crypt.decrypt(event.content)) as Record<string, unknown>
    if (body.v !== 1) return null
    if (typeof body.room !== 'string' || !hexEquals(body.room, opts.roomId)) return null
    if (!body.read || typeof body.read !== 'object' || Array.isArray(body.read)) return null
    const read: ReadPositions = {}
    for (const [channel, raw] of Object.entries(body.read as Record<string, unknown>)) {
      if (channel.length > MAX_CHANNEL_NAME_LENGTH) continue
      if (!raw || typeof raw !== 'object') continue
      const p = raw as Record<string, unknown>
      if (typeof p.at !== 'number' || !Number.isSafeInteger(p.at) || p.at < 0) continue
      const position: ReadPosition = { at: p.at }
      if (typeof p.id === 'string' && p.id.length > 0 && p.id.length <= MAX_MESSAGE_ID_LENGTH) position.id = p.id
      read[channel] = position
    }
    return { room: normaliseHex(body.room), read }
  } catch {
    return null
  }
}

/** Whether `a` is further on than `b`. */
export function furtherOn(a: ReadPosition, b: ReadPosition | undefined): boolean {
  if (!b) return true
  if (a.at !== b.at) return a.at > b.at
  return (a.id ?? '') > (b.id ?? '')
}

/**
 * Merge what this device knows with a record off the wire: the greater
 * position per channel wins, and `localAhead` says whether this device
 * knew something the record did not, so it should republish.
 */
export function mergeReadPositions(local: ReadPositions, remote: ReadPositions): { merged: ReadPositions; localAhead: boolean; remoteAhead: boolean } {
  const merged: ReadPositions = {}
  let localAhead = false
  let remoteAhead = false
  for (const channel of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[channel]
    const r = remote[channel]
    if (l && (!r || furtherOn(l, r))) {
      merged[channel] = l
      if (!r || furtherOn(l, r)) localAhead = true
    } else if (r) {
      merged[channel] = r
      if (!l || furtherOn(r, l)) remoteAhead = true
    }
  }
  return { merged, localAhead, remoteAhead }
}
