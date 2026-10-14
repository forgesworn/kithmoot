import { finalizeEvent, generateSecretKey, getEventHash, type Event, type EventTemplate } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { parseRoomLink } from './link.js'
import { dmPeer, type PeerCrypt } from './dm.js'
import { randomFraction } from './random.js'
import { verifyEventUncached } from './verify.js'

/** A NIP-17 message carries only the invitation. Conversation traffic keeps
 * the ordinary room protocol. The application marker is encrypted too. */
export const CONTACT_INVITATION_TAG = 'kithmoot-invitation'
export const MAX_CONTACT_INVITATION_BYTES = 40_000
export interface ContactInvitationIdentity extends PeerCrypt {
  pubkey: string
  signEvent(event: EventTemplate): Promise<Event>
}
export interface ContactInvitation {
  id: string
  sender: string
  recipient: string
  room: string
  link: string
  sentAt: number
}
export type ContactInvitationRumor = EventTemplate & { pubkey: string; id: string }
const HEX = /^[0-9a-f]{64}$/

export function contactInvitationRumor(sender: string, recipient: string, room: string, link: string, now: number): ContactInvitationRumor {
  const event = { kind: 14, pubkey: sender, created_at: now,
    tags: [['p', recipient], [CONTACT_INVITATION_TAG, '1', room]], content: link }
  const rumor = { ...event, id: getEventHash(event) }
  if (!readContactInvitation(rumor, sender, now)) throw new Error('Invalid private conversation invitation')
  return rumor
}

/** Never use the label or URL author as identity evidence. Bind the exact two
 * members to the authenticated sender and recipient before offering a join. */
export function readContactInvitation(value: unknown, self: string, now: number): ContactInvitation | undefined {
  try {
    const r = value as ContactInvitationRumor
    if (!r || r.kind !== 14 || !HEX.test(r.pubkey) || !HEX.test(r.id) || !Array.isArray(r.tags) || r.tags.length !== 2
      || !Number.isSafeInteger(r.created_at) || r.created_at < 0 || r.created_at > now + 60
      || typeof r.content !== 'string' || r.content.length > 12_000 || r.id !== getEventHash(r)) return
    const [p, marker] = r.tags
    if (!p || p.length !== 2 || p[0] !== 'p' || !HEX.test(p[1]!) || p[1] === r.pubkey
      || !marker || marker.length !== 3 || marker[0] !== CONTACT_INVITATION_TAG || marker[1] !== '1' || !HEX.test(marker[2]!)
      || self !== r.pubkey && self !== p[1]) return
    const parsed = parseRoomLink(r.content)
    if (!parsed.invitation?.persistent || parsed.secret || parsed.pairingCode || parsed.policy?.quiet
      || dmPeer(parsed.policy, r.pubkey) !== p[1] || dmPeer(parsed.policy, p[1]!) !== r.pubkey) return
    return { id: r.id, sender: r.pubkey, recipient: p[1]!, room: marker[2]!, link: r.content, sentAt: r.created_at }
  } catch { return }
}

export async function wrapContactInvitation(rumor: ContactInvitationRumor, identity: ContactInvitationIdentity,
  recipient: string, now: number, current: () => boolean): Promise<Event> {
  if (rumor.pubkey !== identity.pubkey || !readContactInvitation(rumor, recipient, now) || !current()) throw new Error('Invitation is no longer authorised')
  const sealTemplate = { kind: 13, created_at: Math.max(0, now - Math.floor(randomFraction() * 172800)), tags: [],
    content: await identity.encrypt(recipient, JSON.stringify(rumor)) }
  if (!current()) throw new Error('Invitation is no longer authorised')
  const seal = await identity.signEvent(sealTemplate)
  if (!current() || seal.pubkey !== identity.pubkey || !verifyEventUncached(seal)
    || seal.kind !== 13 || seal.created_at !== sealTemplate.created_at || seal.content !== sealTemplate.content || seal.tags.length) throw new Error('Signer returned an invalid invitation seal')
  const key = generateSecretKey()
  try {
    const content = nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(key, recipient))
    if (content.length > MAX_CONTACT_INVITATION_BYTES) throw new Error('Invitation exceeds the transport limit')
    return finalizeEvent({ kind: 1059, created_at: Math.max(0, now - Math.floor(randomFraction() * 172800)), tags: [['p', recipient]], content }, key)
  } finally { key.fill(0) }
}

export function isContactInvitationWrap(event: Event, self: string, now: number): boolean {
  return event.kind === 1059 && typeof event.content === 'string' && event.content.length <= MAX_CONTACT_INVITATION_BYTES
    && Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= now + 60
    && JSON.stringify(event.tags) === JSON.stringify([['p', self]]) && verifyEventUncached(event)
}

export async function unwrapContactInvitation(event: Event, identity: ContactInvitationIdentity, now: number): Promise<ContactInvitationRumor | undefined> {
  try {
    if (!isContactInvitationWrap(event, identity.pubkey, now)) return
    const seal: Event = JSON.parse(await identity.decrypt(event.pubkey, event.content))
    if (seal.kind !== 13 || seal.tags.length || typeof seal.content !== 'string' || seal.content.length > MAX_CONTACT_INVITATION_BYTES
      || !Number.isSafeInteger(seal.created_at) || seal.created_at < 0 || seal.created_at > now + 60 || !verifyEventUncached(seal)) return
    const rumor = JSON.parse(await identity.decrypt(seal.pubkey, seal.content)) as ContactInvitationRumor
    return rumor.pubkey === seal.pubkey && readContactInvitation(rumor, identity.pubkey, now) ? rumor : undefined
  } catch { return }
}
