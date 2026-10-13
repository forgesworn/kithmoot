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
  it('joins an unsettled provider even when the host logout callback throws', async () => {
    const {who,signer}=session();let release!:()=>void,started!:()=>void
    const began=new Promise<void>(r=>{started=r})
    signer.nip44.encrypt.mockImplementation(()=>new Promise<string>(r=>{started();release=()=>r('late')}))
    const access=girnelAccess(who,()=>true,()=>{throw Error('host logout failed')}),borrowed=(await access.restore()).session
    const pending=borrowed.signer.nip44!.encrypt(who.pubkey,'private'),refused=expect(pending).rejects.toThrow('account changed');await began
    let ended=false;const loggingOut=access.logout().finally(()=>{ended=true}),failed=expect(loggingOut).rejects.toThrow('host logout failed')
    await Promise.resolve();expect(ended).toBe(false);release();await refused;await failed;expect(signer.close).not.toHaveBeenCalled()
  })
  it('detaches and freezes authentication data in both directions', async () => {
    const {who}=session();who.authEvent={...who.authEvent,tags:[['u','https://host.example/']]}
    const access=girnelAccess(who,()=>true,()=>{}),borrowed=(await access.restore()).session
    expect(borrowed.authEvent).not.toBe(who.authEvent);expect(Object.isFrozen(borrowed.authEvent)).toBe(true)
    expect(Object.isFrozen(borrowed.authEvent.tags[0])).toBe(true)
    expect(()=>{borrowed.authEvent.tags[0]![1]='changed'}).toThrow()
    expect(who.authEvent.tags[0]![1]).toBe('https://host.example/')
    who.authEvent.tags[0]![1]='host changed';expect(borrowed.authEvent.tags[0]![1]).toBe('https://host.example/')
  })
  it.each(['restore','login'] as const)('refuses %s when revoked before acquisition settles', async method => {
    const {who}=session(),access=girnelAccess(who,()=>true,()=>{}),pending=access[method]()
    const refused=expect(pending).rejects.toThrow('account changed');await access.close();await refused
  })
  it('refuses reentrant revocation inside the current callback before obtaining or signing', async () => {
    const {who,signer}=session();const access=girnelAccess(who,()=>{access.revoke();return true},()=>{})
    await expect(access.restore()).rejects.toThrow('account changed');expect(signer.signEvent).not.toHaveBeenCalled()
  })
  it('revokes promptly and joins an unabortable provider without closing the host signer', async () => {
    const {who,signer}=session();let release!: () => void,started!: () => void
    const began=new Promise<void>(r=>{started=r})
    signer.nip44.encrypt.mockImplementation(()=>new Promise<string>(r=>{started();release=()=>r('late ciphertext')}))
    const access=girnelAccess(who,()=>true,()=>{}),borrowed=await access.restore()
    const pending=borrowed.session.signer.nip44!.encrypt(who.pubkey,'private')
    const refused=expect(pending).rejects.toThrow('account changed');await began
    let ended=false;const closing=access.close().then(()=>{ended=true});await Promise.resolve()
    expect(ended).toBe(false);await expect(access.restore()).rejects.toThrow('account changed')
    release();await refused;await closing;expect(signer.close).not.toHaveBeenCalled()
  })
  it('rejects replacing a borrowed signer even with the same account', async () => {
    const {who,signer}=session(),access=girnelAccess(who,()=>true,()=>{}),borrowed=await access.restore()
    who.signer={...who.signer}
    await expect(borrowed.session.signer.signEvent({kind:1,content:'',created_at:1,tags:[]})).rejects.toThrow('account changed')
    expect(signer.signEvent).not.toHaveBeenCalled()
  })
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
