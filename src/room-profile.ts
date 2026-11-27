import type { Event } from 'nostr-tools/pure'
import { readLogoImage, type LogoImage } from './logo-image.js'
import { verifyEventUncached } from './verify.js'

export interface RoomProfile {
  event: Event
  photo?: LogoImage
}

const MAX_PROFILE_BYTES = 8_192
const encoder = new TextEncoder()

/** Accept the original signed kind 0 for this participant. The optional
 * photo is a separate room assertion and contains only bounded raster bytes. */
export function readRoomProfile(value: unknown, participant: string, now: number): RoomProfile | undefined {
  try {
    if (!value || typeof value !== 'object' || !('event' in value)) return
    const event = value.event as Event | undefined
    if (!event || event.pubkey !== participant || event.kind !== 0 ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > now + 60 ||
        typeof event.content !== 'string' || event.content.length > MAX_PROFILE_BYTES ||
        !Array.isArray(event.tags)) return
    const wire = { kind: event.kind, pubkey: event.pubkey, id: event.id, sig: event.sig,
      created_at: event.created_at, content: event.content, tags: event.tags }
    if (encoder.encode(JSON.stringify(wire)).length > MAX_PROFILE_BYTES || !verifyEventUncached(wire)) return
    const content: unknown = JSON.parse(wire.content)
    if (!content || typeof content !== 'object' || Array.isArray(content)) return
    const photo = 'photo' in value ? readLogoImage(value.photo) : undefined
    return { event: wire, ...(photo ? { photo } : {}) }
  } catch { return undefined }
}

/** NIP-01 replacement order, including events signed in the same second. */
export function newerProfile(event: Pick<Event, 'created_at' | 'id'>, previous: Pick<Event, 'created_at' | 'id'>): boolean {
  return event.created_at > previous.created_at || event.created_at === previous.created_at && event.id < previous.id
}
