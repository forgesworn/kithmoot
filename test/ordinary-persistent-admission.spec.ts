import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-member-proof.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const built = await build({ entryPoints: [fileURLToPath(new URL('./ordinary-persistent-admission.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })
  bundle = built.outputFiles[0]!.text
})
import { setup } from './ordinary-persistent-admission.setup.js'

test.beforeEach(async ({ context, page }) => {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN)
})
async function start(page: import('@playwright/test').Page, options = {}) { await page.evaluate(`(${setup})(${JSON.stringify(options)})`) }

test('actual evidence query binds signed events, device/seal/credential, both leases, fixed writer and reload', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const admission=await request(),[b,t]=await images(),proof=JSON.parse(b.records.get(proofName)),tabProof=JSON.parse(t.records.get(tabProofName))
    const counts=await preflight(),loaded=await member.load()
    const result=[Ordinary.bytesToHex(admission.secret)===Ordinary.bytesToHex(secret),admission.endsAt===now+3600,admission.destruct,
      admission.relays,proof.evidence.eventIds,[proof.binding.account,proof.binding.participant].every(x=>x===participant),
      proof.binding.device.pubkey===Ordinary.getPublicKey(deviceSk),proof.binding.device.credentialIds,[...proof.binding.device.seals],
      proof.binding.operation===tabProof.binding.operation,tabProof.privateProof,
      JSON.parse(b.records.get(Ordinary.FIXED_INVITATION_RELAYS))[roomId],counts.historicalFixedInvitationProofs,
      loaded!==admission&&loaded.secret!==admission.secret&&Ordinary.bytesToHex(loaded.secret)===Ordinary.bytesToHex(secret),
      Object.keys(localStorage),Object.keys(sessionStorage)]
    admission.secret.fill(0);loaded.secret.fill(0);return result
  })()`)).toEqual([true,true,true,['wss://signed.example/'],[await page.evaluate('event.id')],true,true,
    [await page.evaluate('credential.id')],[await page.evaluate('Ordinary.getPublicKey(seal)')],true,null,
    { c:['wss://signed.example/'],signed:true },1,true,[],[]])
  await page.evaluate(`(async()=>{await member.close();await devices.close();await Promise.all([browserOwner.close(),tabOwner.close()])})()`)
  await page.evaluate(`(async()=>{
    const migration={phase:'complete',sources:new Map(),names:[]}
    browserOwner=new Ordinary.OrdinaryStateOwner();tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);crypto.subtle.encrypt=async()=>{throw Error('fresh ciphertext')}
    await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration)
    member=await open();const loaded=await member.load();window.reloaded=Ordinary.bytesToHex(loaded.secret)===Ordinary.bytesToHex(secret)
    loaded.secret.fill(0);crypto.subtle.encrypt=encrypt
  })()`)
  expect(await page.evaluate('reloaded')).toBe(true)
})

test('opt-out retains full proof only in the tab and does not alter browser records or mark fixed relays signed', async ({ page }) => {
  await start(page,{keep:false})
  expect(await page.evaluate(`(async()=>{
    const before=(await images())[0],admission=await request(),[b,t]=await images(),proof=JSON.parse(t.records.get(tabProofName))
    const loaded=await member.load(),counts=await preflight()
    const result=[JSON.stringify([...before.records])===JSON.stringify([...b.records]),b.records.has(proofName),
      b.records.has(prefix+Ordinary.KEPT_ADMISSION_PREFIX+id),b.records.has(Ordinary.FIXED_INVITATION_RELAYS),
      proof.privateProof.kept.enabled,proof.privateProof.evidence.eventIds,!!loaded,counts.historicalFixedInvitationProofs??0]
    admission.secret.fill(0);loaded.secret.fill(0);return result
  })()`)).toEqual([true,false,false,false,false,[await page.evaluate('event.id')],true,0])
})

test('visitor-null binds to the actual local participant instead of accepting an accountless assertion', async ({ page }) => {
  await start(page,{visitor:true})
  expect(await page.evaluate(`(async()=>{await request();const [b]=await images(),proof=JSON.parse(b.records.get(proofName));await preflight()
    return [proof.binding.account,proof.binding.participant===participant]})()`)).toEqual([null,true])
})

test('a no-relay source remains admission evidence without promoting unsigned routing hints', async ({ page }) => {
  await start(page,{noRelays:true,noEnds:true})
  expect(await page.evaluate(`(async()=>{await request();const [b]=await images(),proof=JSON.parse(b.records.get(proofName));await preflight()
    return [proof.selection.relays,proof.selection.contributors.relays,b.records.has(Ordinary.FIXED_INVITATION_RELAYS),!!await member.load()]})()`)).toEqual([null,[],false,true])
})

for (const fault of ['retired','wrong-room','conflicting-room','relay-tie','no-eose','abort','cap'] as const) {
  test(`${fault} query preserves both encrypted images and releases no admission`, async ({ page }) => {
    await start(page)
    expect(await page.evaluate(`(async fault=>{
      const before=await rawBoth();let events=[event],eose=true,options={timeoutMs:5}
      if(fault==='retired')events.push(Ordinary.encodeInvitationRetirement({invitation,inviterSk,now:now+1}))
      if(fault==='wrong-room')events=[Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:new Uint8Array(32).fill(12),now})]
      if(fault==='conflicting-room')events.push(Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:new Uint8Array(32).fill(12),now:now+1}))
      if(fault==='relay-tie')events.push(Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:secret,now,relays:['wss://other.example/']}))
      if(fault==='no-eose')eose=false
      if(fault==='abort'){const abort=new AbortController();abort.abort();options.signal=abort.signal}
      if(fault==='cap')events=Array(65).fill(event)
      // Deliver duplicate candidates too: a relay simulator stores matching
      // copies, so the query work cap is exercised before EOSE.
      const result=await outcome(()=>member.request(replay(events,eose),now,options)),after=await rawBoth()
      return [result!=='ok',after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame)),await member.load()===undefined]
    })('${fault}')`)).toEqual([true,true,true])
  })
}

test('forget during a live query commits both deletion fences and blocks resurrection', async ({ page }) => {
  await start(page)
  await page.evaluate(`(()=>{window.queryStarted=false;window.queryOff=false;window.result='pending'
    const transport={publish:async()=>{},subscribe:(_f,onEvent,onEose)=>{window.deliver=()=>{onEvent(event);onEose()};queryStarted=true;return()=>queryOff=true},close:()=>{}}
    window.query=member.request(transport,now,{timeoutMs:5000}).then(()=>result='ok',e=>result=e.name)
  })()`)
  await page.waitForFunction('queryStarted')
  expect(await page.evaluate(`(async()=>{await member.forget();deliver();await query;const [b,t]=await images()
    return [result!=='ok',queryOff,b.fences.get('invitation:'+id),t.fences.get('invitation:'+id),b.records.has(proofName),t.records.has(tabProofName)]})()`)).toEqual([true,true,1,1,false,false])
})

for (const fault of ['device','credential','epoch','source','room-link','keep','account'] as const) {
  test(`${fault} changes after query capture hold instead of rebinding the old observation`, async ({ page }) => {
    await start(page)
    await page.evaluate(`(()=>{window.started=false;window.result='pending';window.query=member.request({publish:async()=>{},
      subscribe:(_f,onEvent,onEose)=>{window.deliver=()=>{onEvent(event);onEose()};started=true;return()=>{}},close:()=>{}},now,{timeoutMs:5000})
      .then(()=>result='ok',e=>result=e.name)})()`)
    await page.waitForFunction('started')
    expect(await page.evaluate(`(async fault=>{
      if(fault==='keep')current={...current,keep:!keep}
      else if(fault==='account')current={...current,account:'b'.repeat(64)}
      else await browserOwner.mutateMigrated(roomScope,guard,store=>{
        if(fault==='device'){const sk=Ordinary.generateSecretKey();store.set(prefix+Ordinary.DEVICE_PREFIX+roomId,JSON.stringify({sk:Ordinary.bytesToHex(sk),at:now}))}
        if(fault==='credential')store.remove(prefix+Ordinary.OWN_CREDENTIAL_PREFIX+roomId)
        if(fault==='epoch')store.set(prefix+'kithmoot.room-epoch.v1.'+roomId,'{}')
        if(fault==='source')store.set(Ordinary.FIXED_INVITATION_RELAYS,JSON.stringify({[roomId]:{c:['wss://changed.example/'],signed:false}}))
        if(fault==='room-link'){const metadata=JSON.parse(store.get(prefix+Ordinary.ROOM_PREFIX+roomId))
          metadata.link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation:Ordinary.roomInvitation(new Uint8Array(32).fill(21),invitation.inviter,true),relays:[],iceUrls:[]})
          store.set(prefix+Ordinary.ROOM_PREFIX+roomId,JSON.stringify(metadata))}
      })
      const before=await rawBoth();deliver();await query;const after=await rawBoth()
      return [result!=='ok',after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]
    })('${fault}')`)).toEqual([true,true])
  })
}

test('two live tabs retain distinct evidence slots without orphaning an unchanged kept admission', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await request();const other=new Ordinary.OrdinaryStateOwner('tab:'+'b'.repeat(64),tabExpiry)
    await other.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]})
    const second=await Ordinary.OrdinaryPersistentAdmission.open({browser:browserOwner,tab:other,invitation,account,participant,roomId,
      expectedRoomSecret:secret,keep,live:guard,current:()=>current})
    await second.request(replay(),now+1);const [b]=await images(),first=await member.load(),last=await second.load()
    const result=[b.records.has(proofName),b.records.has(prefix+Ordinary.PERSISTENT_PROOF_PREFIX+id+'.'+'b'.repeat(64)),!!first,!!last]
    await second.close();await other.close();first.secret.fill(0);last.secret.fill(0);return result
  })()`)).toEqual([true,true,true,true])
})

test('updated activity timestamps preserve the actual device binding', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{await request();await devices.deviceKey(now+1);return !!await member.load()})()`)).toBe(true)
})

test('actual credential renewal and epoch advance retain historical signed evidence through reopen', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await request();const oldProof=(await images())[0].records.get(proofName),nextSeal=Ordinary.generateSecretKey()
    const renewed=await Ordinary.createDeviceCredential({identity,devicePubkey:Ordinary.getPublicKey(deviceSk),roomId,
      expiresAt:now+10800,now:()=>now+1,seal:Ordinary.getPublicKey(nextSeal)})
    await devices.retainOwnCredential(renewed,nextSeal)
    await browserOwner.mutateMigrated(roomScope,guard,store=>Ordinary.storeKeptRoomEpoch({get:n=>store.get(prefix+n),
      set:(n,v)=>store.set(prefix+n,v),remove:n=>store.remove(prefix+n),keys:()=>[]},roomId,
      {epoch:{epoch:1,secret:new Uint8Array(32).fill(32)},past:[{epoch:0,secret,leftAt:now+2}],removed:[],members:[participant]},now+2))
    const loaded=await member.load();await preflight();await member.close();member=await open();const reopened=await member.load()
    return [!!loaded,!!reopened,(await images())[0].records.get(proofName)===oldProof]
  })()`)).toEqual([true,true,true])
})

test('epoch custody keys stay out of proofs and public device-source fingerprints, including after forget', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const epochSecret=new Uint8Array(32).fill(32),epoch=Ordinary.deriveEpoch({epoch:1,secret:epochSecret})
    await browserOwner.mutateMigrated(roomScope,guard,store=>Ordinary.storeKeptRoomEpoch({get:n=>store.get(prefix+n),
      set:(n,v)=>store.set(prefix+n,v),remove:n=>store.remove(prefix+n),keys:()=>[]},roomId,
      {epoch:{epoch:1,secret:epochSecret},past:[{epoch:0,secret,leftAt:now}],removed:[],members:[participant]},now))
    await request();const [b]=await images(),proof=b.records.get(proofName)
    const store={get:n=>b.records.get(n)??null,keys:()=>[...b.records.keys()]}
    const source=JSON.stringify(Ordinary.persistentAdmissionDevice(store,roomId,participant,account))
    const absent=!proof.includes(Ordinary.bytesToHex(epochSecret))&&!proof.includes(Ordinary.bytesToHex(epoch.key))&&
      !source.includes(Ordinary.bytesToHex(epochSecret))&&!source.includes(Ordinary.bytesToHex(epoch.key))
    await member.forget();const [after,t]=await images()
    return [absent,after.records.has(proofName),t.records.has(tabProofName)]
  })()`)).toEqual([true,false,false])
})

test('expired historical proof does not poison current custody after actual bounded seal and epoch history pruning', async ({ page }) => {
  test.setTimeout(60_000)
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await request();const [initial]=await images(),original=JSON.parse(initial.records.get(proofName))
    const expired=Ordinary.makePersistentAdmissionProof({invitation,evidence:original.evidence,account,participant,
      browser:original.binding.browser,tab:{...original.binding.tab,purpose:'tab:'+'c'.repeat(64),expiresAt:Date.now()-1},
      device:original.binding.device,keep:true,now:original.kept.at,expectedRoomSecret:secret})
    const expiredName=Ordinary.persistentProofName(expired.proof.binding),expiredBytes=JSON.stringify(expired.proof);expired.admission.secret.fill(0)
    const renewals=[]
    for(let i=0;i<129;i++){
      const seal=Ordinary.generateSecretKey(),credential=await Ordinary.createDeviceCredential({identity,
        devicePubkey:Ordinary.getPublicKey(deviceSk),roomId,expiresAt:now+10800,now:()=>now+i+1,seal:Ordinary.getPublicKey(seal)})
      renewals.push({seal,credential})
    }
    await browserOwner.mutateMigrated(roomScope,guard,store=>{
      const scoped={get:n=>store.get(prefix+n),set:(n,v)=>store.set(prefix+n,v),remove:n=>store.remove(prefix+n),keys:()=>[]}
      for(const value of renewals)Ordinary.storeOwnCredentialFor(scoped,roomId,value.credential,value.seal)
      const history=Array.from({length:16},(_,i)=>({epoch:19-i,secret:new Uint8Array(32).fill(50+i),leftAt:now+i}))
      Ordinary.storeKeptRoomEpoch(scoped,roomId,{epoch:{epoch:20,secret:new Uint8Array(32).fill(49)},past:history,removed:[],members:[participant]},now)
    })
    await member.close();member=await open()
    const held=await outcome(()=>member.load());await request()
    await browserOwner.mutateMigrated(roomScope,guard,store=>store.set(expiredName,expiredBytes))
    const counts=await preflight(),loaded=await member.load(),[b]=await images()
    return [held,!!loaded,counts.historicalFixedInvitationProofs,b.records.has(expiredName),
      !JSON.parse(b.records.get(proofName)).binding.device.epochs.some(epoch=>epoch.epoch===0)]
  })()`)).toEqual(['OrdinaryStateHold',true,1,true,true])
})

test('epoch-zero continuity holds a v1-only advance without retained zero-root history', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await request();const epoch=Ordinary.deriveEpoch({epoch:1,secret:new Uint8Array(32).fill(32)})
    await browserOwner.mutateMigrated(roomScope,guard,store=>store.set(prefix+'kithmoot.room-epoch.v1.'+roomId,
      JSON.stringify({epoch:epoch.epoch,id:epoch.id,key:Ordinary.bytesToHex(epoch.key)})))
    return [await outcome(()=>member.load()),await outcome(preflight)]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
})

test('a valid signed bookmark replacement during the query holds with both final frames unchanged', async ({ page }) => {
  await start(page)
  await page.evaluate(`(async()=>{
    window.firstBookmark=await Ordinary.bookmarkFixture('signed',{rootSeed:35})
    window.nextBookmark=await Ordinary.bookmarkFixture('record-pending',{rootSeed:35})
    await browserOwner.mutateMigrated(roomScope,guard,store=>{for(const [name,value] of firstBookmark.records)store.set(name,value)})
    window.started=false;window.receipt='pending'
    window.pending=member.request({publish:async()=>{},subscribe:(_filters,onEvent,onEose)=>{
      window.deliver=()=>{onEvent(event);onEose()};started=true;return()=>{}},close:()=>{}},now,{timeoutMs:5000})
      .then(()=>receipt='ok',e=>receipt=e.name)
  })()`)
  await page.waitForFunction('started')
  expect(await page.evaluate(`(async()=>{
    await browserOwner.mutateMigrated(roomScope,guard,store=>store.set(firstBookmark.name,nextBookmark.records.get(nextBookmark.name)))
    const before=await rawBoth(),encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let encryptions=0
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)}
    deliver();await pending;crypto.subtle.encrypt=encrypt;const after=await rawBoth()
    return [receipt,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]
  })()`)).toEqual(['OrdinaryStateHold',0,true])
})

test('a recomputed device hash cannot add a seal absent from its signed credential set', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await request();const [b]=await images(),proof=JSON.parse(b.records.get(proofName)),{recordsHash,...device}=proof.binding.device
    device.seals.push('f'.repeat(64));device.seals.sort()
    const hash=Ordinary.bytesToHex(Ordinary.sha256(new TextEncoder().encode(JSON.stringify(['kithmoot/persistent-admission-proof/v1/device',device]))))
    return outcome(()=>Ordinary.makePersistentAdmissionProof({invitation,evidence:proof.evidence,account,participant,
      browser:proof.binding.browser,tab:proof.binding.tab,device:{...device,recordsHash:hash},keep,now,expectedRoomSecret:secret}))
  })()`)).toBe('OrdinaryStateHold')
})

for (const name of ['tab-access','tab-navigation']) {
  test(`${name} malformed source holds before querying or writing`, async ({ page }) => {
    await start(page)
    expect(await page.evaluate(`(async kind=>{
      const scope=await tabOwner.capture('fixture',guard)
      await tabOwner.mutateMigrated(scope,guard,store=>store.set(kind==='tab-access'?Ordinary.TAB_ADMISSION_PREFIX+id:'kithmoot.way-back','{}'))
      const before=await rawBoth(),transport=replay(),subscribe=transport.subscribe.bind(transport);let queries=0
      transport.subscribe=(...args)=>{queries++;return subscribe(...args)}
      const result=await outcome(()=>member.request(transport,now)),after=await rawBoth()
      return [result,queries,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]
    })('${name}')`)).toEqual(['OrdinaryStateHold',0,true])
  })
}

test('a valid proof cannot be copied into a recreated browser generation', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await request();const [b]=await images();await member.close();await browserOwner.close()
    const opening=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
    await new Promise((resolve,reject)=>{opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('owners','readwrite')
      tx.objectStore('owners').delete('browser');tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)}})
    browserOwner=new Ordinary.OrdinaryStateOwner();await browserOwner.prepare(guard,b.records,{phase:'complete',sources:new Map(),names:[]})
    return [await outcome(preflight),await outcome(open)]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
})

for (const at of ['string','negative','future','extra'] as const) {
  test(`legacy ${at} kept metadata is held without rewriting its source`, async ({ page }) => {
    await start(page)
    expect(await page.evaluate(`(async fault=>{
      await browserOwner.mutateMigrated(roomScope,guard,store=>{const legacy={roomSecret:Ordinary.bytesToHex(secret),persistent:true,epoch:0,
        ends:now+3600,destruct:true,createdAt:fault==='string'?'old':fault==='negative'?-1:fault==='future'?now+5:now}
        if(fault==='extra')legacy.extra=true;store.set(Ordinary.KEPT_ADMISSION_PREFIX+id,JSON.stringify(legacy))})
      const before=await rawBoth(),result=await outcome(()=>member.request(replay(),now)),after=await rawBoth()
      return [result,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]
    })('${at}')`)).toEqual(['OrdinaryStateHold',true])
  })
}

test('opt-out holds an exact legacy signed fixed row instead of returning evidence that fails preflight', async ({ page }) => {
  await start(page,{keep:false})
  expect(await page.evaluate(`(async()=>{
    await browserOwner.mutateMigrated(roomScope,guard,store=>store.set(Ordinary.FIXED_INVITATION_RELAYS,
      JSON.stringify({[roomId]:{c:['wss://signed.example/'],signed:true}})))
    const before=await rawBoth(),result=await outcome(request),after=await rawBoth()
    return [result,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]
  })()`)).toEqual(['OrdinaryStateHold',true])
})

test('exact legacy encrypted custody is upgraded using the actual admission and fixed writers', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await browserOwner.mutateMigrated(roomScope,guard,store=>{
      Ordinary.storeKeptAdmission(store,id,{secret,persistent:true,epoch:0,endsAt:now+3600,destruct:true},now)
      store.set(Ordinary.FIXED_INVITATION_RELAYS,JSON.stringify({[roomId]:{c:['wss://signed.example/'],signed:true}}))})
    const tScope=await tabOwner.capture('invitation:'+id,guard)
    await tabOwner.mutateMigrated(tScope,guard,store=>Ordinary.storeTabAdmission(store,invitation,{secret,persistent:true,epoch:0,endsAt:now+3600,destruct:true}))
    await request();await preflight();const [b,t]=await images()
    return [b.records.has(Ordinary.KEPT_ADMISSION_PREFIX+id),t.records.has(Ordinary.TAB_ADMISSION_PREFIX+id),b.records.has(proofName),t.records.has(tabProofName)]
  })()`)).toEqual([false,false,true,true])
})

for (const operation of ['request','load'] as const) {
  test(`tab expiry in the final ${operation} handoff suppresses an already acknowledged result`, async ({ page }) => {
    await start(page)
    expect(await page.evaluate(`(async operation=>{
      if(operation==='load')await request()
      const key=operation==='load'?'readPairMigrated':'mutatePairMigrated',native=Ordinary.OrdinaryStateOwner[key],clock=Date.now
      Ordinary.OrdinaryStateOwner[key]=(...args)=>native.apply(Ordinary.OrdinaryStateOwner,args).then(value=>{Date.now=()=>tabExpiry;return value})
      const result=await outcome(()=>operation==='load'?member.load():request())
      Date.now=clock;Ordinary.OrdinaryStateOwner[key]=native
      return result
    })('${operation}')`)).toBe('OrdinaryStateHold')
  })
}

test('unknown paired acknowledgement holds the actual query result until exact native recovery', async ({ page }) => {
  await start(page)
  await page.evaluate(`(()=>{const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);window.encryptions=0;window.receipt='pending';let once=false
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)}
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw Error('unavailable')};tx.onabort(event)})}
      else descriptor.set.call(tx,callback)}})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen;crypto.subtle.encrypt=encrypt}
    window.pending=request().then(admission=>{receipt='ack';admission.secret.fill(0)},e=>receipt=e.name)
  })()`)
  await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
  expect(await page.evaluate('[receipt,encryptions]')).toEqual(['pending',2])
  await page.evaluate(`(async()=>{restore();window.intended=(await rawBoth()).map(row=>structuredClone(row.frame));member.retryRetention();await pending})()`)
  expect(await page.evaluate(`(async()=>[receipt,encryptions,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,intended[i])),!!await member.load()])()`)).toEqual(['ack',2,true,true])
})

for (const expired of [false,true]) {
  test(`${expired?'expired':'live'} historical tab slots obey the per-invitation bound without live eviction`, async ({ page }) => {
    test.setTimeout(60_000)
    await start(page)
    expect(await page.evaluate(`(async expired=>{
      await request();const [b]=await images(),original=JSON.parse(b.records.get(proofName))
      await browserOwner.mutateMigrated(roomScope,guard,store=>{
        for(let i=1;i<64;i++){
          const copy=Ordinary.makePersistentAdmissionProof({invitation,evidence:original.evidence,account,participant,
            browser:original.binding.browser,tab:{...original.binding.tab,purpose:'tab:'+i.toString(16).padStart(64,'0'),
              expiresAt:expired?Date.now()-1:tabExpiry},device:original.binding.device,keep:true,now:original.kept.at,expectedRoomSecret:secret})
          store.set(Ordinary.persistentProofName(copy.proof.binding),JSON.stringify(copy.proof));copy.admission.secret.fill(0)
        }
      })
      const other=new Ordinary.OrdinaryStateOwner('tab:'+'b'.repeat(64),tabExpiry)
      await other.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]})
      const second=await Ordinary.OrdinaryPersistentAdmission.open({browser:browserOwner,tab:other,invitation,account,participant,roomId,
        expectedRoomSecret:secret,keep,live:guard,current:()=>current})
      const before=await rawBoth(),native=crypto.subtle.encrypt.bind(crypto.subtle);let encryptions=0
      crypto.subtle.encrypt=async(...args)=>{encryptions++;return native(...args)}
      const result=await outcome(()=>second.request(replay(),now));crypto.subtle.encrypt=native
      const [after]=await images(),names=[...after.records.keys()].filter(n=>n.startsWith(prefix+Ordinary.PERSISTENT_PROOF_PREFIX+id+'.'))
      await second.close();await other.close()
      return [result,encryptions,names.length,expired?true:Ordinary.sameOrdinaryFrame((await rawBoth())[0].frame,before[0].frame)]
    })(${expired})`)).toEqual(expired?['ok',2,2,true]:['OrdinaryStateHold',0,64,true])
  })
}

test('a fabricated extra proof beyond the reload bound holds both adapter and whole-image preflight', async ({ page }) => {
  test.setTimeout(60_000)
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await request();const [b]=await images(),original=JSON.parse(b.records.get(proofName))
    await browserOwner.mutateMigrated(roomScope,guard,store=>{
      for(let i=1;i<65;i++){
        const copy=Ordinary.makePersistentAdmissionProof({invitation,evidence:original.evidence,account,participant,
          browser:original.binding.browser,tab:{...original.binding.tab,purpose:'tab:'+i.toString(16).padStart(64,'0')},
          device:original.binding.device,keep:true,now:original.kept.at,expectedRoomSecret:secret})
        store.set(Ordinary.persistentProofName(copy.proof.binding),JSON.stringify(copy.proof));copy.admission.secret.fill(0)
      }
    })
    return [await outcome(()=>member.load()),await outcome(preflight)]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
})

for (const fault of ['operation','events','device','tab-lease','relays','bare-flag','raw-proof'] as const) {
  test(`${fault} substitution fails complete same-image custody validation`, async ({ page }) => {
    await start(page)
    expect(await page.evaluate(`(async fault=>{
      await request();const [b,t]=await images(),proof=JSON.parse(b.records.get(proofName))
      if(fault==='operation')proof.binding.operation='f'.repeat(64)
      if(fault==='events')proof.evidence.events=[]
      if(fault==='device')proof.binding.device.pubkey='f'.repeat(64)
      if(fault==='tab-lease')proof.binding.tab.expiresAt++
      if(fault==='relays'){const fixed=JSON.parse(b.records.get(Ordinary.FIXED_INVITATION_RELAYS));fixed[roomId].c=['wss://other.example/'];b.records.set(Ordinary.FIXED_INVITATION_RELAYS,JSON.stringify(fixed))}
      if(fault==='bare-flag'){b.records.delete(proofName);t.records.delete(tabProofName)}
      if(!['relays','bare-flag','raw-proof'].includes(fault))b.records.set(proofName,JSON.stringify(proof))
      const context=Ordinary.captureOrdinarySnapshotContext(b.records,t.records)
      return outcome(()=>Ordinary.validateOrdinarySnapshot(b.records,t.records,{browser:fault!=='raw-proof',tab:true},context))
    })('${fault}')`)).toBe('OrdinaryStateHold')
  })
}

test('a second-image capacity failure allocates no nonce and preserves both prior frames', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const scope=await tabOwner.capture('fixture',guard)
    await tabOwner.mutateMigrated(scope,guard,store=>{
      for(let i=0;i<3;i++)store.set('filler'+i,'x'.repeat(Ordinary.ORDINARY_VALUE_BYTES-1))
      store.set('filler3','x'.repeat(Ordinary.ORDINARY_VALUE_BYTES-2000))
    })
    const before=await rawBoth(),native=crypto.subtle.encrypt.bind(crypto.subtle);let encryptions=0
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return native(...args)}
    const result=await outcome(request);crypto.subtle.encrypt=native;const after=await rawBoth()
    return [result,encryptions,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]
  })()`)).toEqual(['OrdinaryStateHold',0,true])
})

test('caller options are captured before a queued read and abort still closes the actual subscription', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{const controller=new AbortController(),options={timeoutMs:30,signal:controller.signal};let off=false
    const pending=member.request({publish:async()=>{},subscribe:()=>()=>off=true,close:()=>{}},now,options)
    options.timeoutMs=5000;options.signal=new AbortController().signal;controller.abort();const result=await outcome(()=>pending)
    return [result!=='ok',off,await member.load()===undefined]})()`)).toEqual([true,false,true])
})
