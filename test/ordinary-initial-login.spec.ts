import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-initial-login.kithmoot.test'
let bundle = '', staleBundle = ''
test.beforeAll(async () => {
  const entry = fileURLToPath(new URL('./ordinary-initial-login.browser-entry.ts', import.meta.url))
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
 window.nostr={getPublicKey:async()=>{discoveries++;startsUnderLock.push(nativeHeld>0);if(behaviour==='discovery-hold'){entered();await new Promise(resolve=>release=resolve)}return account},
  signEvent:async event=>{signs++;startsUnderLock.push(nativeHeld>0);if(behaviour==='retry'&&signs===1)throw Error('Request failed');
   if(behaviour==='sign-hold'){entered();await new Promise(resolve=>release=resolve)}
   const signed=Ordinary.finalizeEvent(event,key);if(behaviour==='wrong-template')return Ordinary.finalizeEvent({...event,content:'substituted'},key);
   if(behaviour==='wrong-signature')return {...signed,sig:'f'.repeat(128)};
   if(behaviour==='noncanonical-proof')return {...signed,id:signed.id.toUpperCase(),sig:signed.sig.toUpperCase()};return signed},nip44:{encrypt:async(_peer,text)=>'encrypted:'+text,decrypt:async(_peer,text)=>text.slice(10)}};
 const close=Ordinary.Nip07Signer.prototype.close;Ordinary.Nip07Signer.prototype.close=function(){rawCloses++;return close.call(this)};
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabPurpose='tab:'+'a'.repeat(64);window.tabExpiry=Date.now()+3600_000;window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);
 const migration={phase:'complete',sources:new Map(),names:[]};await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration);
 window.clientFailure=false;window.clientHook=async()=>{};window.options={browser:browserOwner,tab:tabOwner,generation:0,currentGeneration:()=>generation,live:guard,
  checkClients:async()=>{await clientHook();if(clientFailure)throw Error('old client')},stop:()=>{stops++;live=false}};
 window.openController=()=>Ordinary.OrdinaryInitialLogin.open(options);window.controller=null;
 window.rawRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
  const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.images=async()=>Promise.all((await rawRows()).map(row=>Ordinary.openOrdinaryFrame(row.frame,row.key)));
 window.peek=async()=>{const [b,t]=await images();const raw=t.records.get(Ordinary.ORDINARY_INITIAL_LOGIN_KEY);return{pending:raw?JSON.parse(raw):null,sdk:b.records.get(k.pubkey)??null,
  browserRevision:b.revision,tabRevision:t.revision,fences:[b.fences.get('@ordinary-signet'),t.fences.get('@ordinary-signet')]}};
 window.seed=async(owner,changes)=>{const scope=await owner.capture('@test-seed',()=>true);await owner.mutateMigrated(scope,()=>true,store=>{
  for(const[name,value]of Object.entries(changes)){if(value===null)store.remove(name);else store.set(name,value)}})};
 window.forget=async owner=>{const scope=await owner.capture('@ordinary-signet',()=>true);await owner.forget(scope,()=>true,()=>false)};
 window.begin=()=>{window.receipt='pending';window.result=null;window.started=new Promise(resolve=>entered=resolve);
  window.pending=controller.loginExtension().then(value=>{result=value;receipt='success'},error=>receipt=error.name)};
 window.countCrypto=()=>{window.entropy=0;window.encryptions=0;const random=crypto.getRandomValues.bind(crypto),encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.getRandomValues=(...args)=>{entropy++;return random(...args)};crypto.subtle.encrypt=(...args)=>{encryptions++;return encrypt(...args)};
  window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.encrypt=encrypt}};
}`
async function open(context: BrowserContext, stale = false) {
  const source = stale ? staleBundle : bundle
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script>' + source.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate('(' + setup + ')()'); return page
}
test('initial login retains the proof atomically and exposes only the native foreground signer', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{controller=await openController();const session=await controller.loginExtension(), state=await peek(), before=await rawRows();
   const event=await session.signer.signEvent({kind:1,created_at:Math.floor(Date.now()/1000),tags:[],content:'native message'}),after=await rawRows();
   const answer=[session.pubkey===account,session.method,session.signer instanceof Ordinary.OrdinaryForegroundSigner,session.signer.providerEffectBoundary===undefined,
    Object.isFrozen(session),Object.isFrozen(session.authEvent.tags[0]),state.pending,state.sdk===account,state.browserRevision===state.tabRevision,state.fences,
    discoveries,signs,startsUnderLock.every(Boolean),event.content,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),Object.keys(localStorage),Object.keys(sessionStorage)];
   await controller.close();return answer})()`)).toEqual([true,'nip07',true,true,true,true,null,true,true,[0,0],1,2,true,'native message',true,[],[]])
  await context.close()
})
for (const stage of ['discovery', 'sign'] as const) test(`challenge custody acknowledges before ${stage} and waiting releases the native lock`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  await page.evaluate(`(async()=>{controller=await openController();behaviour='${stage}-hold';begin()})()`); await page.evaluate('started')
  expect(await page.evaluate(`(async()=>{const value=await peek();await seed(browserOwner,{'non-private-fixture':null});return[receipt,nativeHeld,value.pending.method,
   /^[0-9a-f]{64}$/.test(value.pending.challenge),value.pending.account===${stage === 'sign' ? 'account' : 'null'},value.sdk,discoveries,signs]})()`))
    .toEqual(['pending',0,'nip07',true,true,null,1,stage==='sign'?1:0])
  await page.evaluate('release();pending'); expect(await page.evaluate('receipt')).toBe('success'); await page.evaluate('controller.close()'); await context.close()
})
for (const fault of ['generation','client','sdk-change','unknown-record','browser-forget','tab-forget'] as const) test(`${fault} refuses initial effects`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{controller=await openController();countCrypto();if('${fault}'==='generation')generation++;
   if('${fault}'==='client')clientFailure=true;if('${fault}'==='sdk-change')await seed(browserOwner,{[k.clientSk]:'01'.repeat(32)});
   if('${fault}'==='unknown-record')await seed(browserOwner,{'kithmoot.unclassified-private':'keep'});
   if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='tab-forget')await forget(tabOwner);
   entropy=0;encryptions=0;let error;try{await controller.loginExtension()}catch(e){error=e.name};await controller.close();restoreCrypto();return[error,discoveries,signs,entropy,encryptions,stops]})()`))
    .toEqual([fault==='client'?'Error':'OrdinaryStateHold',0,0,0,0,1]); await context.close()
})
for (const stage of ['discovery','sign'] as const) for (const fault of ['close','browser-close','tab-close','generation','sdk-change','tab-forget','client','expiry','pending-account','pending-owner','browser-forget','unknown-record'] as const)
test(`${fault} during ${stage} joins the unabortable request and suppresses handoff`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  await page.evaluate(`(async()=>{controller=await openController();behaviour='${stage}-hold';begin()})()`); await page.evaluate('started')
  await page.evaluate(`(async()=>{window.closeDone=false;
   if('${fault}'==='close')void(window.closing=controller.close().then(()=>closeDone=true));if('${fault}'==='browser-close')void(window.closing=browserOwner.close().then(()=>closeDone=true));
   if('${fault}'==='tab-close')void(window.closing=tabOwner.close().then(()=>closeDone=true));if('${fault}'==='generation')generation++;
   if('${fault}'==='sdk-change')await seed(browserOwner,{[k.clientSk]:'01'.repeat(32)});if('${fault}'==='tab-forget')await forget(tabOwner);if('${fault}'==='client')clientFailure=true;
   if('${fault}'==='expiry'){const value=await peek();Date.now=()=>value.pending.expiresAt}
   if('${fault}'==='pending-account'){const value=await peek();await seed(tabOwner,{[Ordinary.ORDINARY_INITIAL_LOGIN_KEY]:JSON.stringify({...value.pending,account:'f'.repeat(64)})})}
   if('${fault}'==='pending-owner'){const value=await peek();await seed(tabOwner,{[Ordinary.ORDINARY_INITIAL_LOGIN_KEY]:JSON.stringify({...value.pending,browser:{...value.pending.browser,generation:'b'.repeat(64)}})})}
   if('${fault}'==='browser-forget')await forget(browserOwner);if('${fault}'==='unknown-record')await seed(browserOwner,{'kithmoot.unclassified-private':'keep'});
  })()`)
  expect(await page.evaluate('[receipt,closeDone,nativeHeld]')).toEqual(['pending',false,0])
  await page.evaluate('release();pending'); await page.evaluate('controller.close()'); if(fault.endsWith('close')) await page.evaluate('closing')
  expect(await page.evaluate('[receipt,result,discoveries,signs,stops]')).toEqual([fault==='client'?'Error':'OrdinaryStateHold',null,1,stage==='sign'?1:0,1]); await context.close()
})
test('fenced cancellation prevents old results and allows a fresh explicit login', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(async()=>{controller=await openController();behaviour='sign-hold';begin()})()`);await page.evaluate('started')
  const oldChallenge = await page.evaluate('(async()=>{const value=await peek();await Ordinary.OrdinaryInitialLogin.cancelPending(options);return value.pending.challenge})()')
  expect(await page.evaluate('(async()=>{const value=await peek();return[value.pending,value.sdk,value.fences]})()')).toEqual([null,null,[1,1]])
  await page.evaluate('release();pending');expect(await page.evaluate('[receipt,result]')).toEqual(['OrdinaryStateHold',null]);await page.evaluate('controller.close()')
  expect(await page.evaluate(`(async()=>{live=true;generation++;options={...options,generation};behaviour='normal';controller=await openController();const session=await controller.loginExtension();
   return[session.authEvent.tags[0][1]!==${JSON.stringify(oldChallenge)},session.pubkey===account,discoveries,signs]})()`)).toEqual([true,true,2,2]);await page.evaluate('controller.close()');await context.close()
})
test('a retained interrupted login holds a reopened owner until explicit cancellation', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(async()=>{controller=await openController();behaviour='discovery-hold';begin();})()`);await page.evaluate('started')
  await page.evaluate('void controller.close()');await page.evaluate('release();pending');await page.evaluate('controller.close()')
  expect(await page.evaluate(`(async()=>{await Promise.all([browserOwner.close(),tabOwner.close()]);live=true;generation++;
   browserOwner=new Ordinary.OrdinaryStateOwner();tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);
   const migration={phase:'complete',sources:new Map(),names:[]};await browserOwner.prepare(guard,new Map(),migration);await tabOwner.prepare(guard,new Map(),migration);
   options={...options,browser:browserOwner,tab:tabOwner,generation};const before=await rawRows();let error;try{await openController()}catch(e){error=e.name};const after=await rawRows();
   return[error,discoveries,signs,(await peek()).pending!==null,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()`)).toEqual(['OrdinaryStateHold',1,0,true,true]);await context.close()
})
for(const fault of ['wrong-template','wrong-signature','noncanonical-proof'] as const)test(`${fault} cannot create session records`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{controller=await openController();behaviour='${fault}';let error;try{await controller.loginExtension()}catch(e){error=e.name};await controller.close();
  const value=await peek();return[error,value.sdk,value.pending!==null,discoveries,signs,rawCloses]})()`)).toEqual([fault==='noncanonical-proof'?'OrdinaryStateHold':'Error',null,true,1,1,1]);await context.close()
})
test('a second initial operation reentered from a client selector holds both without any provider',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{controller=await openController();let nested,once=false;clientHook=async()=>{if(!once){once=true;nested=controller.loginExtension().catch(e=>e.name)}};
  let error;try{await controller.loginExtension()}catch(e){error=e.name};const second=await nested;await controller.close();return[error,second,discoveries,signs,stops]})()`))
  .toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,1]);await context.close()
})
test('a real provider retry uses the retained challenge and a new native start decision',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{controller=await openController();behaviour='retry';const session=await controller.loginExtension();
  const answer=[session.pubkey===account,discoveries,signs,startsUnderLock.every(Boolean),(await peek()).pending];await controller.close();return answer})()`))
  .toEqual([true,1,2,true,null]);await context.close()
})
test('changing SDK custody during a retry prevents the second signing prompt',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 await page.evaluate(`(async()=>{controller=await openController();behaviour='retry';begin()})()`);await page.waitForFunction('signs===1')
 await page.evaluate(`seed(browserOwner,{[k.clientSk]:'01'.repeat(32)})`);await page.evaluate('pending');await page.evaluate('controller.close()')
 expect(await page.evaluate('[receipt,discoveries,signs,result]')).toEqual(['OrdinaryStateHold',1,1,null]);await context.close()
})
for(const owner of ['browser','tab'] as const)test(`${owner} capacity refuses before initial entropy or provider effects`,async({browser})=>{
 test.setTimeout(90_000);const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{const owner=${JSON.stringify(owner)}==='browser'?browserOwner:tabOwner,scope=await owner.capture('@capacity-fixture',guard);
  await owner.mutateMigrated(scope,guard,store=>{for(let i=0;i<Ordinary.ORDINARY_RECORDS-(${JSON.stringify(owner)}==='browser'?1:0);i++){const room=i.toString(16).padStart(64,'0');
   store.set(${JSON.stringify(owner)}==='browser'?'kithmoot.nudge.'+room:'kithmoot.conversation.v1.visitor.'+room,${JSON.stringify(owner)}==='browser'?'true':'')}});
  const before=await rawRows();countCrypto();let error;try{controller=await openController();await controller.loginExtension()}catch(e){error=e.name};
  const after=await rawRows();const answer=[error,discoveries,signs,entropy,encryptions,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))];restoreCrypto();return answer})()`))
  .toEqual(['OrdinaryStateHold',0,0,0,0,true]);await context.close()
})
test('a missing SDK headless contract holds before entropy or extension discovery',async({browser})=>{
 const context=await browser.newContext(),page=await open(context,true)
 expect(await page.evaluate(`(async()=>{countCrypto();let error;try{controller=await openController()}catch(e){error=e.name};restoreCrypto();return[error,entropy,encryptions,discoveries,signs]})()`))
  .toEqual(['OrdinaryStateHold',0,0,0,0]);await context.close()
})
