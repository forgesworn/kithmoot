import { test, expect, type Page } from '@playwright/test'
import { preparedRestart } from './ordinary-prepared-extension.setup.js'
import { memberTransport } from './ordinary-prepared-extension.transport.js'

async function extensionRestart(page: Page, keep = true, priorLease = false, sdkExpirySeconds?: number): Promise<void> {
  await preparedRestart(page, false, keep, priorLease, sdkExpirySeconds)
  await memberTransport(page)
  await page.evaluate(() => {
    const w = window as any, c = w.current
    w.extensionSelection = { account:c.account, participant:c.participant, invitationId:c.invitationId, link:c.link, keep:c.keep, credentialExpiresAt:c.credentialExpiresAt }
    w.sdkGeneration = 0; w.discoveryCalls = 0; w.discoveryHeld = []; w.getterCalls = 0
    const discover = w.nostr.getPublicKey
    w.nostr.getPublicKey = () => { w.discoveryCalls++; w.discoveryHeld.push(w.nativeHeld > 0); return discover() }
    w.extensionOptions = { browser:w.browserOwner, tab:w.tabOwner, invitation:w.recoveryOptions.invitation,
      account:c.account, link:c.link, keep:c.keep, credentialExpiresAt:c.credentialExpiresAt,
      current:()=>w.extensionSelection, live:w.guard, generation:0, currentGeneration:()=>w.sdkGeneration, checkClients:async()=>{}, stop:()=>{} }
    w.restoreStatus = 'pending'; w.restoreStack = undefined
    w.beginExtension = () => {
      w.restoring = w.Ordinary.OrdinaryMemberExtensionStartup.open(w.extensionOptions)
        .then((startup: any) => { w.extensionStartup = startup; w.restoreStatus = 'ok' }, (error: Error) => { w.restoreStatus = error.name; w.restoreStack = error.stack })
    }
  })
}

for (const keep of [false, true]) for (const priorLease of [false, true]) {
  test(`actual extension restores at E then recovers and sends, keep=${keep}, priorLease=${priorLease}`, async ({ page }) => {
    await extensionRestart(page, keep, priorLease)
    await page.evaluate('beginExtension();undefined'); await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,restoreStack??null]')).toEqual(['ok', null])
    expect(await page.evaluate('[discoveryCalls,discoveryHeld,providerPhases,signCalls,dials.length,frames.length]')).toEqual([1, [true], ['prepared', 'provider-started'], 1, 0, 0])
    expect(await page.evaluate('preparedPhase()')).toBe('settled')
    await page.evaluate('(async()=>{window.member=await extensionStartup.openMemberSession(sessionOptions);await member.join();await member.send("restored extension member")})()')
    expect(await page.evaluate('member.messages().then(messages=>messages.map(message=>message.text))')).toContain('restored extension member')
    expect(await page.evaluate('[dials.every(Boolean),frames.every(frame=>frame[1])]')).toEqual([true, true])
    await page.evaluate('extensionStartup.close()')
    expect(await page.evaluate('sockets.every(socket=>socket.readyState===3)')).toBe(true)
  })
}

for (const fault of ['account', 'selection-pointer', 'selection-field', 'selection-getter', 'async-selection', 'generation', 'input-method']) {
  test(`prepared SDK restore refuses current ${fault} before provider or entropy`, async ({ page }) => {
    await extensionRestart(page)
    await page.evaluate(fault => {
      const w = window as any
      w.extensionOptions.checkClients = async () => {
        if (fault === 'account') w.extensionSelection.account = 'f'.repeat(64)
        if (fault === 'selection-pointer') w.extensionSelection = {...w.extensionSelection}
        if (fault === 'selection-field') w.extensionSelection.keep = false
        if (fault === 'selection-getter') Object.defineProperty(w.extensionSelection, 'keep', {get:()=>{w.getterCalls=(w.getterCalls??0)+1;return true}})
        if (fault === 'async-selection') w.extensionSelection = Promise.resolve(w.extensionSelection)
        if (fault === 'generation') w.sdkGeneration = 1
        if (fault === 'input-method') w.extensionOptions.current = () => w.extensionSelection
      }
    }, fault)
    const before = await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined'); await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,discoveryCalls,getterCalls??0]')).toEqual(['OrdinaryStateHold',0,0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
  })
}

for (const fault of ['wrong-key', 'malformed-key', 'window-replaced', 'discovery-replaced', 'signing-replaced', 'throw']) {
  test(`actual discovery ${fault} refuses without renewal signing or writes`, async ({ page }) => {
    await extensionRestart(page)
    await page.evaluate(fault => {
      const w = window as any, original = w.nostr.getPublicKey, p = w.nostr
      w.nostr.getPublicKey = async () => {
        const key = await original()
        if (fault === 'wrong-key') return 'f'.repeat(64)
        if (fault === 'malformed-key') return 'not a public key'
        if (fault === 'window-replaced') w.nostr = { ...p }
        if (fault === 'discovery-replaced') p.getPublicKey = async () => key
        if (fault === 'signing-replaced') p.signEvent = async () => { throw Error('must not sign') }
        if (fault === 'throw') throw Error('extension unavailable')
        return key
      }
      const close = w.Ordinary.Nip07Signer.prototype.close; w.sdkCloses = 0
      w.Ordinary.Nip07Signer.prototype.close = function() { w.sdkCloses++; return close.call(this) }
    }, fault)
    const before = await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined'); await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('restoreStatus')).not.toBe('ok')
    expect(await page.evaluate('[discoveryCalls,discoveryHeld]')).toEqual([1,[true]])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
    expect(await page.evaluate('sdkCloses')).toBe(fault === 'wrong-key' ? 1 : 0)
  })
}

test('case-varied discovery is normalised by the actual SDK before exact account comparison', async ({ page }) => {
  await extensionRestart(page)
  await page.evaluate(() => { const w=window as any, original=w.nostr.getPublicKey; w.nostr.getPublicKey=async()=>(await original()).toUpperCase() })
  await page.evaluate('beginExtension();undefined'); await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,discoveryCalls,signCalls]')).toEqual(['ok',1,1])
  await page.evaluate('extensionStartup.close()')
})

for (const fault of ['generation', 'owner-close', 'selection']) {
  test(`unabortable discovery joins ${fault} and never hands out a signer`, async ({ page }) => {
    await extensionRestart(page)
    await page.evaluate(() => {
      const w=window as any, original=w.nostr.getPublicKey
      w.nostr.getPublicKey=async()=>{w.discoveryBlocked=true;await new Promise<void>(resolve=>w.releaseDiscovery=resolve);return original()}
    })
    const before = await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined'); await page.waitForFunction('window.discoveryBlocked===true')
    await page.evaluate(fault => {
      const w=window as any
      if(fault==='generation')w.sdkGeneration=1
      if(fault==='selection')w.extensionSelection={...w.extensionSelection,keep:false}
      w.closeStatus='pending';w.closing=w.browserOwner.close().then(()=>w.closeStatus='done')
    }, fault)
    expect(await page.evaluate('[restoreStatus,closeStatus,signCalls]')).toEqual(['pending','pending',0])
    await page.evaluate('releaseDiscovery();undefined'); await page.evaluate('closing')
    expect(await page.evaluate('[restoreStatus,closeStatus]')).toEqual(['OrdinaryStateHold','done'])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
  })
}

test('generation revocation after SDK construction closes the raw signer before any member', async ({ page }) => {
  await extensionRestart(page)
  await page.evaluate(() => {
    const w=window as any, close=w.Ordinary.Nip07Signer.prototype.close;let checks=0;w.sdkCloses=0
    w.Ordinary.Nip07Signer.prototype.close=function(){w.sdkCloses++;return close.call(this)}
    w.extensionOptions.checkClients=async()=>{if(++checks===4)w.sdkGeneration=1}
  })
  const before=await page.evaluate('[entropy,puts,signCalls]')
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,discoveryCalls,sdkCloses]')).toEqual(['OrdinaryStateHold',1,1])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  expect(await page.evaluate('[dials.length,frames.length]')).toEqual([0,0])
})

test('provider method getter changing selection at the native factory check cannot start discovery', async ({ page }) => {
  await extensionRestart(page)
  await page.evaluate(() => {
    const w=window as any, original=w.nostr.getPublicKey
    Object.defineProperty(w.nostr,'getPublicKey',{configurable:true,get(){
      if(new Error().stack?.includes('checkOrdinaryPreparedExtensionPromise'))w.extensionSelection.keep=false
      return original
    }})
  })
  const before=await page.evaluate('[entropy,puts,signCalls]')
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,discoveryCalls]')).toEqual(['OrdinaryStateHold',0])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
})

test('SDK discovery metadata getter cannot change selection before the actual provider call', async ({ page }) => {
  await extensionRestart(page)
  await page.evaluate(() => {
    const w=window as any,p=w.nostr;w.sdkGetterChanged=false
    Object.defineProperty(window,'nostr',{configurable:true,get(){
      const stack=new Error().stack?.split('\n')??[]
      if(!w.sdkGetterChanged&&stack.some((line,index)=>line.includes('check')&&stack[index+1]?.includes('preflight'))){
        w.sdkGetterChanged=true;w.extensionSelection.keep=false
      }
      return p
    }})
  })
  const before=await page.evaluate('[entropy,puts,signCalls]')
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,sdkGetterChanged,discoveryCalls]')).toEqual(['OrdinaryStateHold',true,0])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
})

test('the immediate native pre-start clock cut cannot revoke selection and still discover', async ({ page }) => {
  await extensionRestart(page)
  await page.evaluate(() => {
    const w=window as any,p=w.nostr,now=Date.now;w.preflightSeen=false;w.clockChanged=false
    Object.defineProperty(window,'nostr',{configurable:true,get(){
      if(new Error().stack?.includes('preflight'))w.preflightSeen=true
      return p
    }})
    Date.now=()=>{
      const stack=new Error().stack?.split('\n')??[],run=stack.findIndex(line=>/\brun\b/.test(line))
      if(w.preflightSeen&&!w.discoveryCalls&&!w.clockChanged&&run>0&&!stack.slice(0,run).some(line=>/check|live/i.test(line))){
        w.clockChanged=true;w.extensionSelection.keep=false
      }
      return now()
    }
  })
  const before=await page.evaluate('[entropy,puts,signCalls]')
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,preflightSeen,clockChanged,discoveryCalls]')).toEqual(['OrdinaryStateHold',true,true,0])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
})

for(const cut of ['post-result','constructor']){
  test(`selection revoked by SDK ${cut} metadata is joined and the raw signer closed`,async({page})=>{
    await extensionRestart(page)
    await page.evaluate(cut=>{
      const w=window as any,p=w.nostr,close=w.Ordinary.Nip07Signer.prototype.close;w.resultChanged=false;w.sdkCloses=0
      w.Ordinary.Nip07Signer.prototype.close=function(){w.sdkCloses++;return close.call(this)}
      const change=()=>{w.resultChanged=true;w.extensionSelection.keep=false}
      if(cut==='post-result')Object.defineProperty(window,'nostr',{configurable:true,get(){
        const stack=new Error().stack?.split('\n')??[]
        if(w.discoveryCalls&&!w.resultChanged&&stack.some((line,index)=>line.includes('check')&&stack[index+1]?.includes('guardedNip07Discovery')))change()
        return p
      }})
      else Object.defineProperty(p,'nip44',{configurable:true,get(){
        if(w.discoveryCalls&&!w.resultChanged&&new Error().stack?.split('\n').some(line=>/\bNip07Signer\d*(?:@|\s|\()/.test(line)))change()
        return undefined
      }})
    },cut)
    const before=await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,resultChanged,discoveryCalls,sdkCloses,dials.length,frames.length]')).toEqual(['OrdinaryStateHold',true,1,1,0,0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

for(const callback of ['live','currentGeneration']){
  test(`current ${callback} callback mutating selection cannot hide behind an earlier capture`,async({page})=>{
    await extensionRestart(page)
    await page.evaluate(callback=>{const w=window as any
      w.extensionOptions[callback]=()=>{w.extensionSelection.keep=false;return callback==='live'?true:0}
    },callback)
    const before=await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,discoveryCalls]')).toEqual(['OrdinaryStateHold',0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

test('alternating current selection cannot substitute a foreign pointer for the member adapter',async({page})=>{
  await extensionRestart(page)
  await page.evaluate(()=>{const w=window as any,pinned=w.extensionSelection,foreign={...pinned};let calls=0
    w.extensionOptions.current=()=>++calls%2===1?pinned:foreign
  })
  const before=await page.evaluate('[entropy,puts,signCalls]')
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,discoveryCalls]')).toEqual(['OrdinaryStateHold',0])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
})

test('concurrent opens reserve the native tab until unabortable discovery and closing join',async({page})=>{
  await extensionRestart(page)
  await page.evaluate(()=>{const w=window as any,original=w.nostr.getPublicKey;w.unblockedDiscovery=original
    w.nostr.getPublicKey=async()=>{const key=await original();w.discoveryBlocked=true;await new Promise<void>(resolve=>w.releaseDiscovery=resolve);return key}
  })
  await page.evaluate('beginExtension();undefined');await page.waitForFunction('window.discoveryBlocked===true')
  expect(await page.evaluate(`Ordinary.OrdinaryMemberExtensionStartup.open({...extensionOptions}).then(()=> 'unexpected',error=>error.name)`)).toBe('OrdinaryStateHold')
  expect(await page.evaluate('[discoveryCalls,signCalls]')).toEqual([1,0])
  await page.evaluate('window.live=false;window.closing=browserOwner.close();undefined')
  expect(await page.evaluate(`Ordinary.OrdinaryMemberExtensionStartup.open({...extensionOptions}).then(()=> 'unexpected',error=>error.name)`)).toBe('OrdinaryStateHold')
  await page.evaluate('releaseDiscovery();undefined');await page.evaluate('closing');await page.evaluate('restoring')
  expect(await page.evaluate('[restoreStatus,discoveryCalls,signCalls]')).toEqual(['OrdinaryStateHold',1,0])
  await page.evaluate(()=>{const w=window as any
    w.browserOwner=new w.Ordinary.OrdinaryStateOwner();w.live=true;w.extensionOptions.browser=w.browserOwner;w.nostr.getPublicKey=w.unblockedDiscovery;w.restoreStatus='pending'
  })
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,discoveryCalls,signCalls]')).toEqual(['ok',2,1])
  await page.evaluate('extensionStartup.close()')
})

for(const row of ['browser','tab','control']){
  test(`native ${row} removal while discovery is pending refuses handoff without signing`,async({page})=>{
    await extensionRestart(page)
    await page.evaluate(()=>{const w=window as any,original=w.nostr.getPublicKey
      w.nostr.getPublicKey=async()=>{const key=await original();w.discoveryBlocked=true;await new Promise<void>(resolve=>w.releaseDiscovery=resolve);return key}
    })
    const before=await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined');await page.waitForFunction('window.discoveryBlocked===true')
    await page.evaluate(async row=>{const w=window as any,r=indexedDB.open(w.Ordinary.ORDINARY_DATABASE,1)
      const db=await new Promise<IDBDatabase>(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite')
      const key=row==='browser'?'browser':row==='tab'?w.tabOwner.purpose:w.Ordinary.ordinaryOperationNames(w.tabOwner.purpose).control
      tx.objectStore('owners').delete(key)
      await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});db.close()
      w.releaseDiscovery()
    },row)
    await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,discoveryCalls,dials.length,frames.length]')).toEqual(['OrdinaryStateHold',1,0,0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

test('idle native tab expiry revokes the member, closes its SDK and prevents later use',async({page})=>{
  await extensionRestart(page)
  await page.evaluate(()=>{const w=window as any,close=w.Ordinary.Nip07Signer.prototype.close;w.sdkCloses=0;w.stops=0
    w.Ordinary.Nip07Signer.prototype.close=function(){w.sdkCloses++;return close.call(this)}
    w.extensionOptions.stop=()=>w.stops++
  })
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('restoreStatus')).toBe('ok')
  const remaining=await page.evaluate<number>('tabOwner.expiresAt-Date.now()')
  await page.clock.fastForward(remaining+1);await page.waitForFunction('window.sdkCloses===1')
  expect(await page.evaluate('extensionStartup.openMemberSession(sessionOptions).then(()=>"unexpected",error=>error.name)')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('[sdkCloses,stops,dials.length,frames.length]')).toEqual([1,1,0,0])
})


test('historical SDK expiry closes an idle restored controller before native tab expiry',async({page})=>{
  await extensionRestart(page,true,false,2400)
  await page.evaluate(()=>{const w=window as any,close=w.Ordinary.Nip07Signer.prototype.close;w.sdkCloses=0;w.stops=0
    w.Ordinary.Nip07Signer.prototype.close=function(){w.sdkCloses++;return close.call(this)}
    w.extensionOptions.stop=()=>w.stops++
  })
  await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
  expect(await page.evaluate('[restoreStatus,sourceSession.expiresAt<tabOwner.expiresAt]')).toEqual(['ok',true])
  const remaining=await page.evaluate<number>('sourceSession.expiresAt-Date.now()')
  await page.clock.fastForward(remaining+1);await page.waitForFunction('window.sdkCloses===1')
  expect(await page.evaluate('extensionStartup.openMemberSession(sessionOptions).then(()=>"unexpected",error=>error.name)')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('[sdkCloses,stops,dials.length,frames.length,Date.now()<tabOwner.expiresAt]')).toEqual([1,1,0,0,true])
})

for(const deadline of ['sdk','tab']){
  test(`unabortable discovery crossing ${deadline} expiry joins and refuses renewal`,async({page})=>{
    await extensionRestart(page,true,false,2400)
    await page.evaluate(()=>{const w=window as any,original=w.nostr.getPublicKey
      w.nostr.getPublicKey=async()=>{const key=await original();w.discoveryBlocked=true;await new Promise<void>(resolve=>w.releaseDiscovery=resolve);return key}
    })
    const before=await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined');await page.waitForFunction('window.discoveryBlocked===true')
    const remaining=await page.evaluate<number>(deadline==='sdk'?'sourceSession.expiresAt-Date.now()':'tabOwner.expiresAt-Date.now()')
    await page.clock.fastForward(remaining+1)
    expect(await page.evaluate('restoreStatus')).toBe('pending')
    await page.evaluate('releaseDiscovery();undefined');await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,discoveryCalls,dials.length,frames.length]')).toEqual(['OrdinaryStateHold',1,0,0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}
