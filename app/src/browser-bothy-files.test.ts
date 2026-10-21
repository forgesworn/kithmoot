import { describe, it, expect, vi } from 'vitest'
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { fileFixture, deferred, scope, node, otherNode, account, accountKey, room } from '../../test/private-file-fixture.js'
import { PrivateFileVault } from './private-file-vault.js'
import { sha256Hex } from '../../src/attachment.js'

const signal = () => new AbortController().signal

describe('private files over the selected paired Bothy route', () => {
  it('encrypts before dispatch, binds signed upload authority and decrypts verified bytes without following descriptor URLs', async () => {
    const f = fileFixture(); await f.controller.allow()
    const noFetch = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No public fetch permitted'))
    try {
      const attachment = await f.controller.upload(f.file,signal())
      expect(attachment.url).toBe(`fsl://${node}/${attachment.sha256}`)
      const request = f.request.mock.calls[0][0]
      expect(request).toMatchObject({routeId:scope.routeId,method:'PUT',path:'/upload'})
      const stored = f.blobs.get(attachment.sha256)!
      expect(sha256Hex(stored)).toBe(attachment.sha256)
      expect(Buffer.from(stored).includes(Buffer.from(await f.file.arrayBuffer()))).toBe(false)
      // Dispatch borrows an owned buffer; it is wiped once the request settles.
      expect(request.body.every(byte => byte === 0)).toBe(true)
      const event = JSON.parse(Buffer.from(request.authorization.slice('Nostr '.length),'base64').toString())
      expect(verifyEvent(event)).toBe(true)
      expect(event).toMatchObject({pubkey:account,kind:24242})
      expect(event.tags).toContainEqual(['server',node])
      expect(event.tags).toContainEqual(['x',attachment.sha256])
      expect(event.tags).toContainEqual(['t','upload'])
      const opened = await f.controller.download(attachment,signal())
      expect(await opened.source.text()).toBe(await f.file.text())
      expect(opened.name).toBe(f.file.name)
      expect(f.request.mock.calls[1][0]).toMatchObject({method:'GET',path:`/${attachment.sha256}`,authorization:''})
      expect((await new PrivateFileVault(f.storage).uploads(account,room))[0].status).toBe('stored')
      expect(noFetch).not.toHaveBeenCalled()
    } finally { noFetch.mockRestore() }
  })
  it('requires separate private file permission and holds when the selected route is unavailable', async () => {
    const f = fileFixture()
    await expect(f.controller.upload(f.file,signal())).rejects.toThrow('Allow encrypted files')
    await f.controller.allow(); f.paired = false
    await expect(f.controller.upload(f.file,signal())).rejects.toThrow('No other route')
    expect(f.request).not.toHaveBeenCalled()
  })
  it.each(['account','device','phase','expiry','room'] as const)('refuses mismatched %s before dispatch', async field => {
    const f = fileFixture(); await f.controller.allow()
    if (field === 'account') f.selected!.account = 'c'.repeat(64)
    if (field === 'device') f.selected!.device = 'c'.repeat(64)
    if (field === 'phase') f.selected!.phase = 'withdrawing'
    if (field === 'expiry') f.advance(1000)
    if (field === 'room') f.context = {...f.context!, room:'c'.repeat(64)}
    await expect(f.controller.upload(f.file,signal())).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
  })
  it.each(['withdraw','account','generation','route','expired'] as const)('holds a signer result after %s changes', async change => {
    const f = fileFixture(); await f.controller.allow()
    const entered = deferred(), finish = deferred()
    f.identity.signEvent.mockImplementationOnce(async event => { entered.resolve(); await finish.promise; return finalizeEvent(event,accountKey) })
    const result = f.controller.upload(f.file,signal())
    const rejected = expect(result).rejects.toThrow()
    await entered.promise
    if (change === 'withdraw') await f.controller.revoke()
    if (change === 'account') f.context = undefined
    if (change === 'generation') f.context = {...f.context!,generation:2}
    if (change === 'route') f.selected!.box = {routeId:'replacement',eventUrl:`ws://${otherNode}/events`}
    if (change === 'expired') f.advance(90)
    finish.resolve(); await rejected
    expect(f.request).not.toHaveBeenCalled()
  })
  it('refuses a validly signed substitution of operation terms', async () => {
    const f = fileFixture(); await f.controller.allow()
    f.identity.signEvent.mockImplementationOnce(async event => finalizeEvent({...event,tags:[['t','upload'],['server',otherNode]]},accountKey))
    await expect(f.controller.upload(f.file,signal())).rejects.toThrow('exact private file operation')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('dispatches nothing when saving upload intent fails', async () => {
    const f = fileFixture(); await f.controller.allow(); f.storage.fail = true
    await expect(f.controller.upload(f.file,signal())).rejects.toThrow('disk full')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('retains uncertain intent after a lost reply and never retries the write', async () => {
    const f = fileFixture(); await f.controller.allow()
    f.request.mockRejectedValueOnce(new Error('connection lost after write'))
    await expect(f.controller.upload(f.file,signal())).rejects.toThrow('connection lost')
    expect(f.request).toHaveBeenCalledTimes(1)
    expect((await f.vault.uploads(account,room))[0].status).toBe('uncertain')
  })
  it('releases the route lock on cancellation while retaining a late upload result without returning a file', async () => {
    const f = fileFixture(); await f.controller.allow()
    const entered = deferred(), finish = deferred(), recorded = deferred()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async request => {
      const reply = await original(request); entered.resolve(); await finish.promise; return reply
    })
    const originalOutcome = f.vault.outcome.bind(f.vault)
    vi.spyOn(f.vault,'outcome').mockImplementation(async (...args) => {
      try { await originalOutcome(...args); recorded.resolve() }
      catch (error) { recorded.reject(error); throw error }
    })
    const controller = new AbortController(), result = f.controller.upload(f.file,controller.signal)
    const rejected = expect(result).rejects.toThrow('cancelled')
    await entered.promise; controller.abort(new Error('cancelled')); await rejected
    expect(f.release).toHaveBeenCalledTimes(2) // allow and upload
    finish.resolve(); await recorded.promise
    expect((await f.vault.uploads(account,room))[0].status).toBe('stored')
  })
  it('retains committed upload provenance but refuses staging after permission withdrawal during HTTP', async () => {
    const f = fileFixture(); await f.controller.allow()
    const entered = deferred(), finish = deferred(), original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async request => { const reply = await original(request); entered.resolve(); await finish.promise; return reply })
    const result = f.controller.upload(f.file,signal()), rejected = expect(result).rejects.toThrow()
    await entered.promise; await f.controller.revoke(); finish.resolve(); await rejected
    expect((await f.vault.uploads(account,room))[0].status).toBe('stored')
  })
  it('rejects a different-node reference without contacting it and corrupt bytes before decryption', async () => {
    const f = fileFixture(); await f.controller.allow()
    const attachment = await f.controller.upload(f.file,signal())
    await expect(f.controller.download({...attachment,url:attachment.url.replace(node,otherNode)},signal())).rejects.toThrow('different Bothy')
    expect(f.request).toHaveBeenCalledTimes(1)
    f.blobs.get(attachment.sha256)![0] ^= 1
    await expect(f.controller.download(attachment,signal())).rejects.toThrow('not the encrypted file')
  })
  it('resolves a successful own-claim removal while preserving bytes retained by other owners', async () => {
    const f = fileFixture(); await f.controller.allow(); const attachment = await f.controller.upload(f.file,signal())
    const receipt = (await f.controller.uploads())[0]
    await f.controller.revoke(); f.selected = undefined; f.advance(1100)
    f.request.mockResolvedValueOnce(f.reply({sha256:receipt.hash,blobDeleted:false}))
    await expect(f.controller.remove(receipt,signal())).resolves.toBe('claim-removed')
    expect(await f.vault.accountUploads(account)).toEqual([])
    expect(f.blobs.has(attachment.sha256)).toBe(true)
    expect(sha256Hex(f.blobs.get(attachment.sha256)!)).toBe(attachment.sha256)
    const event = JSON.parse(Buffer.from(f.request.mock.calls.at(-1)![0].authorization.slice(6),'base64').toString())
    expect(event.tags).toContainEqual(['t','delete'])
    expect(Number(event.tags.find((t:string[]) => t[0] === 'expiration')[1])).toBeGreaterThan(2100)
  })
  it('does not forget an upload for a malformed deletion response', async () => {
    const f = fileFixture(); await f.controller.allow(); await f.controller.upload(f.file,signal())
    const receipt = (await f.controller.uploads())[0]
    f.request.mockResolvedValueOnce(f.reply({sha256:receipt.hash,blob_deleted:true}))
    await expect(f.controller.remove(receipt,signal())).rejects.toThrow('could not be verified')
    expect(await f.controller.uploads()).toEqual([receipt])
  })
})

describe('private file consent and signer lifecycle', () => {
  it.each(['cancel','account','generation'] as const)('holds permission committed after %s changes during a delayed storage write', async change => {
    const f = fileFixture(), entered = deferred(), finish = deferred(), controller = new AbortController()
    f.storage.beforePut = async () => { entered.resolve(); await finish.promise }
    const pending = f.controller.allow(controller.signal), rejected = expect(pending).rejects.toThrow()
    await entered.promise
    if (change === 'cancel') controller.abort(new Error('cancelled'))
    if (change === 'account') f.owner = undefined
    if (change === 'generation') f.context = {...f.context!,generation:2}
    finish.resolve(); await rejected
    await f.storage.withLock(async () => {})
    await expect(f.vault.permission(scope,1000)).rejects.toThrow('could not be saved')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('allows owner cleanup from Account after the originating room is gone', async () => {
    const f = fileFixture(); await f.controller.allow(); await f.controller.upload(f.file,signal())
    const row = (await f.vault.accountUploads(account))[0]
    f.context = undefined; f.selected = undefined
    expect((await f.vault.accountUploads(account))[0]).toEqual(row)
    await expect(f.controller.remove(row,signal())).resolves.toBe('deleted')
    expect(await f.vault.accountUploads(account)).toEqual([])
  })
  it('holds owner cleanup if its account changes while the actual SDK provider is running', async () => {
    const f = fileFixture(); await f.controller.allow(); await f.controller.upload(f.file,signal())
    const row = (await f.vault.accountUploads(account))[0], entered = deferred(), finish = deferred()
    f.identity.signEvent.mockImplementationOnce(async event => { entered.resolve(); await finish.promise; return finalizeEvent(event,accountKey) })
    const removing = f.controller.remove(row,signal()), rejected = expect(removing).rejects.toThrow()
    await entered.promise; f.owner = undefined; finish.resolve(); await rejected
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(await f.vault.accountUploads(account)).toEqual([row])
  })
  it('blocks an actual SDK transient retry at its provider start after file consent withdrawal', async () => {
    const f = fileFixture(); await f.controller.allow(); vi.useFakeTimers()
    const entered = deferred()
    f.identity.signEvent.mockImplementationOnce(async () => { entered.resolve(); throw new Error('Extension context invalidated') })
    const pending = f.controller.upload(f.file,signal()), settled = pending.then(value => ({value,error:undefined}),error => ({value:undefined,error}))
    try {
      await entered.promise; await f.controller.revoke()
      await vi.advanceTimersByTimeAsync(300)
      expect((await settled).error).toBeInstanceOf(Error)
      expect(f.identity.signEvent).toHaveBeenCalledTimes(1)
      expect(f.request).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})

describe('private file uncertain deletion recovery', () => {
  it('resolves a lost committed DELETE reply only after same-node GET confirms reported absence', async () => {
    const f = fileFixture(); await f.controller.allow(); await f.controller.upload(f.file,signal())
    const row = (await f.controller.uploads())[0], original = f.request.getMockImplementation()!
    f.request.mockImplementationOnce(async request => { await original(request); throw Error('lost deletion reply') })
    await expect(f.controller.remove(row,signal())).rejects.toThrow('lost deletion reply')
    expect(await f.vault.accountUploads(account)).toEqual([row])
    await expect(f.controller.remove(row,signal())).resolves.toBe('absent')
    expect(f.request.mock.calls.slice(-2).map(([request]) => [request.routeId,request.method,request.path])).toEqual([
      [scope.routeId,'DELETE',`/${row.hash}`],[scope.routeId,'GET',`/${row.hash}`]])
    expect(await f.vault.accountUploads(account)).toEqual([])
  })
  it.each([200,401,403,302])('keeps the exact receipt when follow-up GET returns %s instead of reported absence', async status => {
    const f = fileFixture(); await f.controller.allow(); await f.controller.upload(f.file,signal())
    const row = (await f.controller.uploads())[0]
    f.request.mockResolvedValueOnce({...f.reply({}),status:404})
    f.request.mockResolvedValueOnce({...f.reply({}),status})
    await expect(f.controller.remove(row,signal())).rejects.toThrow('did not confirm')
    expect(await f.vault.accountUploads(account)).toEqual([row])
  })
  it('keeps the receipt if the account changes while confirming absence', async () => {
    const f = fileFixture(); await f.controller.allow(); await f.controller.upload(f.file,signal())
    const row = (await f.controller.uploads())[0], entered = deferred(), finish = deferred()
    f.request.mockResolvedValueOnce({...f.reply({}),status:404})
    f.request.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return {...f.reply({}),status:404} })
    const result = f.controller.remove(row,signal()), rejected = expect(result).rejects.toThrow()
    await entered.promise; f.owner = undefined; finish.resolve(); await rejected
    expect(await f.vault.accountUploads(account)).toEqual([row])
  })
})
