import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Real native owners/composer plus the reviewed SDK candidate. External
// extension and bunker backend behaviour is synthetic; startup is unmounted.
const ORIGIN = 'https://ordinary-foreground-signer.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-foreground-signer.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `async()=>{
 window.live=true;window.generation=0;window.stops=0;window.signs=0;window.crypts=0;window.rawCloses=0;window.nativeHeld=0;window.startsUnderLock=[];
 window.guard=()=>live;window.key=new Uint8Array(32);key[31]=1;window.account=Ordinary.getPublicKey(key);window.k=Ordinary.ORDINARY_SIGNET_KEYS;
 const request=navigator.locks.request.bind(navigator.locks);
 navigator.locks.request=(name,...args)=>{const callback=args.pop();return request(name,...args,async lock=>{
   if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;
   try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 window.behaviour='normal';window.entered=null;window.release=null;window.accessors=0;
 window.sign=async event=>{
   signs++;startsUnderLock.push(nativeHeld>0);
   if(behaviour==='retry'&&signs===1)throw Error('Request failed');
   if(behaviour==='hold'){entered();await new Promise(resolve=>release=resolve)}
   const result=Ordinary.finalizeEvent(event,key);
   if(behaviour==='accessor-result'){const sig=result.sig;Object.defineProperty(result,'sig',{get(){accessors++;return sig}});return result};
   if(behaviour==='wrong-event')return Ordinary.finalizeEvent({...event,content:'substituted'},key);
   if(behaviour==='bad-signature')return {...result,sig:'0'.repeat(128)};
   if(behaviour==='wrong-account'){const other=new Uint8Array(32);other[31]=2;return Ordinary.finalizeEvent(event,other)};
   return result
 };
 window.cryptoProvider={encrypt:async function(peer,text){crypts++;startsUnderLock.push(nativeHeld>0);if(this!==cryptoProvider)throw Error('lost receiver');
   if(behaviour==='hold'){entered();await new Promise(resolve=>release=resolve)}return 'encrypted:'+text},
   decrypt:async function(peer,text){crypts++;startsUnderLock.push(nativeHeld>0);if(this!==cryptoProvider)throw Error('lost receiver');
   if(behaviour==='hold'){entered();await new Promise(resolve=>release=resolve)}return text.slice('encrypted:'.length)}};
 window.nostr={getPublicKey:async()=>account,signEvent:event=>sign(event),nip04:cryptoProvider,nip44:cryptoProvider};
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabPurpose='tab:'+'a'.repeat(64);
 window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,Date.now()+3600_000);
 await browserOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
 await tabOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
 window.storage=await Ordinary.OrdinarySignetState.open({owner:browserOwner,generation:0,currentGeneration:()=>generation,live:guard,
   origin:location.origin,appName:'KithMoot',checkClients:async()=>{},stop:()=>{stops++;live=false}});
 window.rawSession=await Ordinary.login({preferredMethod:'nip07',appName:'KithMoot',storage});signs=0;startsUnderLock=[];
 window.selected=rawSession;window.clientChecks=0;window.clientFailure=false;window.clientHook=()=>{};
 window.selectionHook=()=>{};
 window.options={browser:browserOwner,tab:tabOwner,session:rawSession,currentSession:()=>{selectionHook();return selected},generation:0,currentGeneration:()=>generation,
   live:guard,checkClients:async()=>{clientChecks++;await clientHook();if(clientFailure)throw Error('old client')},stop:()=>{stops++;live=false}};
 window.adapter=await Ordinary.OrdinaryForegroundSigner.open(options);
 window.event=()=>({kind:1,created_at:Math.floor(Date.now()/1000),tags:[['t','original']],content:'native message'});
 window.seed=async changes=>{const scope=await browserOwner.capture('@test-seed',()=>true);await browserOwner.mutateMigrated(scope,()=>true,store=>{
   for(const[name,value]of Object.entries(changes)){if(value===null)store.remove(name);else store.set(name,value)}})};
 window.forget=async owner=>{const scope=await owner.capture('@ordinary-signet',()=>true);await owner.forget(scope,()=>true,()=>false)};
 window.rawRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);
   tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.begin=()=>{window.receipt='pending';window.result=null;window.started=new Promise(resolve=>entered=resolve);
   window.pending=adapter.signEvent(event()).then(value=>{result=value;receipt='success'},error=>receipt=error.name)};
 window.makeDeferred=async(kind='deferred',captureCopies=false)=>{
   await adapter.close();live=true;stops=0;window.upgradeReady=new Promise(resolve=>window.upgrade=resolve);
   const authEvent=rawSession.authEvent,uri='bunker://'+'b'.repeat(64)+'?relay=wss%3A%2F%2Frelay.test';
   window.backend={signEvent:event=>sign(event),nip04Encrypt:async()=>'',nip04Decrypt:async()=>'',nip44Encrypt:async()=>'',nip44Decrypt:async()=>'',
     getPublicKey:async()=>account,provisionRendezvous:async()=>'',ping:async()=>{},switchRelays:async()=>true,logout:async()=>{},close:async()=>{rawCloses++}};
   window.bunker=new Ordinary.BunkerSignerImpl(account,backend,uri,key);
   window.deferred=new Ordinary.DeferredBunkerSigner(account,authEvent,upgradeReady,uri,key);
   window.deferredCalled=false;const original=deferred.signEvent;deferred.signEvent=function(...args){deferredCalled=true;return original.apply(this,args)};
   for(const family of ['nip04','nip44'])for(const method of ['encrypt','decrypt']){const original=deferred[family][method];deferred[family][method]=function(...args){deferredCalled=true;return original.apply(this,args)}};
   rawSession={pubkey:account,method:'bunker',signer:kind==='live'?bunker:deferred,authEvent};selected=rawSession;
   await seed({[k.method]:'bunker',[k.bunkerUri]:uri,[k.bunkerClientSk]:Array.from(key,b=>b.toString(16).padStart(2,'0')).join('')});
   options={...options,session:rawSession};
   const slice=Uint8Array.prototype.slice;window.ownedCopies=[];
   if(captureCopies)Uint8Array.prototype.slice=function(...args){const copy=slice.apply(this,args);if(this===key)ownedCopies.push(copy);return copy};
   try{adapter=await Ordinary.OrdinaryForegroundSigner.open(options)}finally{Uint8Array.prototype.slice=slice};
 };
}`
async function open(context: BrowserContext) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate('(' + setup + ')()'); return page
}
test('actual SDK signing and all crypto methods start under fresh native custody and return detached results', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const before=await rawRows(),input=event(),signed=await adapter.signEvent(input);
    const results=[];for(const family of ['nip04','nip44']){const sealed=await adapter[family].encrypt(account,'private');results.push(sealed,await adapter[family].decrypt(account,sealed))}
    const after=await rawRows();return [signs,crypts,startsUnderLock.every(Boolean),signed.content,Object.isFrozen(signed),Object.isFrozen(signed.tags[0]),
      adapter.session.signer===adapter,Object.isFrozen(adapter.session.authEvent.tags[0]),adapter.nip46===undefined,adapter.providerEffectBoundary===undefined,
      results,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),Object.keys(localStorage),Object.keys(sessionStorage)]
  })()`)).toEqual([1,4,true,'native message',true,true,true,true,true,true,['encrypted:private','private','encrypted:private','private'],true,[],[]])
  await context.close()
})
for(const fault of ['generation','account','proof-alias','signer-method','crypto-method','client','session-bytes','browser-forget','tab-forget','unknown-record','reentrant-revoke','tab-expiry'] as const)
test(`${fault} refuses a provider before starting`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{
  const fault='${fault}';if(fault==='generation')generation++;
  if(fault==='account')selected={...rawSession};
  if(fault==='proof-alias')rawSession.authEvent.tags[0][1]='changed';
  if(fault==='signer-method')rawSession.signer.signEvent=async()=>{signs++;throw Error('replaced')};
  if(fault==='crypto-method')rawSession.signer.nip44.encrypt=async()=>{crypts++;return ''};
  if(fault==='client')clientFailure=true;
  if(fault==='session-bytes')await seed({[k.displayName]:'Changed'});
  if(fault==='browser-forget')await forget(browserOwner);
  if(fault==='tab-forget')await forget(tabOwner);
  if(fault==='unknown-record')await seed({'kithmoot.unknown-private-record':'keep'});
  if(fault==='reentrant-revoke'){const signer=rawSession.signer;Object.defineProperty(rawSession,'signer',{get(){adapter.revoke();return signer}})};
  if(fault==='tab-expiry'){const expired=tabOwner.expiresAt;Date.now=()=>expired};
  let error;try{await adapter.signEvent(event())}catch(e){error=e.name};return[error,signs,crypts,stops]
 })()`)).toEqual([fault==='client'?'Error':'OrdinaryStateHold',0,0,1]);await context.close()
})
test('a real transient extension failure retries through a new native decision',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{behaviour='retry';const result=await adapter.signEvent(event());
  return[signs,startsUnderLock,result.content,stops]})()`)).toEqual([2,[true,true],'native message',0]);await context.close()
})
for(const fault of ['session-bytes','browser-forget','tab-forget','generation'] as const)test(`a ${fault} during NIP07 retry prevents the second provider attempt`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`behaviour='retry';begin()`);await page.waitForFunction('signs===1')
 await page.evaluate(`(async()=>{if('${fault}'==='session-bytes')await seed({[k.displayName]:'Changed'});if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);if('${fault}'==='generation')generation++})()`)
 await page.evaluate('pending');expect(await page.evaluate('[receipt,signs,stops,result]')).toEqual(['OrdinaryStateHold',1,1,null]);await context.close()
})
for(const fault of ['close','browser-close','tab-close','generation','session-bytes','tab-forget','client'] as const)test(`${fault} during an unabortable provider joins it and suppresses its result`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`behaviour='hold';begin()`);await page.evaluate('started')
 // A competing native write must finish while the provider is blocked.
 await page.evaluate(`seed({'kithmoot.test-placeholder':null})`)
 await page.evaluate(`(async()=>{
  window.closeDone=false;if('${fault}'==='close')void(window.closing=adapter.close().then(()=>closeDone=true));
  if('${fault}'==='browser-close')void(window.closing=browserOwner.close().then(()=>closeDone=true));
  if('${fault}'==='tab-close')void(window.closing=tabOwner.close().then(()=>closeDone=true));
  if('${fault}'==='generation')generation++;if('${fault}'==='session-bytes')await seed({[k.displayName]:'Changed'});
  if('${fault}'==='tab-forget')await forget(tabOwner);if('${fault}'==='client')clientFailure=true;
 })()`)
 expect(await page.evaluate('[receipt,closeDone,nativeHeld,signs]')).toEqual(['pending',false,0,1])
 await page.evaluate('release();pending');if(fault.endsWith('close'))await page.evaluate('closing')
 if(fault.endsWith('close'))expect(await page.evaluate('closeDone')).toBe(true)
 expect(await page.evaluate('[receipt,result,rawCloses]')).toEqual([fault==='client'?'Error':'OrdinaryStateHold',null,0]);await context.close()
})
for(const fault of ['wrong-event','bad-signature','wrong-account','accessor-result'] as const)test(`a ${fault} result is not handed to the app`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{behaviour='${fault}';let error;try{await adapter.signEvent(event())}catch(e){error=e.name};return[error,signs,stops,accessors]})()`))
  .toEqual(['OrdinaryStateHold',1,1,0]);await context.close()
})
test('a selector mutating the caller template cannot change its captured statement',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const input=event();selectionHook=()=>{input.content='changed';input.tags[0][1]='changed'};
  const signed=await adapter.signEvent(input);return[signed.content,signed.tags,signs]})()`))
  .toEqual(['native message',[['t','original']],1]);await context.close()
})
test('a selector reentering crypto while mutating the template cannot start either provider',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const input=event();let attempted=false,nested,nestedError;
  selectionHook=()=>{if(!attempted){attempted=true;input.content='changed';input.tags[0][1]='changed';nested=adapter.nip44.encrypt(account,'private').catch(e=>nestedError=e.name)}};
  let error;try{await adapter.signEvent(input)}catch(e){error=e.name};await nested;return[error,nestedError,signs,crypts,stops]})()`))
  .toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,1]);await context.close()
})
for(const method of ['sign','encrypt'] as const)test(`concurrent ${method} cannot start a second provider and the active call remains joined`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`behaviour='hold';begin()`);await page.evaluate('started')
 expect(await page.evaluate(`(async()=>{let error;try{await ${method==='sign'?'adapter.signEvent(event())':"adapter.nip44.encrypt(account,'private')"}}catch(e){error=e.name};return[error,receipt,signs,crypts,stops]})()`))
  .toEqual(['OrdinaryStateHold','pending',1,0,1])
 await page.evaluate('release();pending');expect(await page.evaluate('[receipt,result]')).toEqual(['OrdinaryStateHold',null]);await context.close()
})
for(const fault of ['many-tags','wide-tag','aggregate','controls','surrogates','sparse-tag','sparse-part','accessor-part','accessor-content'] as const)
test(`hostile ${fault} template refuses before native reads or provider effects`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const input=event(),checks=clientChecks;
  if('${fault}'==='many-tags')input.tags=Array.from({length:129},()=>['t','x']);
  if('${fault}'==='wide-tag')input.tags=[Array(33).fill('x')];
  if('${fault}'==='aggregate')input.tags=Array.from({length:128},()=>Array(32).fill(String.fromCharCode(0).repeat(1024)));
  if('${fault}'==='controls')input.content=String.fromCharCode(0).repeat(2*1024*1024);
  if('${fault}'==='surrogates')input.content=String.fromCharCode(0xd800).repeat(2*1024*1024);
  if('${fault}'==='sparse-tag')input.tags=Array(1);
  if('${fault}'==='sparse-part')input.tags=[Array(1)];
  if('${fault}'==='accessor-part')Object.defineProperty(input.tags[0],'1',{get(){accessors++;return 'hidden'}});
  if('${fault}'==='accessor-content')Object.defineProperty(input,'content',{get(){accessors++;return 'hidden'}});
  let error;try{await adapter.signEvent(input)}catch(e){error=e.name};return[error,signs,clientChecks-checks,accessors,stops]})()`))
  .toEqual(['OrdinaryStateHold',0,0,0,1]);await context.close()
})
test('ordinary escaping and valid/lone surrogates retain their exact signed data',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const input=event();input.content=String.fromCharCode(34,92,10,0xd800)+String.fromCodePoint(0x1f334);
  const result=await adapter.signEvent(input);return[result.content===input.content,signs,stops]})()`)).toEqual([true,1,0]);await context.close()
})
for(const fault of ['oversize','accessor','toJSON','unknown-field'] as const)test(`a malformed ${fault} auth proof holds opening before client/native/provider effects`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{await adapter.close();live=true;stops=0;const before=await rawRows(),checks=clientChecks,proof=structuredClone(rawSession.authEvent);
  if('${fault}'==='oversize')proof.content=String.fromCharCode(0).repeat(2*1024*1024);
  if('${fault}'==='accessor')Object.defineProperty(proof,'content',{get(){accessors++;return ''}});
  if('${fault}'==='toJSON')proof.toJSON=()=>{accessors++;return rawSession.authEvent};
  if('${fault}'==='unknown-field')proof.future='unknown';
  selected={...rawSession,authEvent:proof};let error;try{await Ordinary.OrdinaryForegroundSigner.open({...options,session:selected})}catch(e){error=e.name};
  const after=await rawRows();return[error,signs,clientChecks-checks,accessors,stops,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`))
  .toEqual(['OrdinaryStateHold',0,0,0,1,true]);await context.close()
})
for(const kind of ['live','deferred'] as const)for(const fault of ['uri','key','native-uri','native-key'] as const)
test(`${kind} bunker ${fault} substitution refuses without backend disclosure`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context);await page.evaluate(`makeDeferred('${kind}')`)
 expect(await page.evaluate(`(async()=>{
  if('${fault}'==='uri')rawSession.signer.bunkerUri+='&secret=changed';
  if('${fault}'==='key')rawSession.signer.clientSecretKey[0]=9;
  if('${fault}'==='native-uri')await seed({[k.bunkerUri]:rawSession.signer.bunkerUri+'&secret=changed'});
  if('${fault}'==='native-key')await seed({[k.bunkerClientSk]:'03'.repeat(32)});
  let error;try{await adapter.nip44.encrypt(account,'private')}catch(e){error=e.name};return[error,signs,crypts,stops]})()`))
  .toEqual(['OrdinaryStateHold',0,0,1]);await context.close()
})
for(const method of ['sign','encrypt','decrypt'] as const)test(`deferred upgraded key mismatch is refused before ${method} data reaches the backend`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context);await page.evaluate('makeDeferred()')
 await page.evaluate(`(()=>{window.receipt='pending';window.pending=${method==='sign'?'adapter.signEvent(event())':`adapter.nip44.${method}(account,'private')`}.then(()=>receipt='success',e=>receipt=e.message)})()`)
 await page.waitForFunction('deferredCalled')
 await page.evaluate(`upgrade(new Ordinary.BunkerSignerImpl(account,backend,bunker.bunkerUri,new Uint8Array(32).fill(3)));pending`)
 expect(await page.evaluate('[receipt,signs,crypts,rawCloses]')).toEqual(['deferred-bunker-binding-mismatch',0,0,1]);await context.close()
})
test('permanent hold wipes only the adapter-owned client-key copy without needing external close',async({browser})=>{
 const context=await browser.newContext(),page=await open(context);await page.evaluate(`makeDeferred('live',true)`)
 expect(await page.evaluate(`(async()=>{generation++;let error;try{await adapter.signEvent(event())}catch(e){error=e.name};
  return[error,ownedCopies.length,ownedCopies.every(copy=>copy.every(byte=>byte===0)),key[31],key.slice(0,31).every(byte=>byte===0),rawCloses]})()`))
  .toEqual(['OrdinaryStateHold',1,true,1,true,0]);await context.close()
})
test('caller template edits during a client await cannot change what the actual SDK signs',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{
  let enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);clientHook=async()=>{enter();await gate};
  const input=event(),pending=adapter.signEvent(input);await ready;input.content='altered';input.tags[0][1]='altered';release();
  const result=await pending;return[result.content,result.tags,signs,startsUnderLock]
 })()`)).toEqual(['native message',[['t','original']],1,[true]]);await context.close()
})
for(const fault of ['valid','tab-forget','close','tab-close'] as const)test(`deferred upgrade ${fault} uses fresh native custody after becoming ready`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context);await page.evaluate('makeDeferred()')
 await page.evaluate('begin()');await page.waitForFunction('deferredCalled')
 expect(await page.evaluate('[receipt,signs]')).toEqual(['pending',0])
 if(fault==='tab-forget')await page.evaluate('forget(tabOwner)')
 if(fault==='close')await page.evaluate('window.closeDone=false;void(window.closing=adapter.close().then(()=>closeDone=true))')
 if(fault==='tab-close')await page.evaluate('window.closeDone=false;void(window.closing=tabOwner.close().then(()=>closeDone=true))')
 if(fault.endsWith('close'))expect(await page.evaluate('closeDone')).toBe(false)
 await page.evaluate('upgrade(bunker);pending');if(fault.endsWith('close'))await page.evaluate('closing')
 expect(await page.evaluate('[receipt,signs,rawCloses]')).toEqual([fault==='valid'?'success':'OrdinaryStateHold',fault==='valid'?1:0,0]);await context.close()
})
test('old SDK or auth-only signers cannot silently ignore the native boundary',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{await adapter.close();const errors=[];
  for(const authOnly of [false,true]){live=true;stops=0;const signer={...rawSession.signer,signEvent:async()=>{signs++;throw Error('unguarded')},
   capabilities:{canSignEvents:!authOnly,hasNip44:false},providerEffectBoundary:authOnly?1:undefined,pubkey:account,method:'nip07'};selected={...rawSession,signer};
   try{await Ordinary.OrdinaryForegroundSigner.open({...options,session:selected})}catch(e){errors.push([e.name,signs,stops])}}
  return errors})()`)).toEqual([['OrdinaryStateHold',0,1],['OrdinaryStateHold',0,1]]);await context.close()
})
for(const family of ['nip04','nip44'] as const)for(const method of ['encrypt','decrypt'] as const)for(const fault of ['close','tab-close','tab-forget'] as const)
test(`${family} ${method} joins a blocked provider after ${fault} and refuses its plaintext/ciphertext`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(()=>{behaviour='hold';window.receipt='pending';window.result=null;window.started=new Promise(resolve=>entered=resolve);
  window.pending=adapter['${family}']['${method}'](account,'encrypted:private').then(value=>{result=value;receipt='success'},error=>receipt=error.name)})()`)
 await page.evaluate('started');await page.evaluate(`seed({'kithmoot.test-placeholder':null})`)
 await page.evaluate(`window.closeDone=false;${fault==='close'?'void(window.closing=adapter.close().then(()=>closeDone=true))':fault==='tab-close'?'void(window.closing=tabOwner.close().then(()=>closeDone=true))':'void(window.forgetting=forget(tabOwner))'}`)
 if(fault==='tab-forget')await page.evaluate('forgetting')
 expect(await page.evaluate('[receipt,closeDone,nativeHeld,crypts]')).toEqual(['pending',false,0,1])
 await page.evaluate('release();pending');if(fault.endsWith('close'))await page.evaluate('closing')
 expect(await page.evaluate('[receipt,result,startsUnderLock,rawCloses]')).toEqual(['OrdinaryStateHold',null,[true],0]);await context.close()
})
