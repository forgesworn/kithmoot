import { test, expect, type Page } from '@playwright/test'
import { preparedRestart } from './ordinary-prepared-extension.setup.js'
import { memberTransport } from './ordinary-prepared-extension.transport.js'

async function extensionRestart(page: Page, keep = true, priorLease = false, sdkExpirySeconds?: number): Promise<void> {
  await preparedRestart(page, false, keep, priorLease, sdkExpirySeconds, 'ordinary')
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

test('ordinary native cold start restores the actual SDK privately before fresh member join and send', async ({ page }) => {
  await preparedRestart(page, false, true, false, undefined, 'ordinary')
  await memberTransport(page)
  await page.evaluate(() => {
    const w = window as any, c = w.current
    w.extensionSelection = { account: c.account, participant: c.participant, invitationId: c.invitationId,
      link: c.link, keep: c.keep, credentialExpiresAt: c.credentialExpiresAt }
    w.discoveryCalls = 0; w.discoveryHeld = []
    const discover = w.nostr.getPublicKey
    w.nostr.getPublicKey = () => { w.discoveryCalls++; w.discoveryHeld.push(w.nativeHeld > 0); return discover() }
    w.extensionOptions = { browser: w.browserOwner, tab: w.tabOwner, invitation: w.recoveryOptions.invitation,
      account: c.account, link: c.link, keep: c.keep, credentialExpiresAt: c.credentialExpiresAt,
      current: () => w.extensionSelection, live: w.guard, generation: 0, currentGeneration: () => 0,
      checkClients: async () => {}, stop: () => {} }
  })
  expect(await page.evaluate('(async()=> (await browserOwner.inspectRenewalStartup(guard)).status)()')).toBe('ordinary')
  const before = await page.evaluate('[entropy,puts,signCalls]')
  await page.evaluate(async () => {
    const w = window as any
    try { w.extensionStartup = await w.Ordinary.OrdinaryMemberExtensionStartup.open(w.extensionOptions); w.restoreStatus = 'ok' }
    catch (error) { w.restoreStatus = (error as Error).name }
  })
  expect(await page.evaluate('[restoreStatus,discoveryCalls,discoveryHeld]')).toEqual(['ok', 1, [true]])
  expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  await page.evaluate('(async()=>{window.member=await extensionStartup.openMemberSession(sessionOptions);await member.join();await member.send("ordinary cold-start member")})()')
  expect(await page.evaluate('member.messages().then(messages=>messages.map(message=>message.text))')).toContain('ordinary cold-start member')
  await page.evaluate('extensionStartup.close()')
  expect(await page.evaluate('sockets.every(socket=>socket.readyState===3)')).toBe(true)
})

for (const fault of ['account', 'selection-pointer', 'selection-field', 'selection-getter', 'async-selection', 'generation', 'input-method']) {
  test(`ordinary SDK restore refuses current ${fault} before provider or entropy`, async ({ page }) => {
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
    expect(await page.evaluate('preparedPhase()')).toBe('ordinary')
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
    expect(await page.evaluate('preparedPhase()')).toBe('ordinary')
    expect(await page.evaluate('sdkCloses')).toBe(fault === 'wrong-key' ? 1 : 0)
  })
}


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
    expect(await page.evaluate('preparedPhase()')).toBe('ordinary')
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
      if(new Error().stack?.includes('checkOrdinaryColdExtensionPromise'))w.extensionSelection.keep=false
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


for (const keep of [false,true]) for (const priorLease of [false,true]) {
  test(`ordinary P restore uses current credential, keep=${keep}, priorLease=${priorLease}`, async ({page})=>{
    await extensionRestart(page,keep,priorLease)
    const before=await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,restoreStack??null]')).toEqual(['ok',null])
    expect(await page.evaluate('[discoveryCalls,discoveryHeld]')).toEqual([1,[true]])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
    await page.evaluate('(async()=>{window.member=await extensionStartup.openMemberSession(sessionOptions);await member.join();await member.send("ordinary selected lease")})()')
    expect(await page.evaluate('member.messages().then(messages=>messages.map(message=>message.text))')).toContain('ordinary selected lease')
    await page.evaluate('extensionStartup.close()')
    expect(await page.evaluate('sockets.every(socket=>socket.readyState===3)')).toBe(true)
  })
}

for (const stage of ['provider-returned','candidate-prepared','candidate-committed','settled'] as const) {
  test(`neutral ${stage} recovery finishes before any provider getter`,async({page})=>{
    await preparedRestart(page,false,true,false,undefined,stage)
    await memberTransport(page)
    await page.evaluate(()=>{
      const w=window as any,c=w.current,p=w.nostr
      w.extensionSelection={account:c.account,participant:c.participant,invitationId:c.invitationId,link:c.link,keep:c.keep,credentialExpiresAt:c.credentialExpiresAt}
      w.providerReads=[];w.readsBeforeOrdinary=0;w.neutralOrdinary=false
      const inspect=w.Ordinary.OrdinaryStateOwner.prototype.inspectRenewalStartup
      w.Ordinary.OrdinaryStateOwner.prototype.inspectRenewalStartup=async function(...args:any[]){
        const result=await inspect.apply(this,args);if(result.status==='ordinary')w.neutralOrdinary=true;return result
      }
      Object.defineProperty(window,'nostr',{configurable:true,get(){w.providerReads.push(w.neutralOrdinary);if(!w.neutralOrdinary)w.readsBeforeOrdinary++;return p}})
      w.extensionOptions={browser:w.browserOwner,tab:w.tabOwner,invitation:w.recoveryOptions.invitation,account:c.account,link:c.link,keep:c.keep,
        credentialExpiresAt:c.credentialExpiresAt,current:()=>w.extensionSelection,live:w.guard,generation:0,currentGeneration:()=>0,checkClients:async()=>{},stop:()=>{}}
    })
    expect(await page.evaluate('preparedPhase()')).toBe(stage)
    const signCalls=await page.evaluate('signCalls')
    expect(await page.evaluate('Ordinary.OrdinaryMemberExtensionStartup.open(extensionOptions).then(value=>{window.extensionStartup=value;return "ok"},error=>error.name)')).toBe('ok')
    expect(await page.evaluate('[readsBeforeOrdinary,providerReads.length>0,providerReads.every(Boolean),signCalls]')).toEqual([0,true,true,signCalls])
    expect(await page.evaluate('preparedPhase()')).toBe('settled')
    await page.evaluate('extensionStartup.close()')
  })
}

test('ordinary credential below the 600 second floor refuses account discovery',async({page})=>{
  await extensionRestart(page)
  await page.clock.fastForward(1201000)
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
  expect(await page.evaluate('[restoreStatus,discoveryCalls,signCalls]')).toEqual(['ok',2,0])
  await page.evaluate('extensionStartup.close()')
})

for(const row of ['browser','tab','control']){
  test(`native ${row} removal while discovery is pending refuses handoff without signing`,async({page})=>{
    await extensionRestart(page,true,true)
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

for(const fault of ['provider-started','foreign-prepared'] as const){
  test(`origin ${fault} refuses before any provider getter or recovery write`,async({page})=>{
    await preparedRestart(page,false,true,false,undefined,fault==='provider-started'?'provider-started':'prepared')
    await page.evaluate(fault=>{
      const w=window as any,c=w.current,p=w.nostr;w.providerReads=0
      w.extensionSelection={account:c.account,participant:c.participant,invitationId:c.invitationId,link:c.link,keep:c.keep,credentialExpiresAt:c.credentialExpiresAt}
      if(fault==='foreign-prepared')w.tabOwner=new w.Ordinary.OrdinaryStateOwner('tab:'+'b'.repeat(64),w.tabOwner.expiresAt)
      Object.defineProperty(window,'nostr',{configurable:true,get(){w.providerReads++;return p}})
      w.extensionOptions={browser:w.browserOwner,tab:w.tabOwner,invitation:w.recoveryOptions.invitation,account:c.account,link:c.link,keep:c.keep,
        credentialExpiresAt:c.credentialExpiresAt,current:()=>w.extensionSelection,live:w.guard,generation:0,currentGeneration:()=>0,checkClients:async()=>{},stop:()=>{}}
    },fault)
    const before=await page.evaluate('[entropy,puts,signCalls]')
    expect(await page.evaluate('Ordinary.OrdinaryMemberExtensionStartup.open(extensionOptions).then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('providerReads')).toBe(0)
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

for(const fault of ['pending','incomplete-migration','missing-proof','ended-room','changed-link','changed-keep','wrong-origin','wrong-app','proof-signature','generation','fence'] as const){
  test(`ordinary native ${fault} refuses before account discovery`,async({page})=>{
    await extensionRestart(page)
    await page.evaluate(async fault=>{
      const w=window as any,o=w.Ordinary,rows=new Map(await w.readPreparedRows()),saved:any=rows.get('browser')
      const image=await o.openOrdinaryFrame(saved.frame,saved.key),tab:any=rows.get(w.tabOwner.purpose)
      try{
        const name=[...image.records.keys()].find((name:any)=>name.includes(o.ROOM_PREFIX))
        if(fault==='ended-room'||fault==='changed-link'||fault==='changed-keep'){
          const value=JSON.parse(image.records.get(name))
          if(fault==='ended-room')value.endedAt=Math.floor(Date.now()/1000)
          if(fault==='changed-link')value.link+='changed'
          if(fault==='changed-keep')value.keep=false
          image.records.set(name,JSON.stringify(value))
        }
        if(fault==='wrong-origin'||fault==='wrong-app'||fault==='proof-signature'){
          const key=o.ORDINARY_SIGNET_KEYS.authEvent,event=JSON.parse(image.records.get(key))
          if(fault==='wrong-origin')event.tags=event.tags.map((tag:any)=>tag[0]==='origin'?['origin','https://foreign.invalid']:tag)
          if(fault==='wrong-app')event.tags=event.tags.map((tag:any)=>tag[0]==='app'?['app','Other app']:tag)
          const signed=await w.freshProviderSign({kind:event.kind,created_at:event.created_at,tags:event.tags,content:event.content})
          if(fault==='proof-signature')signed.sig='0'.repeat(128)
          image.records.set(key,JSON.stringify(signed))
        }
        if(fault==='generation')image.generation='b'.repeat(64)
        if(fault==='fence')image.fences.set('invitation:'+w.current.participant+':'+w.current.invitationId,1)
        if(fault==='incomplete-migration')image.migration.phase='cleaning'
        if(fault==='missing-proof'){
          const t=await o.openOrdinaryFrame(tab.frame,tab.key)
          try{
            t.records.delete(o.accountPrefix(w.current.participant)+o.PERSISTENT_TAB_PROOF_V2_PREFIX+w.current.invitationId)
            tab.frame=await o.sealOrdinaryImage(t,tab.key)
          }finally{t.records.clear();t.fences.clear();t.migration?.sources.clear()}
        }
        if(fault==='pending')saved.pending=await o.sealOrdinaryImage({...image,revision:image.revision+1},saved.key)
        else saved.frame=await o.sealOrdinaryImage(image,saved.key)
      }finally{image.records.clear();image.fences.clear();image.migration?.sources.clear()}
      const request=indexedDB.open(o.ORDINARY_DATABASE,1),db=await new Promise<IDBDatabase>(resolve=>request.onsuccess=()=>resolve(request.result))
      const tx=db.transaction('owners','readwrite');tx.objectStore('owners').put(saved,'browser');tx.objectStore('owners').put(tab,w.tabOwner.purpose)
      await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});db.close()
    },fault)
    const before=await page.evaluate('[entropy,puts,signCalls]')
    await page.evaluate('beginExtension();undefined');await page.waitForFunction("restoreStatus!=='pending'")
    expect(await page.evaluate('[restoreStatus,discoveryCalls]')).toEqual(['OrdinaryStateHold',0])
    expect(await page.evaluate('[entropy,puts,signCalls]')).toEqual(before)
  })
}

for(const owner of ['browser','tab'] as const){
  test(`unknown neutral recovery retains its cohort through ${owner} close and never reads the provider`,async({page})=>{
    await preparedRestart(page,false,true,false,undefined,'candidate-prepared')
    await page.evaluate(()=>{
      const w=window as any,o=w.Ordinary,c=w.current,p=w.nostr,put=IDBObjectStore.prototype.put;let changed=false
      w.providerReads=0;w.stopCalls=0
      w.extensionSelection={account:c.account,participant:c.participant,invitationId:c.invitationId,link:c.link,keep:c.keep,credentialExpiresAt:c.credentialExpiresAt}
      Object.defineProperty(window,'nostr',{configurable:true,get(){w.providerReads++;return p}})
      IDBObjectStore.prototype.put=function(...args:any[]){
        if(!changed&&String(args[1]).startsWith(o.ORDINARY_OPERATION_CONTROL_PREFIX)){
          changed=true;w.frozenRecoveryControl=[args[1],structuredClone(args[0])]
          const bad=structuredClone(args[0]);new Uint8Array(bad.tab.ciphertext)[0]^=1;return put.call(this,bad,args[1])
        }
        return put.apply(this,args as any)
      }
      w.restoreRecoveryFault=()=>{IDBObjectStore.prototype.put=put}
      w.extensionOptions={browser:w.browserOwner,tab:w.tabOwner,invitation:w.recoveryOptions.invitation,account:c.account,link:c.link,keep:c.keep,
        credentialExpiresAt:c.credentialExpiresAt,current:()=>w.extensionSelection,live:w.guard,generation:0,currentGeneration:()=>0,checkClients:async()=>{},stop:()=>w.stopCalls++}
      w.restoreStatus='pending';w.restoring=o.OrdinaryMemberExtensionStartup.open(w.extensionOptions).then(()=>w.restoreStatus='escaped',(error:Error)=>w.restoreStatus=error.name)
    })
    await page.waitForFunction('browserOwner.holdingRetention')
    await page.evaluate(owner=>{
      const w=window as any;w.closeStatus='pending';w.closing=(owner==='browser'?w.browserOwner:w.tabOwner).close().then(()=>w.closeStatus='done')
    },owner)
    await expect.poll(()=>page.evaluate('stopCalls')).toBe(1)
    await page.waitForFunction('browserOwner.holdingRetention')
    expect(await page.evaluate('[restoreStatus,closeStatus,providerReads]')).toEqual(['pending','pending',0])
    const entropy=await page.evaluate('entropy')
    await page.evaluate(async()=>{
      const w=window as any;w.restoreRecoveryFault();const request=indexedDB.open(w.Ordinary.ORDINARY_DATABASE,1)
      const db=await new Promise<IDBDatabase>(resolve=>request.onsuccess=()=>resolve(request.result)),tx=db.transaction('owners','readwrite')
      tx.objectStore('owners').put(w.frozenRecoveryControl[1],w.frozenRecoveryControl[0])
      await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});db.close()
      w.browserOwner.retryRetention();w.tabOwner.retryRetention()
    })
    await page.evaluate('closing');await page.evaluate('restoring')
    expect(await page.evaluate('[restoreStatus,closeStatus,providerReads,entropy]')).toEqual(['OrdinaryStateHold','done',0,entropy])
    expect(await page.evaluate('preparedPhase()')).toBe('candidate-committed')
  })
}

test('a second context cannot reach provider access while the first holds ordinary discovery',async({page,context})=>{
  await extensionRestart(page)
  await page.evaluate(()=>{
    const w=window as any,discover=w.nostr.getPublicKey
    w.nostr.getPublicKey=async()=>{const key=await discover();w.discoveryBlocked=true;await new Promise<void>(resolve=>w.releaseDiscovery=resolve);return key}
  })
  const captured=await page.evaluate(()=>{
    const w=window as any;return {selection:w.extensionSelection,bearer:Array.from(w.recoveryOptions.invitation.bearer),
      inviter:w.recoveryOptions.invitation.inviter,purpose:w.tabOwner.purpose,expiresAt:w.tabOwner.expiresAt,time:Date.now()}
  })
  await page.evaluate('beginExtension();undefined');await page.waitForFunction('window.discoveryBlocked===true')
  const other=await context.newPage();await other.goto('https://ordinary-renewal-startup.invalid');await other.clock.install({time:new Date(captured.time)})
  await other.evaluate(captured=>{
    const w=window as any,o=w.Ordinary,c=captured.selection;w.discoveryCalls=0;w.providerReads=0;w.restoreStatus='pending'
    const provider={getPublicKey:async()=>{w.discoveryCalls++;return c.account},signEvent:async()=>{throw Error('cold startup must not sign')}}
    Object.defineProperty(window,'nostr',{configurable:true,get(){w.providerReads++;return provider}})
    w.browserOwner=new o.OrdinaryStateOwner();w.tabOwner=new o.OrdinaryStateOwner(captured.purpose,captured.expiresAt)
    w.options={browser:w.browserOwner,tab:w.tabOwner,invitation:o.roomInvitation(Uint8Array.from(captured.bearer as number[]),captured.inviter,true),
      account:c.account,link:c.link,keep:c.keep,credentialExpiresAt:c.credentialExpiresAt,current:()=>c,live:()=>true,generation:0,currentGeneration:()=>0,checkClients:async()=>{},stop:()=>{}}
    w.restoring=o.OrdinaryMemberExtensionStartup.open(w.options).then((value:any)=>{w.startup=value;w.restoreStatus='ok'},(error:Error)=>w.restoreStatus=error.name)
  },captured)
  // An explicit sentinel queued on the same native origin lock proves the
  // second context has begun waiting behind the retained first operation.
  await other.evaluate(()=>{
    const w=window as any;w.lockQueued=false;w.lockSentinel=navigator.locks.request(w.Ordinary.ORDINARY_DATABASE+':write',()=>{w.lockQueued=true})
  })
  expect(await other.evaluate('[restoreStatus,providerReads,discoveryCalls,lockQueued]')).toEqual(['pending',0,0,false])
  await page.evaluate('releaseDiscovery();undefined');await page.evaluate('restoring')
  await other.evaluate('restoring');await other.evaluate('lockSentinel')
  expect(await page.evaluate('[restoreStatus,discoveryCalls]')).toEqual(['ok',1])
  expect(await other.evaluate('[restoreStatus,discoveryCalls,lockQueued]')).toEqual(['ok',1,true])
  await page.evaluate('extensionStartup.close()');await other.evaluate('startup.close()');await other.close()
})
