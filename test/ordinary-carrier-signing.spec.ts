import { build } from 'esbuild'
import { expect,test,type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { setup } from './ordinary-bootstrap.setup.js'

// Real native owners, full composer, retained visitor keys and SDK signers.
// Wallets and carrier scheduling are controlled; the existing query/creator
// specs additionally cover real loopback WebSockets. Production is unmounted.
const ORIGIN='https://ordinary-carrier-signing.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts',import.meta.url))],
 bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text})
test.beforeEach(async({context,page})=>{await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}));await page.goto(ORIGIN)})
const controls=`async()=>{
 window.nativeHeld=0;window.walletLocked=[];const request=navigator.locks.request.bind(navigator.locks);
 navigator.locks.request=(name,...args)=>{const callback=args.pop();return request(name,...args,async lock=>{
  if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 window.pairRead=async effect=>{const s=await scopes();return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,
  work:(b,t,_bn,_tn,c)=>effect(b,t,c,s)})};
 window.makeDeferred=async()=>{
  await bootstrap.close();await identity.close();window.upgradeReady=new Promise(resolve=>window.upgrade=resolve);
  window.clientKey=new Uint8Array(32).fill(3);window.uri='bunker://'+'d'.repeat(64)+'?relay=wss%3A%2F%2Fbunker.example';
  window.backend={signEvent:template=>nostr.signEvent(template),nip04Encrypt:async()=>'',nip04Decrypt:async()=>'',nip44Encrypt:async()=>'',nip44Decrypt:async()=>'',
   getPublicKey:async()=>participant,provisionRendezvous:async()=>'',ping:async()=>{},switchRelays:async()=>true,logout:async()=>{},close:async()=>{}};
  window.bunker=new Ordinary.BunkerSignerImpl(participant,backend,uri,clientKey);
  window.deferred=new Ordinary.DeferredBunkerSigner(participant,sourceSession.authEvent,upgradeReady,uri,clientKey);
  window.deferredCalled=false;const original=deferred.signEvent;deferred.signEvent=function(...args){deferredCalled=true;return original.apply(this,args)};
  const scope=await browserOwner.capture('@ordinary-signet',guard),k=Ordinary.ORDINARY_SIGNET_KEYS;
  await browserOwner.mutateMigrated(scope,guard,b=>{b.set(k.method,'bunker');b.set(k.bunkerUri,uri);b.set(k.bunkerClientSk,Ordinary.bytesToHex(clientKey))});
  sourceSession={pubkey:participant,method:'bunker',authEvent:sourceSession.authEvent,signer:deferred};
  identity=await Ordinary.OrdinaryForegroundSigner.open({browser:browserOwner,tab:tabOwner,session:sourceSession,currentSession:()=>sourceSession,
   generation:0,currentGeneration:()=>0,live:guard,checkClients:async()=>{},stop:()=>{}});current={...current,identity};bootstrap=await open();
 };
 window.carrier=()=>{
  window.frames=[];window.dials=[];window.sockets=[];window.authSigns=0;window.closed=false;
  const destinations=['wss://first.example/','wss://second.example/'];
  class Socket{
   readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null;
   constructor(url){this.url=url;dials.push([url,nativeHeld>0]);sockets.push(this);queueMicrotask(()=>{if(this.readyState===3)return;this.readyState=1;this.onopen?.({type:'open'});this.onmessage?.({data:JSON.stringify(['AUTH','native-challenge'])})})}
   send(data){frames.push([data,nativeHeld>0]);const frame=JSON.parse(data);queueMicrotask(()=>{if(this.readyState===3)return;
    if(frame[0]==='AUTH')this.onmessage?.({data:JSON.stringify(['OK',frame[1].id,true,'accepted'])});
    if(frame[0]==='REQ'){this.onmessage?.({data:JSON.stringify(['EVENT',frame[1],event])});this.onmessage?.({data:JSON.stringify(['EOSE',frame[1]])})}})}
   close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({type:'close'})}
  }
  window.carrierCurrent={generation:'c'.repeat(64),profile:'direct',destinations,websocketImplementation:Socket,authentication:destinations.map(url=>({url,identity}))};
  window.queryOptions={...carrierCurrent,current:()=>carrierCurrent,timeoutMs:5000,authenticationTimeoutMs:4000};
  window.query=()=>{window.receipt='pending';window.querying=bootstrap.queryEvidence(queryOptions).then(result=>{window.answer=result;receipt='ok'},error=>receipt=error.name);return querying};
 };
}`
async function start(page:Page,visitor=false){await page.evaluate(`(${setup})(${JSON.stringify({visitor})})`);await page.evaluate(`(${controls})()`)}

for(const fault of ['valid','fabricated-token','wrong-browser-instance','wrong-tab-instance','browser-fence','tab-fence','browser-generation','tab-generation','expired','reentrant-close','escaped'] as const)
test(`native same-read component binding ${fault}`,async({page})=>{
 await start(page,true)
 expect(await page.evaluate(`(async()=>{let error,escaped;
  const otherBrowser=new Ordinary.OrdinaryStateOwner(),otherTab=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);
  if('${fault}'==='wrong-browser-instance')await otherBrowser.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
  if('${fault}'==='wrong-tab-instance')await otherTab.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
  try{await pairRead((b,t,c,s)=>{const input={browser:{owner:browserOwner,scope:{...s.b}},tab:{owner:tabOwner,scope:{...s.t}},live:guard};
   if('${fault}'==='wrong-browser-instance')input.browser.owner=otherBrowser;if('${fault}'==='wrong-tab-instance')input.tab.owner=otherTab;
   if('${fault}'==='browser-fence')input.browser.scope.fence++;if('${fault}'==='tab-fence')input.tab.scope.fence++;
   if('${fault}'==='browser-generation')input.browser.scope.generation='e'.repeat(64);if('${fault}'==='tab-generation')input.tab.scope.generation='e'.repeat(64);
   if('${fault}'==='expired')Date.now=()=>tabExpiry;
   if('${fault}'==='reentrant-close')input.live=()=>{void(window.closing=browserOwner.close());return true};
   if('${fault}'==='escaped'){escaped={c,input};return};Ordinary.OrdinaryStateOwner.validatePairBinding('${fault}'==='fabricated-token'?{}:c,input)
  });if(escaped)Ordinary.OrdinaryStateOwner.validatePairBinding(escaped.c,escaped.input)}catch(e){error=e.name}
  if(window.closing)await closing;return[error,signCalls,nativeHeld]})()`)).toEqual([fault==='valid'?undefined:'OrdinaryStateHold',0,0])
})
for(const fault of ['valid','account-role','wrong-key','kind','relay','challenge','accessor','mutation-token','signing-throw'] as const)
test(`visitor NIP42 uses only acknowledged native key and exact statement: ${fault}`,async({page})=>{
 await start(page,true)
 expect(await page.evaluate(`(async()=>{const fill=Uint8Array.prototype.fill,random=crypto.getRandomValues.bind(crypto);let wiped=0,signed,error;
  Uint8Array.prototype.fill=function(value,...rest){if(value===0&&this.length===32&&Ordinary.bytesToHex(this)===Ordinary.bytesToHex(participantSk))wiped++;return fill.call(this,value,...rest)};
  try{const effect=(b,t,c)=>{const binding={account:null,participant,url:'wss://relay.example/',challenge:'visitor',createdAt:now},input={kind:22242,created_at:now,content:'',tags:[['relay',binding.url],['challenge',binding.challenge]]};
   if('${fault}'==='account-role')binding.account=participant;if('${fault}'==='wrong-key')binding.participant=Ordinary.getPublicKey(inviterSk);
   if('${fault}'==='kind')input.kind=1;if('${fault}'==='relay')input.tags[0][1]='wss://other.example/';if('${fault}'==='challenge')input.tags[1][1]='different';
   if('${fault}'==='accessor')Object.defineProperty(input,'content',{get(){throw Error('accessor must not run')}});
   if('${fault}'==='signing-throw')crypto.getRandomValues=()=>{throw Error('nonce refused')};
   signed=Ordinary.signOrdinaryVisitorAuthentication(b,t,c,binding,input);
  };if('${fault}'==='mutation-token')await pair((b,t,_bn,_tn,c)=>effect(b,t,c));else await pairRead(effect)}catch(e){error=e.name}
  finally{Uint8Array.prototype.fill=fill;crypto.getRandomValues=random}
  return[error,!!signed,signed?.pubkey===participant,!!signed&&Object.isFrozen(signed.tags[0]),signCalls,wiped>0]})()`))
  .toEqual(fault==='valid'?[undefined,true,true,true,0,true]:['OrdinaryStateHold',false,false,false,0,fault==='wrong-key'||fault==='signing-throw'])
})
for(const fault of ['valid','room','device','seal','expiration','restamp','account-role'] as const)test(`visitor credential statement is exactly bound: ${fault}`,async({page})=>{
 await start(page,true)
 expect(await page.evaluate(`(async()=>{let signed,error;try{await pairRead((b,t,c)=>{const binding={account:null,participant,roomId,devicePubkey:Ordinary.getPublicKey(inviterSk),seal:participant,expiresAt:credentialExpiresAt,createdAt:now};
  const input={kind:20460,created_at:now,content:'',tags:[['d',roomId],['device',binding.devicePubkey],['expiration',String(credentialExpiresAt)],['seal',participant]]};
  if('${fault}'==='room')input.tags[0][1]='f'.repeat(64);if('${fault}'==='device')input.tags[1][1]=participant;if('${fault}'==='seal')input.tags[3][1]=binding.devicePubkey;
  if('${fault}'==='expiration')input.tags[2][1]=String(credentialExpiresAt+1);if('${fault}'==='restamp')input.created_at++;if('${fault}'==='account-role')binding.account=participant;
  signed=Ordinary.signOrdinaryVisitorCredential(b,t,c,binding,input)})}catch(e){error=e.name};return[error,!!signed,signCalls]})()`))
 .toEqual([fault==='valid'?undefined:'OrdinaryStateHold',fault==='valid',0])
})
for(const shape of ['generic','prototype-forgery'] as const)test(`${shape} account identity refuses opening before entropy or provider callbacks`,async({page})=>{
 await start(page)
 expect(await page.evaluate(`(async()=>{await bootstrap.close();let called=0,error;const fake={pubkey:participant,signEvent:async()=>{called++;throw Error('generic')}};
  if('${shape}'==='prototype-forgery')Object.setPrototypeOf(fake,Ordinary.OrdinaryForegroundSigner.prototype);
  current={...current,identity:fake};identity=fake;countCrypto();try{await open()}catch(e){error=e.name};const answer=[error,called,entropy,encryptions];restoreCrypto();return answer})()`))
 .toEqual(['OrdinaryStateHold',0,0,0])
})
test('replaced instance borrowing method cannot bypass the native SDK consumer implementation',async({page})=>{
 await start(page)
 expect(await page.evaluate(`(async()=>{let called=0;identity.borrowSignEvent=()=>{called++;return async()=>{throw Error('bypass')}};carrier();await query();
  return[receipt,called,authSigns,frames.length]})()`)).toEqual(['ok',0,2,4])
})
test('visitor bootstrap and both relay AUTHs never invoke a generic async provider',async({page})=>{
 await start(page,true)
 expect(await page.evaluate(`(async()=>{await bootstrap.close();let called=0;identity={pubkey:participant,signEvent:async()=>{called++;throw Error('must not call')}};current={...current,identity};bootstrap=await open();carrier();
  await query();const result=await bootstrap.bootstrap(answer);const output=[receipt,called,result.credential.pubkey===participant,frames.length,frames.every(f=>f[1]),dials.every(d=>d[1])];Ordinary.wipeOrdinaryPersistentBootstrapResult(result);return output})()`))
 .toEqual(['ok',0,true,4,true,true])
})
test('visitor role ignores genuine Fore provider for both query AUTH and member credential',async({page})=>{
 await start(page)
 expect(await page.evaluate(`(async()=>{await bootstrap.close();const s=await scopes();await browserOwner.mutateMigrated(s.b,guard,b=>b.set('kithmoot.participant',Ordinary.bytesToHex(participantSk)));
  account=null;current={...current,account};bootstrap=await open();let called=0;nostr.signEvent=async()=>{called++;throw Error('visitor must not invoke SDK')};
  carrier();await query();const result=await bootstrap.bootstrap(answer);const output=[receipt,called,authSigns,signCalls,result.credential.pubkey===participant,frames.length];Ordinary.wipeOrdinaryPersistentBootstrapResult(result);return output})()`))
 .toEqual(['ok',0,0,0,true,4])
})
test('visitor query refuses foreign genuine Fore consent before any dial or signing',async({page})=>{
 await start(page)
 expect(await page.evaluate(`(async()=>{await bootstrap.close();const foreign=identity,s=await scopes();participant=Ordinary.getPublicKey(inviterSk);account=null;identity=Ordinary.localIdentity(inviterSk);
  await browserOwner.mutateMigrated(s.b,guard,b=>b.set('kithmoot.participant',Ordinary.bytesToHex(inviterSk)));current={...current,participant,account,identity};bootstrap=await open();carrier();
  carrierCurrent={...carrierCurrent,authentication:carrierCurrent.destinations.map(url=>({url,identity:foreign}))};queryOptions={...queryOptions,...carrierCurrent};let called=0;nostr.signEvent=async()=>{called++;throw Error('foreign')};
  await query();return[receipt,called,authSigns,dials.length,frames.length]})()`)).toEqual(['OrdinaryStateHold',0,0,0,0])
})
for(const fault of ['malformed-scalar','replaced-scalar','tab-alias','template-close'] as const)test(`visitor ${fault} refuses before signature entropy`,async({page})=>{
 await start(page,true)
 expect(await page.evaluate(`(async()=>{const s=await scopes();if('${fault}'==='malformed-scalar'||'${fault}'==='replaced-scalar')await browserOwner.mutateMigrated(s.b,guard,b=>b.set('kithmoot.participant','${fault}'==='malformed-scalar'?'0'.repeat(64):Ordinary.bytesToHex(inviterSk)));
  if('${fault}'==='tab-alias')await tabOwner.mutateMigrated(s.t,guard,t=>t.set('kithmoot.participant',Ordinary.bytesToHex(participantSk)));
  countCrypto();let error;try{await pairRead((b,t,c)=>{const binding={account:null,participant,url:'wss://relay.example/',challenge:'visitor',createdAt:now},input={kind:22242,created_at:now,content:'',tags:[['relay',binding.url],['challenge',binding.challenge]]};
   if('${fault}'==='template-close')input.tags=new Proxy(input.tags,{getOwnPropertyDescriptor(target,name){void(window.closing=browserOwner.close());return Reflect.getOwnPropertyDescriptor(target,name)}});
   Ordinary.signOrdinaryVisitorAuthentication(b,t,c,binding,input)})}catch(e){error=e.name};if(window.closing)await closing;
  const result=[error,entropy,signCalls];restoreCrypto();return result})()`)).toEqual(['OrdinaryStateHold',0,0])
})
for(const fault of ['valid','consent','selection','browser-fence','tab-fence','close','browser-close','tab-close'] as const)
test(`deferred SDK query ${fault} checks native carrier at actual start and joins queued relay signing`,async({page})=>{
 await start(page);await page.evaluate('makeDeferred()');await page.evaluate('carrier();query();undefined');await page.waitForFunction('deferredCalled')
 expect(await page.evaluate('[receipt,authSigns,frames.length]')).toEqual(['pending',0,0])
 await page.evaluate(`(async()=>{window.closeDone=false;if('${fault}'==='consent')carrierCurrent={...carrierCurrent,authentication:[]};if('${fault}'==='selection')current={...current,keep:false};
  if('${fault}'==='browser-fence'||'${fault}'==='tab-fence'){const s=await scopes();await('${fault}'==='browser-fence'?browserOwner:tabOwner).forget('${fault}'==='browser-fence'?s.b:s.t,()=>true,()=>false)};
  if('${fault}'==='close')void(window.closing=bootstrap.close().then(()=>closeDone=true));if('${fault}'==='browser-close')void(window.closing=browserOwner.close().then(()=>closeDone=true));
  if('${fault}'==='tab-close')void(window.closing=tabOwner.close().then(()=>closeDone=true))})()`)
 if(fault.endsWith('close'))expect(await page.evaluate('closeDone')).toBe(false)
 await page.evaluate('upgrade(bunker);querying');if(fault.endsWith('close'))await page.evaluate('closing')
 expect(await page.evaluate('[receipt,authSigns,frames.length,nativeHeld]')).toEqual([fault==='valid'?'ok':'OrdinaryStateHold',fault==='valid'?2:0,fault==='valid'?4:0,0])
})
for(const fault of ['consent','selection','same-byte-revision'] as const)test(`actual SDK query retry rechecks ${fault} and prevents queued second relay`,async({page})=>{
 await start(page);await page.evaluate(`carrier();authHook=event=>{walletLocked.push(nativeHeld>0);throw Error('Request failed')};query();undefined`);await page.waitForFunction('authSigns===1')
 await page.evaluate(`(async()=>{if('${fault}'==='consent')carrierCurrent={...carrierCurrent,authentication:[]};if('${fault}'==='selection')current={...current,keep:false};
  if('${fault}'==='same-byte-revision'){const s=await scopes();await browserOwner.mutateMigrated(s.b,()=>true,()=>{})};await querying})()`)
 expect(await page.evaluate('[receipt,authSigns,frames.length,walletLocked]')).toEqual(['OrdinaryStateHold',1,0,[true]])
})
for(const target of ['bootstrap','browser','tab','signer'] as const)test(`unabortable SDK AUTH joins ${target} close and never starts the queued second relay`,async({page})=>{
 await start(page);await page.evaluate(`carrier();window.walletStarted=false;authHook=event=>{walletLocked.push(nativeHeld>0);walletStarted=true;return new Promise(resolve=>window.releaseWallet=()=>resolve(authSign(event)))};query();undefined`)
 await page.waitForFunction('walletStarted')
 await page.evaluate(`window.closeDone=false;window.closing=${target==='bootstrap'?'bootstrap':target==='browser'?'browserOwner':target==='tab'?'tabOwner':'identity'}.close().then(()=>closeDone=true);undefined`)
 expect(await page.evaluate('[receipt,closeDone,authSigns,nativeHeld,frames.length]')).toEqual(['pending',false,1,0,0])
 await page.evaluate('releaseWallet();querying');await page.evaluate('closing')
 expect(await page.evaluate('[receipt,closeDone,authSigns,frames.length,walletLocked]')).toEqual(['OrdinaryStateHold',true,1,0,[true]])
})
for(const fault of ['valid','selection','same-byte-revision','browser-fence','close'] as const)test(`deferred actual SDK credential ${fault} validates bootstrap source before provider start`,async({page})=>{
 await start(page);await page.evaluate('makeDeferred()');await page.evaluate(`window.receipt='pending';window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);receipt='ok'},e=>receipt=e.name);undefined`);await page.waitForFunction('deferredCalled')
 await page.evaluate(`(async()=>{if('${fault}'==='selection')current={...current,keep:false};if('${fault}'==='same-byte-revision'){const s=await scopes();await browserOwner.mutateMigrated(s.b,()=>true,()=>{})};
  if('${fault}'==='browser-fence'){const s=await scopes();await browserOwner.forget(s.b,()=>true,()=>false)};if('${fault}'==='close')void(window.closing=bootstrap.close());upgrade(bunker);await pending})()`)
 if(fault==='close')await page.evaluate('closing')
 expect(await page.evaluate('[receipt,signCalls]')).toEqual([fault==='valid'?'ok':'OrdinaryStateHold',fault==='valid'?1:0])
})
for(const fault of ['selection','same-byte-revision'] as const)test(`actual SDK credential retry rechecks ${fault} without a second provider attempt`,async({page})=>{
 await start(page);await page.evaluate(`signHook=event=>{walletLocked.push(nativeHeld>0);throw Error('Request failed')};window.receipt='pending';window.pending=start().then(r=>{Ordinary.wipeOrdinaryPersistentBootstrapResult(r);receipt='ok'},e=>receipt=e.name);undefined`)
 await page.waitForFunction('signCalls===1')
 await page.evaluate(`(async()=>{if('${fault}'==='selection')current={...current,keep:false};else{const s=await scopes();await browserOwner.mutateMigrated(s.b,()=>true,()=>{})};await pending})()`)
 expect(await page.evaluate('[receipt,signCalls,walletLocked]')).toEqual(['OrdinaryStateHold',1,[true]])
})
