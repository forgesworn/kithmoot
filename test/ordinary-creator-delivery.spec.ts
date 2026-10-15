import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { verifyEvent } from 'nostr-tools/pure'
import { fileURLToPath } from 'node:url'
import { creatorSetup } from './ordinary-creator.setup.js'
const ORIGIN='https://ordinary-creator-delivery.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{const result=await build({entryPoints:[fileURLToPath(new URL('./ordinary-creator.browser-entry.ts',import.meta.url))],
 bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'});bundle=result.outputFiles[0]!.text})
test.beforeEach(async({context,page})=>{await context.route(`${ORIGIN}/**`,route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}));await page.goto(ORIGIN)})
const carrierSetup=`async (options={})=>{
 window.sockets=[];window.enqueues=[];window.dials=[];window.autoOpen=options.autoOpen??true;window.autoAck=options.autoAck??true
 window.beforeEnqueue=undefined;window.afterEnqueue=undefined;window.authChallenge=options.auth??false;window.signs=0
 window.carrierGeneration='c'.repeat(64)
 class NativeSocket {
  static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3
  CONNECTING=0;OPEN=1;CLOSING=2;CLOSED=3;readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null
  constructor(url){this.url=url;sockets.push(this);dials.push(url)
   const guarded=this.send.bind(this);this.send=data=>{beforeEnqueue?.(data,this);return guarded(data)}
   if(autoOpen)queueMicrotask(()=>this.open())}
  open(){if(this.readyState!==0)return;this.readyState=1;this.onopen?.({type:'open'});if(authChallenge)this.message(['AUTH','challenge-for-'+this.url])}
  message(value){this.onmessage?.({data:JSON.stringify(value)})}
  send(data){if(this.readyState!==1)throw Error('closed');enqueues.push({url:this.url,data});const frame=JSON.parse(data)
   afterEnqueue?.(data,this);if(autoAck)queueMicrotask(()=>this.message(['OK',frame[1].id,true,'']))}
  close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({type:'close',code:1000,reason:'fixture closed'})}
 }
 window.NativeSocket=NativeSocket
 window.identity=Ordinary.localIdentity(participantSk);window.originalSign=identity.signEvent.bind(identity)
 if(options.auth){
   window.nostr={getPublicKey:async()=>participant,signEvent:async template=>{
    if(template.kind===22242){signs++;return window.signer?signer(template):originalSign(template)}
    return Ordinary.finalizeEvent(template,participantSk)}}
   const storage=await Ordinary.OrdinarySignetState.open({owner:browserOwner,generation:0,currentGeneration:()=>0,live:guard,
    origin:location.origin,appName:'KithMoot',checkClients:async()=>{},stop:()=>{}})
   window.sourceSession=await Ordinary.login({preferredMethod:'nip07',appName:'KithMoot',storage})
   identity=await Ordinary.OrdinaryForegroundSigner.open({browser:browserOwner,tab:tabOwner,session:sourceSession,currentSession:()=>sourceSession,
    generation:0,currentGeneration:()=>0,live:guard,checkClients:async()=>{},stop:()=>{}})
   await creator.close();account=participant;current={...current,account};creator=await open()
 }
 window.carrierCurrent={generation:carrierGeneration,profile:'direct',websocketImplementation:NativeSocket,
 authentication:options.auth?destinations.map(url=>({url,identity})):[]}
 window.delivery={...carrierCurrent,current:()=>carrierCurrent,timeoutMs:options.timeoutMs??2000,authenticationTimeoutMs:1000}
 window.retained=await creator.prepare(now);window.lockName=Ordinary.ORDINARY_DATABASE+':write'
 window.begin=()=>{window.deliveryState='pending';window.publishing=creator.publish(delivery).then(result=>{window.delivered=result;deliveryState='ack'},error=>deliveryState=error.name);return publishing}
 window.nativeIntent=async()=>JSON.parse((await images())[0].records.get(intentName))
 window.takeLock=async()=>{let acquired;const ready=new Promise(resolve=>acquired=resolve);window.lockWork=navigator.locks.request(lockName,async()=>{
 acquired();await new Promise(resolve=>window.releaseLock=resolve)});await ready}
}`
async function start(page:Page,options={}){await page.evaluate(`(${creatorSetup})()`);await page.evaluate(`(${carrierSetup})(${JSON.stringify(options)})`)}

test('both exact destinations receive the retained event and all ACKs become durable before success',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{await begin();const intent=await nativeIntent();return [deliveryState,dials.sort(),
 enqueues.length,enqueues.every(row=>row.data==='["EVENT",'+retained.proof.event+']'),intent.state,intent.acknowledged,
 sockets.every(socket=>socket.readyState===3)]})()`)).toEqual(['ack',['wss://first.example/','wss://second.example/'],2,true,'acknowledged',['wss://first.example/','wss://second.example/'],true])
})
test('a first ACK keeps publication pending until the slower destination actually ACKs',async({page})=>{
 await start(page,{autoOpen:false});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets.find(socket=>socket.url.includes("first")).open()');await page.waitForFunction(`(async()=>{const intent=await nativeIntent();return intent.acknowledged.length===1})()`)
 expect(await page.evaluate('(async()=>[deliveryState,(await nativeIntent()).state,enqueues.length])()')).toEqual(['pending','pending',1])
 await page.evaluate('sockets.find(socket=>socket.url.includes("second")).open()');await page.evaluate('publishing')
 expect(await page.evaluate('[deliveryState,enqueues.length]')).toEqual(['ack',2])
})
test('wire timeout preserves pending exact bytes, joins writes and permits an exact retry',async({page})=>{
 await start(page,{autoAck:false,timeoutMs:600});expect(await page.evaluate(`(async()=>{await begin();const first=await nativeIntent(),before=await rawBoth(),sent=enqueues.map(row=>row.data)
 const stale=[...sockets];for(const socket of stale)socket.message(['OK',retained.proof.eventId,true,'late']);await new Promise(resolve=>setTimeout(resolve,30))
 const unchanged=(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))
 autoAck=true;await begin();return [first.state,first.acknowledged,sent.every(data=>data==='["EVENT",'+retained.proof.event+']'),unchanged,
 deliveryState,enqueues.length,enqueues.every(row=>row.data==='["EVENT",'+retained.proof.event+']')]})()`)).toEqual(['pending',[],true,true,'ack',4,true])
})
for(const fault of ['carrier-generation','implementation','profile','selection','abort','close'])test(`${fault} while dial is queued refuses all dials`,async({page})=>{
 await start(page);await page.evaluate('takeLock()');await page.evaluate(`(()=>{if(${JSON.stringify(fault)}==='abort'){window.abortController=new AbortController();delivery.signal=abortController.signal};begin()})()`)
 expect(await page.evaluate(`(async fault=>{if(fault==='carrier-generation')carrierCurrent={...carrierCurrent,generation:'d'.repeat(64)}
 if(fault==='implementation')carrierCurrent={...carrierCurrent,websocketImplementation:WebSocket};if(fault==='profile')carrierCurrent={...carrierCurrent,profile:'tor'}
 if(fault==='selection')current={...current,keep:false};if(fault==='abort')abortController.abort()
 let closing;if(fault==='close')closing=creator.close();releaseLock();await lockWork;await publishing;await closing
 return [deliveryState,dials.length,enqueues.length,(await nativeIntent()).state]})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold',0,0,'pending'])
})
test('forget queued ahead of dial wins without constructing a socket',async({page})=>{
 await start(page);await page.evaluate('takeLock()');expect(await page.evaluate(`(async()=>{const forgetting=creator.forget();begin();releaseLock();await lockWork;await forgetting;await publishing
 return [deliveryState,dials.length,enqueues.length,(await images())[0].records.has(proofName)]})()`)).toEqual(['OrdinaryStateHold',0,0,false])
})
for(const channel of ['EVENT','AUTH'])test(`${channel} queued after forget wins emits no frame`,async({page})=>{
 await start(page,{autoOpen:false,auth:channel==='AUTH'});await page.evaluate(`(()=>{window.forgetting=undefined;beforeEnqueue=(data)=>{
 if(JSON.parse(data)[0]===${JSON.stringify(channel)}&&!forgetting)forgetting=creator.forget()};begin()})()`);await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets[0].open()');await page.evaluate('publishing');await page.evaluate('forgetting')
 expect(await page.evaluate('[deliveryState,enqueues.length,sockets.every(socket=>socket.readyState===3)]')).toEqual(['OrdinaryStateHold',0,true])
})
for(const channel of ['EVENT','AUTH'])test(`${channel} send accepted ahead of forget occurs once; later frames are cancelled`,async({page})=>{
 await start(page,{autoOpen:false,autoAck:false,auth:channel==='AUTH'});await page.evaluate(`(()=>{window.forgetting=undefined;afterEnqueue=(data)=>{
 if(JSON.parse(data)[0]===${JSON.stringify(channel)}&&!forgetting)forgetting=creator.forget()};begin()})()`);await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets[0].open()');await page.evaluate('publishing');await page.evaluate('forgetting')
 expect(await page.evaluate('[deliveryState,enqueues.length,sockets.every(socket=>socket.readyState===3)]')).toEqual(['OrdinaryStateHold',1,true])
})
for(const fault of ['generation','close','overflow-count','overflow-bytes','binary','unexpected','send-throw'])test(`${fault} refuses queued EVENT and keeps pending intent`,async({page})=>{
 await start(page,{autoOpen:false});await page.evaluate(`(fault=>{if(fault==='overflow-count')delivery.maxQueuedFrames=1;if(fault==='overflow-bytes')delivery.maxQueuedBytes=1
 window.fault=${JSON.stringify(fault)};begin()})(${JSON.stringify(fault)})`);await page.waitForFunction('dials.length===2')
 expect(await page.evaluate(`(async fault=>{if(fault==='generation')beforeEnqueue=()=>{carrierCurrent={...carrierCurrent,generation:'d'.repeat(64)}}
 if(fault==='close')beforeEnqueue=()=>{void creator.close()};if(fault==='send-throw')NativeSocket.prototype.send=()=>{throw Error('fixture send refused')}
 if(fault==='overflow-count')await takeLock()
 if(fault==='binary'||fault==='unexpected')try{sockets[0].send(fault==='binary'?new Uint8Array([1]):'["EVENT",{}]')}catch{}
 else{for(const socket of sockets)socket.open()}
 if(fault==='overflow-count'){releaseLock();await lockWork};await publishing
 return [deliveryState,enqueues.length,(await nativeIntent()).state,sockets.every(socket=>socket.readyState===3)]})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold',0,'pending',true])
})
test('actual NIP-42 consent signs AUTH first; every exact EVENT follows its own relay AUTH ACK',async({page})=>{
 await start(page,{auth:true});expect(await page.evaluate(`(async()=>{await begin();return [deliveryState,signs,enqueues.map(row=>JSON.parse(row.data)[0]).sort(),
 destinations.every(url=>{const frames=enqueues.filter(row=>row.url===url).map(row=>JSON.parse(row.data));return frames.length===2&&frames[0][0]==='AUTH'&&frames[1][0]==='EVENT'}),
 (await nativeIntent()).state]})()`)).toEqual(['ack',2,['AUTH','AUTH','EVENT','EVENT'],true,'acknowledged'])
})
for(const foreign of [false,true])test(`visitor creator ${foreign?'refuses foreign Fore consent':'ignores matching Fore provider'} before private SDK effects`,async({page})=>{
 await start(page,{auth:true})
 expect(await page.evaluate(`(async()=>{await creator.forget();account=null;current={...current,account};creator=await open();retained=await creator.prepare(now);let called=0;
  if(${foreign}){
   await identity.close();nostr={getPublicKey:async()=>Ordinary.getPublicKey(inviterSk),signEvent:async template=>Ordinary.finalizeEvent(template,inviterSk)};
   const storage=await Ordinary.OrdinarySignetState.open({owner:browserOwner,generation:0,currentGeneration:()=>0,live:guard,origin:location.origin,appName:'KithMoot',checkClients:async()=>{},stop:()=>{}});
   sourceSession=await Ordinary.login({preferredMethod:'nip07',appName:'KithMoot',storage});identity=await Ordinary.OrdinaryForegroundSigner.open({browser:browserOwner,tab:tabOwner,session:sourceSession,currentSession:()=>sourceSession,
    generation:0,currentGeneration:()=>0,live:guard,checkClients:async()=>{},stop:()=>{}})
  }
  nostr.signEvent=async()=>{called++;throw Error('visitor provider forbidden')};carrierCurrent={...carrierCurrent,authentication:destinations.map(url=>({url,identity}))};delivery={...delivery,...carrierCurrent};
  await begin();return[deliveryState,called,signs,dials.length,enqueues.length,(await nativeIntent()).state]})()`))
 .toEqual(foreign?['OrdinaryStateHold',0,0,0,0,'pending']:['ack',0,0,2,4,'acknowledged'])
})
for(const fault of ['no-consent','signer-refusal','invalid-signer','withdrawn','late-signer'])test(`${fault} never enqueues AUTH or EVENT`,async({page})=>{
 await start(page,{autoOpen:false,auth:fault!=='no-consent'});await page.evaluate(`(fault=>{authChallenge=true;if(fault==='signer-refusal')window.signer=async()=>{throw Error('refused')}
 if(fault==='invalid-signer')window.signer=async template=>({...await originalSign(template),content:'changed'})
 if(fault==='late-signer')window.signer=template=>new Promise(resolve=>window.resolveSigner=async()=>resolve(await originalSign(template)))
 if(fault==='withdrawn')carrierCurrent={...carrierCurrent,authentication:[]};begin()})(${JSON.stringify(fault)})`)
 if(fault!=='withdrawn'){await page.waitForFunction('dials.length===2');await page.evaluate('sockets[0].open()')}
 if(fault==='late-signer'){await page.waitForFunction('signs===1');await page.evaluate('window.closedReceipt=false;window.closing=creator.close().then(()=>closedReceipt=true);undefined');
 expect(await page.evaluate('closedReceipt')).toBe(false);await page.evaluate('resolveSigner()');await page.evaluate('publishing');await page.evaluate('closing')}
 else await page.evaluate('publishing')
 expect(await page.evaluate('(async()=>[deliveryState,enqueues.length,(await nativeIntent()).state,sockets.every(socket=>socket.readyState===3)])()')).toEqual(['OrdinaryStateHold',0,'pending',true])
})

for(const authentication of [false,true])test(`actual browser WebSockets publish canonical retained bytes and ${authentication?'NIP-42 AUTH':'unauthenticated'} receipts`,async({page})=>{
 const browserMessages:string[]=[];page.on('console',message=>{if(message.type()==='error')browserMessages.push(message.text())})
 const http=createServer((request,response)=>{if(request.url!=='/ui'){response.writeHead(404);response.end();return}
 response.writeHead(200,{'content-type':'text/html'});response.end(`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`)})
 const relay=new WebSocketServer({server:http});await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve)})
 const address=http.address();if(!address||typeof address==='string')throw Error('no local relay address')
 const urls=[`ws://127.0.0.1:${address.port}/first`,`ws://127.0.0.1:${address.port}/second`],received:{url:string;data:string;verified:boolean}[]=[]
 relay.on('connection',(socket,request)=>{const url=`ws://127.0.0.1:${address.port}${request.url}`
 if(authentication)socket.send(JSON.stringify(['AUTH','wire-challenge']))
 socket.on('message',bytes=>{const data=bytes.toString(),frame=JSON.parse(data),event=frame[1];received.push({url,data,verified:verifyEvent(event)})
 if(frame[0]==='AUTH'||frame[0]==='EVENT')socket.send(JSON.stringify(['OK',event.id,true,'accepted']))})})
 try{
 await page.goto(`http://127.0.0.1:${address.port}/ui`)
 await page.evaluate(`(${creatorSetup})()`);await page.evaluate(`(async urls=>{await creator.close();destinations=urls;current={...current,destinations};creator=await open();window.retained=await creator.prepare(now)
 const identity=Ordinary.localIdentity(participantSk);window.wireDiagnostics=[];window.wireFailure=null
 class WireSocket extends WebSocket{constructor(url){super(url);wireDiagnostics.push(['dial',url]);this.addEventListener('open',()=>wireDiagnostics.push(['open',url]))
 this.addEventListener('error',()=>wireDiagnostics.push(['error',url]));this.addEventListener('close',event=>wireDiagnostics.push(['close',event.code,event.reason]))}
 send(data){wireDiagnostics.push(['send',JSON.parse(data)[0]]);super.send(data)}}
 window.carrierCurrent={generation:'e'.repeat(64),profile:'direct',websocketImplementation:WireSocket,
 authentication:${authentication?'urls.map(url=>({url,identity}))':'[]'}}
 window.delivery={...carrierCurrent,current:()=>carrierCurrent,timeoutMs:10000};try{window.result=await creator.publish(delivery)}catch(e){window.wireFailure=e.name}})(${JSON.stringify(urls)})`)
 const diagnostic=await page.evaluate<[string|null,unknown[]]>('[wireFailure??null,wireDiagnostics]');expect(diagnostic[0],JSON.stringify({received,diagnostic,browserMessages})).toBeNull()
 const event=await page.evaluate<string>('retained.proof.event'),expected='["EVENT",'+event+']'
 expect(received.filter(row=>JSON.parse(row.data)[0]==='EVENT').map(row=>row.data)).toEqual([expected,expected])
 expect(received.every(row=>row.verified)).toBe(true);expect(received.length).toBe(authentication?4:2)
 expect(await page.evaluate('result.intent.state')).toBe('acknowledged')
 for(const url of urls){const frames=received.filter(row=>row.url===url).map(row=>JSON.parse(row.data));expect(frames.map(frame=>frame[0])).toEqual(authentication?['AUTH','EVENT']:['EVENT'])}
 }finally{for(const socket of relay.clients)socket.terminate();await new Promise<void>(resolve=>relay.close(()=>resolve()));await new Promise<void>(resolve=>http.close(()=>resolve()))}
})
for(const owner of ['browser','tab'])test(`native ${owner} invitation fence wins queued EVENT without a send`,async({page})=>{
 await start(page,{autoOpen:false});await page.evaluate(`(async owner=>{const target=owner==='browser'?browserOwner:tabOwner,scope=await target.capture('invitation:'+id,guard)
 window.fencing=undefined;beforeEnqueue=()=>{if(!fencing)fencing=target.forget(scope,guard,()=>false)};begin()})(${JSON.stringify(owner)})`)
 await page.waitForFunction('dials.length===2');await page.evaluate('sockets[0].open()');await page.evaluate('publishing');await page.evaluate('fencing')
 expect(await page.evaluate('[deliveryState,enqueues.length]')).toEqual(['OrdinaryStateHold',0])
})
test('a received ACK is retained after another connection fails; late replies cannot complete it',async({page})=>{
 await start(page,{autoOpen:false,autoAck:false});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets[0].open()');await page.waitForFunction('enqueues.length===1')
 await page.evaluate(`(()=>{const first=sockets[0];first.message(['OK',retained.proof.eventId,true,'']);sockets[1].onerror?.({type:'error'})})()`)
 await page.evaluate('publishing');expect(await page.evaluate(`(async()=>{const intent=await nativeIntent(),before=await rawBoth();for(const socket of sockets)socket.message(['OK',retained.proof.eventId,true,'late'])
 await new Promise(resolve=>setTimeout(resolve,30));return [deliveryState,intent.state,intent.acknowledged.length,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]})()`)).toEqual(['OrdinaryStateHold','pending',1,true])
})

for(const source of ['current','getter'])test(`${source} re-entry cannot start a second publisher before the first latch`,async({page})=>{
 await start(page);expect(await page.evaluate(`(async source=>{let once=false;window.innerResult='none'
 const reenter=()=>{if(!once){once=true;void creator.publish(delivery).then(()=>innerResult='ack',e=>innerResult=e.name)}}
 if(source==='current'){delivery.current=()=>{reenter();return carrierCurrent}}
 else Object.defineProperty(delivery,'generation',{enumerable:true,get(){reenter();return carrierGeneration}})
 await begin();await Promise.resolve();return [deliveryState,innerResult,dials.length,enqueues.length]})(${JSON.stringify(source)})`)).toEqual(['ack','OrdinaryStateHold',2,2])
})
test('concurrent second publish is refused while the first remains independently current',async({page})=>{
 await start(page,{autoOpen:false});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 expect(await page.evaluate('outcome(()=>creator.publish(delivery))')).toBe('OrdinaryStateHold')
 await page.evaluate('sockets.forEach(socket=>socket.open())');await page.evaluate('publishing')
 expect(await page.evaluate('[deliveryState,dials.length,enqueues.length]')).toEqual(['ack',2,2])
})
test('partial timeout retries only the missing destination using the identical retained event',async({page})=>{
 await start(page,{autoOpen:false,timeoutMs:600});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets.find(socket=>socket.url.includes("first")).open()');await page.waitForFunction('(async()=> (await nativeIntent()).acknowledged.length===1)()')
 await page.evaluate('publishing');expect(await page.evaluate('(async()=>[deliveryState,(await nativeIntent()).state,(await nativeIntent()).acknowledged])()')).toEqual(['OrdinaryStateHold','pending',['wss://first.example/']])
 expect(await page.evaluate(`(async()=>{const old=[...sockets],count=dials.length;autoOpen=true;await begin();for(const socket of old)socket.message(['OK',retained.proof.eventId,true,'replay'])
 return [deliveryState,dials.slice(count),enqueues.length,enqueues.every(row=>row.data==='["EVENT",'+retained.proof.event+']'),(await nativeIntent()).state]})()`)).toEqual(['ack',['wss://second.example/'],2,true,'acknowledged'])
})
for(const fault of ['carrier-generation','selection','forget'])test(`${fault} after EVENT rejects late OK without retaining a receipt`,async({page})=>{
 await start(page,{autoOpen:false,autoAck:false});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets[0].open()');await page.waitForFunction('enqueues.length===1')
 expect(await page.evaluate(`(async fault=>{if(fault==='carrier-generation')carrierCurrent={...carrierCurrent,generation:'d'.repeat(64)}
 if(fault==='selection')current={...current,keep:false};let forgetting;if(fault==='forget')forgetting=creator.forget()
 const old=sockets[0];old.message(['OK',retained.proof.eventId,true,'late']);await publishing;await forgetting
 const [b]=await images();return [deliveryState,b.records.has(intentName)?JSON.parse(b.records.get(intentName)).acknowledged:[],enqueues.length]})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold',[],1])
})
for(const fault of ['negative','malformed','wrong-event','duplicate'])test(`${fault} relay OK cannot fabricate a complete intent`,async({page})=>{
 await start(page,{autoOpen:false,autoAck:false,timeoutMs:600});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets[0].open()');await page.waitForFunction('enqueues.length===1')
 expect(await page.evaluate(`(async fault=>{const id=retained.proof.eventId;if(fault==='negative')sockets[0].message(['OK',id,false,'refused'])
 if(fault==='malformed')sockets[0].message(['OK',id,true]);if(fault==='wrong-event')sockets[0].message(['OK','f'.repeat(64),true,'other'])
 if(fault==='duplicate'){sockets[0].message(['OK',id,true,'']);sockets[0].message(['OK',id,true,''])}
 await publishing;const intent=await nativeIntent();return [deliveryState,intent.state,intent.acknowledged.length,enqueues.length]})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold','pending',fault==='duplicate'?1:0,1])
})

test('unknown paired ACK commit never reports success early; close joins reconciliation and reopen retries only missing relay',async({page})=>{
 await start(page,{autoOpen:false,autoAck:false});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets[0].open()');await page.waitForFunction('enqueues.length===1')
 await page.evaluate(`(()=>{const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open,
 encrypt=crypto.subtle.encrypt.bind(crypto.subtle);window.encryptions=0;let once=false
 crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)}
 Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
 if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw Error('unknown ACK custody unavailable')};tx.onabort(event)})}
 else descriptor.set.call(tx,callback)}})
 window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen;crypto.subtle.encrypt=encrypt}
 sockets[0].message(['OK',retained.proof.eventId,true,''])})()`)
 await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
 await page.evaluate('window.closedState="pending";window.closing=creator.close().then(()=>closedState="done");undefined')
 expect(await page.evaluate('[deliveryState,closedState,encryptions]')).toEqual(['pending','pending',2])
 await page.evaluate(`(async()=>{restore();window.intended=(await rawBoth()).map(row=>structuredClone(row.frame));creator.retryRetention();await publishing;await closing})()`)
 expect(await page.evaluate(`(async()=>[deliveryState,closedState,encryptions,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,intended[i])),(await nativeIntent()).acknowledged.length])()`)).toEqual(['OrdinaryStateHold','done',2,true,1])
 expect(await page.evaluate(`(async()=>{creator=await open();const before=dials.length;autoOpen=true;autoAck=true;await begin();return [deliveryState,dials.slice(before),
 enqueues.length,enqueues.every(row=>row.data==='["EVENT",'+retained.proof.event+']')]})()`)).toEqual(['ack',['wss://second.example/'],2,true])
})
test('definite ACK transaction abort preserves both frames and requires explicit retry',async({page})=>{
 await start(page,{autoOpen:false,autoAck:false});await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 await page.evaluate('sockets[0].open()');await page.waitForFunction('enqueues.length===1')
 expect(await page.evaluate(`(async()=>{const before=await rawBoth(),nativePut=IDBObjectStore.prototype.put;let once=false
 IDBObjectStore.prototype.put=function(...args){const result=nativePut.apply(this,args);if(this.name==='owners'&&!once){once=true;this.transaction.abort()}return result}
 try{sockets[0].message(['OK',retained.proof.eventId,true,'']);await publishing;return [deliveryState,(await nativeIntent()).acknowledged,
 (await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame)),browserOwner.holdingRetention,tabOwner.holdingRetention]}
 finally{IDBObjectStore.prototype.put=nativePut}})()`)).toEqual(['OrdinaryStateHold',[],true,false,false])
 await page.evaluate('autoOpen=true;autoAck=true;begin()');expect(await page.evaluate('deliveryState')).toBe('ack')
})

for(const owner of ['browser','tab'])for(const effect of ['dial','EVENT'])test(`native ${owner} generation replacement wins queued ${effect}`,async({page})=>{
 await start(page,{autoOpen:false});if(effect==='EVENT'){await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')}
 await page.evaluate('takeLock()')
 await page.evaluate(`(owner=>{window.replacementRequested=false;window.replacing=(async()=>{const saved=await images(),target=owner==='browser'?'browser':tabPurpose
 window.oldGeneration=saved[owner==='browser'?0:1].generation;const initial=saved[owner==='browser'?0:1].records
 const request=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);await new Promise((resolve,reject)=>{request.onsuccess=()=>{const db=request.result,tx=db.transaction('owners','readwrite')
 tx.objectStore('owners').delete(target);tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)}})
 window.replacementOwner=new Ordinary.OrdinaryStateOwner(target,owner==='browser'?0:tabExpiry);replacementRequested=true
 await replacementOwner.prepare(guard,initial,migration)})()})(${JSON.stringify(owner)})`)
 await page.waitForFunction('replacementRequested')
 await page.evaluate(effect==='EVENT'?'sockets[0].open()':'begin();undefined')
 expect(await page.evaluate(`(async({owner,effect})=>{releaseLock();await lockWork;await replacing;await publishing;const imagesNow=await images()
 return [deliveryState,enqueues.length,dials.length,imagesNow[owner==='browser'?0:1].generation!==oldGeneration]})(${JSON.stringify({owner,effect})})`)).toEqual(['OrdinaryStateHold',0,effect==='EVENT'?2:0,true])
})
for(const consent of [false,true])test(`Tor publication uses only exact onion destinations and ${consent?'refuses identity authentication':'requires the selected carrier'}`,async({page})=>{
 await page.evaluate(`(${creatorSetup})()`);await page.evaluate(`(async()=>{await creator.close();destinations=['ws://aebagbafaydqqcikbmga2dqpcaireeyuculbogazdinryhi6d4qcmeqd.onion/']
 roomRelays=undefined;link=Ordinary.encodeRoomLink(location.origin+'/j/',{invitation,relays:destinations,iceUrls:[]})
 current={...current,destinations,roomRelays,link,profile:'tor'};creator=await open()})()`)
 await page.evaluate(`(${carrierSetup})()`);expect(await page.evaluate(`(async consent=>{carrierCurrent={...carrierCurrent,profile:'tor',authentication:consent?destinations.map(url=>({url,identity})):[]}
 delivery={...delivery,...carrierCurrent,current:()=>carrierCurrent};await begin();return [deliveryState,dials,enqueues.length]})(${JSON.stringify(consent)})`)).toEqual(consent?['OrdinaryStateHold',[],0]:['ack',['ws://aebagbafaydqqcikbmga2dqpcaireeyuculbogazdinryhi6d4qcmeqd.onion/'],1])
})
for(const fault of ['deadline','invitation-expiry'])test(`${fault} while EVENT is queued forbids the frame`,async({page})=>{
 if(fault==='invitation-expiry'){await page.evaluate(`(${creatorSetup})()`);await page.evaluate(`(async()=>{await creator.close();current={...current,endsAt:now+5};creator=await open()})()`);await page.evaluate(`(${carrierSetup})({autoOpen:false})`);await page.evaluate('delivery.timeoutMs=120000')}
 else await start(page,{autoOpen:false})
 await page.evaluate('begin();undefined');await page.waitForFunction('dials.length===2')
 expect(await page.evaluate(`(async fault=>{const nativeNow=Date.now;beforeEnqueue=()=>{Date.now=()=>nativeNow()+ (fault==='invitation-expiry'?6000:3000)}
 try{sockets[0].open();await publishing;return [deliveryState,enqueues.length,(await nativeIntent()).state]}finally{Date.now=nativeNow}})(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold',0,'pending'])
})
test('fully acknowledged reopen returns durable completion without reconnecting or sending again',async({page})=>{
 await start(page);expect(await page.evaluate(`(async()=>{await begin();await creator.close();creator=await open();const d=dials.length,s=enqueues.length;await begin()
 return [deliveryState,dials.length===d,enqueues.length===s,(await nativeIntent()).state]})()`)).toEqual(['ack',true,true,'acknowledged'])
})
test('publish without prior native preparation refuses without signing or dialing',async({page})=>{
 await page.evaluate(`(${creatorSetup})()`);expect(await page.evaluate(`(async()=>{let dials=0;class Base{constructor(){dials++}}const currentCarrier={generation:'c'.repeat(64),profile:'direct',websocketImplementation:Base}
 return [await outcome(()=>creator.publish({...currentCarrier,current:()=>currentCarrier})),dials,(await images())[0].records.has(proofName)]})()`)).toEqual(['OrdinaryStateHold',0,false])
})
