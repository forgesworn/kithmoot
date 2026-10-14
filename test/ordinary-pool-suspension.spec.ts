import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-relay-carrier.setup.js'

const ORIGIN = 'https://ordinary-pool-suspension.kithmoot.test'
let bundle = ''
test.beforeAll(async () => { bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-pool-suspension.browser-entry.ts', import.meta.url))],
  bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text })
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN)
})

// Actual native read owners and immutable full-image binding, with a local
// graph controller only. This fixture proves carrier drain/abort behaviour;
// it supplies no production member admission, successor, or MLS authority.
const graphControls = `async()=>{
 window.allowed=true;
 const bscope=await browserOwner.capture(invScopeName,guard),tscope=await tabOwner.capture(invScopeName,guard);
 const binding={browser:{owner:browserOwner,scope:bscope},tab:{owner:tabOwner,scope:tscope},live:()=>guard()&&allowed};
 let active,expected;
 const image=(b,t,c)=>{const bm=new Map(b.keys().sort().map(n=>[n,b.get(n)])),tm=new Map(t.keys().sort().map(n=>[n,t.get(n)]));
  const h=Ordinary.ordinaryPairReadCustodyFor(c,bm,tm);return JSON.stringify([[...bm],[...tm],h.browser.revision,h.tab.revision])};
 window.validateGraphPair=(b,t,c)=>{Ordinary.OrdinaryStateOwner.validatePairBinding(c,binding);const next=image(b,t,c);
  if(expected!==undefined&&expected!==next)throw new Ordinary.OrdinaryStateHold();expected??=next;active={b,t,c};
  Ordinary.OrdinaryStateOwner.validatePairBinding(c,binding)};
 const retain=p=>{Ordinary.OrdinaryStateOwner.joinPairLifetime(browserOwner,tabOwner,p);return p};
 const native={retain,check:()=>{if(!active)throw new Ordinary.OrdinaryStateHold();validateGraphPair(active.b,active.t,active.c)},
  run:(operation,effect)=>retain(Ordinary.OrdinaryStateOwner.readPairMigrated({...binding,work:(b,t,_bn,_tn,c)=>{
   const previous=active;validateGraphPair(b,t,c);try{const value=effect();validateGraphPair(b,t,c);return value}
   finally{active=previous}}}))};
 window.workGraph=new Ordinary.OrdinaryProtocolWork(native,()=>window.carrier?.close());
 window.withGraphRoot=(scope,effect)=>native.run('fixture root boundary',()=>workGraph.enter(scope,'fixture root boundary',effect));
 window.beginDrain=(timeout=5000)=>{window.drainState='starting';window.draining=workGraph.execution.task('fixture-renewal',async scope=>{
  window.producerScope=scope;await workGraph.suspend(scope,timeout);window.drainState='held';
  await new Promise(resolve=>window.releaseDrain=resolve);await scope.run('unchanged predecessor abort',()=>{});
  workGraph.resume(scope)
 }).then(()=>drainState='resumed',error=>drainState=error.name);return undefined};
 window.finishDrain=async()=>{releaseDrain();await draining;await carrier.resumeResources()};
 window.stageDrain=()=>{window.drainState='staged';window.draining=workGraph.execution.task('fixture-renewal',async scope=>{
  window.producerScope=scope;await new Promise(resolve=>window.releaseLatch=resolve);drainState='starting';await workGraph.suspend(scope,5000);
  drainState='held';await new Promise(resolve=>window.releaseDrain=resolve);await scope.run('unchanged predecessor abort',()=>{});workGraph.resume(scope)
 }).then(()=>drainState='resumed',e=>drainState=e.name);return undefined};
}`

async function start(page: Page, options = {}, visitor = true) {
  await page.evaluate(`(${setup})(${JSON.stringify({ visitor })})`)
  await page.evaluate(`(${graphControls})()`)
  await page.evaluate(`(${controls})(${JSON.stringify(options)})`)
}

test('genuine paired owners retain an exact timer lifecycle root without an awaiting timer ancestor', async ({ page }) => {
  await page.clock.install(); await start(page)
  await page.evaluate(`(()=>{
   window.timers=new Ordinary.ProtocolTimers(workGraph.execution);
   window.lifecycleState='waiting';
   timers.scheduleRoot('fixture-renewal',10,begin=>window.lifecycle=workGraph.startRoot(async scope=>{
    window.lifecycleScope=scope;if(!begin(scope))return;
    await workGraph.suspend(scope);workGraph.checkQuiescent(scope);lifecycleState='held';
    await new Promise(resolve=>window.finishLifecycle=resolve);
    await withGraphRoot(scope,()=>workGraph.checkTransition(scope));
    workGraph.resume(scope);lifecycleState='resumed'
   }));return undefined
  })()`)
  await page.clock.runFor(10); await page.waitForFunction('lifecycleState==="held"')
  expect(await page.evaluate('[timers.has("fixture-renewal"),workGraph.suspended]')).toEqual([false,true])
  await page.evaluate('finishLifecycle();lifecycle'); expect(await page.evaluate('lifecycleState')).toBe('resumed')
  expect(await page.evaluate('lifecycleScope.run("stale",()=>{}).then(()=>"bad",e=>e.name)')).toBe('OrdinaryProtocolSuspended')
  await page.evaluate('timers.close();shutdown()')
})

test('genuine lifecycle transition refuses a live child and an unrelated callback scope', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{
   const results=[];
   await workGraph.startRoot(async scope=>{
    await workGraph.suspend(scope);workGraph.checkQuiescent(scope);
    const held=new Promise(resolve=>window.finishChild=resolve);scope.retain(held);
    try{await withGraphRoot(scope,()=>workGraph.checkTransition(scope));results.push('bad')}
    catch(e){results.push(e.name)}
    finishChild();await held;await Promise.resolve();
    await scope.run('child callback',()=>{try{workGraph.checkTransition(scope);results.push('bad')}catch(e){results.push(e.name)}});
    await withGraphRoot(scope,()=>{workGraph.checkTransition(scope);results.push('exact root')});
    workGraph.resume(scope)
   });return results
  })()`)).toEqual(['OrdinaryProtocolSuspended','OrdinaryProtocolSuspended','exact root'])
  await page.evaluate('shutdown()')
})

test('genuine owners join a wrapped rejected lifecycle root through its unabortable body', async ({ page }) => {
  await start(page)
  await page.evaluate(`(()=>{
   window.lifecycleState='waiting';
   window.lifecycle=workGraph.startRoot(async()=>{window.lifecycleState='started';await new Promise(resolve=>window.finishLifecycle=resolve)});
   window.result=lifecycle.then(()=>window.lifecycleState='bad',()=>window.lifecycleState='refused');
   return undefined
  })()`)
  await page.waitForFunction('lifecycleState==="started"')
  expect(await page.evaluate(`(()=>{
   try{workGraph.execution.retainRoot(lifecycle.then(()=>{}));return 'bad'}catch(e){return e.name}
  })()`)).toBe('OrdinaryProtocolSuspended')
  await page.evaluate('window.graphJoined=false;window.graphJoining=workGraph.join().then(()=>graphJoined=true);undefined')
  expect(await page.evaluate('graphJoined')).toBe(false)
  await page.evaluate('finishLifecycle();graphJoining'); expect(await page.evaluate('[graphJoined,lifecycleState]')).toEqual([true,'refused'])
  await page.evaluate('shutdown()')
})

test('native graph drains only exact already-sent old ACKs and recreates freshly guarded readers after abort', async ({ page }) => {
  await start(page, { autoAck: false, history: false })
  await page.evaluate('listen();publish();undefined')
  await page.waitForFunction('frames.filter(row=>JSON.parse(row[0])[0]==="EVENT").length===2')
  await page.evaluate('beginDrain()'); await page.waitForFunction('workGraph.suspended')
  expect(await page.evaluate('drainState')).toBe('starting')
  const before = await page.evaluate('frames.length')
  await page.evaluate(`(()=>{for(const socket of sockets){socket.message(['EVENT','late',event]);socket.message(['EOSE','late']);
   socket.message(['OK','0'.repeat(64),true,'unsolicited']);socket.message(['AUTH','late']);}})()`)
  expect(await page.evaluate('[frames.length,delivered.length,drainState]')).toEqual([before, 0, 'starting'])
  await page.evaluate(`(()=>{for(const socket of sockets)socket.message(['OK',event.id,true,'accepted'])})()`)
  await page.waitForFunction('drainState==="held"')
  expect(await page.evaluate('[publication,carrier.closed,sockets.every(s=>s.readyState===3)]')).toEqual(['ok', false, true])
  await page.evaluate('finishDrain()')
  await page.waitForFunction('sockets.filter(s=>s.readyState===1).length===2')
  expect(await page.evaluate('[drainState,dials.every(row=>row[1]),frames.every(row=>row[1]),handoffs.every(Boolean)]'))
    .toEqual(['resumed', true, true, true])
  expect(await page.evaluate('producerScope.run("old ticket",()=>{}).then(()=>"bad",e=>e.name)')).toBe('OrdinaryProtocolSuspended')
  await page.evaluate('shutdown()')
})

test('drain timeout closes the old carrier without a retry, new dial or fabricated acknowledgement', async ({ page }) => {
  await page.clock.install(); await start(page, { autoAck: false, history: false })
  await page.evaluate('publish();undefined'); await page.waitForFunction('frames.filter(row=>JSON.parse(row[0])[0]==="EVENT").length===2')
  await page.evaluate('beginDrain(50)'); await page.waitForFunction('workGraph.suspended')
  const before = await page.evaluate<number[]>('[dials.length,frames.length]')
  await page.clock.fastForward(51); await page.evaluate('draining')
  expect(await page.evaluate('[drainState,carrier.closed,sockets.every(s=>s.readyState===3),dials.length,frames.length]'))
    .toEqual(['OrdinaryProtocolSuspended', true, true, ...before])
  await page.evaluate('shutdown();undefined'); await page.evaluate('carrier.joinLifetime()')
  expect(await page.evaluate('publication')).not.toBe('ok')
})

test('a changed native source refuses abort resume before fresh sockets or subscription writes', async ({ page }) => {
  await start(page, { history: false }); await page.evaluate('listen()'); await page.waitForFunction('eoses===1')
  await page.evaluate('beginDrain()'); await page.waitForFunction('drainState==="held"')
  const before = await page.evaluate<number[]>('[dials.length,frames.length]')
  await page.evaluate('(async()=>{const s=await scopes();await browserOwner.mutateMigrated(s.b,guard,()=>{});releaseDrain();await draining})()')
  expect(await page.evaluate('[drainState,carrier.closed,dials.length,frames.length]')).toEqual(['OrdinaryStateHold', true, ...before])
  await page.evaluate('shutdown()')
})

test('first ACK leaves its slower fanout owned; acknowledged socket ACKs cannot impersonate the remaining receipt', async ({ page }) => {
  await start(page, { autoAck: false, history: false })
  await page.evaluate('publish();undefined'); await page.waitForFunction('frames.filter(r=>JSON.parse(r[0])[0]==="EVENT").length===2')
  await page.evaluate('window.oldCallback=sockets[0].onmessage;sockets[0].message(["OK",event.id,true,"accepted"])')
  await page.waitForFunction('publication==="ok"')
  await page.evaluate('beginDrain()'); await page.waitForFunction('workGraph.suspended')
  expect(await page.evaluate('[drainState,sockets[0].readyState,sockets[1].readyState]')).toEqual(['starting', 1, 1])
  await page.evaluate('oldCallback({data:JSON.stringify(["OK",event.id,true,"replayed"])});undefined')
  expect(await page.evaluate('drainState')).toBe('starting')
  await page.evaluate('sockets[1].message(["OK",event.id,true,"accepted"])')
  await page.waitForFunction('drainState==="held"'); await page.evaluate('finishDrain();shutdown()')
})

test('concurrent different events drain by their exact receipts, including reversed and duplicate ACKs', async ({ page }) => {
  await start(page, { autoAck: false, history: false })
  await page.evaluate(`window.event2=Ordinary.finalizeEvent({kind:event.kind,created_at:event.created_at,tags:event.tags,content:'second'},participantSk);
   publish();window.other='pending';window.otherPublishing=carrier.publish(event2).then(()=>other='ok',e=>other=e.name);undefined`)
  await page.waitForFunction('frames.filter(r=>JSON.parse(r[0])[0]==="EVENT").length===4')
  await page.evaluate('beginDrain()'); await page.waitForFunction('workGraph.suspended')
  await page.evaluate(`for(const socket of sockets){socket.message(['OK',event2.id,true,'accepted']);socket.message(['OK',event2.id,true,'duplicate'])}`)
  await page.waitForFunction('other==="ok"')
  expect(await page.evaluate('[publication,drainState]')).toEqual(['pending', 'starting'])
  await page.evaluate(`for(const socket of sockets)socket.message(['OK',event.id,true,'accepted'])`)
  await page.waitForFunction('drainState==="held"')
  expect(await page.evaluate('[publication,other,carrier.closed]')).toEqual(['ok', 'ok', false])
  await page.evaluate('finishDrain()'); await page.evaluate('shutdown()')
})

test('exact negative old ACKs finish the refused publication without a retry or hang', async ({ page }) => {
  await start(page, { autoAck: false, history: false })
  await page.evaluate('publish();undefined'); await page.waitForFunction('frames.filter(r=>JSON.parse(r[0])[0]==="EVENT").length===2')
  await page.evaluate('beginDrain()'); await page.waitForFunction('workGraph.suspended')
  const before = await page.evaluate<number[]>('[dials.length,frames.length]')
  await page.evaluate(`for(const socket of sockets)socket.message(['OK',event.id,false,'refused'])`)
  await page.waitForFunction('drainState==="held"')
  expect(await page.evaluate('[publication,carrier.closed,dials.length,frames.length]')).toEqual(['Error', false, ...before])
  await page.evaluate('finishDrain()'); await page.evaluate('shutdown()')
})

test('right event ID on a readable socket that never sent the event cannot complete the drain', async ({ page }) => {
  await start(page, { autoAck: false, history: false, relays: [
    { url: 'wss://first.example/', read: true, write: true }, { url: 'wss://second.example/', read: true, write: false },
  ] })
  await page.evaluate('listen();publish();undefined'); await page.waitForFunction('sockets.length===2&&frames.some(r=>JSON.parse(r[0])[0]==="EVENT")')
  await page.evaluate('window.reader=sockets.find(s=>s.url.includes("second"));window.wrongCallback=reader.onmessage;beginDrain()')
  await page.waitForFunction('workGraph.suspended')
  await page.evaluate('wrongCallback({data:JSON.stringify(["OK",event.id,true,"not a writer"])});undefined')
  expect(await page.evaluate('[publication,drainState,reader.readyState]')).toEqual(['pending', 'starting', 3])
  await page.evaluate('sockets.find(s=>s.url.includes("first")).message(["OK",event.id,true,"accepted"])')
  await page.waitForFunction('drainState==="held"'); await page.evaluate('finishDrain()'); await page.evaluate('shutdown()')
})

test('pre-latch ACK queued behind a real native lock stays owned while later generations fence its callback', async ({ page }) => {
  await start(page, { autoAck: false, history: false })
  await page.evaluate('publish();stageDrain();undefined')
  await page.waitForFunction('typeof releaseLatch==="function"&&frames.filter(r=>JSON.parse(r[0])[0]==="EVENT").length===2')
  await page.evaluate('takeLock()')
  await page.evaluate(`window.saved=sockets.map(s=>s.onmessage);for(const socket of sockets)socket.message(['OK',event.id,true,'queued']);releaseLatch();undefined`)
  await page.waitForFunction('workGraph.suspended')
  expect(await page.evaluate('drainState')).toBe('starting')
  await page.evaluate('releaseLock();undefined'); await page.evaluate('lockWork')
  await page.waitForFunction('drainState==="held"'); expect(await page.evaluate('publication')).toBe('ok')
  await page.evaluate('finishDrain()')
  const before = await page.evaluate<number[]>('[dials.length,frames.length]')
  await page.evaluate(`for(const callback of saved)callback({data:JSON.stringify(['OK',event.id,true,'old generation'])})`)
  expect(await page.evaluate('[carrier.closed,dials.length,frames.length]')).toEqual([false, ...before])
  await page.evaluate('shutdown()')
})

test('late unabortable AUTH and a second queued AUTH remain joined without post-latch provider starts or sends', async ({ page }) => {
  await start(page, { auth: true, history: false }, false)
  await page.evaluate(`window.authPending=false;window.authHook=value=>{authPending=true;return new Promise(resolve=>window.releaseAuth=()=>resolve(authSign(value)))};listen();undefined`)
  await page.waitForFunction('authPending&&sockets.length===2')
  await page.evaluate('beginDrain()'); await page.waitForFunction('workGraph.suspended')
  expect(await page.evaluate('[drainState,authSigns,sockets.every(s=>s.readyState===3)]')).toEqual(['starting', 1, true])
  await page.evaluate('releaseAuth();undefined')
  await page.waitForFunction('drainState==="held"')
  expect(await page.evaluate('[authSigns,frames.filter(r=>["AUTH","EVENT","REQ"].includes(JSON.parse(r[0])[0])).length,carrier.closed]'))
    .toEqual([1, 0, false])
  await page.evaluate('window.authHook=undefined;finishDrain()'); await page.evaluate('shutdown()')
})

test('post-resume source validation failure suppresses resource recreation before any Base socket or REQ', async ({ page }) => {
  await start(page, { history: false }); await page.evaluate('listen()'); await page.waitForFunction('eoses===1')
  await page.evaluate('beginDrain()'); await page.waitForFunction('drainState==="held"')
  await page.evaluate('releaseDrain();undefined'); await page.evaluate('draining')
  const before = await page.evaluate<number[]>('[dials.length,frames.length]')
  expect(await page.evaluate(`(async()=>{const s=await scopes();await browserOwner.mutateMigrated(s.b,guard,()=>{});
   let error;try{await carrier.resumeResources()}catch(e){error=e.name};return[error,carrier.closed,dials.length,frames.length]})()`))
    .toEqual(['OrdinaryStateHold', true, ...before])
  await page.evaluate('shutdown()')
})

test('pending publication cap pressure closes without orphaning fanout or native graph roots', async ({ page }) => {
  await start(page, { autoAck: false, history: false })
  await page.evaluate(`window.capWork=Array.from({length:130},(_,i)=>Ordinary.finalizeEvent({kind:event.kind,created_at:event.created_at,tags:[],content:String(i)},participantSk))
   .map(value=>carrier.publish(value).then(()=>"ok",e=>e.name));undefined`)
  await page.waitForFunction('carrier.closed')
  expect(await page.evaluate(`(async()=>{const results=await Promise.all(capWork);await carrier.joinLifetime();await workGraph.join();
   return[results.some(value=>value==='OrdinaryStateHold'),sockets.every(s=>s.readyState===3)]})()`)).toEqual([true, true])
})

for (const fault of ['none', 'revision', 'unsubscribe', 'close']) test(`a pre-latch queued EOSE handoff preserves exact binding evidence and fences ${fault}`, async ({ page }) => {
  await start(page, { history: false, autoEose: false })
  if (fault === 'revision') await page.evaluate('(async()=>window.faultScope=(await scopes()).b)()')
  await page.evaluate('stageDrain()'); await page.waitForFunction('typeof releaseLatch==="function"')
  await page.evaluate(`(()=>{window.eoseFault=${JSON.stringify(fault)};const subscribe=Ordinary.NostrRelayPool.prototype.subscribe;
   Ordinary.NostrRelayPool.prototype.subscribe=function(filters,onEvent,onEose,history){return subscribe.call(this,filters,onEvent,()=>{
    onEose?.();
    if(eoseFault==='revision')window.faultWork=browserOwner.mutateMigrated(faultScope,guard,()=>{});
    if(eoseFault==='unsubscribe')stop();if(eoseFault==='close')carrier.close();releaseLatch()
   },history)};listen()})()`)
  await page.waitForFunction('frames.filter(r=>JSON.parse(r[0])[0]==="REQ").length===2')
  await page.evaluate(`for(const socket of sockets)socket.message(['EOSE',socket.requestId])`)
  if (fault === 'revision' || fault === 'close') {
    await page.waitForFunction('carrier.closed'); await page.evaluate('draining'); await page.evaluate('window.faultWork')
    expect(await page.evaluate('eoses')).toBe(0)
  } else {
    await page.waitForFunction('drainState==="held"')
    expect(await page.evaluate('[eoses,carrier.closed]')).toEqual([fault === 'none' ? 1 : 0, false])
    await page.evaluate('finishDrain()')
  }
  await page.evaluate('shutdown()')
})

test('resumed incomplete history ignores old callbacks and IDs and needs every fresh readable binding', async ({ page }) => {
  await start(page, { history: false, autoEose: false })
  await page.evaluate(`(()=>{const send=Socket.prototype.send;Socket.prototype.send=function(data){const frame=JSON.parse(data);
   if(frame[0]==='REQ')this.requestId=frame[1];return send.call(this,data)};listen()})()`)
  await page.waitForFunction('sockets.length===2&&sockets.every(s=>s.requestId)')
  await page.evaluate('window.previous=sockets.map(s=>({callback:s.onmessage,id:s.requestId}));beginDrain()')
  await page.waitForFunction('drainState==="held"'); await page.evaluate('finishDrain()')
  await page.waitForFunction('sockets.length===4&&sockets.slice(2).every(s=>s.requestId)')
  await page.evaluate(`for(let i=0;i<2;i++){previous[i].callback({data:JSON.stringify(['EOSE',sockets[i+2].requestId])});
   sockets[i+2].message(['EOSE',previous[i].id])}`)
  await page.evaluate('carrier.joinLifetime()'); expect(await page.evaluate('eoses')).toBe(0)
  await page.evaluate('sockets[2].message(["EOSE",sockets[2].requestId])'); await page.evaluate('carrier.joinLifetime()')
  expect(await page.evaluate('eoses')).toBe(0)
  await page.evaluate('sockets[3].message(["EOSE",sockets[3].requestId])'); await page.waitForFunction('eoses===1')
  expect(await page.evaluate('carrier.closed')).toBe(false); await page.evaluate('shutdown()')
})

test('resume keeps already completed history complete without granting a new timeout EOSE', async ({ page }) => {
  await page.clock.install(); await start(page, { history: false })
  await page.evaluate('listen()'); await page.waitForFunction('eoses===1')
  await page.evaluate('beginDrain()'); await page.waitForFunction('drainState==="held"')
  await page.clock.fastForward(9000)
  await page.evaluate('window.autoEose=false;finishDrain()')
  await page.clock.fastForward(9000)
  expect(await page.evaluate('[carrier.closed,eoses]')).toEqual([false, 1])
  await page.evaluate('shutdown()')
})
