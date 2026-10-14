import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-extension-restore.kithmoot.test'
let bundle = '', staleBundle = ''
test.beforeAll(async () => {
  const entry = fileURLToPath(new URL('./ordinary-extension-restore.browser-entry.ts', import.meta.url))
  const base = { entryPoints: [entry], bundle: true, format: 'iife' as const, globalName: 'Ordinary', platform: 'browser' as const, write: false as const, target: 'es2022' }
  bundle = (await build(base)).outputFiles[0]!.text
  const sdk = fileURLToPath(new URL('../node_modules/signet-login/dist/signet-login.js', import.meta.url))
  staleBundle = (await build({ ...base, plugins: [{ name: 'sdk-without-headless-contract', setup(builder) {
    builder.onResolve({ filter: /^signet-login$/ }, () => ({ path: 'stale-sdk', namespace: 'contract-fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'contract-fixture' }, () => ({ contents: `export const HEADLESS_PROVIDER_EFFECT_BOUNDARY = undefined; export * from ${JSON.stringify(sdk)};`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) }))
  } }] })).outputFiles[0]!.text
})
const setup = `async()=>{
 window.live=true;window.generation=0;window.stops=0;window.discoveries=0;window.signs=0;window.nativeHeld=0;window.startsUnderLock=[];window.rawCloses=0;
 window.key=new Uint8Array(32);key[31]=1;window.account=Ordinary.getPublicKey(key);window.k=Ordinary.ORDINARY_SIGNET_KEYS;window.guard=()=>live;
 const locks=navigator.locks.request.bind(navigator.locks);navigator.locks.request=(name,...args)=>{const callback=args.pop();return locks(name,...args,async lock=>{
  if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld++;try{return await callback(lock)}finally{if(name===Ordinary.ORDINARY_DATABASE+':write')nativeHeld--}})};
 window.behaviour='normal';window.entered=null;window.release=null;
 window.nostr={getPublicKey:async()=>{discoveries++;startsUnderLock.push(nativeHeld>0);if(behaviour==='hold'){entered();await new Promise(resolve=>release=resolve)}
  if(behaviour==='reject')throw Error('wallet unavailable');return behaviour==='wrong-account'?'f'.repeat(64):account},
  signEvent:async event=>{signs++;startsUnderLock.push(nativeHeld>0);if(behaviour==='sign-hold'){entered();await new Promise(resolve=>release=resolve)}return Ordinary.finalizeEvent(event,key)},
  nip44:{encrypt:async(_peer,text)=>'encrypted:'+text,decrypt:async(_peer,text)=>text.slice(10)}};
 const close=Ordinary.Nip07Signer.prototype.close;Ordinary.Nip07Signer.prototype.close=function(){rawCloses++;return close.call(this)};
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabPurpose='tab:'+'a'.repeat(64);window.tabExpiry=Date.now()+3600_000;window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);
 const migration={phase:'complete',sources:new Map(),names:[]};await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration);
 window.seed=async(owner,changes)=>{const scope=await owner.capture('@test-seed',()=>true);await owner.mutateMigrated(scope,()=>true,store=>{
  for(const[name,value]of Object.entries(changes)){if(value===null)store.remove(name);else store.set(name,value)}})};
 window.proof=Ordinary.finalizeEvent({kind:21236,created_at:Math.floor(Date.now()/1000)-86400*30,content:'',tags:[['challenge','c'.repeat(64)],['origin',location.origin],['app','KithMoot']]},key);
 window.proofRaw=JSON.stringify(proof);window.sessionExpiry=Date.now()+600_000;
 await seed(browserOwner,{[k.pubkey]:account,[k.method]:'nip07',[k.authEvent]:proofRaw,[k.expiresAt]:String(sessionExpiry),[k.displayName]:'Retained name',[k.clientSk]:'01'.repeat(32)});
 window.clientFailure=false;window.clientHook=async()=>{};window.options={browser:browserOwner,tab:tabOwner,generation:0,currentGeneration:()=>generation,live:guard,
  checkClients:async()=>{await clientHook();if(clientFailure)throw Error('old client')},stop:()=>{stops++;live=false}};
 window.openController=()=>Ordinary.OrdinaryExtensionRestore.open(options);window.controller=null;
 window.rawRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
  const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.images=async()=>Promise.all((await rawRows()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)));
 window.forget=async owner=>{const scope=await owner.capture('@ordinary-signet',()=>true);await owner.forget(scope,()=>true,()=>false)};
 window.begin=()=>{window.receipt='pending';window.result=null;window.started=new Promise(resolve=>entered=resolve);
  window.pending=controller.restoreExtension().then(value=>{result=value;receipt='success'},error=>receipt=error.name)};
 window.countCrypto=()=>{window.entropy=0;window.encryptions=0;const random=crypto.getRandomValues.bind(crypto),encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.getRandomValues=(...args)=>{entropy++;return random(...args)};crypto.subtle.encrypt=(...args)=>{encryptions++;return encrypt(...args)};
  window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.encrypt=encrypt}};
 window.sameRows=(before,after)=>after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame));
}`
async function open(context: BrowserContext, stale = false) {
  const source = stale ? staleBundle : bundle
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script>' + source.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate('(' + setup + ')()'); return page
}
test('restore discovers the retained account without signing, entropy or writes and exposes the native wrapper',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const before=await rawRows();countCrypto();controller=await openController();const session=await controller.restoreExtension();
  const answer=[session.pubkey===account,session.method,session.signer instanceof Ordinary.OrdinaryForegroundSigner,Object.isFrozen(session),Object.isFrozen(session.authEvent.tags[0]),
   JSON.stringify(session.authEvent)===proofRaw,session.expiresAt===sessionExpiry,session.displayName,discoveries,signs,startsUnderLock.every(Boolean),entropy,encryptions,
   sameRows(before,await rawRows()),Object.keys(localStorage),Object.keys(sessionStorage)];restoreCrypto();await controller.close();answer.push(rawCloses);return answer})()`))
  .toEqual([true,'nip07',true,true,true,true,true,'Retained name',1,0,true,0,0,true,[],[],1]);await context.close()
})
test('restored signing and encryption use fresh native decisions and do not persist a new proof',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const before=await rawRows();controller=await openController();const session=await controller.restoreExtension();
  const event=await session.signer.signEvent({kind:1,created_at:1,content:'restored message',tags:[]}),encrypted=await session.signer.nip44.encrypt(account,'private');
  const answer=[event.content,encrypted,discoveries,signs,startsUnderLock.every(Boolean),sameRows(before,await rawRows())];await controller.close();return answer})()`))
  .toEqual(['restored message','encrypted:private',1,1,true,true]);await context.close()
})
for(const fault of ['absent','auth-only','malformed-proof','noncanonical-json','uppercase-proof','expired','overlapping-redirect','overlapping-relay','unknown-browser','unknown-tab','incomplete-migration'] as const)
test(`${fault} holds at opening before discovery and preserves the native frames`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{
  if('${fault}'==='absent')await seed(browserOwner,{[k.pubkey]:null,[k.method]:null,[k.authEvent]:null,[k.expiresAt]:null,[k.displayName]:null});
  if('${fault}'==='auth-only')await seed(browserOwner,{[k.method]:'redirect'});
  if('${fault}'==='malformed-proof')await seed(browserOwner,{[k.authEvent]:JSON.stringify({...proof,sig:'f'.repeat(128)})});
  if('${fault}'==='noncanonical-json')await seed(browserOwner,{[k.authEvent]:JSON.stringify(proof,null,2)});
  if('${fault}'==='uppercase-proof')await seed(browserOwner,{[k.authEvent]:JSON.stringify({...proof,id:proof.id.toUpperCase(),sig:proof.sig.toUpperCase()})});
  if('${fault}'==='expired')await seed(browserOwner,{[k.expiresAt]:String(Date.now()-1)});
  if('${fault}'==='overlapping-redirect')await seed(browserOwner,{[k.pendingRedirect]:JSON.stringify({challenge:'d'.repeat(64),origin:location.origin,appName:'KithMoot',createdAt:Date.now()})});
  if('${fault}'==='overlapping-relay')await seed(browserOwner,{[k.pendingRelayAuth]:JSON.stringify({challenge:'d'.repeat(64),origin:location.origin,appName:'KithMoot',relayUrl:'wss://relay.test',sessionSkHex:'01'.repeat(32),issuedAt:Date.now()})});
  if('${fault}'==='unknown-browser')await seed(browserOwner,{'kithmoot.unclassified-private':'keep'});if('${fault}'==='unknown-tab')await seed(tabOwner,{'kithmoot.unclassified-private':'keep'});
  if('${fault}'==='incomplete-migration'){const row=(await rawRows())[0],image=await Ordinary.openOrdinaryFrame(row.frame,row.key);image.migration={...image.migration,phase:'sealed'};
   row.frame=await Ordinary.sealOrdinaryImage(image,row.key);await new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners','readwrite');tx.objectStore('owners').put(row,'browser');tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}})};
  const before=await rawRows();countCrypto();let error;try{controller=await openController()}catch(e){error=e.name};if(controller)await controller.close();
  const answer=[error,discoveries,signs,entropy,encryptions,sameRows(before,await rawRows())];restoreCrypto();return answer})()`))
  .toEqual(['OrdinaryStateHold',0,0,0,0,true]);await context.close()
})
for(const fault of ['generation','client','client-key','proof','display-name','pending-redirect','browser-forget','tab-forget','unknown-record','session-expiry','tab-expiry'] as const)
test(`${fault} after opening prevents discovery without changing retained data`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{controller=await openController();if('${fault}'==='generation')generation++;if('${fault}'==='client')clientFailure=true;
  if('${fault}'==='client-key')await seed(browserOwner,{[k.clientSk]:'02'.repeat(32)});if('${fault}'==='proof')await seed(browserOwner,{[k.authEvent]:JSON.stringify(Ordinary.finalizeEvent({...proof,created_at:proof.created_at+1},key))});
  if('${fault}'==='display-name')await seed(browserOwner,{[k.displayName]:'changed'});
  if('${fault}'==='pending-redirect')await seed(browserOwner,{[k.pendingRedirect]:JSON.stringify({challenge:'d'.repeat(64),origin:location.origin,appName:'KithMoot',createdAt:Date.now()})});
  if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);
  if('${fault}'==='unknown-record')await seed(browserOwner,{'kithmoot.unclassified-private':'keep'});
  if('${fault}'==='session-expiry')Date.now=()=>sessionExpiry;if('${fault}'==='tab-expiry')Date.now=()=>tabExpiry;
  const before=await rawRows();countCrypto();let error;try{await controller.restoreExtension()}catch(e){error=e.name};await controller.close();
  const answer=[error,discoveries,signs,entropy,encryptions,sameRows(before,await rawRows()),stops];restoreCrypto();return answer})()`))
  .toEqual([fault==='client'?'Error':'OrdinaryStateHold',0,0,0,0,true,1]);await context.close()
})
for(const fault of ['close','browser-close','tab-close','generation','client','client-key','display-name','browser-forget','tab-forget','unknown-record','session-expiry','provider-substitution'] as const)
test(`${fault} during discovery joins the unabortable request and refuses the handoff`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(async()=>{controller=await openController();behaviour='hold';begin()})()`);await page.evaluate('started')
 await page.evaluate(`(async()=>{window.closeDone=false;
  if('${fault}'==='close')void(window.closing=controller.close().then(()=>closeDone=true));if('${fault}'==='browser-close')void(window.closing=browserOwner.close().then(()=>closeDone=true));
  if('${fault}'==='tab-close')void(window.closing=tabOwner.close().then(()=>closeDone=true));if('${fault}'==='generation')generation++;if('${fault}'==='client')clientFailure=true;
  if('${fault}'==='client-key')await seed(browserOwner,{[k.clientSk]:'02'.repeat(32)});if('${fault}'==='display-name')await seed(browserOwner,{[k.displayName]:'changed'});
  if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);if('${fault}'==='unknown-record')await seed(browserOwner,{'kithmoot.unclassified-private':'keep'});
  if('${fault}'==='session-expiry')Date.now=()=>sessionExpiry;if('${fault}'==='provider-substitution')window.nostr={...nostr};window.before=await rawRows();
 })()`)
 expect(await page.evaluate('[receipt,result,closeDone,nativeHeld]')).toEqual(['pending',null,false,0])
 await page.evaluate('release();pending');await page.evaluate('controller.close()');if(fault.endsWith('close'))await page.evaluate('closing')
 expect(await page.evaluate('(async()=>[receipt,result,discoveries,signs,stops,sameRows(before,await rawRows())])()'))
  .toEqual([fault==='client'||fault==='provider-substitution'?'Error':'OrdinaryStateHold',null,1,0,1,true]);await context.close()
})
for(const behaviour of ['wrong-account','reject'] as const)test(`${behaviour} leaves stored session intact for explicit recovery`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const before=await rawRows();controller=await openController();behaviour='${behaviour}';let error;try{await controller.restoreExtension()}catch(e){error=e.name};
  await controller.close();return[error,discoveries,signs,rawCloses,sameRows(before,await rawRows())]})()`))
  .toEqual([behaviour==='wrong-account'?'OrdinaryStateHold':'Error',1,0,behaviour==='wrong-account'?1:0,true]);await context.close()
})
test('missing headless contract refuses before discovery, entropy or writes',async({browser})=>{
 const context=await browser.newContext(),page=await open(context,true)
 expect(await page.evaluate(`(async()=>{const before=await rawRows();countCrypto();let error;try{await openController()}catch(e){error=e.name};
  const answer=[error,discoveries,signs,entropy,encryptions,sameRows(before,await rawRows())];restoreCrypto();return answer})()`))
  .toEqual(['OrdinaryStateHold',0,0,0,0,true]);await context.close()
})
test('client-selector reentrancy stops both restores before any account discovery',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{controller=await openController();let nested,once=false;clientHook=async()=>{if(!once){once=true;nested=controller.restoreExtension().catch(e=>e.name)}};
  let error;try{await controller.restoreExtension()}catch(e){error=e.name};const second=await nested;await controller.close();return[error,second,discoveries,signs,stops]})()`))
  .toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,1]);await context.close()
})
test('a concurrent second restore cannot start another discovery or expose the old result',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(async()=>{controller=await openController();behaviour='hold';begin()})()`);await page.evaluate('started')
 expect(await page.evaluate('controller.restoreExtension().catch(e=>e.name)')).toBe('OrdinaryStateHold')
 expect(await page.evaluate('[receipt,discoveries,rawCloses,nativeHeld]')).toEqual(['pending',1,0,0])
 await page.evaluate('release();pending');await page.evaluate('controller.close()');expect(await page.evaluate('[receipt,result,discoveries,signs]')).toEqual(['OrdinaryStateHold',null,1,0]);await context.close()
})
test('restore owner revokes and joins foreground signing before closing its raw wrapper',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(async()=>{controller=await openController();window.session=await controller.restoreExtension();behaviour='sign-hold';window.started=new Promise(resolve=>entered=resolve);window.receipt='pending';
  window.pending=session.signer.signEvent({kind:1,created_at:1,tags:[],content:'wait'}).then(()=>receipt='success',e=>receipt=e.name)})()`);await page.evaluate('started')
 await page.evaluate('window.closeDone=false;void(window.closing=controller.close().then(()=>closeDone=true))')
 expect(await page.evaluate('[receipt,closeDone,rawCloses,nativeHeld]')).toEqual(['pending',false,0,0])
 await page.evaluate('release();pending;');await page.evaluate('closing');expect(await page.evaluate('[receipt,closeDone,rawCloses,discoveries,signs]')).toEqual(['OrdinaryStateHold',true,1,1,1]);await context.close()
})
test('expired restored session suppresses signing and closes the owned raw wrapper',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{controller=await openController();const session=await controller.restoreExtension();Date.now=()=>sessionExpiry;
  let error;try{await session.signer.signEvent({kind:1,created_at:1,tags:[],content:'expired'})}catch(e){error=e.name};await controller.close();return[error,discoveries,signs,rawCloses]})()`))
  .toEqual(['OrdinaryStateHold',1,0,1]);await context.close()
})
test('a fresh owner can restore the same historical proof without replacing it',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const before=await rawRows();controller=await openController();await controller.restoreExtension();await controller.close();await Promise.all([browserOwner.close(),tabOwner.close()]);
  live=true;generation++;browserOwner=new Ordinary.OrdinaryStateOwner();tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);const migration={phase:'complete',sources:new Map(),names:[]};
  await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration);options={...options,browser:browserOwner,tab:tabOwner,generation};controller=await openController();
  const session=await controller.restoreExtension(),answer=[session.pubkey===account,JSON.stringify(session.authEvent)===proofRaw,discoveries,signs,sameRows(before,await rawRows())];await controller.close();return answer})()`))
  .toEqual([true,true,2,0,true]);await context.close()
})
test('a retained bunker session requires its separate guarded connection path without starting discovery',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{await seed(browserOwner,{[k.method]:'bunker',[k.bunkerUri]:'bunker://'+account+'?relay=wss%3A%2F%2Frelay.test',[k.bunkerClientSk]:'01'.repeat(32)});
  const before=await rawRows();let error;try{await openController()}catch(e){error=e.name};return[error,discoveries,signs,sameRows(before,await rawRows())]})()`))
  .toEqual(['OrdinaryStateHold',0,0,true]);await context.close()
})
test('an absent extension does not downgrade or delete the retained identity',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{window.nostr=undefined;const before=await rawRows();controller=await openController();let error;try{await controller.restoreExtension()}catch(e){error=e.name};
  await controller.close();return[error,discoveries,signs,rawCloses,sameRows(before,await rawRows())]})()`))
  .toEqual(['Error',0,0,0,true]);await context.close()
})
test('a changed SDK partition at provider settlement prevents session adoption',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{controller=await openController();let once=false;clientHook=async()=>{if(discoveries===1&&!once){once=true;await seed(browserOwner,{[k.clientSk]:'02'.repeat(32)})}};
  let error;try{await controller.restoreExtension()}catch(e){error=e.name};await controller.close();return[error,discoveries,signs,stops]})()`))
  .toEqual(['OrdinaryStateHold',1,0,1]);await context.close()
})
test('session expiry timer closes an adopted raw wrapper and leaves native records unchanged',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(async()=>{sessionExpiry=Date.now()+2000;await seed(browserOwner,{[k.expiresAt]:String(sessionExpiry)});window.before=await rawRows();controller=await openController();window.session=await controller.restoreExtension()})()`)
 await page.waitForFunction('rawCloses===1')
 expect(await page.evaluate(`(async()=>{let error;try{await session.signer.signEvent({kind:1,created_at:1,tags:[],content:'expired'})}catch(e){error=e.name};
  await controller.close();return[error,discoveries,signs,rawCloses,stops,sameRows(before,await rawRows())]})()`))
  .toEqual(['OrdinaryStateHold',1,0,1,1,true]);await context.close()
})
test('session expiry during wallet discovery remains joined and cannot expose a result',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(async()=>{sessionExpiry=Date.now()+2000;await seed(browserOwner,{[k.expiresAt]:String(sessionExpiry)});window.before=await rawRows();controller=await openController();behaviour='hold';begin()})()`);await page.evaluate('started')
 await page.waitForFunction('stops===1');await page.evaluate('window.closeDone=false;void(window.closing=controller.close().then(()=>closeDone=true))')
 expect(await page.evaluate('[receipt,result,closeDone,nativeHeld]')).toEqual(['pending',null,false,0])
 await page.evaluate('release();pending');await page.evaluate('closing')
 expect(await page.evaluate('(async()=>[receipt,result,closeDone,discoveries,signs,rawCloses,sameRows(before,await rawRows())])()'))
  .toEqual(['OrdinaryStateHold',null,true,1,0,0,true]);await context.close()
})
test('native tab expiry closes the restored wrapper before its longer session lease',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(async()=>{await tabOwner.close();tabPurpose='tab:'+'b'.repeat(64);tabExpiry=Date.now()+2000;tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);
  await tabOwner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});options={...options,tab:tabOwner};window.before=await rawRows();
  controller=await openController();window.session=await controller.restoreExtension()})()`)
 await page.waitForFunction('rawCloses===1')
 expect(await page.evaluate(`(async()=>{let error;try{await session.signer.signEvent({kind:1,created_at:1,tags:[],content:'tab expired'})}catch(e){error=e.name};
  await controller.close();return[error,discoveries,signs,rawCloses,stops,Date.now()<sessionExpiry,sameRows(before,await rawRows())]})()`))
  .toEqual(['OrdinaryStateHold',1,0,1,1,true,true]);await context.close()
})
