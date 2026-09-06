import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { dmPolicy, dmPeer, isDmPolicy, localPeerCrypt, openInvite, preferredDm, sealInvite } from './dm.js'
import { evaluateAccess } from './access.js'

const NOW = 1_800_000_000

describe('direct messages', () => {
  const adaSk = generateSecretKey()
  const rowanSk = generateSecretKey()
  const strangerSk = generateSecretKey()
  const ada = getPublicKey(adaSk)
  const rowan = getPublicKey(rowanSk)
  const stranger = getPublicKey(strangerSk)
  const room = 'd'.repeat(64)

  it('a DM policy is open in tier and shut to everybody but the pair', () => {
    const policy = dmPolicy(rowan, ada)
    expect(policy.members).toEqual([ada, rowan].sort())
    expect(isDmPolicy(policy)).toBe(true)
    expect(evaluateAccess(policy, ada, undefined, NOW, room).admitted).toBe(true)
    expect(evaluateAccess(policy, rowan, undefined, NOW, room).admitted).toBe(true)
    expect(evaluateAccess(policy, stranger, undefined, NOW, room)).toEqual({ admitted: false, reason: 'not a member' })
    expect(() => dmPolicy(ada, ada)).toThrow()
  })

  it('names the other member, and nobody for a room that is not a DM', () => {
    expect(dmPeer(dmPolicy(ada, rowan), ada)).toBe(rowan)
    expect(dmPeer(dmPolicy(ada, rowan), stranger)).toBeUndefined()
    expect(dmPeer({ tier: 'open' }, ada)).toBeUndefined()
    expect(dmPeer({ tier: 'open', members: [ada, rowan, stranger] }, ada)).toBeUndefined()
  })

  it('a sealed link opens for the addressee and the sender, and for nobody else', async () => {
    const link = 'https://kithmoot.example/j#v3...'
    const invite = await sealInvite(link, { to: rowan, room, crypt: localPeerCrypt(adaSk) })
    expect(invite.to).toBe(rowan)
    expect(invite.link).not.toContain('kithmoot')
    expect(await openInvite(invite, { self: rowan, sender: ada, crypt: localPeerCrypt(rowanSk) })).toBe(link)
    expect(await openInvite(invite, { self: ada, sender: ada, crypt: localPeerCrypt(adaSk) })).toBe(link)
    expect(await openInvite(invite, { self: stranger, sender: ada, crypt: localPeerCrypt(strangerSk) })).toBeNull()
    // The addressee with the wrong key: a decrypt that fails is null, not a throw.
    expect(await openInvite(invite, { self: rowan, sender: ada, crypt: localPeerCrypt(strangerSk) })).toBeNull()
  })

  it('two at once: the earlier wins, then the lower room id', () => {
    expect(preferredDm([{ room: 'b'.repeat(64), sentAt: 10 }, { room: 'a'.repeat(64), sentAt: 10 }])!.room).toBe('a'.repeat(64))
    expect(preferredDm([{ room: 'a'.repeat(64), sentAt: 12 }, { room: 'b'.repeat(64), sentAt: 10 }])!.room).toBe('b'.repeat(64))
    expect(preferredDm([])).toBeUndefined()
  })
})
