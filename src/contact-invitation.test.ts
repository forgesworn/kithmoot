import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { createRoomInvitation } from './invitation.js'
import { encodeRoomLink } from './link.js'
import { deriveRoom, generateRoomSecret } from './room.js'
import { dmPolicy, localPeerCrypt } from './dm.js'
import { contactInvitationRumor, readContactInvitation, unwrapContactInvitation, wrapContactInvitation, type ContactInvitationIdentity } from './contact-invitation.js'

const now = 1_800_000_000
export function invitationIdentity(): ContactInvitationIdentity {
  const key = generateSecretKey()
  return { pubkey: getPublicKey(key), ...localPeerCrypt(key), signEvent: async event => finalizeEvent(event, key) }
}
export function invitationLink(sender: string, recipient: string): { room: string; link: string } {
  const { invitation } = createRoomInvitation(true), { roomId } = deriveRoom(generateRoomSecret())
  return { room: roomId, link: encodeRoomLink('https://kithmoot.example/j/', { invitation, relays: ['wss://relay.example'], iceUrls: [], policy: dmPolicy(sender, recipient) }) }
}

describe('account-addressed private conversation invitations', () => {
  it('opens both envelopes exported by the independent Android implementation', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/contact-invitations-android.json', import.meta.url), 'utf8'))
    const identity = (byte: number): ContactInvitationIdentity => {
      const key = new Uint8Array(32).fill(byte)
      return { pubkey: getPublicKey(key), ...localPeerCrypt(key), signEvent: async event => finalizeEvent(event, key) }
    }
    expect(await unwrapContactInvitation(fixture.other, identity(2), now)).toEqual(fixture.rumor)
    expect(await unwrapContactInvitation(fixture.own, identity(1), now)).toEqual(fixture.rumor)
  })
  it('opens the same authenticated invitation for the recipient and the sender, hiding all application tags', async () => {
    const a = invitationIdentity(), b = invitationIdentity(), room = invitationLink(a.pubkey, b.pubkey)
    const rumor = contactInvitationRumor(a.pubkey, b.pubkey, room.room, room.link, now)
    for (const recipient of [a, b]) {
      const wrap = await wrapContactInvitation(rumor, a, recipient.pubkey, now, () => true)
      expect(wrap.tags).toEqual([['p', recipient.pubkey]])
      expect(wrap.content).not.toContain(room.link)
      expect(await unwrapContactInvitation(wrap, recipient, now)).toEqual(rumor)
    }
  })
  it('rejects a forged rumor author even inside a correctly signed outer wrap and seal', async () => {
    const a = invitationIdentity(), b = invitationIdentity(), attacker = invitationIdentity(), room = invitationLink(a.pubkey, b.pubkey)
    const rumor = contactInvitationRumor(a.pubkey, b.pubkey, room.room, room.link, now)
    const seal = await attacker.signEvent({ kind: 13, tags: [], created_at: now, content: await attacker.encrypt(b.pubkey, JSON.stringify(rumor)) })
    const ephemeral = generateSecretKey()
    const outer = finalizeEvent({ kind: 1059, tags: [['p', b.pubkey]], created_at: now,
      content: nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(ephemeral, b.pubkey)) }, ephemeral)
    expect(await unwrapContactInvitation(outer, b, now)).toBeUndefined()
  })
  it('rejects invitations that admit a third person or mismatch the message recipient', () => {
    const a = invitationIdentity(), b = invitationIdentity(), outsider = invitationIdentity()
    const wrong = invitationLink(a.pubkey, outsider.pubkey)
    expect(() => contactInvitationRumor(a.pubkey, b.pubkey, wrong.room, wrong.link, now)).toThrow()
    const valid = invitationLink(a.pubkey, b.pubkey)
    const rumor = contactInvitationRumor(a.pubkey, b.pubkey, valid.room, valid.link, now)
    expect(readContactInvitation({ ...rumor, content: wrong.link }, b.pubkey, now)).toBeUndefined()
  })
  it('rechecks account and contact authority after a delayed encryption or signature', async () => {
    const a = invitationIdentity(), b = invitationIdentity(), room = invitationLink(a.pubkey, b.pubkey)
    let allowed = true, signatures = 0
    const delayed = { ...a, encrypt: async (peer: string, text: string) => { const encrypted = await a.encrypt(peer, text); allowed = false; return encrypted },
      signEvent: async (event: Parameters<typeof a.signEvent>[0]) => { signatures++; return a.signEvent(event) } }
    const rumor = contactInvitationRumor(a.pubkey, b.pubkey, room.room, room.link, now)
    await expect(wrapContactInvitation(rumor, delayed, b.pubkey, now, () => allowed)).rejects.toThrow('no longer authorised')
    expect(signatures).toBe(0)
  })
})
