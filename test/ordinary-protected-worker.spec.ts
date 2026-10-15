import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

let server:Server,origin='',bundle='',protocol='',supported=true
let holdResponse=false,workerArrived:(()=>void)|undefined,releaseResponse:(()=>void)|undefined
test.beforeAll(async()=>{
  const result=await build({entryPoints:['test/ordinary-protected-worker.browser-entry.ts'],bundle:true,write:false,
    format:'iife',globalName:'WorkerTest',platform:'browser',target:'es2022',metafile:true})
  // This pre-owner graph must remain free of SDK, signers and private readers.
  expect(Object.keys(result.metafile!.inputs).sort()).toEqual([
    'app/src/ordinary-legacy-startup.ts','app/src/ordinary-protected-worker.ts','app/src/ordinary-state-clients.ts',
    'app/src/ordinary-state-codec.ts','app/src/ordinary-state-layout.ts','test/ordinary-protected-worker.browser-entry.ts',
  ])
  bundle=result.outputFiles[0]!.text
  protocol=await readFile('app/public/ordinary-state-sw.js','utf8')
  server=createServer((req,res)=>{
    const url=new URL(req.url??'/','http://fixture.invalid')
    res.setHeader('cache-control','no-store')
    if(url.pathname==='/j/sw.js'){
      res.setHeader('content-type','text/javascript')
      const source="self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));"+
        (url.search?"self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));":'')+(supported?protocol:'')
      if(holdResponse){releaseResponse=()=>{res.end(source);releaseResponse=undefined};workerArrived?.();return}
      res.end(source);return
    }
    res.setHeader('content-type','text/html')
    res.end(`<!doctype html><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script><script>
      window.effects={storage:0,key:0,privateOpen:0,provider:0};
      for(const name of ['getItem','setItem','removeItem','clear'])Storage.prototype[name]=()=>{effects.storage++;throw Error('private Storage')};
      crypto.subtle.generateKey=()=>{effects.key++;throw Error('private key')};
      indexedDB.open=()=>{effects.privateOpen++;throw Error('private database')};
      Object.defineProperty(window,'nostr',{get(){effects.provider++;throw Error('provider')}});
    </script>`)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw Error('missing worker fixture')
  origin=`http://127.0.0.1:${address.port}`
})
test.beforeEach(async({page})=>{supported=true;holdResponse=false;workerArrived=undefined;await page.goto(origin+'/j/')})
test.afterEach(()=>{releaseResponse?.();holdResponse=false})
test.afterAll(()=>new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes())))
const noPrivateEffects={storage:0,key:0,privateOpen:0,provider:0}
async function controlled(page:Page){
  expect(await page.evaluate(`(async()=>{
    window.worker=new WorkerTest.OrdinaryProtectedWorkerLifetime();const result=await worker.prepare();await worker.close();return result
  })()`)).toBe('controlled-reload-required')
  await page.reload()
}
async function ready(page:Page){
  await controlled(page)
  expect(await page.evaluate(`(async()=>{window.worker=new WorkerTest.OrdinaryProtectedWorkerLifetime();return worker.prepare()})()`)).toBe('ready')
}

test('an actual first install requires controlled reload before compatibility readiness',async({page})=>{
  expect(await page.evaluate(`(async()=>{
    window.worker=new WorkerTest.OrdinaryProtectedWorkerLifetime();const result=await worker.prepare()
    const registration=await navigator.serviceWorker.getRegistration('/j/')
    const value={result,live:worker.live,uncontrolled:navigator.serviceWorker.controller===null,
      active:registration.active?.state,scope:registration.scope,script:registration.active?.scriptURL,effects}
    await worker.close();return value
  })()`)).toEqual({result:'controlled-reload-required',live:false,uncontrolled:true,active:'activated',
    scope:origin+'/j/',script:origin+'/j/sw.js',effects:noPrivateEffects})
})

test('an actual controlled worker performs the fresh all-window protocol without private effects',async({page})=>{
  await ready(page)
  expect(await page.evaluate(`(async()=>{await worker.assertCurrent();return {live:worker.live,effects}})()`))
    .toEqual({live:true,effects:noPrivateEffects})
  await page.evaluate('worker.close()')
})

test('a silent legacy window outside the fixed scope refuses worker preparation',async({page,context})=>{
  await controlled(page)
  const old=await context.newPage();await old.goto(origin+'/outside/old')
  expect(await page.evaluate(`(async()=>{
    window.worker=new WorkerTest.OrdinaryProtectedWorkerLifetime();let result
    try{await worker.prepare();result='unexpected'}catch(e){result=e.name}
    await worker.close();return {result,live:worker.live,effects}
  })()`)).toEqual({result:'OrdinaryStateHold',live:false,effects:noPrivateEffects})
})

test('an actual modern outside-scope window can acknowledge the origin-wide fence',async({page,context})=>{
  await ready(page)
  const outside=await context.newPage();await outside.goto(origin+'/outside/modern')
  expect(await outside.evaluate('navigator.serviceWorker.controller===null')).toBe(true)
  await outside.evaluate('window.modernFence=new WorkerTest.OrdinaryClientFence()')
  await page.evaluate('worker.assertCurrent()')
  expect(await page.evaluate('({live:worker.live,effects})')).toEqual({live:true,effects:noPrivateEffects})
  await outside.evaluate('modernFence.close()');await page.evaluate('worker.close()')
})

test('two controlled modern documents acknowledge each other before preparation returns',async({page,context})=>{
  await ready(page)
  const other=await context.newPage();await other.goto(origin+'/j/')
  expect(await other.evaluate(`(async()=>{window.worker=new WorkerTest.OrdinaryProtectedWorkerLifetime();return worker.prepare()})()`)).toBe('ready')
  await page.evaluate('worker.assertCurrent()');await other.evaluate('worker.assertCurrent()')
  expect(await other.evaluate('effects')).toEqual(noPrivateEffects)
  await other.evaluate('worker.close()');await page.evaluate('worker.close()')
})

test('actual controller replacement irrevocably revokes readiness',async({page})=>{
  await ready(page)
  await page.evaluate('navigator.serviceWorker.register("/j/sw.js?replacement",{scope:"/j/",updateViaCache:"none"})')
  await page.waitForFunction('navigator.serviceWorker.controller?.scriptURL.endsWith("?replacement")')
  expect(await page.evaluate(`(async()=>{
    let current=false,prepare=false;try{await worker.assertCurrent()}catch{current=true}
    try{await worker.prepare()}catch{prepare=true};await worker.close()
    return {live:worker.live,current,prepare,effects}
  })()`)).toEqual({live:false,current:true,prepare:true,effects:noPrivateEffects})
})

test('close joins an actual pending origin inventory before a fixture root releases MIGRATION',async({page,context})=>{
  await ready(page)
  const old=await context.newPage();await old.goto(origin+'/outside/old')
  await page.evaluate(`(async()=>{
    window.lease=new WorkerTest.OrdinaryLegacyStartupLifetime();await lease.acquire()
    window.seenProbe=false;window.result='pending';window.workerClosed=false
    navigator.serviceWorker.addEventListener('message',e=>{if(e.data?.phase==='probe')seenProbe=true})
    window.pending=worker.assertCurrent().then(()=>result='unexpected',e=>result=e.name)
  })()`)
  await page.waitForFunction('window.seenProbe')
  expect(await page.evaluate(`(async()=>{
    window.ended=worker.close().then(()=>{workerClosed=true;return lease.close()})
    const available=await navigator.locks.request('kithmoot-ordinary-state-v1:migration',{ifAvailable:true},lock=>!!lock)
    return {available,result,workerClosed,live:worker.live}
  })()`)).toEqual({available:false,result:'pending',workerClosed:false,live:false})
  expect(await page.evaluate(`(async()=>{
    await ended;await pending
    return {available:await navigator.locks.request('kithmoot-ordinary-state-v1:migration',{ifAvailable:true},lock=>!!lock),
      result,workerClosed,effects}
  })()`)).toEqual({available:true,result:'OrdinaryStateHold',workerClosed:true,effects:noPrivateEffects})
})

test('close joins delayed native registration before a fixture root releases MIGRATION',async({page})=>{
  holdResponse=true
  const arrived=new Promise<void>(resolve=>workerArrived=resolve)
  await page.evaluate(`(async()=>{
    window.lease=new WorkerTest.OrdinaryLegacyStartupLifetime();await lease.acquire()
    window.worker=new WorkerTest.OrdinaryProtectedWorkerLifetime();window.result='pending';window.workerClosed=false
    window.pending=worker.prepare().then(()=>result='unexpected',e=>result=e.name)
  })()`)
  await arrived
  expect(await page.evaluate(`(async()=>{
    window.ended=worker.close().then(()=>{workerClosed=true;return lease.close()})
    return {available:await navigator.locks.request('kithmoot-ordinary-state-v1:migration',{ifAvailable:true},lock=>!!lock),result,workerClosed}
  })()`)).toEqual({available:false,result:'pending',workerClosed:false})
  releaseResponse!()
  expect(await page.evaluate(`(async()=>{
    await pending;await ended
    return {available:await navigator.locks.request('kithmoot-ordinary-state-v1:migration',{ifAvailable:true},lock=>!!lock),result,workerClosed,effects}
  })()`)).toEqual({available:true,result:'OrdinaryStateHold',workerClosed:true,effects:noPrivateEffects})
})

test('same-origin fixed-path control without the real protocol never proves compatibility',async({page})=>{
  supported=false
  await controlled(page)
  expect(await page.evaluate(`(async()=>{
    window.worker=new WorkerTest.OrdinaryProtectedWorkerLifetime();let result
    try{await worker.prepare();result='unexpected'}catch(e){result=e.name}
    await worker.close();return {result,live:worker.live,effects}
  })()`)).toEqual({result:'OrdinaryStateHold',live:false,effects:noPrivateEffects})
})
