import { nip44 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'
import { hexEquals, normaliseHex } from './hex.js'
import type { RoomPolicy } from './types.js'
import type { ChatInvite } from './messages.js'

/**
 * Direct messages. A DM is a room: a persistent group whose link admits
 * exactly two members, and the key never leaves the pair. What this module
 * adds is the sealing of that room's link to the other member, carried as
 * a chat message in a room both already share. The design is
 * `docs/messages.md`.
 */

/** NIP-44 between this participant and another. A local identity does it
 *  with its key; a signer does it through NIP-07 or NIP-46. */
export interface PeerCrypt {
  encrypt(peer: string, plaintext: string): Promise<string>
  decrypt(peer: string, ciphertext: string): Promise<string>
}

export function localPeerCrypt(participantSk: Uint8Array): PeerCrypt {
  return {
    async encrypt(peer, plaintext) {
      return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(participantSk, normaliseHex(peer)))
    },
    async decrypt(peer, ciphertext) {
      return nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(participantSk, normaliseHex(peer)))
    },
  }
}

/** The policy of a DM between two participants: open in tier, shut to
 *  everybody but the pair. Sorted, so both sides derive the same bytes. */
export function dmPolicy(a: string, b: string): RoomPolicy {
  const members = [normaliseHex(a), normaliseHex(b)]
  if (members[0] === members[1]) throw new Error('a direct message needs two people')
  members.sort()
  return { tier: 'open', members }
}

/** Whether a policy is a DM's: exactly two members. */
export function isDmPolicy(policy: RoomPolicy | undefined): boolean {
  return policy?.members?.length === 2
}

/** The other member of a DM this participant is in, or undefined when the
 *  policy is not a DM's or does not include them. */
export function dmPeer(policy: RoomPolicy | undefined, self: string): string | undefined {
  if (!isDmPolicy(policy)) return undefined
  const members = policy!.members!
  if (!members.some((m) => hexEquals(m, self))) return undefined
  return members.find((m) => !hexEquals(m, self))
}

export interface SealInviteOptions {
  to: string
  room: string
  crypt: PeerCrypt
}

/** Seal a DM room's link to one participant. */
export async function sealInvite(link: string, opts: SealInviteOptions): Promise<ChatInvite> {
  if (!link) throw new Error('an invitation needs a link')
  return { to: normaliseHex(opts.to), room: normaliseHex(opts.room), link: await opts.crypt.encrypt(opts.to, link) }
}

export interface OpenInviteOptions {
  /** This participant. */
  self: string
  /** The message's author. */
  sender: string
  crypt: PeerCrypt
}

/**
 * Open an invitation, or null. Opens for the addressee, and for the
 * sender's own other devices: the conversation key is the same from either
 * end, so a phone that holds the identity that sent this from a laptop
 * reads it too. Anybody else gets null without a decrypt being tried.
 */
export async function openInvite(invite: ChatInvite, opts: OpenInviteOptions): Promise<string | null> {
  const peer = hexEquals(invite.to, opts.self) ? opts.sender : hexEquals(opts.sender, opts.self) ? invite.to : undefined
  if (peer === undefined) return null
  try {
    const link = await opts.crypt.decrypt(peer, invite.link)
    return link.length > 0 ? link : null
  } catch {
    return null
  }
}

/**
 * When both people start a DM with each other before either sees the
 * other's, both keep the one that was sent first, then the lower room id.
 * One DM per pair.
 */
export function preferredDm<T extends { room: string; sentAt: number }>(candidates: readonly T[]): T | undefined {
  let best: T | undefined
  for (const c of candidates) {
    if (!best || c.sentAt < best.sentAt || (c.sentAt === best.sentAt && normaliseHex(c.room) < normaliseHex(best.room))) best = c
  }
  return best
}

/** For tests and keepers that hold a key: the pubkey a crypt speaks as. */
export function peerCryptPubkey(participantSk: Uint8Array): string {
  return getPublicKey(participantSk)
}
