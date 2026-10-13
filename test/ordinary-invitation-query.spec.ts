import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { setup } from './ordinary-bootstrap.setup.js'

const ORIGIN = 'https://ordinary-invitation-query.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts', import.meta.url))], bundle: true,
    format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN)
})
const carrierSetup = `async (options={}) => {
  window.destinations=['wss://first.example/','wss://second.example/'];window.dials=[];window.frames=[];window.sockets=[]
  window.autoOpen=options.autoOpen!==false;window.autoEose=options.autoEose!==false;window.challenge=options.auth===true
  window.sourceEvents=[event]
  window.beforeEnqueue=undefined;window.afterEnqueue=undefined;window.authSigns=0
  window.authIdentity=Ordinary.localIdentity(participantSk);window.authSign=authIdentity.signEvent
  authIdentity.signEvent=function(value){authSigns++;return window.authHook?authHook(value):authSign.call(this,value)}
  class NativeSocket {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3
    CONNECTING=0;OPEN=1;CLOSING=2;CLOSED=3;readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null
    constructor(url){this.url=url;sockets.push(this);dials.push(url);const guarded=this.send.bind(this)
      this.send=data=>{beforeEnqueue?.(data,this);return guarded(data)};if(autoOpen)queueMicrotask(()=>this.open())}
    open(){if(this.readyState!==0)return;this.readyState=1;this.onopen?.({type:'open'});if(challenge)this.message(['AUTH','query-challenge'])}
    message(frame){this.onmessage?.({data:JSON.stringify(frame)})}
    send(data){if(this.readyState!==1)throw Error('closed');frames.push({url:this.url,data});const frame=JSON.parse(data)
      afterEnqueue?.(data,this)
      if(frame[0]==='AUTH')queueMicrotask(()=>this.message(['OK',frame[1].id,true,'']))
      if(frame[0]==='REQ'&&autoEose)queueMicrotask(()=>{for(const value of sourceEvents)this.message(['EVENT',frame[1],value]);this.message(['EOSE',frame[1]])})}
    close(){if(this.readyState===3)return;this.readyState=3;window.onNativeClose?.();this.onclose?.({type:'close'})}
  }
  window.NativeSocket=NativeSocket
  window.carrierCurrent={generation:'c'.repeat(64),profile:'direct',destinations,websocketImplementation:NativeSocket,
    authentication:options.auth?destinations.map(url=>({url,identity:authIdentity})):[]}
  window.queryOptions={...carrierCurrent,current:()=>carrierCurrent,timeoutMs:options.timeoutMs??2000,authenticationTimeoutMs:1000}
  window.begin=()=>{window.queryState='pending';window.querying=bootstrap.queryEvidence(queryOptions).then(value=>{window.queried=value;queryState='ok'},error=>queryState=error.name);return querying}
  window.takeLock=async()=>{let ready;const taken=new Promise(resolve=>ready=resolve);window.lockWork=navigator.locks.request(Ordinary.ORDINARY_DATABASE+':write',async()=>{
    ready();await new Promise(resolve=>window.releaseLock=resolve)});await taken}
}`
async function start(page: Page, options = {}) {
  await page.evaluate(`(${setup})()`)
  await page.evaluate(`(${carrierSetup})(${JSON.stringify(options)})`)
}
for (const auth of [false, true]) test(`actual Fold query completes only both exact destinations, authentication=${auth}`, async ({ page }) => {
  await start(page, { auth })
  expect(await page.evaluate(`(async()=>{
    const before=await rawBoth();countCrypto();await begin();const result=await bootstrap.bootstrap(queried)
    const requests=frames.filter(row=>JSON.parse(row.data)[0]==='REQ'),answer=[queryState,queried.completion,queried.eventIds,
      requests.length,requests.every(row=>JSON.stringify(JSON.parse(row.data).slice(2))===JSON.stringify([{kinds:[1463,1461],authors:[invitation.inviter],'#d':[id]}])),
      authSigns,signCalls,sockets.every(s=>s.readyState===3),Ordinary.bytesToHex(result.admission.secret)===Ordinary.bytesToHex(secret)]
    Ordinary.wipeOrdinaryPersistentBootstrapResult(result);restoreCrypto();return answer
  })()`)).toEqual(['ok', 'eose', [await page.evaluate('event.id')], 2, true, auth ? 2 : 0, 1, true, true])
})
test('one destination EOSE is insufficient; read-only query changes no encrypted image', async ({ page }) => {
  await start(page, { autoOpen: false, autoEose: false })
  await page.evaluate('window.before=undefined;begin();undefined'); await page.waitForFunction('dials.length===2')
  await page.evaluate(`(async()=>{before=await rawBoth();sockets[0].open()})()`); await page.waitForFunction('frames.length===1')
  await page.evaluate(`sockets[0].message(['EVENT','ordinary-invitation',event]);sockets[0].message(['EOSE','ordinary-invitation'])`)
  expect(await page.evaluate('queryState')).toBe('pending')
  await page.evaluate('sockets[1].open()'); await page.waitForFunction('frames.length===2')
  await page.evaluate(`sockets[1].message(['EOSE','ordinary-invitation']);querying`)
  expect(await page.evaluate(`(async()=>[queryState,(await rawBoth()).every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame)),signCalls,authSigns])()`)).toEqual(['ok', true, 0, 0])
})
for (const fault of ['account','keep','generation','implementation','profile','destinations','abort','close','browser-fence','tab-fence','same-byte-revision']) {
  test(`${fault} ahead of native dial refuses every connection`, async ({ page }) => {
    await start(page)
    await page.evaluate(`(async()=>{const s=await scopes();await takeLock();window.abortController=new AbortController();queryOptions.signal=abortController.signal
      window.cutting=undefined
      if(${JSON.stringify(fault)}==='browser-fence'||${JSON.stringify(fault)}==='tab-fence'||${JSON.stringify(fault)}==='same-byte-revision'){
        cutting=${JSON.stringify(fault)}==='same-byte-revision'?browserOwner.mutateMigrated(s.b,guard,()=>{}):
          (${JSON.stringify(fault)}==='browser-fence'?browserOwner:tabOwner).forget(${JSON.stringify(fault)}==='browser-fence'?s.b:s.t,guard,()=>false)
      }
      begin()})()`)
    expect(await page.evaluate(`(async fault=>{
      if(fault==='account')current={...current,account:null};if(fault==='keep')current={...current,keep:false}
      if(fault==='generation')carrierCurrent={...carrierCurrent,generation:'d'.repeat(64)}
      if(fault==='implementation')carrierCurrent={...carrierCurrent,websocketImplementation:WebSocket}
      if(fault==='profile')carrierCurrent={...carrierCurrent,profile:'tor'}
      if(fault==='destinations')carrierCurrent={...carrierCurrent,destinations:['wss://elsewhere.example/']}
      if(fault==='abort')abortController.abort();let closing;if(fault==='close')closing=bootstrap.close()
      releaseLock();await lockWork;await cutting;await querying;await closing;return [queryState,dials.length,frames.length,signCalls]
    })(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold', 0, 0, 0])
  })
}
for (const kind of ['REQ','AUTH']) for (const cut of ['before','after']) test(`${cut} raw ${kind} enqueue fence has a single native ordering`, async ({ page }) => {
  await start(page, { autoOpen: false, autoEose: false, auth: kind === 'AUTH' })
  await page.evaluate(`(async()=>{window.cutting=undefined;window.s=await scopes();${cut === 'before' ? 'beforeEnqueue' : 'afterEnqueue'}=data=>{
    if(JSON.parse(data)[0]===${JSON.stringify(kind)}&&!cutting)cutting=browserOwner.forget(s.b,guard,()=>false)};begin()})()`)
  await page.waitForFunction('dials.length===2'); await page.evaluate('sockets[0].open()'); await page.evaluate('querying'); await page.evaluate('cutting')
  expect(await page.evaluate('[queryState,frames.length,sockets.every(s=>s.readyState===3)]')).toEqual(['OrdinaryStateHold', cut === 'before' ? 0 : 1, true])
})
for (const fault of ['timeout','close','wrong-id','unsolicited-auth','binary','overflow-count','overflow-bytes']) test(`${fault} cannot manufacture completed evidence`, async ({ page }) => {
  await start(page, { autoOpen: false, autoEose: false, timeoutMs: 300 })
  await page.evaluate(`(fault=>{if(fault==='overflow-count')queryOptions.maxQueuedFrames=1;if(fault==='overflow-bytes')queryOptions.maxQueuedBytes=1;begin()})(${JSON.stringify(fault)})`)
  {
    await page.waitForFunction('dials.length===2')
    await page.evaluate(`(async fault=>{
      if(fault==='overflow-count')await takeLock();sockets.forEach(s=>s.open())
      if(fault==='overflow-count'){releaseLock();await lockWork}
    })(${JSON.stringify(fault)})`)
    if (!fault.startsWith('overflow')) {
      await page.waitForFunction('frames.length===2')
      await page.evaluate(`(fault=>{if(fault==='close')sockets[0].close();if(fault==='wrong-id')sockets[0].message(['EOSE','wrong'])
        if(fault==='unsolicited-auth')sockets[0].message(['AUTH','not-consented'])
        if(fault==='binary')sockets[0].onmessage?.({data:new Uint8Array([1])})})(${JSON.stringify(fault)})`)
    }
  }
  await page.evaluate('querying')
  expect(await page.evaluate('[queryState,typeof queried,signCalls,sockets.every(s=>s.readyState===3)]')).toEqual(['OrdinaryStateHold','undefined',0,true])
})
test('late AUTH signer is joined after close; no late frame or evidence escapes', async ({ page }) => {
  await start(page, { auth: true })
  await page.evaluate(`window.authReleases=[];window.authHook=value=>new Promise(resolve=>authReleases.push(()=>resolve(authSign.call(authIdentity,value))));begin();undefined`)
  await page.waitForFunction('authSigns===2')
  await page.evaluate('window.closedReceipt=false;window.closing=bootstrap.close().then(()=>closedReceipt=true);undefined')
  expect(await page.evaluate('[closedReceipt,frames.length]')).toEqual([false,0])
  // Settle both captured providers, including the first independent relay.
  await page.evaluate('authReleases.forEach(release=>release());undefined')
  await page.evaluate('querying');await page.evaluate('closing')
  expect(await page.evaluate('[queryState,closedReceipt,frames.length,typeof queried,sockets.every(s=>s.readyState===3)]')).toEqual(['OrdinaryStateHold',true,0,'undefined',true])
})
for (const source of ['getter','current']) test(`${source} re-entry refuses a second query and bootstrap`, async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async source=>{let once=false;window.reentered=[]
    const reenter=()=>{if(once)return;once=true;try{bootstrap.queryEvidence(queryOptions)}catch(e){reentered.push(e.name)}
      try{bootstrap.bootstrap(evidence)}catch(e){reentered.push(e.name)}}
    if(source==='getter')Object.defineProperty(queryOptions,'generation',{enumerable:true,get(){reenter();return carrierCurrent.generation}})
    else queryOptions.current=()=>{reenter();return carrierCurrent}
    await begin();return [queryState,reentered,dials.length,frames.length]
  })(${JSON.stringify(source)})`)).toEqual(['ok',['OrdinaryStateHold','OrdinaryStateHold'],2,2])
})
for (const fault of ['generation','destinations','authentication','account','keep','source','same-byte-revision']) test(`final handoff refuses ${fault} after all EOSEs`, async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async fault=>{
    const s=await scopes();window.cutting=undefined;let once=false
    window.onNativeClose=()=>{if(once)return;once=true
      if(fault==='generation')carrierCurrent={...carrierCurrent,generation:'d'.repeat(64)}
      if(fault==='destinations')carrierCurrent={...carrierCurrent,destinations:['wss://elsewhere.example/']}
      if(fault==='authentication')carrierCurrent={...carrierCurrent,authentication:[{url:destinations[0],identity:authIdentity}]}
      if(fault==='account')current={...current,account:null};if(fault==='keep')current={...current,keep:false}
      if(fault==='source'||fault==='same-byte-revision')cutting=browserOwner.mutateMigrated(s.b,guard,b=>{
        if(fault==='source')b.set('kithmoot.nudge.'+roomId,'true')})}
    await begin();await cutting;return [queryState,typeof queried,frames.length,signCalls,sockets.every(s=>s.readyState===3)]
  })(${JSON.stringify(fault)})`)).toEqual(['OrdinaryStateHold','undefined',2,0,true])
})
test('expired captured credential choice refuses query before all dials',async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async()=>{
    await bootstrap.close();credentialExpiresAt=now;current={...current,credentialExpiresAt};bootstrap=await open()
    await begin();return [queryState,dials.length,frames.length]
  })()`)).toEqual(['OrdinaryStateHold',0,0])
})
for(const observation of ['absent','retired'])test(`completed ${observation} observation never bootstraps a member`,async({page})=>{
  await start(page)
  expect(await page.evaluate(`(async observation=>{
    sourceEvents=observation==='absent'?[]:[event,Ordinary.encodeInvitationRetirement({invitation,inviterSk,now:now+1})]
    await begin();countCrypto();const state=await outcome(()=>bootstrap.bootstrap(queried))
    const answer=[queryState,queried.completion,state,entropy,encryptions,signCalls];restoreCrypto();return answer
  })(${JSON.stringify(observation)})`)).toEqual(['ok','eose','OrdinaryStateHold',0,0,0])
})
for (const auth of [false,true]) test(`native browser WebSockets query actual signed events and all EOSEs, authentication=${auth}`, async ({ page }) => {
  let source: unknown, inviter: string
  const http = createServer((_request, response) => { response.writeHead(200, {'content-type':'text/html'}); response.end(`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`) })
  const relay = new WebSocketServer({ server: http }), received: string[] = []
  await new Promise<void>((resolve,reject) => { http.once('error',reject); http.listen(0,'127.0.0.1',resolve) })
  const address = http.address(); if (!address || typeof address === 'string') throw Error('no relay address')
  relay.on('connection', socket => {
    if (auth) socket.send(JSON.stringify(['AUTH','wire-query-challenge']))
    socket.on('message', bytes => {
      const data=bytes.toString(),frame=JSON.parse(data); received.push(data)
      if(frame[0]==='AUTH')socket.send(JSON.stringify(['OK',frame[1].id,true,'accepted']))
      if(frame[0]==='REQ'){socket.send(JSON.stringify(['EVENT',frame[1],source]));socket.send(JSON.stringify(['EOSE',frame[1]]))}
    })
  })
  try {
    await page.goto(`http://127.0.0.1:${address.port}/ui`);await page.evaluate(`(${setup})()`)
    source=await page.evaluate('event');inviter=await page.evaluate('invitation.inviter')
    const destinations=[`ws://127.0.0.1:${address.port}/first`,`ws://127.0.0.1:${address.port}/second`]
    expect(await page.evaluate(`(async destinations=>{
      const carrier={generation:'e'.repeat(64),profile:'direct',destinations,websocketImplementation:WebSocket,
        authentication:${auth?'destinations.map(url=>({url,identity}))':'[]'}}
      const queried=await bootstrap.queryEvidence({...carrier,current:()=>carrier,timeoutMs:10000})
      return [queried.completion,queried.eventIds]
    })(${JSON.stringify(destinations)})`)).toEqual(['eose',[(source as {id:string}).id]])
    const reqs=received.map(data=>JSON.parse(data)).filter(frame=>frame[0]==='REQ')
    expect(reqs).toHaveLength(2);expect(reqs.every(frame=>frame[2].authors[0]===inviter)).toBe(true)
    expect(received).toHaveLength(auth?4:2)
  } finally { for(const socket of relay.clients)socket.terminate();await new Promise<void>(resolve=>relay.close(()=>resolve()));await new Promise<void>(resolve=>http.close(()=>resolve())) }
})
