import { describe, it, expect } from 'vitest'
import { PrivateFileVault } from './private-file-vault.js'
import { FileStorage, scope, account, room, hash, otherNode, deferred } from '../../test/private-file-fixture.js'

describe('private file custody and uncertain upload journal', () => {
  it('retains encrypted permission and upload provenance across restart without storing file keys or names', async () => {
    const storage = new FileStorage(), vault = new PrivateFileVault(storage)
    await vault.allow(scope, 2000)
    const ticket = (await vault.permission(scope, 1000))!
    const upload = await vault.intent(ticket, hash, 65536, 1000)
    expect(storage.storedKey?.extractable).toBe(false)
    const ciphertext = Buffer.from(storage.value!.ciphertext).toString('utf8')
    for (const value of [account, room, hash, scope.node, scope.routeId]) expect(ciphertext).not.toContain(value)
    const restarted = new PrivateFileVault(storage)
    expect(await restarted.permission(scope, 1000)).toEqual(ticket)
    expect(await restarted.uploads(account, room)).toEqual([upload])
    expect(Object.keys(upload).sort()).toEqual(['account','created','hash','id','node','room','routeId','size','status'])
  })
  it('rejects old authority and new operations while withdrawal is pending, retaining old upload receipts', async () => {
    const storage = new FileStorage(), vault = new PrivateFileVault(storage)
    await vault.allow(scope, 2000)
    const ticket = (await vault.permission(scope, 1000))!, row = await vault.intent(ticket, hash, 1, 1000)
    const entered = deferred(), finish = deferred()
    storage.beforePut = async () => { entered.resolve(); await finish.promise }
    const pending = vault.revoke(account, room)
    expect(vault.revision()).not.toBe(ticket.revision)
    await entered.promise
    finish.resolve(); await pending
    expect(await vault.current(ticket, 1000)).toBe(false)
    await expect(vault.intent(ticket, hash, 1, 1000)).rejects.toThrow('permission changed')
    await vault.outcome(row, 'stored')
    expect((await vault.uploads(account, room))[0].status).toBe('stored')
    expect(await vault.permission(scope, 1000)).toBeUndefined()
  })
  it('holds new operations after a failed withdrawal until an explicit permission change is saved', async () => {
    const storage = new FileStorage(), vault = new PrivateFileVault(storage)
    await vault.allow(scope, 2000); storage.fail = true
    await expect(vault.revoke(account, room)).rejects.toThrow('disk full')
    storage.fail = false
    await expect(new PrivateFileVault(storage).permission(scope, 1000)).rejects.toThrow('could not be saved')
    await vault.revoke(account, room)
    expect(await vault.permission(scope, 1000)).toBeUndefined()
  })
  it('requires the exact selected account, room, node, route and unexpired permission', async () => {
    const vault = new PrivateFileVault(new FileStorage()); await vault.allow(scope, 2000)
    for (const changes of [{account:'c'.repeat(64)}, {room:'d'.repeat(64)}, {node:otherNode}, {routeId:'replacement'}]) {
      expect(await vault.permission({...scope,...changes},1000)).toBeUndefined()
    }
    expect(await vault.permission(scope,2000)).toBeUndefined()
  })
  it('preserves corrupt ciphertext or missing keys and refuses replacement storage', async () => {
    const storage = new FileStorage(), vault = new PrivateFileVault(storage)
    await vault.allow(scope,2000)
    storage.value!.ciphertext = storage.value!.ciphertext.slice(1)
    const original = structuredClone(storage.value)
    await expect(vault.allow(scope,3000)).rejects.toThrow()
    expect(storage.value).toEqual(original)
    storage.storedKey = undefined
    await expect(vault.permission(scope,1000)).rejects.toThrow('journal was retained')
    expect(storage.value).toEqual(original)
  })
  it('cannot adopt a forged receipt or silently remove a retained blob', async () => {
    const vault = new PrivateFileVault(new FileStorage()); await vault.allow(scope,2000)
    const row = await vault.intent((await vault.permission(scope,1000))!,hash,1,1000)
    await expect(vault.outcome({...row,node:otherNode},'deleted')).rejects.toThrow('provenance changed')
    await vault.outcome(row,'kept')
    expect((await vault.uploads(account,room))[0].status).toBe('kept')
    await vault.outcome(row,'deleted')
    expect(await vault.uploads(account,room)).toEqual([])
  })
})

describe('private file browser forget lifecycle', () => {
  it('blocks a browser wipe while any account has uncertain upload provenance', async () => {
    const storage = new FileStorage(), vault = new PrivateFileVault(storage)
    await vault.allow(scope,2000)
    const row = await vault.intent((await vault.permission(scope,1000))!,hash,1,1000)
    let wiped = false
    expect(await vault.forget(async () => { wiped = true })).toBe(false)
    expect(wiped).toBe(false)
    expect(await vault.accountUploads(account)).toEqual([row])
    expect(storage.storedKey).toBeDefined()
  })
  it('holds policy writes queued during a wipe before they can recreate private records or keys', async () => {
    const storage = new FileStorage(), vault = new PrivateFileVault(storage)
    await vault.allow(scope,2000)
    const entered = deferred(), finish = deferred()
    const wiping = vault.forget(async () => { entered.resolve(); await finish.promise })
    await entered.promise
    const pending = vault.allow(scope,3000), rejected = expect(pending).rejects.toThrow('changed before its save')
    finish.resolve(); expect(await wiping).toBe(true); await rejected
    expect(storage.value).toBeUndefined(); expect(storage.storedKey).toBeUndefined(); expect(storage.revision()).toBe('')
  })
})
