import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { setup, actorFixture } from './ordinary-bootstrap.setup.js'

const ORIGIN = 'https://ordinary-first-member.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts', import.meta.url))], bundle: true,
    format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
async function serve(context: import('@playwright/test').BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html', body:
    `<!doctype html><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
}
test.beforeEach(async ({ context, page }) => { await serve(context); await page.goto(ORIGIN) })
async function start(page: import('@playwright/test').Page, options = {}) { await page.evaluate(`(${setup})(${JSON.stringify(options)})`) }

for (const keep of [true,false]) test(`first member retains actual device/seal/credential and query evidence together, keep=${keep}`, async ({ page }) => {
  await start(page, { keep, visitor: true })
  expect(await page.evaluate(`(async()=>{
    countCrypto();const result=await start(),[b,t]=await images(),counts=await preflight(),loaded=await bootstrap.load()
    const device=keep?b:t,proof=JSON.parse(keep?b.records.get(proofName):t.records.get(tabProofName)).privateProof??JSON.parse(b.records.get(proofName)??'null')
    const output=[signCalls,encryptions,Ordinary.bytesToHex(result.admission.secret)===Ordinary.bytesToHex(secret),
      result.credential.pubkey===participant,result.credential.tags.find(t=>t[0]==='device')[1]===Ordinary.getPublicKey(result.deviceKey),
      result.credential.tags.find(t=>t[0]==='seal')[1]===Ordinary.getPublicKey(result.sealKey),
      device.records.has(prefix+Ordinary.DEVICE_PREFIX+roomId),proof.version,proof.binding.deviceCustody.owner,proof.evidence.eventIds,
      counts.identities,!!loaded,loaded.deviceKey!==result.deviceKey&&loaded.sealKey!==result.sealKey&&loaded.admission.secret!==result.admission.secret,
      b.records.has(prefix+Ordinary.DEVICE_PREFIX+roomId),b.records.has(proofName),b.records.has(prefix+Ordinary.KEPT_ADMISSION_PREFIX+id),
      b.records.has(Ordinary.FIXED_INVITATION_RELAYS),Object.keys(localStorage),Object.keys(sessionStorage)]
    Ordinary.wipeOrdinaryPersistentBootstrapResult(result);Ordinary.wipeOrdinaryPersistentBootstrapResult(loaded);restoreCrypto();return output
  })()`)).toEqual([1,2,true,true,true,true,true,2,keep?'browser':'tab',[await page.evaluate('event.id')],1,true,true,keep,keep,keep,keep,[],[]])
})

for(const keep of [true,false])test(`exact owner reopen loads retained keys without signing, entropy or ciphertext, keep=${keep}`,async({page})=>{
  await start(page,{keep})
  expect(await page.evaluate(`(async()=>{
    const result=await start(),device=Ordinary.bytesToHex(result.deviceKey),seal=Ordinary.bytesToHex(result.sealKey)
    Ordinary.wipeOrdinaryPersistentBootstrapResult(result);const before=await rawBoth();await bootstrap.close()
    await Promise.all([browserOwner.close(),tabOwner.close()]);browserOwner=new Ordinary.OrdinaryStateOwner();tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
    countCrypto();const migration={phase:'complete',sources:new Map(),names:[]};await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration)
    bootstrap=await open();const loaded=await bootstrap.load(),after=await rawBoth()
    const answer=[signCalls,entropy,encryptions,Ordinary.bytesToHex(loaded.deviceKey)===device,Ordinary.bytesToHex(loaded.sealKey)===seal,
      after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]
    Ordinary.wipeOrdinaryPersistentBootstrapResult(loaded);restoreCrypto();return answer
  })()`)).toEqual([1,0,0,true,true,true])
})

for(const owner of ['browser','tab'])test(`actual full-composer ${owner} record capacity refuses before device/seal entropy or signer`,async({page})=>{
  test.setTimeout(90_000);await start(page,{keep:owner==='browser'})
  expect(await page.evaluate(`(async()=>{
    await bootstrap.close();const s=await scopes(),owner=${JSON.stringify(owner)}==='browser'?browserOwner:tabOwner
    await owner.mutateMigrated(${JSON.stringify(owner)}==='browser'?s.b:s.t,guard,store=>{
      for(let i=0;i<Ordinary.ORDINARY_RECORDS-2;i++){
        const room=i.toString(16).padStart(64,'0')
        const name=${JSON.stringify(owner)}==='browser'?'kithmoot.nudge.'+room:'kithmoot.conversation.v1.visitor.'+room
        store.set(name,${JSON.stringify(owner)}==='browser'?'true':'')
      }
    });bootstrap=await open();const before=await rawBoth();countCrypto();const result=await outcome(start),after=await rawBoth()
    const out=[result,entropy,encryptions,signCalls,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true])
})

for(const fault of ['account','keep','link','credential-choice','identity-method','identity-reference','source','same-byte-revision','room-fence','invitation-fence','tab-fence','tab-lease','end-time'] as const){
  test(`changes during signer ${fault} refuse the candidate without retention`,async({page})=>{
    await start(page);await page.evaluate(`(()=>{gateSigner();countCrypto();window.before=undefined;window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);return 'ok'},e=>e.name)})()`)
    await page.waitForFunction('signing')
    expect(await page.evaluate(`(async()=>{
      const fault=${JSON.stringify(fault)}
      if(fault==='account')current={...current,account:null}
      if(fault==='keep')current={...current,keep:false}
      if(fault==='link')current={...current,link:url+'wrong'}
      if(fault==='credential-choice')current={...current,credentialExpiresAt:credentialExpiresAt+1}
      if(fault==='identity-method')identity.signEvent=()=>Promise.reject(Error('replacement'))
      if(fault==='identity-reference')current={...current,identity:Ordinary.localIdentity(participantSk)}
      if(fault==='source')await pair(b=>b.set('kithmoot.name','Changed'))
      if(fault==='same-byte-revision')await pair(()=>{})
      if(fault==='room-fence'){const scope=await browserOwner.capture('room:'+roomId,guard);await browserOwner.forget(scope,guard,()=>false)}
      if(fault==='invitation-fence'){const s=await scopes();await browserOwner.forget(s.b,guard,()=>false)}
      if(fault==='tab-fence'){const s=await scopes();await tabOwner.forget(s.t,guard,()=>false)}
      if(fault==='tab-lease'||fault==='end-time'){
        const nativeNow=Date.now;window.restoreTime=()=>{Date.now=nativeNow}
        Date.now=()=>${JSON.stringify(fault)}==='tab-lease'?tabExpiry+1:(now+3601)*1000
      }
      const previous=await rawBoth(),priorEncryptions=encryptions;releaseSigner();const result=await pending
      if(window.restoreTime)restoreTime();const after=await rawBoth(),output=[result,signCalls,encryptions===priorEncryptions,
        after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,previous[i].frame))]
      restoreCrypto();return output
    })()`)).toEqual(['OrdinaryStateHold',1,true,true])
  })
}

for(const fault of ['throw','signature','account','device','seal','expiration','restamp','extra-field','missing-field'] as const)test(`malformed signer ${fault} cannot enter custody`,async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    signHook=event=>{
      const fault=${JSON.stringify(fault)};if(fault==='throw')throw Error('provider refused')
      const changed=structuredClone(event)
      if(fault==='device')changed.tags=changed.tags.map(t=>t[0]==='device'?['device',Ordinary.getPublicKey(inviterSk)]:t)
      if(fault==='seal')changed.tags=changed.tags.map(t=>t[0]==='seal'?['seal',Ordinary.getPublicKey(inviterSk)]:t)
      if(fault==='expiration')changed.tags=changed.tags.map(t=>t[0]==='expiration'?['expiration',String(credentialExpiresAt+1)]:t)
      if(fault==='restamp')changed.created_at--
      const signed=Ordinary.finalizeEvent(changed,fault==='account'?inviterSk:participantSk)
      if(fault==='signature')signed.sig='0'.repeat(128)
      if(fault==='extra-field')signed.extra=true
      if(fault==='missing-field')delete signed.id
      return Promise.resolve(signed)
    }
    const before=await rawBoth();countCrypto();const result=await outcome(start),after=await rawBoth();restoreCrypto()
    return [result!=='ok',signCalls,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]
  })()`)).toEqual([true,1,0,true])
})

test('signer reentry cannot start a second invocation or close past an unresolved provider',async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{window.reentry='pending';window.closedReceipt=false;window.answer='pending';gateSigner()
    const hook=signHook;signHook=event=>{try{bootstrap.bootstrap(evidence);reentry='allowed'}catch(e){reentry=e.name}
      const pending=hook(event);void bootstrap.close().then(()=>closedReceipt=true);return pending}
    window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);answer='ok'},e=>answer=e.name)
  })()`)
  await page.waitForFunction('signing')
  expect(await page.evaluate('[reentry,closedReceipt,answer,signCalls]')).toEqual(['OrdinaryStateHold',false,'pending',1])
  await page.evaluate('releaseSigner()');await page.evaluate('pending');await page.waitForFunction('closedReceipt')
  expect(await page.evaluate(`(async()=>[answer,signCalls,(await images()).every(image=>image.records.size===0)])()`)).toEqual(['OrdinaryStateHold',1,true])
})

for(const keep of [true,false])test(`forget during pending signer fences both owners and forbids late retention, keep=${keep}`,async({page})=>{
  await start(page,{keep})
  await page.evaluate(`(()=>{gateSigner();window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);return 'ok'},e=>e.name)})()`)
  await page.waitForFunction('signing')
  expect(await page.evaluate(`(async()=>{
    await bootstrap.forget();const [b,t]=await images();releaseSigner();const result=await pending
    return [result,signCalls,b.fences.get(invScopeName),t.fences.get(invScopeName),b.records.size,t.records.size]
  })()`)).toEqual(['OrdinaryStateHold',1,1,1,0,0])
})

for(const keep of [true,false])test(`committed member forget removes device/proof/admission atomically, keep=${keep}`,async({page})=>{
  await start(page,{keep,visitor:true})
  expect(await page.evaluate(`(async()=>{
    const result=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(result)
    await bootstrap.forget();const counts=await preflight(),[b,t]=await images()
    return [b.fences.get(invScopeName),t.fences.get(invScopeName),counts.identities,b.records.has('kithmoot.participant'),
      [...b.records.keys()].filter(n=>n.startsWith(prefix)),t.records.size]
  })()`)).toEqual([1,1,0,true,[],0])
})

test('unknown paired acknowledgement holds same actual credential and frames until explicit retry',async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    let once=false;window.receipt='pending';countCrypto()
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw Error('unavailable')};tx.onabort(event)})}
      else descriptor.set.call(tx,callback)}})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen}
    window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);receipt='ack'},e=>receipt=e.name)
  })()`)
  await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
  expect(await page.evaluate('[receipt,signCalls,encryptions]')).toEqual(['pending',1,2])
  await page.evaluate(`(async()=>{restore();window.intended=(await rawBoth()).map(row=>structuredClone(row.frame));bootstrap.retryRetention();await pending})()`)
  expect(await page.evaluate(`(async()=>{const loaded=await bootstrap.load(),rows=await rawBoth();const result=[receipt,signCalls,encryptions,
    rows.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,intended[i])),!!loaded];Ordinary.wipeOrdinaryPersistentBootstrapResult(loaded);restoreCrypto();return result})()`)).toEqual(['ack',1,2,true,true])
})

for(const keep of [true,false])test(`two actual tabs may sign but one fresh browser claim commits, keep=${keep}`,async({context,page})=>{
  await start(page,{keep});await page.evaluate(`(()=>{gateSigner();countCrypto();window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);return 'ok'},e=>e.name)})()`)
  await page.waitForFunction('signing')
  const second=await context.newPage();await second.goto(ORIGIN)
  await start(second,{keep,participantSk:await page.evaluate('Array.from(participantSk)'),tabPurpose:'tab:'+'b'.repeat(64)})
  await second.evaluate(`(()=>{gateSigner();countCrypto();window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);return 'ok'},e=>e.name)})()`)
  await second.waitForFunction('signing')
  await page.evaluate('releaseSigner()');expect(await page.evaluate('pending')).toBe('ok')
  const accepted=await page.evaluate(`(async()=>{const loaded=await bootstrap.load();const device=Ordinary.getPublicKey(loaded.deviceKey);Ordinary.wipeOrdinaryPersistentBootstrapResult(loaded);return device})()`)
  await second.evaluate('releaseSigner()')
  expect(await second.evaluate('pending')).toBe('OrdinaryStateHold')
  expect(await second.evaluate(`(async()=>{const [b,t]=await images();return [signCalls,encryptions,t.records.size,
    b.records.has(prefix+Ordinary.DEVICE_PREFIX+roomId)?Ordinary.getPublicKey(Ordinary.hexToBytes(JSON.parse(b.records.get(prefix+Ordinary.DEVICE_PREFIX+roomId)).sk)):null]})()`)).toEqual([1,0,0,keep?accepted:null])
  expect(await page.evaluate('[signCalls,encryptions]')).toEqual([1,2])
})

test('opt-out rejoin permits its inert exact remembered link and keeps other tab room keys byte-exact',async({page})=>{
  await start(page,{keep:false})
  expect(await page.evaluate(`(async()=>{
    const result=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(result)
    const before=await records(),oldRoom=roomId,oldId=id,oldProof=tabProofName
    // Make unrelated room activity ancient; first-use pruning must never see it.
    await pair((_b,t)=>{const name=prefix+Ordinary.DEVICE_PREFIX+oldRoom,key=JSON.parse(t.get(name));key.at=0;t.set(name,JSON.stringify(key))})
    const retained=(await images())[1].records,oldRows=[...retained].filter(([n])=>n.endsWith('.'+oldRoom)||n.endsWith('.'+oldId))
    await bootstrap.close();secret=new Uint8Array(32).fill(32);roomId=Ordinary.deriveRoom(secret).roomId
    invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(18),Ordinary.getPublicKey(inviterSk),true);id=Ordinary.deriveInvitationId(invitation)
    url=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[]});current={...current,invitationId:id,link:url}
    event=Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:secret,now,endsAt:now+3600,destruct:true,relays:['wss://signed.example/']})
    const relay=new Ordinary.SimRelay({replay:true});relay.publish(event);const query=await Ordinary.requestPersistentRoomAdmissionEvidence({transport:new Ordinary.SimTransport(relay),invitation})
    evidence=query.evidence;query.outcome.admission.secret.fill(0);bootstrap=await open()
    const second=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(second);const after=(await images())[1].records
    await preflight();return [signCalls,oldRows.every(([n,raw])=>after.get(n)===raw),after.has(oldProof),after.has(prefix+Ordinary.DEVICE_PREFIX+roomId)]
  })()`)).toEqual([2,true,true,true])
})

test('a fresh empty opt-out tab can bootstrap again from the exact saved link after the previous tab is gone',async({page})=>{
  await start(page,{keep:false,visitor:true})
  expect(await page.evaluate(`(async()=>{
    const first=await start(),firstDevice=Ordinary.getPublicKey(first.deviceKey);Ordinary.wipeOrdinaryPersistentBootstrapResult(first)
    await bootstrap.close();await tabOwner.close();tabPurpose='tab:'+'b'.repeat(64);tabExpiry=Date.now()+3600_000
    tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);await tabOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]})
    bootstrap=await open();const second=await start(),newDevice=Ordinary.getPublicKey(second.deviceKey);Ordinary.wipeOrdinaryPersistentBootstrapResult(second)
    await preflight();const [b,t]=await images();return [signCalls,firstDevice!==newDevice,
      [...b.records.keys()].filter(n=>Ordinary.classifyOrdinaryPhysicalName(n,'browser')?.family==='identity'),!b.records.has(Ordinary.FIXED_INVITATION_RELAYS),t.records.size]
  })()`)).toEqual([2,true,['kithmoot.participant'],true,6])
})

for(const changed of ['unknown-account','prepared-device','bookmark','fixed','epoch','ended-link','other-account-metadata'] as const)test(`fresh admission conflict ${changed} holds before entropy`,async({page})=>{
  await start(page,{keep:false})
  expect(await page.evaluate(`(async()=>{
    const fault=${JSON.stringify(changed)}
    await pair((b,t)=>{
      const scoped={get:n=>b.get(prefix+n),set:(n,v)=>b.set(prefix+n,v),remove:n=>b.remove(prefix+n),keys:()=>b.keys().filter(n=>n.startsWith(prefix)).map(n=>n.slice(prefix.length))}
      if(fault==='unknown-account')b.set('kithmoot.participant','0'.repeat(64))
      if(fault==='prepared-device'){b.set(prefix+Ordinary.DEVICE_PREFIX+roomId,JSON.stringify({sk:Ordinary.bytesToHex(inviterSk),at:now}));b.set(prefix+'kithmoot.device-owner.'+roomId,JSON.stringify({account:participant,roomId}))}
      if(fault==='bookmark'){const key='kithmoot.bookmarks.'+participant+'.'+roomId
        b.set(key,JSON.stringify({pending:{value:{roomId,at:now*1000,room:{roomId,link:url,openedAt:now,readAt:0,keep:false}},d:'kithmoot.rooms.v1.12345678-1234-4234-8234-123456789abc'}}))}
      if(fault==='fixed')b.set(Ordinary.FIXED_INVITATION_RELAYS,JSON.stringify({[roomId]:{c:['wss://signed.example/'],signed:false}}))
      if(fault==='epoch')b.set(prefix+'kithmoot.room-epoch.v1.'+roomId,'{}')
      if(fault==='ended-link'){Ordinary.rememberRoom(scoped,{roomId,link:url,openedAt:now});Ordinary.setKeepRoom(scoped,roomId,false)
        const name=prefix+Ordinary.ROOM_PREFIX+roomId;b.set(name,JSON.stringify({...JSON.parse(b.get(name)),endedAt:now}))}
      if(fault==='other-account-metadata')b.set('kithmoot.account.'+'b'.repeat(64)+'.'+Ordinary.ROOM_PREFIX+roomId,JSON.stringify({link:url,openedAt:now,readAt:0,keep:false}))
    })
    const before=await rawBoth();countCrypto();const result=await outcome(start),after=await rawBoth();restoreCrypto()
    return [result!=='ok',signCalls,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]
  })()`)).toEqual([true,0,0,0,true])
})

test('closed bootstrap wipes its provisional root/device/seal buffers before a late signer result can escape',async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{
    const NativeBytes=Uint8Array;window.allocated=[];window.rootWipes=[];const nativeFill=NativeBytes.prototype.fill
    NativeBytes.prototype.fill=function(value,...args){if(value===0&&this.length===32&&window.signing&&Ordinary.bytesToHex(this)===Ordinary.bytesToHex(secret))rootWipes.push(this);return nativeFill.call(this,value,...args)}
    window.restoreFill=()=>{NativeBytes.prototype.fill=nativeFill};window.restoreBytes=()=>{window.Uint8Array=NativeBytes}
    const capture=b=>{if(b.length===32)allocated.push(b);return b}
    window.Uint8Array=new Proxy(NativeBytes,{construct(target,args){return capture(Reflect.construct(target,args,target))},
      get(target,name,receiver){if(name==='fromHex'&&typeof target.fromHex==='function')return(...args)=>capture(Reflect.apply(target.fromHex,target,args));return Reflect.get(target,name,receiver)}})
    gateSigner();window.closedReceipt=false;window.answer='pending';window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);answer='ok'},e=>answer=e.name)
  })()`)
  await page.waitForFunction('signing')
  expect(await page.evaluate(`(()=>{
    const device=unsigned.tags.find(t=>t[0]==='device')[1],seal=unsigned.tags.find(t=>t[0]==='seal')[1]
    window.provisionalDevice=allocated.filter(b=>{try{return Ordinary.getPublicKey(b)===device}catch{return false}})
    window.provisionalSeal=allocated.filter(b=>{try{return Ordinary.getPublicKey(b)===seal}catch{return false}})
    window.provisionalRoot=rootWipes
    restoreBytes();void bootstrap.close().then(()=>closedReceipt=true)
    return [provisionalDevice.length>0,provisionalSeal.length>0]
  })()`)).toEqual([true,true])
  expect(await page.evaluate('[closedReceipt,answer]')).toEqual([false,'pending'])
  await page.evaluate('releaseSigner()');await page.evaluate('pending');await page.waitForFunction('closedReceipt')
  expect(await page.evaluate(`[answer,...[provisionalDevice,provisionalSeal,provisionalRoot].map(list=>list.length>0&&list.every(b=>b.every(v=>v===0)))]`)).toEqual(['OrdinaryStateHold',true,true,true])
  await page.evaluate('restoreFill()')
})

test('instance opened on absence cannot load or forget a proof another instance commits',async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const stale=bootstrap;bootstrap=await open();const result=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(result)
    const before=await rawBoth(),loaded=await outcome(()=>stale.load()),forgotten=await outcome(()=>stale.forget()),after=await rawBoth()
    return [loaded,forgotten,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),!!await bootstrap.load()]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',true,true])
})

test('existing instance pins its selected operation and cannot load or forget a canonical successor',async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const result=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(result)
    await pair((b,t)=>{
      const prior=JSON.parse(b.get(proofName)),admission={secret,epoch:0,endsAt:now+3600,destruct:true,relays:['wss://signed.example/']}
      const verified=Ordinary.makePersistentAdmissionProof({invitation,evidence,account,participant,browser:prior.binding.browser,tab:prior.binding.tab,
        deviceCustody:prior.binding.deviceCustody,device:prior.binding.device,keep:true,now:now+1,expectedRoomSecret:secret})
      b.set(proofName,JSON.stringify(verified.proof));t.set(tabProofName,Ordinary.tabProofBytes(verified.proof))
      const scoped={get:n=>b.get(prefix+n),set:(n,v)=>b.set(prefix+n,v),remove:n=>b.remove(prefix+n),keys:()=>[]}
      Ordinary.storeKeptAdmission(scoped,id,admission,now+1);verified.admission.secret.fill(0)
    })
    const before=await rawBoth(),loaded=await outcome(()=>bootstrap.load()),forgotten=await outcome(()=>bootstrap.forget()),after=await rawBoth()
    const fresh=await open(),latest=await fresh.load();Ordinary.wipeOrdinaryPersistentBootstrapResult(latest)
    return [loaded,forgotten,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),!!latest]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',true,true])
})

test('a definitely aborted first-use candidate owns no destructive forget authority over its saved opt-out link',async({page})=>{
  await start(page,{keep:false})
  expect(await page.evaluate(`(async()=>{
    await bootstrap.close();await pair(b=>b.set(prefix+Ordinary.ROOM_PREFIX+roomId,JSON.stringify({link:url,openedAt:now-100,readAt:0,keep:false})))
    bootstrap=await open();const before=await records(),put=IDBObjectStore.prototype.put;let once=false
    IDBObjectStore.prototype.put=function(...args){if(!once){once=true;throw new DOMException('fixture abort','QuotaExceededError')}return put.apply(this,args)}
    let result;try{result=await outcome(start)}finally{IDBObjectStore.prototype.put=put}
    await bootstrap.forget();const after=await records(),[b,t]=await images();await preflight()
    return [result!=='ok',JSON.stringify(before)===JSON.stringify(after),b.fences.get(invScopeName),t.fences.get(invScopeName),signCalls]
  })()`)).toEqual([true,true,1,1,1])
})

test('same-cap other actor custody and shared signed list remain valid after this member forgets',async({page})=>{
  await start(page)
  await page.evaluate(`window.retainActor=(${actorFixture})`)
  expect(await page.evaluate(`(async()=>{
    const result=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(result)
    const actorSk=new Uint8Array(32);actorSk[31]=27;const other=await retainActor(Array.from(actorSk))
    await preflight();const before=await records(),otherRows=before.map(rows=>rows.filter(([name])=>name.startsWith(other.prefix)))
    await bootstrap.forget();const [b,t]=await images(),counts=await preflight(),after=await records()
    return [otherRows.every((rows,i)=>rows.every(([name,raw])=>after[i].some(([n,v])=>n===name&&v===raw))),counts.identities,
      b.fences.get(invScopeName),t.fences.get(invScopeName),b.fences.get(other.scopeName)??0,t.fences.get(other.scopeName)??0,
      JSON.parse(b.records.get(Ordinary.FIXED_INVITATION_RELAYS))[roomId],b.records.has(prefix+Ordinary.DEVICE_PREFIX+roomId)]
  })()`)).toEqual([true,1,1,1,0,0,{c:['wss://signed.example/'],signed:true},false])
})

test('failed freshness grants only empty actor-fence forget and preserves pre-existing same-room device and metadata',async({page})=>{
  await start(page,{keep:false});await page.evaluate(`window.retainActor=(${actorFixture})`)
  expect(await page.evaluate(`(async()=>{
    const actorSk=new Uint8Array(32);actorSk[31]=27;await retainActor(Array.from(actorSk),Array(32).fill(18))
    const device=Ordinary.generateSecretKey(),seal=Ordinary.generateSecretKey(),credential=await Ordinary.createDeviceCredential({identity,
      devicePubkey:Ordinary.getPublicKey(device),roomId,expiresAt:credentialExpiresAt,now:()=>now,seal:Ordinary.getPublicKey(seal)})
    await pair(b=>{
      const scoped={get:n=>b.get(prefix+n),set:(n,v)=>b.set(prefix+n,v),remove:n=>b.remove(prefix+n),keys:()=>[]}
      b.set(prefix+Ordinary.DEVICE_PREFIX+roomId,JSON.stringify({sk:Ordinary.bytesToHex(device),at:now}))
      b.set(prefix+'kithmoot.device-owner.'+roomId,JSON.stringify({account:participant,roomId}))
      Ordinary.storeOwnCredentialFor(scoped,roomId,credential,seal)
      Ordinary.rememberRoom(scoped,{roomId,link:url,openedAt:now});Ordinary.setKeepRoom(scoped,roomId,false)
    });await preflight();await bootstrap.close();bootstrap=await open()
    const before=await records(),beforeSigns=signCalls;countCrypto();const result=await outcome(start);const entropyAtRefusal=entropy
    await bootstrap.forget();const after=await records();await preflight();restoreCrypto()
    return [result,entropyAtRefusal,signCalls-beforeSigns,JSON.stringify(before)===JSON.stringify(after)]
  })()`)).toEqual(['OrdinaryStateHold',0,0,true])
})

for(const target of ['current-close','current-forget','live-close','identity-close'] as const)test(`fresh signer guard refuses callback reentry ${target}`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{
    window.reentered=false;window.forgetResult=undefined;window.closedReceipt=false;countCrypto()
    const originalCurrent=current,originalSign=identity.signEvent
    const trigger=()=>{if(reentered||entropy<2||!new Error().stack.includes('#lifetime'))return
      reentered=true;if(${JSON.stringify(target)}==='current-forget')window.forgetResult=bootstrap.forget();else void bootstrap.close().then(()=>closedReceipt=true)}
    if(${JSON.stringify(target)}.startsWith('current'))Object.defineProperty(window,'current',{configurable:true,get(){trigger();return originalCurrent}})
    if(${JSON.stringify(target)}==='live-close')Object.defineProperty(window,'live',{configurable:true,get(){trigger();return true}})
    if(${JSON.stringify(target)}==='identity-close')Object.defineProperty(identity,'pubkey',{configurable:true,get(){trigger();return participant}})
    window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);return 'ok'},e=>e.name)
  })()`)
  expect(await page.evaluate('pending')).toBe('OrdinaryStateHold')
  if(target==='current-forget')await page.evaluate('forgetResult');else await page.waitForFunction('closedReceipt')
  expect(await page.evaluate('[reentered,signCalls,encryptions]')).toEqual([true,0,target==='current-forget'?2:0])
})

test('a signer can revoke synchronously and return; external close then joins without a wait cycle',async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    signHook=event=>{bootstrap.revoke();return signer.call(identity,event)}
    const result=await outcome(start);await bootstrap.close();return [result,signCalls,(await images()).every(image=>image.records.size===0)]
  })()`)).toEqual(['OrdinaryStateHold',1,true])
})

test('projection requires a live exact native pair, native Maps and data fields, without callbacks or entropy',async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const s=await scopes();countCrypto();let calls=0,results=[]
    await Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,
      work:(b,t,_bn,_tn,custody)=>{
        const bm=new Map(b.keys().map(n=>[n,b.get(n)])),tm=new Map(t.keys().map(n=>[n,t.get(n)])),proposed={browser:new Map(bm),tab:new Map(tm)}
        results.push(Object.isFrozen(Ordinary.ordinaryPairProjectedByteLengths(custody,bm,tm,proposed)))
        const fail=work=>{try{work();return false}catch(e){return e.name==='OrdinaryStateHold'}}
        results.push(fail(()=>Ordinary.ordinaryPairProjectedByteLengths({},bm,tm,proposed)))
        const alias=new Map(bm);alias.set('kithmoot.name','fake');results.push(fail(()=>Ordinary.ordinaryPairProjectedByteLengths(custody,alias,tm,proposed)))
        const getter={tab:tm};Object.defineProperty(getter,'browser',{enumerable:true,get(){calls++;return bm}})
        results.push(fail(()=>Ordinary.ordinaryPairProjectedByteLengths(custody,bm,tm,getter)))
        const thenable=new Map(bm);thenable.then=()=>{calls++};results.push(fail(()=>Ordinary.ordinaryPairProjectedByteLengths(custody,bm,tm,{browser:thenable,tab:tm})))
        window.escaped={custody,bm,tm,proposed}
      }})
    let refusedEscaped=false;try{Ordinary.ordinaryPairProjectedByteLengths(window.escaped.custody,window.escaped.bm,window.escaped.tm,window.escaped.proposed)}catch(e){refusedEscaped=e.name==='OrdinaryStateHold'}
    const out=[results,calls,entropy,encryptions,refusedEscaped];restoreCrypto();return out
  })()`)).toEqual([[true,true,true,true,true],0,0,0,true])
})

for(const fault of ['account','keep','lease','credential-expiry','close'] as const)test(`final owned handoff refuses ${fault} after native acknowledgement and wipes returned copies`,async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const original=Ordinary.OrdinaryStateOwner.readPairMigrated,nativeNow=Date.now;let reads=0;window.handoff=undefined
    Ordinary.OrdinaryStateOwner.readPairMigrated=async input=>{
      const result=await original.call(Ordinary.OrdinaryStateOwner,input)
      if(++reads===3){handoff=result;const fault=${JSON.stringify(fault)}
        if(fault==='account')current={...current,account:null}
        if(fault==='keep')current={...current,keep:false}
        if(fault==='close')bootstrap.revoke()
        if(fault==='lease')Date.now=()=>tabExpiry+1
        if(fault==='credential-expiry')Date.now=()=>(credentialExpiresAt+1)*1000
      }
      return result
    }
    let result;try{result=await outcome(start)}finally{Ordinary.OrdinaryStateOwner.readPairMigrated=original;Date.now=nativeNow}
    const [b,t]=await images();return [result,reads,signCalls,!!handoff,
      [handoff.admission.secret,handoff.deviceKey,handoff.sealKey].every(bytes=>bytes.every(v=>v===0)),b.records.has(proofName),t.records.has(tabProofName)]
  })()`)).toEqual(['OrdinaryStateHold',3,1,true,true,true,true])
})

test('credential expiry while candidate crypto is pending prevents both native frame writes',async({page})=>{
  await start(page)
  await page.evaluate(`(async()=>{
    window.before=await rawBoth();window.encrypting=false;window.answer='pending';countCrypto()
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),gate=new Promise(resolve=>window.releaseEncrypt=resolve)
    window.restoreEncrypt=()=>{crypto.subtle.encrypt=encrypt}
    crypto.subtle.encrypt=async(...args)=>{encrypting=true;await gate;return encrypt(...args)}
    window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);answer='ok'},e=>answer=e.name)
  })()`)
  await page.waitForFunction('encrypting')
  expect(await page.evaluate(`(async()=>{
    const nativeNow=Date.now;Date.now=()=>(credentialExpiresAt+1)*1000;releaseEncrypt();await pending
    Date.now=nativeNow;restoreEncrypt();const after=await rawBoth(),result=[answer,signCalls,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]
    restoreCrypto();return result
  })()`)).toEqual(['OrdinaryStateHold',1,true])
})

for(const keep of [true,false])test(`old browser-only device adapter cannot mutate V2 custody or create an opt-out fallback, keep=${keep}`,async({page})=>{
  await start(page,{keep})
  expect(await page.evaluate(`(async()=>{
    const old=await Ordinary.OrdinaryRoomDeviceState.open({owner:browserOwner,account:participant,roomId,current:()=>({account:participant,roomId}),live:guard})
    const result=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(result);const before=await rawBoth();countCrypto()
    const opened=await outcome(()=>Ordinary.OrdinaryRoomDeviceState.open({owner:browserOwner,account:participant,roomId,current:()=>({account:participant,roomId}),live:guard})),
      mutated=await outcome(()=>old.deviceKey(now)),after=await rawBoth()
    const out=[opened,mutated,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,true])
})

for(const owner of ['browser','tab'])test(`full ${owner} fence profile refuses before entropy and does not create an unforgettable member`,async({page})=>{
  test.setTimeout(90_000);await start(page)
  expect(await page.evaluate(`(async()=>{
    await bootstrap.close();const rows=await rawBoth(),index=${JSON.stringify(owner)}==='browser'?0:1,
      image=await Ordinary.openOrdinaryFrame(rows[index].frame,rows[index].key)
    image.fences=new Map(Array.from({length:Ordinary.ORDINARY_FENCES},(_,i)=>['old:'+i,0]))
    const frame=await Ordinary.sealOrdinaryImage(image,rows[index].key)
    await new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners','readwrite');tx.objectStore('owners').put({key:rows[index].key,frame},index===0?'browser':tabPurpose)
      tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)}})
    bootstrap=await open();const before=await rawBoth();countCrypto();const result=await outcome(start),after=await rawBoth()
    const out=[result,entropy,encryptions,signCalls,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true])
})

test('acknowledged admission reserves both exact actor-fence slots and forget only advances those entries',async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    const result=await start();Ordinary.wipeOrdinaryPersistentBootstrapResult(result);const first=await images()
    const reserved=first.map(image=>[image.fences.has(invScopeName),image.fences.get(invScopeName),image.fences.size])
    await bootstrap.forget();const after=await images()
    return [reserved,after.map(image=>[image.fences.get(invScopeName),image.fences.size])]
  })()`)).toEqual([[[true,0,1],[true,0,1]],[[1,1],[1,1]]])
})
