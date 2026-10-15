import { measureStartupStage, startupTimingEnabled } from './ordinary-startup-timing.js'
import { test, expect, type Page } from '@playwright/test'
import { preparedRestart } from './ordinary-member-startup.setup.js'
import { controls } from './ordinary-member-session.setup.js'

async function memberTransport(page: Page): Promise<void> {
  await page.evaluate(`window.secret=new Uint8Array(preparedAuthoritySecret);window.roomId=Ordinary.deriveRoom(secret).roomId;
    window.inviterSk=new Uint8Array(preparedAuthoritySigner);window.memberEpochTimeoutMs=10000`)
  // This is the synthetic authority's relay, not an application observer.
  // Return a grant sealed to the credential from the actual signed request.
  const relay = controls.slice(controls.indexOf(' window.nativeHeld='), controls.indexOf(' if(!window.deferMemberCreation)'))
    .replace("if(frame[1].kind===20468&&grants){", `if(frame[1].kind===20468&&grants){
      if(!Ordinary.decodeEpochRequest(frame[1],{roomId,authoritySk:inviterSk,roomKey:Ordinary.deriveRoom(secret).roomKey,now:Math.floor(Date.now()/1000)}))throw Error('invalid native epoch request');`)
    .replace('credential:ownCredential', "credential:JSON.parse(Ordinary.nip44.v2.decrypt(frame[1].content,Ordinary.nip44.v2.utils.getConversationKey(inviterSk,frame[1].pubkey))).credential")
  await page.evaluate(`(()=>{${relay}})()`)
}

for (const visitor of [false, true]) for (const keep of [false, true]) for (const priorLease of [false, true]) {
  test(`prepared recovery opens a fresh guarded member, visitor=${visitor}, keep=${keep}, priorLease=${priorLease}`, async ({ page }) => {
    if (!startupTimingEnabled(priorLease)) {
      page.on('pageerror', error => console.error('Native member relay fixture:', error.message))
      await preparedRestart(page, visitor, keep, priorLease)
      await memberTransport(page)
      await page.evaluate('(async()=>{window.startup=await Ordinary.OrdinaryMemberStartup.open(recoveryOptions)})()')
      expect(await page.evaluate('preparedPhase()')).toBe('settled')
      expect(await page.evaluate('[signCalls,dials.length,frames.length]')).toEqual([visitor ? 0 : 1, 0, 0])
      await page.evaluate('(async()=>{window.member=await startup.openMemberSession(sessionOptions);await member.join();await member.send("fresh recovered member")})()')
      expect(await page.evaluate('member.messages().then(messages=>messages.map(message=>message.text))')).toContain('fresh recovered member')
      expect(await page.evaluate('[dials.length>0,dials.every(Boolean),frames.length>0,frames.every(frame=>frame[1])]')).toEqual([true, true, true, true])
      expect(await page.evaluate('startup.openMemberSession(sessionOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
      await page.evaluate('startup.close()')
      expect(await page.evaluate('sockets.every(socket=>socket.readyState===3)')).toBe(true)
      expect(await page.evaluate('member.send("closed").then(()=>"escaped",error=>error.name)')).not.toBe('escaped')
      return
    }
    page.on('pageerror', error => console.error('Native member relay fixture:', error.message))
    await preparedRestart(page, visitor, keep, priorLease)
    await memberTransport(page)
    await measureStartupStage(page, 'startup open', () => page.evaluate('(async()=>{window.startup=await Ordinary.OrdinaryMemberStartup.open(recoveryOptions)})()'), priorLease)
    expect(await page.evaluate('preparedPhase()')).toBe('settled')
    expect(await page.evaluate('[signCalls,dials.length,frames.length]')).toEqual([visitor ? 0 : 1, 0, 0])
    await measureStartupStage(page, 'member open', () => page.evaluate('(async()=>{window.memberOpenStatus="pending";window.memberOpening=startup.openMemberSession(sessionOptions);const value=await memberOpening;window.member=value;window.memberOpenStatus="complete"})()'), priorLease)
    await measureStartupStage(page, 'member join', () => page.evaluate('(async()=>{window.memberJoinStatus="pending";window.memberJoining=member.join();const value=await memberJoining;window.memberJoinStatus="complete"})()'), priorLease)
    await measureStartupStage(page, 'member send', () => page.evaluate('(async()=>{window.memberSendStatus="pending";window.memberSending=member.send("fresh recovered member");const value=await memberSending;window.memberSendStatus="complete"})()'), priorLease)
    expect(await measureStartupStage(page, 'message read', () => page.evaluate('member.messages().then(messages=>messages.map(message=>message.text))'), priorLease)).toContain('fresh recovered member')
    expect(await page.evaluate('[dials.length>0,dials.every(Boolean),frames.length>0,frames.every(frame=>frame[1])]')).toEqual([true, true, true, true])
    expect(await page.evaluate('startup.openMemberSession(sessionOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
    await measureStartupStage(page, 'member close', () => page.evaluate('(async()=>{window.memberCloseStatus="pending";window.memberClosing=startup.close();await memberClosing;window.memberCloseStatus="complete"})()'), priorLease)
    expect(await page.evaluate('sockets.every(socket=>socket.readyState===3)')).toBe(true)
    expect(await page.evaluate('member.send("closed").then(()=>"escaped",error=>error.name)')).not.toBe('escaped')
  })
}

for (const visitor of [false, true]) for (const fault of ['selection', 'expired', 'missing-tab', 'missing-browser']) {
  test(`settled storage does not bypass current member ${fault}, visitor=${visitor}`, async ({ page }) => {
    await preparedRestart(page, visitor, true)
    await page.evaluate('beginPrepared();undefined'); await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('recoveryStatus')).toBe('settled')
    await memberTransport(page)
    await page.evaluate(async fault => {
      const w = window as any
      if (fault === 'selection') w.current = { ...w.current, keep: false }
      if (fault === 'missing-tab' || fault === 'missing-browser') {
        const request = indexedDB.open(w.Ordinary.ORDINARY_DATABASE, 1)
        const db = await new Promise<IDBDatabase>(resolve => request.onsuccess = () => resolve(request.result))
        const transaction = db.transaction('owners', 'readwrite')
        transaction.objectStore('owners').delete(fault === 'missing-browser' ? 'browser' : w.tabOwner.purpose)
        await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
        db.close()
      }
    }, fault)
    if (fault === 'expired') await page.clock.fastForward(3_600_000)
    const before = await page.evaluate('[entropy,puts,signCalls]')
    expect(await page.evaluate('Ordinary.OrdinaryMemberStartup.open(recoveryOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('[dials.length,frames.length]')).toEqual([0, 0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

test('existing-custody open cannot initialise an absent database', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const w = window as any; let entropy = 0
    crypto.getRandomValues = () => { entropy++; throw Error('must not allocate') }
    const owner = new w.Ordinary.OrdinaryStateOwner()
    try {
      const outcome = await owner.openExisting(() => true).then(() => 'escaped', (error: Error) => error.name)
      return { outcome, entropy, databases: await indexedDB.databases() }
    } finally { await owner.close() }
  })
  expect(result).toEqual({ outcome: 'OrdinaryStateHold', entropy: 0, databases: [] })
})

for (const fault of ['selection', 'session', 'generation']) {
  test(`current ${fault} change between owner opens refuses without activity`, async ({ page }) => {
    await preparedRestart(page, false, true)
    await page.evaluate('beginPrepared();undefined'); await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('recoveryStatus')).toBe('settled')
    await memberTransport(page)
    await page.evaluate(fault => {
      const w = window as any, original = w.Ordinary.OrdinaryStateOwner.prototype.openExisting
      w.currentSdkGeneration = 0
      w.recoveryOptions.foreground.currentGeneration = () => w.currentSdkGeneration
      w.Ordinary.OrdinaryStateOwner.prototype.openExisting = async function(...args: any[]) {
        await original.apply(this, args)
        if (this.purpose === 'browser') {
          if (fault === 'selection') w.current = { ...w.current, keep: false }
          if (fault === 'session') w.sourceSession = { ...w.sourceSession }
          if (fault === 'generation') w.currentSdkGeneration = 1
        }
      }
    }, fault)
    const before = await page.evaluate('[entropy,puts,signCalls]')
    expect(await page.evaluate('Ordinary.OrdinaryMemberStartup.open(recoveryOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('[dials.length,frames.length]')).toEqual([0, 0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

for (const purpose of ['browser', 'tab']) for (const fault of ['close', 'versionchange']) {
  test(`existing ${purpose} custody joins decrypt during ${fault} without permission`, async ({ page }) => {
    await preparedRestart(page, false, true)
    await page.evaluate('beginPrepared();undefined'); await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('recoveryStatus')).toBe('settled')
    const before = await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate(purpose => {
      const w = window as any, decrypt = crypto.subtle.decrypt.bind(crypto.subtle); let gated = false
      w.targetOwner = purpose === 'browser' ? w.browserOwner : w.tabOwner
      crypto.subtle.decrypt = async (...args) => {
        const result = await decrypt(...args)
        if (!gated) { gated = true; w.readBlocked = true; await new Promise<void>(resolve => w.releaseRead = resolve) }
        return result
      }
      w.readStatus = 'pending'
      w.reading = w.targetOwner.openExisting(w.guard).then(() => w.readStatus = 'escaped', (error: Error) => w.readStatus = error.name)
    }, purpose)
    await page.waitForFunction('window.readBlocked===true')
    if (fault === 'versionchange') {
      await page.evaluate(() => {
        const w = window as any, request = indexedDB.deleteDatabase(w.Ordinary.ORDINARY_DATABASE)
        request.onsuccess = () => w.databaseDeleted = true
        request.onerror = () => w.databaseDeleted = 'failed'
      })
      await page.waitForFunction('window.databaseDeleted===true')
    }
    await page.evaluate('window.closeStatus="pending";window.closing=targetOwner.close().then(()=>closeStatus="done");undefined')
    expect(await page.evaluate('[readStatus,closeStatus]')).toEqual(['pending', 'pending'])
    await page.evaluate('releaseRead();undefined'); await page.evaluate('closing')
    expect(await page.evaluate('[readStatus,closeStatus]')).toEqual(['OrdinaryStateHold', 'done'])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

for (const purpose of ['browser', 'tab']) for (const fault of ['pending', 'incomplete-migration']) {
  test(`existing ${purpose} custody refuses ${fault} without initialisation`, async ({ page }) => {
    await preparedRestart(page, false, true)
    await page.evaluate('beginPrepared();undefined'); await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('recoveryStatus')).toBe('settled')
    await page.evaluate(async ({ purpose, fault }) => {
      const w = window as any, o = w.Ordinary, name = purpose === 'browser' ? 'browser' : w.tabOwner.purpose
      const saved: any = new Map(await w.readPreparedRows()).get(name)
      const image = await o.openOrdinaryFrame(saved.frame, saved.key)
      try {
        if (fault === 'pending') saved.pending = await o.sealOrdinaryImage({ ...image, revision: image.revision + 1 }, saved.key)
        else saved.frame = await o.sealOrdinaryImage({ ...image, migration: { phase: 'cleaning', sources: new Map(), names: [] } }, saved.key)
      } finally { image.records.clear(); image.fences.clear(); image.migration?.sources.clear() }
      const request = indexedDB.open(o.ORDINARY_DATABASE, 1)
      const db = await new Promise<IDBDatabase>(resolve => request.onsuccess = () => resolve(request.result))
      const transaction = db.transaction('owners', 'readwrite')
      transaction.objectStore('owners').put(saved, name)
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
      db.close(); w.targetOwner = purpose === 'browser' ? w.browserOwner : w.tabOwner
    }, { purpose, fault })
    const before = await page.evaluate('[entropy,puts,signCalls]')
    expect(await page.evaluate('targetOwner.openExisting(guard).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

test('liveness loss after the fresh load wipes unadopted material and starts no carrier', async ({ page }) => {
  await preparedRestart(page, false, true)
  await page.evaluate('beginPrepared();undefined'); await page.waitForFunction("recoveryStatus!=='pending'")
  await memberTransport(page)
  await page.evaluate(() => {
    const w = window as any, original = w.Ordinary.OrdinaryPersistentBootstrap.prototype.load
    w.Ordinary.OrdinaryPersistentBootstrap.prototype.load = async function(...args: any[]) {
      const material = await original.apply(this, args)
      w.unadoptedMaterial = material; w.current = { ...w.current, keep: false }
      return material
    }
  })
  const before = await page.evaluate('[entropy,puts,signCalls]')
  expect(await page.evaluate('Ordinary.OrdinaryMemberStartup.open(recoveryOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('[dials.length,frames.length]')).toEqual([0, 0])
  expect(await page.evaluate('[unadoptedMaterial.admission.secret,unadoptedMaterial.deviceKey,unadoptedMaterial.sealKey,...unadoptedMaterial.sealKeys].every(key=>key.every(byte=>byte===0))')).toBe(true)
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
})

test('liveness loss after member construction closes and joins the unreturned member', async ({ page }) => {
  await preparedRestart(page, false, true)
  await memberTransport(page)
  await page.evaluate('(async()=>{window.startup=await Ordinary.OrdinaryMemberStartup.open(recoveryOptions)})()')
  await page.evaluate(() => {
    const w = window as any, original = w.Ordinary.OrdinaryPersistentBootstrap.prototype.openMemberSession
    w.Ordinary.OrdinaryPersistentBootstrap.prototype.openMemberSession = async function(...args: any[]) {
      const member = await original.apply(this, args)
      w.unadoptedMember = member; w.afterConstruction = [w.entropy, w.puts, w.signCalls]
      w.current = { ...w.current, keep: false }
      return member
    }
  })
  expect(await page.evaluate('startup.openMemberSession(sessionOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
  await page.evaluate('startup.close()')
  expect(await page.evaluate('unadoptedMember.join().then(()=>"escaped",error=>error.name)')).not.toBe('escaped')
  expect(await page.evaluate('[dials.length,frames.length]')).toEqual([0, 0])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(await page.evaluate('afterConstruction'))
})

test('native tab changes between owner opens cannot inherit the browser classification', async ({ page }) => {
  await preparedRestart(page, false, true)
  await page.evaluate('beginPrepared();undefined'); await page.waitForFunction("recoveryStatus!=='pending'")
  await memberTransport(page)
  await page.evaluate(() => {
    const w = window as any, o = w.Ordinary, original = o.OrdinaryStateOwner.prototype.openExisting
    o.OrdinaryStateOwner.prototype.openExisting = async function(...args: any[]) {
      await original.apply(this, args)
      if (this.purpose !== 'browser') return
      const saved: any = new Map(await w.readPreparedRows()).get(w.tabOwner.purpose)
      const image = await o.openOrdinaryFrame(saved.frame, saved.key)
      try { saved.frame = await o.sealOrdinaryImage({ ...image, generation: 'b'.repeat(64) }, saved.key) }
      finally { image.records.clear(); image.fences.clear(); image.migration?.sources.clear() }
      const request = indexedDB.open(o.ORDINARY_DATABASE, 1)
      const db = await new Promise<IDBDatabase>(resolve => request.onsuccess = () => resolve(request.result))
      const transaction = db.transaction('owners', 'readwrite')
      transaction.objectStore('owners').put(saved, w.tabOwner.purpose)
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
      db.close(); w.afterMutation = [w.entropy, w.puts, w.signCalls]
    }
  })
  expect(await page.evaluate('Ordinary.OrdinaryMemberStartup.open(recoveryOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('[dials.length,frames.length]')).toEqual([0, 0])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(await page.evaluate('afterMutation'))
})

test('prepared operation for another tab refuses before any recovery write', async ({ page }) => {
  await preparedRestart(page, false, true)
  const before = await page.evaluate('[entropy,puts,signCalls]')
  expect(await page.evaluate(`Ordinary.OrdinaryMemberStartup.open({...recoveryOptions,
    tab:new Ordinary.OrdinaryStateOwner('tab:'+'b'.repeat(64),tabOwner.expiresAt)}).then(()=>"escaped",error=>error.name)`)).toBe('OrdinaryStateHold')
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  expect(await page.evaluate('preparedPhase()')).toBe('prepared')
})
