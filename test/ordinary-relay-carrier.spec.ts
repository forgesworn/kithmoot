import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-relay-carrier.setup.js'

const ORIGIN = 'https://ordinary-relay-carrier.kithmoot.test'
let bundle = ''
test.beforeAll(async () => { bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts', import.meta.url))],
  bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text })
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN)
})

async function start(page: Page, options = {}, visitor = true) {
  await page.evaluate(`(${setup})(${JSON.stringify({ visitor })})`)
  await page.evaluate(`(${controls})(${JSON.stringify(options)})`)
}
for (const auth of [false, true]) for (const visitor of [false, true]) test(`real shared pool publishes and replays with native handoffs, auth=${auth}, visitor=${visitor}`, async ({ page }) => {
  await start(page, { auth }, visitor)
  await page.evaluate('listen()'); await page.waitForFunction('eoses===1&&delivered.length===1')
  await page.evaluate('publish()'); await page.evaluate('publishing')
  expect(await page.evaluate(`(async()=>{const result=[publication,delivered[0][0]===event.id,dials.length,
    dials.every(row=>row[1]),frames.every(row=>row[1]),handoffs.every(Boolean),authSigns,signCalls];await shutdown();return result})()`))
    .toEqual(['ok', true, 2, true, true, true, auth && !visitor ? 2 : 0, 0])
})
for (const fault of ['selection', 'browser-fence', 'tab-fence', 'same-byte-revision', 'browser-close', 'tab-close', 'carrier-close', 'expiry'])
test(`${fault} ahead of the shared pool's actual dial suppresses all sockets`, async ({ page }) => {
  await start(page)
  await page.evaluate(`(async()=>{window.s=await scopes();await takeLock();window.cutting=undefined;
    if('${fault}'==='browser-fence')cutting=browserOwner.forget(s.b,guard,()=>false);
    if('${fault}'==='tab-fence')cutting=tabOwner.forget(s.t,guard,()=>false);
    if('${fault}'==='same-byte-revision')cutting=browserOwner.mutateMigrated(s.b,guard,()=>{});
    listen();if('${fault}'==='selection')allowed=false;if('${fault}'==='browser-close')cutting=browserOwner.close();
    if('${fault}'==='tab-close')cutting=tabOwner.close();if('${fault}'==='carrier-close')carrier.close();
    if('${fault}'==='expiry')Date.now=()=>tabExpiry;releaseLock();await lockWork;await cutting;await carrier.joinLifetime()})()`)
  expect(await page.evaluate('[dials.length,frames.length,delivered.length,eoses,carrier.closed]')).toEqual([0, 0, 0, 0, true])
})
for (const fault of ['selection', 'browser-fence', 'tab-fence', 'same-byte-revision', 'carrier-close']) test(`${fault} wins ahead of a queued room EVENT`, async ({ page }) => {
  await start(page, { autoOpen: false, history: false })
  await page.evaluate('listen()'); await page.waitForFunction('dials.length===2')
  await page.evaluate(`(async()=>{window.s=await scopes();await takeLock();window.cutting=undefined;
    if('${fault}'==='browser-fence')cutting=browserOwner.forget(s.b,guard,()=>false);
    if('${fault}'==='tab-fence')cutting=tabOwner.forget(s.t,guard,()=>false);
    if('${fault}'==='same-byte-revision')cutting=browserOwner.mutateMigrated(s.b,guard,()=>{});
    publish();sockets.forEach(socket=>socket.open());if('${fault}'==='selection')allowed=false;if('${fault}'==='carrier-close')carrier.close();
    releaseLock();await lockWork;await cutting;await publishing;await shutdown()})()`)
  expect(await page.evaluate('[publication,frames.length,eoses,sockets.every(socket=>socket.readyState===3)]')).toEqual(['OrdinaryStateHold', 0, 0, true])
})
for (const fault of ['selection', 'browser-fence', 'tab-fence', 'same-byte-revision', 'expiry']) test(`${fault} ahead of relay ingress permits no event or EOSE handoff`, async ({ page }) => {
  await start(page, { autoEose: false, history: false })
  await page.evaluate('listen()'); await page.waitForFunction('frames.length===2')
  await page.evaluate(`(async()=>{window.s=await scopes();await takeLock();window.cutting=undefined;
    if('${fault}'==='browser-fence')cutting=browserOwner.forget(s.b,guard,()=>false);
    if('${fault}'==='tab-fence')cutting=tabOwner.forget(s.t,guard,()=>false);
    if('${fault}'==='same-byte-revision')cutting=browserOwner.mutateMigrated(s.b,guard,()=>{});
    sockets.forEach(socket=>{const req=JSON.parse(frames.find(row=>JSON.parse(row[0])[0]==='REQ')[0]);socket.message(['EVENT',req[1],event]);socket.message(['EOSE',req[1]])});
    if('${fault}'==='selection')allowed=false;if('${fault}'==='expiry')Date.now=()=>tabExpiry;
    releaseLock();await lockWork;await cutting;await carrier.joinLifetime()})()`)
  expect(await page.evaluate('[carrier.closed,delivered.length,eoses,sockets.every(socket=>socket.readyState===3)]')).toEqual([true, 0, 0, true])
})
for (const fault of ['binary', 'oversized-frame', 'frame-count', 'queue-bytes']) test(`${fault} closes a bounded native ingress queue`, async ({ page }) => {
  await start(page, { autoEose: false, history: false })
  await page.evaluate('listen()'); await page.waitForFunction('frames.length===2')
  await page.evaluate(`(async()=>{await takeLock();const socket=sockets[0];
    if('${fault}'==='binary')socket.onmessage?.({data:new Uint8Array([1])});
    if('${fault}'==='oversized-frame')socket.onmessage?.({data:'x'.repeat(Ordinary.ORDINARY_RELAY_FRAME_BYTES+1)});
    if('${fault}'==='frame-count')for(let n=0;n<=Ordinary.ORDINARY_RELAY_QUEUE_FRAMES;n++)sockets[n%sockets.length].message(['NOTICE','bounded']);
    if('${fault}'==='queue-bytes')for(let n=0;n<5;n++)sockets[n%sockets.length].message(['NOTICE','x'.repeat(Ordinary.ORDINARY_RELAY_FRAME_BYTES-100)]);
    releaseLock();await lockWork;await carrier.joinLifetime()})()`)
  expect(await page.evaluate('[carrier.closed,delivered.length,eoses,sockets.every(socket=>socket.readyState===3)]')).toEqual([true, 0, 0, true])
})
test('a pool timeout cannot impersonate actual relay EOSE', async ({ page }) => {
  await start(page, { autoEose: false, history: false })
  await page.evaluate('listen()'); await page.waitForFunction('frames.length===2')
  await page.waitForFunction('carrier.closed', { timeout: 15000 })
  expect(await page.evaluate('[eoses,delivered.length]')).toEqual([0, 0])
  await page.evaluate('shutdown()')
})
test('one real reader EOSE and a second closed reader cannot fabricate complete history', async ({ page }) => {
  await start(page, { autoEose: false, history: false })
  await page.evaluate('listen()'); await page.waitForFunction('frames.length===2')
  await page.evaluate(`(()=>{for(let n=0;n<sockets.length;n++){const req=JSON.parse(frames[n][0]);if(n===0)sockets[n].message(['EOSE',req[1]]);else sockets[n].close()}})()`)
  await page.waitForFunction('carrier.closed', { timeout: 15000 }); await page.evaluate('shutdown()')
  expect(await page.evaluate('eoses')).toBe(0)
})
test('published input and filters are detached before native waits', async ({ page }) => {
  await start(page, { history: false })
  expect(await page.evaluate(`(async()=>{await takeLock();const copied=structuredClone(event),filters=[{kinds:[event.kind]}];
    window.published=carrier.publish(copied).catch(e=>e.name);carrier.subscribe(filters,()=>{});copied.content='changed';filters[0].kinds[0]=1;
    releaseLock();await lockWork;await published;const sent=frames.map(row=>JSON.parse(row[0]));
    const result=[sent.some(frame=>frame[0]==='EVENT'&&frame[1].content===event.content),sent.some(frame=>frame[0]==='REQ'&&frame[2].kinds?.[0]===event.kind)];await shutdown();return result})()`)).toEqual([true, true])
})
test('accessor-backed publication payloads cannot run before rejection', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{let calls=0;const fake={...event};Object.defineProperty(fake,'content',{get(){calls++;return 'bad'}});
    const result=await carrier.publish(fake).catch(error=>error.name);await shutdown();return[result,calls,dials.length]})()`)).toEqual(['OrdinaryStateHold', 0, 0])
})
for (const lifetime of ['carrier', 'browser', 'tab']) test(`${lifetime} close joins an unabortable account AUTH and refuses its late frames`, async ({ page }) => {
  await start(page, { auth: true }, false)
  await page.evaluate(`(()=>{window.releaseAuth=undefined;window.authHook=value=>new Promise(resolve=>{releaseAuth=()=>resolve(authSign(value))});listen()})()`)
  await page.waitForFunction('authSigns===1')
  await page.evaluate(`(()=>{window.joined=false;carrier.close();window.closing=(${lifetime === 'carrier' ? 'carrier.joinLifetime()' : lifetime + 'Owner.close()'}).then(()=>joined=true)})()`)
  expect(await page.evaluate('[joined,frames.length]')).toEqual([false, 0])
  await page.evaluate('releaseAuth();undefined'); await page.evaluate('closing'); await page.evaluate('shutdown()')
  expect(await page.evaluate('[joined,frames.length,eoses,authSigns,sockets.every(socket=>socket.readyState===3)]')).toEqual([true, 0, 0, 1, true])
})
for (const fault of ['consent', 'source-revision']) test(`${fault} while account AUTH is pending blocks a late response`, async ({ page }) => {
  await start(page, { auth: true }, false)
  await page.evaluate(`(()=>{window.releaseAuth=undefined;window.authHook=value=>new Promise(resolve=>{releaseAuth=()=>resolve(authSign(value))});listen()})()`)
  await page.waitForFunction('authSigns===1')
  await page.evaluate(`(async()=>{if('${fault}'==='consent')allowed=false;else {const s=await scopes();await browserOwner.mutateMigrated(s.b,guard,()=>{})}
    releaseAuth();await carrier.joinLifetime()})()`)
  expect(await page.evaluate('[frames.length,eoses,authSigns,carrier.closed]')).toEqual([0, 0, 1, true])
})
test('visitor AUTH always uses the native participant key, ignoring an external provider', async ({ page }) => {
  await start(page, {}, true); await page.evaluate('shutdown()')
  await page.evaluate(`(async()=>{window.providerCalls=0;const identity={pubkey:participant,signEvent:async()=>{providerCalls++;throw Error('forbidden')}};
    challenge=true;carrier=await Ordinary.OrdinaryRelayCarrier.open({...carrierOptions,authentication:destinations.map(url=>({url,identity}))});listen()})()`)
  await page.waitForFunction('eoses===1'); await page.evaluate('shutdown()')
  expect(await page.evaluate('[providerCalls,frames.filter(row=>JSON.parse(row[0])[0]==="AUTH").length]')).toEqual([0, 2])
})
test('a room validator cannot close an owner reentrantly and still authorise a dial', async ({ page }) => {
  await start(page); await page.evaluate('shutdown()')
  expect(await page.evaluate(`(async()=>{let failure;try{await Ordinary.OrdinaryRelayCarrier.open({...carrierOptions,validate:()=>{void(window.closing=browserOwner.close())}})}
    catch(error){failure=error.name};await closing;return[failure,dials.length,frames.length]})()`)).toEqual(['OrdinaryStateHold', 0, 0])
})
test('an async room validator is refused before running its body or dialling', async ({ page }) => {
  await start(page); await page.evaluate('shutdown()')
  expect(await page.evaluate(`(async()=>{let calls=0,failure;try{await Ordinary.OrdinaryRelayCarrier.open({...carrierOptions,validate:async()=>{calls++}})}
    catch(error){failure=error.name};return[failure,calls,dials.length,frames.length]})()`)).toEqual(['OrdinaryStateHold', 0, 0, 0])
})
test('actual EVENT frames accepted ahead of a fence cannot authorise late OK handoff', async ({ page }) => {
  await start(page, { history: false })
  await page.evaluate('listen()'); await page.waitForFunction('eoses===1')
  await page.evaluate(`(async()=>{const s=await scopes(),send=Socket.prototype.send;window.fencing=false;window.lateSends=0;Socket.prototype.send=function(data){
    const frame=JSON.parse(data);if(frame[0]==='EVENT'){if(fencing)lateSends++;if(!window.cutting)window.cutting=browserOwner.forget(s.b,guard,()=>{fencing=true;return false})}return send.call(this,data)};
    publish();await publishing;await cutting;await shutdown()})()`)
  expect(await page.evaluate('[publication,lateSends,carrier.closed]')).toEqual(['OrdinaryStateHold', 0, true])
  expect(await page.evaluate('frames.filter(row=>JSON.parse(row[0])[0]==="EVENT").length')).toBeGreaterThanOrEqual(1)
})
test('closing joins the shared pool background publication after its first acknowledgement', async ({ page }) => {
  await start(page, { history: false })
  await page.evaluate(`(()=>{const nativePublish=Ordinary.NostrRelayPool.prototype.publish;Ordinary.NostrRelayPool.prototype.publish=function(...args){window.actualPool=this;return nativePublish.apply(this,args)};
    const send=Socket.prototype.send;Socket.prototype.send=function(data){
    if(JSON.parse(data)[0]==='EVENT'&&this.url===destinations[1]){frames.push([data,nativeHeld>0]);return}return send.call(this,data)};publish()})()`)
  await page.evaluate('publishing'); expect(await page.evaluate('publication')).toBe('ok')
  expect(await page.evaluate(`(async()=>{const before=actualPool.publishing;window.joined=false;
    window.joining=carrier.joinLifetime().then(()=>joined=true);await Promise.resolve();const pending=!joined;
    carrier.close();await Promise.resolve();return[before,pending,actualPool.publishing,joined]})()`)).toEqual([true, true, true, false])
  await page.evaluate('joining')
  expect(await page.evaluate('[actualPool.publishing,joined,sockets.every(socket=>socket.readyState===3),carrier.closed]')).toEqual([false, true, true, true])
})
for (const owner of ['browser', 'tab']) test(`an idle ${owner} owner synchronously revokes the retained open sockets`, async ({ page }) => {
  await start(page); await page.evaluate('listen()'); await page.waitForFunction('eoses===1')
  expect(await page.evaluate(`(()=>{window.closing=${owner}Owner.close();return[carrier.closed,sockets.every(socket=>socket.readyState===3)]})()`)).toEqual([true, true])
  await page.evaluate('closing'); await page.evaluate('carrier.joinLifetime()')
})
test('natural tab expiry revokes an idle open carrier without another native read', async ({ page }) => {
  await page.clock.install()
  await start(page); await page.evaluate('listen()'); await page.waitForFunction('eoses===1')
  await page.clock.fastForward(3600_001)
  expect(await page.evaluate('[carrier.closed,sockets.every(socket=>socket.readyState===3)]')).toEqual([true, true])
  await page.evaluate('carrier.joinLifetime()')
})
test('a write-only carrier refuses history immediately and cannot receive local timeout EOSE', async ({ page }) => {
  await page.clock.install()
  await start(page); await page.evaluate('shutdown()')
  await page.evaluate(`(async()=>{carrier=await Ordinary.OrdinaryRelayCarrier.open({...carrierOptions,relays:destinations.map(url=>({url,read:false,write:true}))});listen()})()`)
  expect(await page.evaluate('[carrier.closed,dials.length,eoses]')).toEqual([true, 0, 0])
  await page.clock.fastForward(9000); expect(await page.evaluate('eoses')).toBe(0)
  await page.evaluate('carrier.joinLifetime()')
})
test('database invalidation synchronously revokes an idle retained carrier', async ({ page }) => {
  await start(page); await page.evaluate('listen()'); await page.waitForFunction('eoses===1')
  await page.evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(Ordinary.ORDINARY_DATABASE);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error)})`)
  expect(await page.evaluate('[carrier.closed,sockets.every(socket=>socket.readyState===3)]')).toEqual([true, true])
  await page.evaluate('carrier.joinLifetime()')
})
test('a native retained resource revokes synchronously and both owner closes await its actual cleanup', async ({ page }) => {
  await start(page)
  await page.evaluate(`(async()=>{const s=await scopes();window.revoked=0;window.cleanupStarted=false;window.cleanup=new Promise(resolve=>window.releaseCleanup=resolve);
    await Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,
      work:(_b,_t,_bn,_tn,c)=>Ordinary.OrdinaryStateOwner.retainPairResource(c,{browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard},
        {revoke:()=>revoked++,join:()=>{cleanupStarted=true;return cleanup}})});
    window.browserJoined=false;window.tabJoined=false;window.browserClosing=browserOwner.close().then(()=>browserJoined=true);window.tabClosing=tabOwner.close().then(()=>tabJoined=true)})()`)
  expect(await page.evaluate('[revoked,cleanupStarted,browserJoined,tabJoined]')).toEqual([1, true, false, false])
  await page.evaluate('releaseCleanup();undefined'); await page.evaluate('Promise.all([browserClosing,tabClosing])')
  expect(await page.evaluate('[revoked,browserJoined,tabJoined]')).toEqual([1, true, true])
})
for (const fault of ['fabricated', 'escaped', 'mutation']) test(`${fault} provenance cannot register a native resource`, async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{const s=await scopes(),binding={browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard};let escaped,error,called=0;
    const retain=c=>Ordinary.OrdinaryStateOwner.retainPairResource(c,binding,{revoke:()=>called++,join:async()=>{}});
    try{if('${fault}'==='fabricated')retain({});else await Ordinary.OrdinaryStateOwner.${fault === 'mutation' ? 'mutatePairMigrated' : 'readPairMigrated'}({...binding,
      work:(_b,_t,_bn,_tn,c)=>{if('${fault}'==='escaped'){escaped=c;return}retain(c)}});if(escaped)retain(escaped)}catch(e){error=e.name}
    await shutdown();await browserOwner.close();return[error,called]})()`)).toEqual(['OrdinaryStateHold', 0])
})
test('real pool subscription recovery reissues a fresh guarded REQ and completes actual history', async ({ page }) => {
  await start(page, { history: false, autoEose: false })
  await page.evaluate('listen()'); await page.waitForFunction('frames.length===2')
  await page.evaluate('autoEose=true'); await page.waitForFunction('eoses===1', { timeout: 10000 })
  expect(await page.evaluate('frames.filter(row=>JSON.parse(row[0])[0]==="REQ").length')).toBeGreaterThan(2)
  expect(await page.evaluate('frames.every(row=>row[1])')).toBe(true); await page.evaluate('shutdown()')
})
test('a changed native source suppresses the real pool retry before its next frame', async ({ page }) => {
  await start(page, { history: false, autoEose: false })
  await page.evaluate('listen()'); await page.waitForFunction('frames.length===2')
  await page.evaluate(`(async()=>{const s=await scopes();await browserOwner.mutateMigrated(s.b,guard,()=>{})})()`)
  await page.waitForFunction('carrier.closed', { timeout: 10000 }); await page.evaluate('carrier.joinLifetime()')
  expect(await page.evaluate('[frames.length,eoses]')).toEqual([2, 0])
})
for (const auth of [false, true]) test(`real loopback WebSockets carry the actual shared pool, NIP42=${auth}`, async ({ page }) => {
  const http = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`) })
  const relay = new WebSocketServer({ server: http }), received: string[] = []
  let source: unknown
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address(); if (!address || typeof address === 'string') throw Error('no loopback port')
  relay.on('connection', socket => {
    if (auth) socket.send(JSON.stringify(['AUTH', 'wire-carrier-challenge']))
    socket.on('message', bytes => {
      const raw = bytes.toString(), frame = JSON.parse(raw); received.push(raw)
      if (frame[0] === 'AUTH' || frame[0] === 'EVENT') socket.send(JSON.stringify(['OK', frame[1].id, true, 'accepted']))
      if (frame[0] === 'REQ') { socket.send(JSON.stringify(['EVENT', frame[1], source])); socket.send(JSON.stringify(['EOSE', frame[1]])) }
    })
  })
  try {
    await page.goto(`http://127.0.0.1:${address.port}/ui`); await page.evaluate(`(${setup})()`)
    source = await page.evaluate('event')
    await page.evaluate(`(async()=>{window.delivered=[];window.eoses=0;const relays=['ws://127.0.0.1:${address.port}/first','ws://127.0.0.1:${address.port}/second'];
      window.carrier=await Ordinary.OrdinaryRelayCarrier.open({browser:browserOwner,tab:tabOwner,scope:invScopeName,relays,profile:'direct',websocketImplementation:WebSocket,
        account,participant,authentication:${auth ? 'relays.map(url=>({url,identity}))' : '[]'},live:guard,validate:()=>{}});
      carrier.subscribe([{kinds:[event.kind]}],value=>delivered.push(value.id),()=>eoses++)})()`)
    await page.waitForFunction('eoses===1&&delivered.length===1')
    await page.evaluate('carrier.publish(event)')
    await page.evaluate('(async()=>{carrier.close();await carrier.joinLifetime()})()')
    const frames = received.map(raw => JSON.parse(raw))
    expect(frames.filter(frame => frame[0] === 'AUTH')).toHaveLength(auth ? 2 : 0)
    expect(frames.filter(frame => frame[0] === 'EVENT').length).toBeGreaterThanOrEqual(1)
    expect(await page.evaluate('delivered[0]===event.id')).toBe(true)
  } finally {
    for (const socket of relay.clients) socket.terminate()
    await new Promise<void>(resolve => relay.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve()))
  }
})
