import type { Event } from 'nostr-tools/pure'
import { readContactInvitation, type ContactInvitation, type ContactInvitationRumor } from '../../src/contact-invitation.js'
import { captureAccountRumor, captureOrdinaryCopy, captureOrdinarySeal, captureOrdinaryText, ordinaryExpired,
  ORDINARY_MAX_WIRE_BYTES, type OrdinaryText } from './nostr-message-wire.js'

export type AccountMessageDecrypt = (peer: string, ciphertext: string, current: () => boolean) => Promise<string>
/** Shape is not authority: only this module can mint a live token, and journal
 * adoption must resolve its private account/wrapper/rumor/view binding. */
export interface OpenedInvitation { readonly invitation: Readonly<ContactInvitation> }
const invitations = new WeakMap<OpenedInvitation, { account: string; copy: Event; rumor: ContactInvitationRumor; current: () => boolean }>()
export type OpenedAccountMessage = { kind: 'text'; message: OrdinaryText } | { kind: 'invitation'; token: OpenedInvitation }

/** One explicit two-layer operation shared by text and invitations. Network
 * receipt and journal restoration never call it. It receives only decrypt. */
export async function openAccountMessage(input: Event, account: string, decrypt: AccountMessageDecrypt,
  current: () => boolean, blocked: (peer: string) => boolean, now: () => number): Promise<OpenedAccountMessage> {
  const copy = captureOrdinaryCopy(input, account, now())
  const permitted = (peer: string) => peer === account || !blocked(peer)
  const live = () => !!copy && current() && !ordinaryExpired(copy, now())
  const check = (guard: () => boolean) => { if (!guard()) throw Error('Message opening is no longer current.') }
  const parse = (text: string): unknown => {
    if (typeof text !== 'string' || text.length > ORDINARY_MAX_WIRE_BYTES || new TextEncoder().encode(text).byteLength > ORDINARY_MAX_WIRE_BYTES) throw Error('Invalid opened message size.')
    return JSON.parse(text)
  }
  check(live)
  const outer = await decrypt(copy!.pubkey, copy!.content, live)
  check(live)
  const seal = captureOrdinarySeal(parse(outer), now())
  if (!seal || !permitted(seal.pubkey)) throw Error('Unavailable message author.')
  const authorLive = () => live() && permitted(seal.pubkey)
  check(authorLive)
  const inner = await decrypt(seal.pubkey, seal.content, authorLive)
  check(authorLive)
  const rumor = captureAccountRumor(parse(inner), seal, account, now())
  if (!rumor) throw Error('Unavailable account text.')
  if (rumor.tags.some(tag => tag[0] === 'kithmoot-invitation')) {
    const invitation = readContactInvitation(rumor, account, now())
    if (!invitation) throw Error('Invalid conversation invitation.')
    const invitationLive = () => authorLive() && permitted(invitation.sender) && permitted(invitation.recipient)
    check(invitationLive)
    const token = Object.freeze({ invitation: Object.freeze({ ...invitation }) })
    invitations.set(token, { account, copy: copy!, rumor, current: invitationLive })
    return { kind: 'invitation', token }
  }
  const message = captureOrdinaryText(rumor, seal, account, now())
  if (!message || !message.members.every(permitted)) throw Error('Unavailable ordinary text.')
  check(authorLive)
  return { kind: 'text', message }
}

/** Rechecked at serial queue entry and persistence. A fabricated, cross-account,
 * expired or revoked-origin object cannot introduce an invitation journal row. */
export function openedInvitationRumor(token: OpenedInvitation, account: string, now: number,
  current: () => boolean): ContactInvitationRumor | undefined {
  try {
    const binding = invitations.get(token)
    if (!binding || binding.account !== account || !current() || !binding.current() || ordinaryExpired(binding.copy, now) ||
        !readContactInvitation(binding.rumor, account, now) || !binding.current() || !current()) return
    return binding.rumor
  } catch { return undefined }
}
