import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { foregroundSignerSetup } from './ordinary-foreground-signer.setup.js'

// Genuine native pair/composer and the installed reviewed SDK. Selection and
// consent below are trusted fixture controls, not membership attestations.
// Wallet backends are controlled; the final cases use real browser sockets.
const ORIGIN='https://ordinary-foreground-signing.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-foreground-signer.browser-entry.ts',import.meta.url))],
    bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text
})
const signingSetup=`async()=>{
 window.room='b'.repeat(64);window.currentRoom=room;window.consent=true;window.validations=0;window.consumerLocked=true;
 window.relayName='kithmoot.relays.v1';window.relayRow=JSON.stringify({['room:'+room]:[{url:'wss://relay.test/',read:true,write:true}]});await seed({[relayName]:relayRow});
 window.authEvent=()=>({kind:22242,created_at:Math.floor(Date.now()/1000),content:'',tags:[['relay','wss://relay.test/'],['challenge','native-challenge']]});
 window.consumer={live:()=>consent&&currentRoom===room,validate:(browser,tab,custody)=>{
  validations++;consumerLocked&&=nativeHeld>0;if(browser.get(relayName)!==relayRow)throw new Ordinary.OrdinaryStateHold()}};
 window.borrow=()=>adapter.borrowSignEvent(consumer);window.borrowed=borrow();
 window.beginBorrowed=()=>{window.receipt='pending';window.result=null;window.started=new Promise(resolve=>entered=resolve);
  window.pending=borrowed(authEvent()).then(value=>{result=value;receipt='success'},error=>receipt=error.name)};
}`
async function open(context:BrowserContext){
  await context.route(ORIGIN+'/**',route=>route.fulfill({status:200,contentType:'text/html',
    body:'<!doctype html><meta charset="utf-8"><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>'}))
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate('('+foregroundSignerSetup+')()');
  await page.evaluate('('+signingSetup+')()');return page
}
test('borrowed signing captures callbacks and the NIP42 statement before selectors, with four native checks',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{const input=authEvent();selectionHook=()=>{input.tags[1][1]='changed';input.kind=1};
   consumer.live=()=>false;consumer.validate=()=>{throw Error('changed alias')};const signed=await borrowed(input);
   return [signed.kind,signed.tags,validations,consumerLocked,signs,startsUnderLock,Object.isFrozen(borrowed),
    Object.isFrozen(signed),Object.isFrozen(signed.tags[0]),borrowed.providerEffectBoundary,borrowed.signer,borrowed.capabilities]})()`))
   .toEqual([22242,[['relay','wss://relay.test/'],['challenge','native-challenge']],4,true,1,[true],true,true,true,undefined,undefined,undefined])
  await context.close()
})
for(const fault of ['accessor','extra','symbol','null-prototype'] as const)test(`${fault} borrowed signing consumer cannot run getters or start effects`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(()=>{let calls=0,error;const value={live:()=>true,validate:()=>{}};
   if('${fault}'==='accessor')Object.defineProperty(value,'validate',{get(){calls++;return()=>{}}});
   if('${fault}'==='extra')value.extra=true;if('${fault}'==='symbol')value[Symbol('extra')]=true;
   if('${fault}'==='null-prototype')Object.setPrototypeOf(value,null);
   try{adapter.borrowSignEvent(value)}catch(e){error=e.name};return[error,calls,signs]})()`)).toEqual(['OrdinaryStateHold',0,0])
  await context.close()
})
for(const fault of ['false-live','async','reentrant','base-mutation','late-revocation'] as const)test(`${fault} signing restriction cannot waive the base native decision`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{let checked=0,nested;const call=adapter.borrowSignEvent({
   live:()=> '${fault}'!=='false-live'&&('${fault}'!=='late-revocation'||checked<2),validate:b=>{
    checked++;if('${fault}'==='async')return Promise.reject(Error('async guard'));if('${fault}'==='reentrant')nested=adapter.nip44.encrypt(account,'private').catch(e=>e.name);
    if('${fault}'==='base-mutation')b.set(k.displayName,'changed')}});let error;try{await call(authEvent())}catch(e){error=e.name};if(nested)await nested;
   return[error,signs,crypts,stops]})()`)).toEqual(['OrdinaryStateHold',0,0,1])
  await context.close()
})
test('borrowed signing refuses an external boundary before client reads, callbacks or provider calls',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{const checks=clientChecks;let calls=0,error;try{await borrowed(authEvent(),{start:()=>{calls++;throw Error('external')}})}catch(e){error=e.name};
   return[error,clientChecks-checks,validations,calls,signs,stops]})()`)).toEqual(['OrdinaryStateHold',0,0,0,0,1]);await context.close()
})
for(const fault of ['accessor','oversize','sparse-tags'] as const)test(`${fault} borrowed statement refuses before consumer callbacks`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{const input=authEvent();if('${fault}'==='accessor')Object.defineProperty(input,'content',{get(){accessors++;return ''}});
   if('${fault}'==='oversize')input.tags=Array(129).fill(['t','x']);if('${fault}'==='sparse-tags')input.tags=Array(1);
   let error;try{await borrowed(input)}catch(e){error=e.name};return[error,accessors,validations,signs]})()`)).toEqual(['OrdinaryStateHold',0,0,0]);await context.close()
})
for(const fault of ['wrong-event','bad-signature','wrong-account','accessor-result'] as const)test(`${fault} borrowed result cannot cross the handoff`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{behaviour='${fault}';let error;try{await borrowed(authEvent())}catch(e){error=e.name};return[error,signs,accessors,stops]})()`))
   .toEqual(['OrdinaryStateHold',1,0,1]);await context.close()
})
for(const fault of ['valid','consent','room','native-relays','tab-forget'] as const)test(`deferred SDK upgrade ${fault} rechecks signing consent at the actual backend start`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context);await page.evaluate('(async()=>{await makeDeferred();borrowed=borrow();beginBorrowed()})()')
  await page.waitForFunction('deferredCalled');expect(await page.evaluate('[receipt,signs]')).toEqual(['pending',0])
  await page.evaluate(`(async()=>{if('${fault}'==='consent')consent=false;if('${fault}'==='room')currentRoom='c'.repeat(64);
   if('${fault}'==='native-relays')await seed({[relayName]:'{}'});if('${fault}'==='tab-forget')await forget(tabOwner);upgrade(bunker);await pending})()`)
  expect(await page.evaluate('[receipt,signs,consumerLocked,startsUnderLock,rawCloses]'))
   .toEqual([fault==='valid'?'success':'OrdinaryStateHold',fault==='valid'?1:0,true,fault==='valid'?[true]:[],0]);await context.close()
})
for(const fault of ['consent','room','native-relays'] as const)test(`${fault} between actual SDK retry attempts suppresses the second signing disclosure`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context);await page.evaluate(`behaviour='retry';beginBorrowed()`);await page.waitForFunction('signs===1')
  await page.evaluate(`(async()=>{if('${fault}'==='consent')consent=false;if('${fault}'==='room')currentRoom='c'.repeat(64);
   if('${fault}'==='native-relays')await seed({[relayName]:'{}'});await pending})()`)
  expect(await page.evaluate('[receipt,signs,result,startsUnderLock]')).toEqual(['OrdinaryStateHold',1,null,[true]]);await context.close()
})
for(const fault of ['consent','room','native-relays','adapter-close','browser-close','tab-close'] as const)test(`${fault} during unabortable borrowed signing joins it and withholds the signed event`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context);await page.evaluate(`behaviour='hold';beginBorrowed()`);await page.evaluate('started')
  // The wallet waits outside the native write lock; a competing valid native
  // change can complete while the unabortable provider is still unresolved.
  await page.evaluate(`(async()=>{window.closeDone=false;if('${fault}'==='consent')consent=false;if('${fault}'==='room')currentRoom='c'.repeat(64);
   if('${fault}'==='native-relays')await seed({[relayName]:'{}'});
   if('${fault}'==='adapter-close')void(window.closing=adapter.close().then(()=>closeDone=true));
   if('${fault}'==='browser-close')void(window.closing=browserOwner.close().then(()=>closeDone=true));
   if('${fault}'==='tab-close')void(window.closing=tabOwner.close().then(()=>closeDone=true))})()`)
  expect(await page.evaluate('[receipt,closeDone,nativeHeld,signs]')).toEqual(['pending',false,0,1]);await page.evaluate('release();pending')
  if(fault.endsWith('close')){await page.evaluate('closing');expect(await page.evaluate('closeDone')).toBe(true)}
  expect(await page.evaluate('[receipt,result,rawCloses,consumerLocked]')).toEqual(['OrdinaryStateHold',null,0,true]);await context.close()
})
test('consent revoked at the final native handoff suppresses a previously verified signed event',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{borrowed=adapter.borrowSignEvent({live:()=>consent,validate:()=>{validations++;if(validations===4)consent=false}});
   let error;try{await borrowed(authEvent())}catch(e){error=e.name};return[error,signs,validations,stops]})()`)).toEqual(['OrdinaryStateHold',1,4,1]);await context.close()
})
test('an active borrowed provider prevents a concurrent base signing call without losing lifetime ownership',async({browser})=>{
  const context=await browser.newContext(),page=await open(context);await page.evaluate(`behaviour='hold';beginBorrowed()`);await page.evaluate('started')
  expect(await page.evaluate(`(async()=>{let error;try{await adapter.signEvent(event())}catch(e){error=e.name};return[error,signs,receipt]})()`))
   .toEqual(['OrdinaryStateHold',1,'pending']);await page.evaluate('release();pending');expect(await page.evaluate('[receipt,result]')).toEqual(['OrdinaryStateHold',null]);await context.close()
})
for(const fault of ['valid','consent','native-relays'] as const)test(`actual NIP42 browser socket ${fault} after delayed upgrade releases only an authorised authentication event`,async({browser})=>{
  const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end(`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`)})
  const relay=new WebSocketServer({server}),received:string[]=[]
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const address=server.address();if(!address||typeof address==='string')throw Error('No relay address')
  relay.on('connection',socket=>{socket.send(JSON.stringify(['AUTH','wire-native-challenge']));socket.on('message',bytes=>{
    received.push(bytes.toString());const frame=JSON.parse(bytes.toString());if(frame[0]==='AUTH')socket.send(JSON.stringify(['OK',frame[1].id,true,'accepted']))
  })})
  const context=await browser.newContext()
  try{
    const page=await context.newPage();await page.goto(`http://127.0.0.1:${address.port}/ui`);await page.evaluate('('+foregroundSignerSetup+')()');await page.evaluate('('+signingSetup+')()')
    await page.evaluate('(async()=>{await makeDeferred();borrowed=borrow()})()')
    const url=`ws://127.0.0.1:${address.port}/relay`
    await page.evaluate(`(url=>{window.socketState='pending';const grant={pubkey:account,sign:borrowed};
      const Auth=Ordinary.authenticatedWebSocket(WebSocket,()=>grant,()=>consent,()=>socketState='refused',10000);
      window.socket=new Auth(url);socket.onopen=()=>socketState='open';socket.onclose=()=>{if(socketState==='pending')socketState='closed'}
    })(${JSON.stringify(url)})`)
    await page.waitForFunction('deferredCalled')
    await page.evaluate(`(async()=>{if('${fault}'==='consent'){consent=false;socket.close()};if('${fault}'==='native-relays')await seed({[relayName]:'{}'});upgrade(bunker)})()`)
    await page.waitForFunction('socketState!=="pending"')
    expect(await page.evaluate('[socketState,signs,consumerLocked,startsUnderLock]'))
     .toEqual([fault==='valid'?'open':fault==='consent'?'closed':'refused',fault==='valid'?1:0,true,fault==='valid'?[true]:[]])
    expect(received).toHaveLength(fault==='valid'?1:0)
    if(fault==='valid'){const frame=JSON.parse(received[0]!);expect(frame[0]).toBe('AUTH');expect(frame[1].kind).toBe(22242);expect(frame[1].tags).toEqual([['relay',url],['challenge','wire-native-challenge']])}
    await page.evaluate('socket.close();adapter.close()')
  }finally{
    await context.close();for(const socket of relay.clients)socket.terminate();await new Promise<void>(resolve=>relay.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})
