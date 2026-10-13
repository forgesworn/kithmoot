import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
const ORIGIN='https://ordinary-creator.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{const result=await build({entryPoints:[fileURLToPath(new URL('./ordinary-creator.browser-entry.ts',import.meta.url))],
  bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'});bundle=result.outputFiles[0]!.text})
test.beforeEach(async({context,page})=>{await context.route(`${ORIGIN}/**`,route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}));await page.goto(ORIGIN)})
const setup=`async (options={})=>{
 window.now=Math.floor(Date.now()/1000);window.live=true;window.guard=()=>live
 window.secret=new Uint8Array(32).fill(31);window.roomId=Ordinary.deriveRoom(secret).roomId
 window.inviterSk=new Uint8Array(32);inviterSk[31]=7;window.participantSk=new Uint8Array(32);participantSk[31]=13
 window.participant=Ordinary.getPublicKey(participantSk);window.account=options.account?participant:null
 window.invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(17),Ordinary.getPublicKey(inviterSk),true)
 window.id=Ordinary.deriveInvitationId(invitation);window.prefix=Ordinary.accountPrefix(participant)
 window.destinations=['wss://second.example/','wss://first.example/'];window.roomRelays=options.noRelays?undefined:['wss://fixed.example/']
 window.link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:['wss://hint.example/'],iceUrls:[],name:'New group'})
 window.current={account,participant,invitationId:id,roomId,link,keep:true,destinations,profile:'direct',sourceKind:options.kind??'new-room',
   endsAt:options.noEnds?undefined:now+3600,destruct:!options.noEnds,roomRelays}
 window.migration={phase:'complete',sources:new Map(),names:[]};window.tabPurpose='tab:'+'a'.repeat(64);window.tabExpiry=Date.now()+3600_000
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
 await browserOwner.prepare(guard,new Map([['kithmoot.participant',Ordinary.bytesToHex(participantSk)]]),migration)
 await tabOwner.prepare(guard,new Map(),migration)
 window.ack=async retained=>{const scope=await browserOwner.capture('invitation:'+retained.proof.binding.invitationId,guard)
 await browserOwner.mutateMigrated(scope,guard,store=>store.set(Ordinary.creatorIntentName(retained.proof.binding),
 JSON.stringify(Ordinary.creatorIntent(retained.proof,retained.proof.destinations))))}
 window.open=()=>Ordinary.OrdinaryInvitationCreator.open({...current,browser:browserOwner,tab:tabOwner,invitation,
   expectedRoomSecret:secret,inviterSk,live:guard,current:()=>current})
 window.creator=await open();window.proofName=prefix+Ordinary.CREATOR_PROOF_PREFIX+id;window.intentName=prefix+Ordinary.CREATOR_INTENT_PREFIX+id
 window.rawBoth=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error)
 r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose)
 tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}})
 window.images=async()=>Promise.all((await rawBoth()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)))
 window.records=async()=>(await images()).map(image=>[...image.records])
 window.outcome=async work=>{try{await work();return 'ok'}catch(e){return e.name}}
 window.preflight=async()=>{const bScope=await browserOwner.capture('invitation:'+id,guard),tScope=await tabOwner.capture('invitation:'+id,guard)
 return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:bScope},tab:{owner:tabOwner,scope:tScope},live:guard,
 work:(b,t,_bn,_tn,custody)=>{const browser=new Map(b.keys().map(n=>[n,b.get(n)])),tab=new Map(t.keys().map(n=>[n,t.get(n)]))
 return Ordinary.validateOrdinarySnapshot(browser,tab,{browser:true,tab:true},Ordinary.captureOrdinarySnapshotContext(browser,tab,custody))}})}
}`
async function start(page:import('@playwright/test').Page,options={}){await page.evaluate(`(${setup})(${JSON.stringify(options)})`)}

for(const kind of ['new-room','dm'])test(`${kind} source tag binds a fresh event, owner, room, fixed list and pending intent together`,async({page})=>{
 await start(page,{kind});expect(await page.evaluate(`(async()=>{const before=await images(),result=await creator.prepare(now),[b,t]=await images(),counts=await preflight()
 const verified=Ordinary.readPersistentCreatorProof(b.records.get(proofName));const answer=[result.intent.state,result.intent.acknowledged,
 verified.admission.relays,result.proof.destinations,JSON.parse(b.records.get(prefix+Ordinary.INVITATION_OWNER_PREFIX+id)).createdAt,
 JSON.parse(b.records.get(prefix+Ordinary.ROOM_PREFIX+roomId)).link===link,JSON.parse(b.records.get(Ordinary.FIXED_INVITATION_RELAYS))[roomId],
 counts.historicalCreatorInvitationProofs,counts.historicalFixedInvitationProofs,b.revision>before[0].revision,t.revision>before[1].revision,
 JSON.stringify([...t.records])===JSON.stringify([...before[1].records]),Object.keys(localStorage),Object.keys(sessionStorage)]
 verified.admission.secret.fill(0);return answer})()`)).toEqual(['pending',[],['wss://fixed.example/'],['wss://first.example/','wss://second.example/'],
 await page.evaluate('now'),true,{c:['wss://fixed.example/'],signed:true},1,1,true,true,true,[],[]])
})
test('retry and restart load exactly retained bytes without new randomness, encryption or clock sampling',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const first=await creator.prepare(now);await creator.close();await browserOwner.close();await tabOwner.close()
 browserOwner=new Ordinary.OrdinaryStateOwner();tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry)
 await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration)
 const random=crypto.getRandomValues.bind(crypto),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
 crypto.getRandomValues=()=>{throw Error('new randomness')};crypto.subtle.encrypt=async()=>{throw Error('new ciphertext')}
 try{creator=await open();const retry=await creator.prepare(now+100);return JSON.stringify(first)===JSON.stringify(retry)}
 finally{crypto.getRandomValues=random;crypto.subtle.encrypt=encrypt}})()`)).toBe(true)
})
test('no-relay source retains no signed fixed row and has no fabricated completion claim',async({page})=>{
 await start(page,{noRelays:true,noEnds:true});expect(await page.evaluate(`(async()=>{const retained=await creator.prepare(now),[b]=await images();await preflight()
 return [b.records.has(Ordinary.FIXED_INVITATION_RELAYS),'completion' in retained.proof,'evidence' in retained.proof]})()`)).toEqual([false,false,false])
})
for(const fault of ['account','participant','invitationId','roomId','link','keep','destinations','profile','sourceKind','endsAt','destruct','roomRelays','live'])test(`${fault} change holds exact images before creator retention`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async fault=>{const before=await rawBoth();if(fault==='live')live=false;else if(fault==='destinations'||fault==='roomRelays')current[fault]=['wss://changed.example/'];
 else if(fault==='keep'||fault==='destruct')current[fault]=false;else if(fault==='endsAt')current.endsAt+=1;else current[fault]='changed'
 const answer=await outcome(()=>creator.prepare(now)),after=await rawBoth();return [answer,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold',true])
})
for(const fault of ['room','owner','fixed','owner-fixed'])test(`bare legacy ${fault} cannot acquire creator proof by key possession`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async fault=>{const scope=await browserOwner.capture('invitation:'+id,guard);await browserOwner.mutateMigrated(scope,guard,store=>{
 const scoped={get:n=>store.get(prefix+n),set:(n,v)=>store.set(prefix+n,v),remove:n=>store.remove(prefix+n),keys:()=>[]}
 Ordinary.rememberRoom(scoped,{roomId,link,openedAt:now});if(fault==='owner'||fault==='owner-fixed')Ordinary.storeInvitationOwner(scoped,invitation,secret,inviterSk,now)
 if(fault==='fixed'||fault==='owner-fixed')store.set(Ordinary.FIXED_INVITATION_RELAYS,JSON.stringify({[roomId]:{c:roomRelays,signed:true}}))})
 const before=await rawBoth(),random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{const answer=await outcome(()=>creator.prepare(now)),after=await rawBoth();return [answer,draws,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]}
 finally{crypto.getRandomValues=random}})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold',0,true])
})
test('forget removes creator access/proof/intent and advances both fences atomically',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{await creator.prepare(now);const before=await images();await creator.forget();const [b,t]=await images()
 return [b.records.has(proofName),b.records.has(intentName),b.records.has(prefix+Ordinary.INVITATION_OWNER_PREFIX+id),
 b.records.has(prefix+Ordinary.ROOM_PREFIX+roomId),b.fences.get('invitation:'+id)>=(before[0].fences.get('invitation:'+id)??0)+1,
 t.fences.get('invitation:'+id)>=(before[1].fences.get('invitation:'+id)??0)+1,await outcome(()=>creator.load())]})()`)).toEqual([false,false,false,false,true,true,'OrdinaryStateHold'])
})
test('partial acknowledgements remain pending; complete exact destination set alone completes intent',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const {proof}=await creator.prepare(now),partial=Ordinary.creatorIntent(proof,[proof.destinations[0]]),all=Ordinary.creatorIntent(proof,proof.destinations)
 return [partial.state,all.state,Ordinary.readCreatorIntent(JSON.stringify(partial),proof).acknowledged]})()`)).toEqual(['pending','acknowledged',['wss://first.example/']])
})
test('actual new-key rotation retains both historical owners but only the selected proof validates the fixed row',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const previous=await creator.prepare(now);await ack(previous);const oldId=id,oldProof=proofName,oldOwner=prefix+Ordinary.INVITATION_OWNER_PREFIX+id
 const prior=(await images())[0].records.get(oldOwner);await creator.close();inviterSk=new Uint8Array(32);inviterSk[31]=19
 invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(25),Ordinary.getPublicKey(inviterSk),true);id=Ordinary.deriveInvitationId(invitation)
 link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:['wss://hint.example/'],iceUrls:[],name:'Rotated group'})
 current={...current,invitationId:id,link,sourceKind:'rotation',predecessorOperation:previous.proof.binding.operation};creator=await open();await creator.prepare(now)
 proofName=prefix+Ordinary.CREATOR_PROOF_PREFIX+id;intentName=prefix+Ordinary.CREATOR_INTENT_PREFIX+id
 const counts=await preflight(),[b]=await images(),scope=await browserOwner.capture('fixture',guard)
 await browserOwner.mutateMigrated(scope,guard,store=>{store.remove(proofName);store.remove(intentName)})
 return [counts.historicalCreatorInvitationProofs,counts.historicalFixedInvitationProofs,b.records.get(oldOwner)===prior,b.records.has(oldProof),
 oldId!==id,await outcome(preflight)]})()`)).toEqual([2,1,true,true,true,'OrdinaryStateHold'])
})
test('caller capability, root and signing buffers are copied before native awaits',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const root=Ordinary.bytesToHex(secret),pub=Ordinary.getPublicKey(inviterSk),bearer=Ordinary.bytesToHex(invitation.bearer)
 secret.fill(0);inviterSk.fill(0);invitation.bearer.fill(0);const retained=await creator.prepare(now)
 return [retained.proof.roomSecret===root,retained.proof.capability.inviter===pub,retained.proof.capability.bearer===bearer]})()`)).toEqual([true,true,true])
})
test('valid signed creator proof copied into a recreated browser generation holds restart and full preflight',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{await creator.prepare(now);const [b]=await images();await creator.close();await browserOwner.close()
 const opening=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);await new Promise((resolve,reject)=>{opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('owners','readwrite')
 tx.objectStore('owners').delete('browser');tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)}})
 browserOwner=new Ordinary.OrdinaryStateOwner();await browserOwner.prepare(guard,b.records,migration)
 return [await outcome(open),await outcome(preflight)]})()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
})
test('unknown native acknowledgement keeps exact paired candidate without signing or encrypting again',async({page})=>{
 await start(page);await page.evaluate(`(()=>{const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open,
 encrypt=crypto.subtle.encrypt.bind(crypto.subtle);window.encryptions=0;window.receipt='pending';let once=false
 crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)}
 Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
 if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw Error('unavailable')};tx.onabort(event)})}
 else descriptor.set.call(tx,callback)}})
 window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen;crypto.subtle.encrypt=encrypt}
 window.pending=creator.prepare(now).then(()=>receipt='ack',e=>receipt=e.name)})()`)
 await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
 expect(await page.evaluate('[receipt,encryptions]')).toEqual(['pending',2])
 await page.evaluate(`(async()=>{restore();window.intended=(await rawBoth()).map(row=>structuredClone(row.frame));creator.retryRetention();await pending})()`)
 expect(await page.evaluate(`(async()=>[receipt,encryptions,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,intended[i])),!!await creator.load()])()`)).toEqual(['ack',2,true,true])
})
for(const fault of ['event','eventId','root','account','scope','link','destinations','operation','owner','intent','orphan'])test(`${fault} substitution holds creator load and full image preflight`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async fault=>{await creator.prepare(now);const scope=await browserOwner.capture('fixture',guard)
 await browserOwner.mutateMigrated(scope,guard,store=>{const p=JSON.parse(store.get(proofName)),intent=JSON.parse(store.get(intentName))
 if(fault==='event')p.event=p.event+' ';if(fault==='eventId')p.eventId='f'.repeat(64);if(fault==='root')p.roomSecret='f'.repeat(64)
 if(fault==='account')p.binding.participant='f'.repeat(64);if(fault==='scope')p.binding.browser.fence+=1;if(fault==='link')p.link=link+'extra'
 if(fault==='destinations')p.destinations=['wss://changed.example/'];if(fault==='operation')p.binding.operation='f'.repeat(64)
 if(fault==='owner'){const name=prefix+Ordinary.INVITATION_OWNER_PREFIX+id,owner=JSON.parse(store.get(name));owner.createdAt+=1;store.set(name,JSON.stringify(owner))}
 if(fault==='intent'){intent.eventId='f'.repeat(64);store.set(intentName,JSON.stringify(intent))}
 if(fault==='orphan')store.remove(proofName);else store.set(proofName,JSON.stringify(p))})
 const before=await rawBoth(),answers=[await outcome(()=>creator.load()),await outcome(preflight)],after=await rawBoth()
 return [...answers,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',true])
})

for(const kind of ['rotation','renewal'])test(`${kind} requires an exact acknowledged predecessor before randomness`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async kind=>{await creator.close();current={...current,sourceKind:kind,predecessorOperation:'a'.repeat(64)}
 const before=await rawBoth(),random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{return [await outcome(open),draws,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]}
 finally{crypto.getRandomValues=random}})(${JSON.stringify(kind)})`)).toEqual(['OrdinaryStateHold',0,true])
})
for(const acknowledged of [[],['wss://first.example/']])for(const kind of ['rotation','renewal'])test(`${kind} cannot replace a ${acknowledged.length?'partly acknowledged':'pending'} predecessor`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async({kind,acknowledged})=>{const previous=await creator.prepare(now-10);const scope=await browserOwner.capture('invitation:'+id,guard)
 await browserOwner.mutateMigrated(scope,guard,store=>store.set(intentName,JSON.stringify(Ordinary.creatorIntent(previous.proof,acknowledged))))
 await creator.close();if(kind==='rotation'){inviterSk=new Uint8Array(32);inviterSk[31]=19;invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(25),Ordinary.getPublicKey(inviterSk),true)
 id=Ordinary.deriveInvitationId(invitation);link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[]})}
 current={...current,invitationId:id,link,sourceKind:kind,predecessorOperation:previous.proof.binding.operation}
 const before=await rawBoth(),random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{const answer=await outcome(async()=>{creator=await open();await creator.prepare(now)});return [answer,draws,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]}
 finally{crypto.getRandomValues=random}})(${JSON.stringify({kind,acknowledged})})`)).toEqual(['OrdinaryStateHold',0,true])
})
for(const account of [false,true])test(`same-capability renewal replaces an acknowledged event atomically and preserves authored history (${account?'account':'visitor'})`,async({page})=>{
 await start(page,{account});expect(await page.evaluate(`(async()=>{const previous=await creator.prepare(now-10);await ack(previous);await creator.close()
 current={...current,sourceKind:'renewal',predecessorOperation:previous.proof.binding.operation};creator=await open();const retained=await creator.prepare(now)
 const [b]=await images(),counts=await preflight();await creator.close();creator=await open();const retry=await creator.prepare(now+100)
 return [retained.proof.eventId!==previous.proof.eventId,retained.proof.history.length===1&&retained.proof.history[0]===previous.proof.event,retained.intent.state,
 JSON.parse(b.records.get(prefix+Ordinary.INVITATION_OWNER_PREFIX+id)).createdAt,counts.historicalCreatorInvitationProofs,
 JSON.stringify(retained)===JSON.stringify(retry),retained.proof.binding.account]})()`)).toEqual([true,true,'pending',await page.evaluate('now'),1,true,account?await page.evaluate('participant'):null])
})
for(const transition of ['same','different','absent','from-absent'])test(`rotation ${transition} fixed-list transition and historical forget preserve selected new custody`,async({page})=>{
 await start(page,{noRelays:transition==='from-absent'});expect(await page.evaluate(`(async transition=>{const previous=await creator.prepare(now-10);await ack(previous)
 const old={current:{...current},invitation,inviterSk,id};await creator.close()
 inviterSk=new Uint8Array(32);inviterSk[31]=19;invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(25),Ordinary.getPublicKey(inviterSk),true);id=Ordinary.deriveInvitationId(invitation)
 link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[],name:'Rotated group'})
 roomRelays=transition==='absent'?undefined:transition==='different'?['wss://changed.example/']:['wss://fixed.example/']
 current={...current,invitationId:id,link,roomRelays,sourceKind:'rotation',predecessorOperation:previous.proof.binding.operation}
 creator=await open();const retained=await creator.prepare(now);const first=await preflight();await creator.close()
 const latest={current:{...current},invitation,inviterSk,id};current=old.current;invitation=old.invitation;inviterSk=old.inviterSk;id=old.id
 creator=await open();await creator.forget();current=latest.current;invitation=latest.invitation;inviterSk=latest.inviterSk;id=latest.id;creator=await open()
 const loaded=await creator.load(),[b]=await images(),last=await preflight(),fixed=JSON.parse(b.records.get(Ordinary.FIXED_INVITATION_RELAYS)??'{}')[roomId]
 return [first.historicalCreatorInvitationProofs,last.historicalCreatorInvitationProofs,JSON.stringify(loaded)===JSON.stringify(retained),
 JSON.parse(b.records.get(prefix+Ordinary.ROOM_PREFIX+roomId)).link===latest.current.link,
 fixed??null,last.historicalFixedInvitationProofs??0,b.records.has(Ordinary.creatorProofName(previous.proof.binding))]})(${JSON.stringify(transition)})`)).toEqual([2,1,true,true,transition==='absent'?null:{c:[transition==='different'?'wss://changed.example/':'wss://fixed.example/'],signed:true},transition==='absent'?0:1,false])
})
for(const fault of ['top-order','binding-order','scope-order','capability-order'])test(`canonical creator ${fault} substitution is rejected`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async fault=>{await creator.prepare(now);const scope=await browserOwner.capture('fixture',guard)
 await browserOwner.mutateMigrated(scope,guard,store=>{let p=JSON.parse(store.get(proofName))
 const reverse=o=>Object.fromEntries(Object.entries(o).reverse());if(fault==='top-order')p=reverse(p);if(fault==='binding-order')p.binding=reverse(p.binding)
 if(fault==='scope-order')p.binding.browser=reverse(p.binding.browser);if(fault==='capability-order')p.capability=reverse(p.capability)
 store.set(proofName,JSON.stringify(p))});return [await outcome(()=>creator.load()),await outcome(preflight)]})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
})

test('a source-row change on another page between read and retention holds before candidate encryption',async({page,context})=>{
 await start(page);const other=await context.newPage();await other.goto(ORIGIN)
 await other.evaluate(`(async()=>{window.raceOwner=new Ordinary.OrdinaryStateOwner();await raceOwner.prepare(()=>true,new Map(),{phase:'complete',sources:new Map(),names:[]})})()`)
 await page.exposeFunction('sourceRace',()=>other.evaluate(`(async()=>{const scope=await raceOwner.capture('fixture',()=>true)
 await raceOwner.mutateMigrated(scope,()=>true,store=>store.set('kithmoot.circle.v1',JSON.stringify(['changed-on-another-page'])))})()`))
 expect(await page.evaluate(`(async()=>{const mutate=Ordinary.OrdinaryStateOwner.mutatePairMigrated,encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let encryptions=0
 Ordinary.OrdinaryStateOwner.mutatePairMigrated=async input=>{await sourceRace();window.raceFrames=await rawBoth();crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)};return mutate.call(Ordinary.OrdinaryStateOwner,input)}
 try{const answer=await outcome(()=>creator.prepare(now));return [answer,encryptions,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,raceFrames[i].frame))]}
 finally{Ordinary.OrdinaryStateOwner.mutatePairMigrated=mutate;crypto.subtle.encrypt=encrypt}})()`)).toEqual(['OrdinaryStateHold',0,true]);await other.close()
})
for(const fault of ['end-extension','end-omission','destruct-clear','list-omission','same-time','wrong-predecessor'])test(`renewal ${fault} preserves exact predecessor before randomness`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async fault=>{const previous=await creator.prepare(now-10);await ack(previous);await creator.close()
 current={...current,sourceKind:'renewal',predecessorOperation:previous.proof.binding.operation}
 if(fault==='end-extension')current.endsAt+=1;if(fault==='end-omission')current.endsAt=undefined;if(fault==='destruct-clear')current.destruct=false
 if(fault==='list-omission')current.roomRelays=undefined;if(fault==='wrong-predecessor')current.predecessorOperation='a'.repeat(64)
 const before=await rawBoth(),random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{const answer=await outcome(async()=>{creator=await open();await creator.prepare(fault==='same-time'?now-10:now)});return [answer,draws,
 (await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]}finally{crypto.getRandomValues=random}})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold',0,true])
})

test('forgetting the selected rotation clears its fixed row; historical custody remains valid and can then be forgotten',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const previous=await creator.prepare(now-10);await ack(previous)
 const old={current:{...current},invitation,inviterSk,id};await creator.close()
 inviterSk=new Uint8Array(32);inviterSk[31]=19;invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(25),Ordinary.getPublicKey(inviterSk),true);id=Ordinary.deriveInvitationId(invitation)
 link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[]});current={...current,invitationId:id,link,sourceKind:'rotation',predecessorOperation:previous.proof.binding.operation}
 creator=await open();await creator.prepare(now);await creator.forget();const counts=await preflight(),[b]=await images()
 const first=[counts.historicalCreatorInvitationProofs,counts.historicalFixedInvitationProofs??0,b.records.has(prefix+Ordinary.ROOM_PREFIX+roomId),
 b.records.has(Ordinary.creatorProofName(previous.proof.binding))]
 current=old.current;invitation=old.invitation;inviterSk=old.inviterSk;id=old.id;creator=await open();const historicalLoad=await outcome(()=>creator.load());await creator.forget()
 const last=await preflight();return [...first,historicalLoad,last.historicalCreatorInvitationProofs??0,last.invitations]})()`)).toEqual([1,0,false,true,'OrdinaryStateHold',0,0])
})
test('64 authenticated historical creator slots survive; the next rotation holds before randomness',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const first=await creator.prepare(now-10);await ack(first);await creator.close()
 const rows=[];for(let i=1;i<Ordinary.MAX_CREATOR_PROOFS_PER_ROOM;i++){
 const sk=new Uint8Array(32);sk[31]=i+20;const cap=Ordinary.roomInvitation(new Uint8Array(32).fill(i+40),Ordinary.getPublicKey(sk),true)
 const sourceId=Ordinary.deriveInvitationId(cap),scope=await browserOwner.capture('invitation:'+sourceId,guard)
 const sourceLink=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation:cap,relays:[],iceUrls:[]})
 const event=Ordinary.encodePersistentInvitation({invitation:cap,inviterSk:sk,roomSecret:secret,now:now-10,endsAt:current.endsAt,destruct:true,relays:roomRelays})
 const verified=Ordinary.makePersistentCreatorProof({event,invitation:cap,expectedRoomSecret:secret,account,participant,browser:scope,
 link:sourceLink,keep:true,destinations,profile:'direct',sourceKind:'rotation',predecessorOperation:first.proof.binding.operation})
 try{rows.push({sk,cap,proof:verified.proof})}finally{verified.admission.secret.fill(0)}}
 const scope=await browserOwner.capture('fixture',guard);await browserOwner.mutateMigrated(scope,guard,store=>{
 const scoped={get:n=>store.get(prefix+n),set:(n,v)=>store.set(prefix+n,v),remove:n=>store.remove(prefix+n),keys:()=>[]}
 for(const {sk,cap,proof} of rows){Ordinary.storeInvitationOwner(scoped,cap,secret,sk,proof.createdAt,current.endsAt,true)
 store.set(Ordinary.creatorProofName(proof.binding),JSON.stringify(proof));store.set(Ordinary.creatorIntentName(proof.binding),JSON.stringify(Ordinary.creatorIntent(proof,proof.destinations)))}})
 const counts=await preflight();inviterSk=new Uint8Array(32);inviterSk[31]=120;invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(130),Ordinary.getPublicKey(inviterSk),true)
 id=Ordinary.deriveInvitationId(invitation);link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[]})
 current={...current,invitationId:id,link,sourceKind:'rotation',predecessorOperation:first.proof.binding.operation}
 const before=await rawBoth(),random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{return [counts.historicalCreatorInvitationProofs,await outcome(open),draws,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]}
 finally{crypto.getRandomValues=random;for(const row of rows){row.sk.fill(0);row.cap.bearer.fill(0)}}})()`)).toEqual([64,'OrdinaryStateHold',0,true])
})
test('64 authored renewal sources are retained without eviction; another renewal holds before randomness',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const first=await creator.prepare(now-100);await creator.close();const history=[first.proof.event]
 for(let i=1;i<Ordinary.MAX_CREATOR_SOURCE_EVENTS-1;i++){const source=Ordinary.revalidatePersistentInvitationSource({invitation,expectedRoomSecret:secret,
 event:Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:secret,now:now-100+i,endsAt:current.endsAt,destruct:true,relays:roomRelays})})
 try{history.push(source.event)}finally{source.admission.secret.fill(0)}}
 const event=Ordinary.encodePersistentInvitation({invitation,inviterSk,roomSecret:secret,now:now-37,endsAt:current.endsAt,destruct:true,relays:roomRelays})
 const scope=await browserOwner.capture('invitation:'+id,guard),verified=Ordinary.makePersistentCreatorProof({event,invitation,expectedRoomSecret:secret,
 account,participant,browser:scope,link,keep:true,destinations,profile:'direct',sourceKind:'renewal',predecessorOperation:first.proof.binding.operation,history})
 try{await browserOwner.mutateMigrated(scope,guard,store=>{const scoped={get:n=>store.get(prefix+n),set:(n,v)=>store.set(prefix+n,v),remove:n=>store.remove(prefix+n),keys:()=>[]}
 Ordinary.storeInvitationOwner(scoped,invitation,secret,inviterSk,verified.proof.createdAt,current.endsAt,true)
 Ordinary.rememberRoom(scoped,{roomId,link,openedAt:verified.proof.createdAt,endsAt:current.endsAt,destruct:true});Ordinary.setKeepRoom(scoped,roomId,true)
 store.set(proofName,JSON.stringify(verified.proof));store.set(intentName,JSON.stringify(Ordinary.creatorIntent(verified.proof,verified.proof.destinations)))})
 await preflight();current={...current,sourceKind:'renewal',predecessorOperation:verified.proof.binding.operation};const before=await rawBoth()
 const random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{const answer=await outcome(async()=>{creator=await open();await creator.prepare(now)});return [history.length+1,answer,draws,
 (await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]}finally{crypto.getRandomValues=random}}
 finally{verified.admission.secret.fill(0)}})()`)).toEqual([64,'OrdinaryStateHold',0,true])
})

for(const failure of [false,true])test(`owned input copies are erased on ${failure?'open refusal':'close'}; caller buffers remain unchanged`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async failure=>{await creator.close();const originals=[invitation.bearer,secret,inviterSk],before=originals.map(Ordinary.bytesToHex),owned=[]
 const Base=Uint8Array;window.Uint8Array=new Proxy(Base,{construct(Target,args){const result=Reflect.construct(Target,args)
 if(originals.includes(args[0]))owned.push(result);return result}})
 try{if(failure)current={...current,destinations:[]};const answer=await outcome(async()=>{creator=await open();await creator.close()})
 return [answer,owned.length,owned.every(value=>value.every(byte=>byte===0)),originals.every((value,i)=>Ordinary.bytesToHex(value)===before[i])]}
 finally{window.Uint8Array=Base}})(${JSON.stringify(failure)})`)).toEqual([failure?'OrdinaryStateHold':'ok',3,true,true])
})

for(const kind of ['new-room','dm'])for(const phase of ['raw','complete'])test(`${kind} refuses a validated ${phase} bookmark-only room before randomness`,async({page})=>{
 await start(page,{kind});expect(await page.evaluate(`(async phase=>{const fixture=await Ordinary.bookmarkFixture('signed',{rootSeed:31,accountSeed:13,bearerSeed:17})
 const browser=new Map([...fixture.records,['kithmoot.participant',Ordinary.bytesToHex(participantSk)]]),tab=new Map()
 const checked=Ordinary.validateOrdinaryRoomAccessAndBookmarksSnapshot(browser,tab,{browser:phase==='complete',tab:true},
 Ordinary.captureOrdinaryStartupContext(browser,tab));if(checked.bookmarks.length!==1)throw Error('fixture missing bookmark')
 await creator.close();if(phase==='complete'){
 const scope=await browserOwner.capture('fixture',guard);await browserOwner.mutateMigrated(scope,guard,store=>{for(const [name,value]of fixture.records)store.set(name,value)})
 await preflight()}else{
 await browserOwner.close();const request=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
 await new Promise((resolve,reject)=>{request.onsuccess=()=>{const db=request.result,tx=db.transaction('owners','readwrite');tx.objectStore('owners').delete('browser')
 tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)}})
 for(const [name,value]of fixture.records)localStorage.setItem(name,value)
 browserOwner=new Ordinary.OrdinaryStateOwner();await browserOwner.prepare(guard,browser,{phase:'sealed',sources:fixture.records,names:[...fixture.records.keys()]})}
 const before=await rawBoth(),raw=JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(n=>[n,localStorage.getItem(n)])))
 const random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{const answer=await outcome(async()=>{creator=await open();await creator.prepare(now)});return [answer,draws,
 (await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame)),
 JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(n=>[n,localStorage.getItem(n)])))===raw]}
 finally{crypto.getRandomValues=random}})(${JSON.stringify(phase)})`)).toEqual(['OrdinaryStateHold',0,true,true])
})
test('rotation with a new inviter but the old bearer refuses before randomness',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{const previous=await creator.prepare(now-10);await ack(previous);await creator.close()
 inviterSk=new Uint8Array(32);inviterSk[31]=19;invitation=Ordinary.roomInvitation(Ordinary.hexToBytes(previous.proof.capability.bearer),Ordinary.getPublicKey(inviterSk),true)
 id=Ordinary.deriveInvitationId(invitation);link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[]})
 current={...current,invitationId:id,link,sourceKind:'rotation',predecessorOperation:previous.proof.binding.operation}
 const before=await rawBoth(),random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{const answer=await outcome(async()=>{creator=await open();await creator.prepare(now)});return [id===previous.proof.binding.invitationId,answer,draws,
 (await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]}finally{crypto.getRandomValues=random}})()`)).toEqual([true,'OrdinaryStateHold',0,true])
})

for(const reuse of ['bearer','inviter'])test(`a third rotation cannot reuse the first retained ${reuse} before randomness`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async reuse=>{const first=await creator.prepare(now-20);await ack(first);await creator.close()
 inviterSk=new Uint8Array(32);inviterSk[31]=19;invitation=Ordinary.roomInvitation(new Uint8Array(32).fill(25),Ordinary.getPublicKey(inviterSk),true);id=Ordinary.deriveInvitationId(invitation)
 link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[]});current={...current,invitationId:id,link,sourceKind:'rotation',predecessorOperation:first.proof.binding.operation}
 creator=await open();const second=await creator.prepare(now-10);await ack(second);await creator.close()
 inviterSk=new Uint8Array(32);inviterSk[31]=reuse==='inviter'?7:23
 invitation=Ordinary.roomInvitation(reuse==='bearer'?Ordinary.hexToBytes(first.proof.capability.bearer):new Uint8Array(32).fill(27),Ordinary.getPublicKey(inviterSk),true);id=Ordinary.deriveInvitationId(invitation)
 link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:[],iceUrls:[]});current={...current,invitationId:id,link,sourceKind:'rotation',predecessorOperation:second.proof.binding.operation}
 const before=await rawBoth(),random=crypto.getRandomValues.bind(crypto);let draws=0;crypto.getRandomValues=(...args)=>{draws++;return random(...args)}
 try{const answer=await outcome(async()=>{creator=await open();await creator.prepare(now)});return [id!==second.proof.binding.invitationId,
 reuse==='bearer'?id===first.proof.binding.invitationId:id!==first.proof.binding.invitationId,answer,draws,
 (await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]}finally{crypto.getRandomValues=random}})(${JSON.stringify(reuse)})`)).toEqual([true,true,'OrdinaryStateHold',0,true])
})
