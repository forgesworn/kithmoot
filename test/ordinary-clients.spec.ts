import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
let server: Server, origin: string
test.beforeAll(async () => {
  const result = await build({ entryPoints:[fileURLToPath(new URL('./ordinary-clients.browser-entry.ts',import.meta.url))],bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false })
  const bundle = result.outputFiles[0]!.text
  const worker = await readFile(new URL('../app/public/ordinary-state-sw.js',import.meta.url),'utf8')
  server=createServer((req,res)=>{
    if(req.url?.startsWith('/sw.js')) {res.setHeader('content-type','text/javascript');res.end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));${req.url.includes('unclaimed')?'':"self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"}\n${worker}`);return}
    res.setHeader('content-type','text/html')
    res.end(`<!doctype html><meta charset="utf-8">${req.url==='/old'?'':`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}`)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw new Error('server address missing');origin=`http://127.0.0.1:${address.port}`
})
test.afterAll(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
async function ready(page: Page) {
  await page.goto(origin)
  await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready})
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller)
  await page.evaluate('window.clientFence=new Ordinary.OrdinaryClientFence()')
}
test('actual active worker verifies every modern window', async({browser})=>{
  const context=await browser.newContext();const a=await context.newPage(),b=await context.newPage();await ready(a);await ready(b)
  await a.evaluate('clientFence.assertCurrent()');await b.evaluate('clientFence.assertCurrent()');await context.close()
})
test('an old silent window holds until it is closed',async({browser})=>{
  const context=await browser.newContext();const a=await context.newPage();await ready(a)
  const old=await context.newPage();await old.goto(origin+'/old')
  expect(await a.evaluate(`(async()=>{try{await clientFence.assertCurrent();return 'success'}catch(e){return e.name}})()`)).toBe('OrdinaryStateHold')
  await old.close();await a.evaluate('clientFence.assertCurrent()');await context.close()
})
test('a modern but unresponsive window cannot be omitted from migration',async({browser})=>{
  const context=await browser.newContext();const a=await context.newPage(),b=await context.newPage();await ready(a);await ready(b)
  await b.evaluate('clientFence.close()')
  expect(await a.evaluate(`(async()=>{try{await clientFence.assertCurrent();return 'success'}catch(e){return e.name}})()`)).toBe('OrdinaryStateHold')
  await b.close();await a.evaluate('clientFence.assertCurrent()');await context.close()
})
test('an uncontrolled old window is included before migration can proceed',async({browser})=>{
  const context=await browser.newContext();const old=await context.newPage();await old.goto(origin+'/old')
  const a=await context.newPage();await a.goto(origin)
  await a.evaluate(async()=>{
    const registration=await navigator.serviceWorker.register('/sw.js?unclaimed')
    await navigator.serviceWorker.ready
    await new Promise<void>(resolve=>{const worker=registration.active!;if(worker.state==='activated')resolve();else worker.addEventListener('statechange',()=>{if(worker.state==='activated')resolve()})})
  })
  await a.reload();await a.waitForFunction(()=>!!navigator.serviceWorker.controller)
  await a.evaluate('window.clientFence=new Ordinary.OrdinaryClientFence()')
  expect(await old.evaluate(()=>navigator.serviceWorker.controller===null)).toBe(true)
  expect(await a.evaluate(`(async()=>{try{await clientFence.assertCurrent();return 'success'}catch(e){return e.name}})()`)).toBe('OrdinaryStateHold')
  await old.close();await a.evaluate('clientFence.assertCurrent()');await context.close()
})
test('a window opened during acknowledgements changes the inventory and holds',async({browser})=>{
  const context=await browser.newContext();const a=await context.newPage(),b=await context.newPage();await ready(a);await ready(b)
  await b.evaluate(`(() => {
    clientFence.close()
    navigator.serviceWorker.addEventListener('message',event=>{
      const data=event.data
      if(data?.protocol!=='kithmoot:ordinary-state-clients-v1'||data.phase!=='probe')return
      window.probeSeen=true
      new Promise(resolve=>window.releaseProbe=resolve).then(()=>event.ports[0].postMessage({protocol:data.protocol,phase:'ready',nonce:data.nonce}))
    })
  })()`)
  await a.evaluate(`void (window.result=clientFence.assertCurrent().then(()=>'success',e=>e.name))`)
  await b.waitForFunction('window.probeSeen')
  const old=await context.newPage();await old.goto(origin+'/old')
  await b.evaluate('window.releaseProbe()')
  expect(await a.evaluate('window.result')).toBe('OrdinaryStateHold')
  expect(await b.evaluate('window.probeSeen')).toBe(true)
  await old.close();await b.close();await a.evaluate('clientFence.assertCurrent()');await context.close()
})
