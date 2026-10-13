import { describe, expect, it, vi } from 'vitest'
import type { SignetSession } from 'signet-login'
import { girnelAccess } from './girnel-host.js'

function session() {
  const signer = {pubkey: 'a'.repeat(64), method: 'nip07', capabilities: {canSignEvents: true, hasNip44: true},
    clientSecretKey: 'must-never-cross', close: vi.fn(),
    signEvent: vi.fn(async () => ({pubkey: 'a'.repeat(64)})),
    nip44: {encrypt: vi.fn(async () => 'sealed'), decrypt: vi.fn(async () => 'plain')}}
  return {who: {pubkey: signer.pubkey, method: 'nip07', signer, authEvent: {}} as unknown as SignetSession, signer}
}
describe('Girnel host signer boundary', () => {
  it('borrows guarded methods without exposing SDK secrets or closing the host signer', async () => {
    const {who, signer} = session(), logout = vi.fn()
    const access = girnelAccess(who, () => true, logout), borrowed = await access.restore()
    expect(borrowed.session.signer).not.toHaveProperty('clientSecretKey')
    expect(await borrowed.session.signer.nip44!.encrypt(who.pubkey, 'reviewed')).toBe('sealed')
    await borrowed.session.signer.close(); await access.logout()
    expect(signer.close).not.toHaveBeenCalled(); expect(logout).toHaveBeenCalledOnce()
  })
  it('refuses a signer result when the host account changes during approval', async () => {
    const {who, signer} = session(); let current = true
    signer.signEvent.mockImplementation(async () => {current = false; return {pubkey: who.pubkey}})
    const borrowed = await girnelAccess(who, () => current, () => {}).restore()
    await expect(borrowed.session.signer.signEvent({kind: 1, content: '', created_at: 1, tags: []})).rejects.toThrow('account changed')
    await expect(borrowed.session.signer.nip44!.encrypt(who.pubkey, 'private')).rejects.toThrow('account changed')
    expect(signer.nip44.encrypt).not.toHaveBeenCalled()
  })
  it('refuses another account, expired sessions and missing encryption', async () => {
    const {who} = session()
    who.expiresAt = Date.now() - 1
    await expect(girnelAccess(who, () => true, () => {}).restore()).rejects.toThrow('expired')
    delete who.expiresAt; who.signer.nip44 = undefined
    await expect(girnelAccess(who, () => true, () => {}).restore()).rejects.toThrow('NIP-44')
  })
})
