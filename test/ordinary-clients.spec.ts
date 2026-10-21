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
  // Test-only observation of the browser's actual window inventory. Closing a
  // Playwright Page need not retire its service-worker Client synchronously.
  const inventory = `self.addEventListener('message', e => {
    if (e.data?.test !== 'ordinary-client-inventory-v1' || !e.source || e.ports.length !== 1) return;
    e.waitUntil((async () => {
      const clients = await self.clients.matchAll({type:'window', includeUncontrolled:true});
      e.ports[0].postMessage({source:e.source.id, clients:clients.map(client => client.id)});
    })());
  });`
  server=createServer((req,res)=>{
    if(new URL(req.url ?? '/', 'http://fixture.test').pathname.endsWith('/sw.js')) {res.setHeader('content-type','text/javascript');res.end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));${req.url?.includes('unclaimed')?'':"self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"}\n${worker}\n${inventory}`);return}
    res.setHeader('content-type','text/html')
    res.end(`<!doctype html><meta charset="utf-8">${new URL(req.url ?? '/', 'http://fixture.test').pathname.endsWith('/old')?'':`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}`)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw new Error('server address missing');origin=`http://127.0.0.1:${address.port}`
})
test.afterAll(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())))
async function ready(page: Page, path = '/') {
  await page.goto(origin + path)
  await page.evaluate(async (script) => { await navigator.serviceWorker.register(script); await navigator.serviceWorker.ready }, path + 'sw.js')
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller)
  await page.evaluate('window.clientFence=new Ordinary.OrdinaryClientFence()')
}
async function waitForRetiredClients(page: Page): Promise<void> {
  const samples: unknown[] = []
  try {
    await expect.poll(async () => {
      const sample = await page.evaluate(async () => {
        const channel = new MessageChannel()
        try {
          return await new Promise<{ source: string; clients: string[] }>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Native client inventory did not answer')), 1000)
            channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data) }
            navigator.serviceWorker.controller!.postMessage({ test: 'ordinary-client-inventory-v1' }, [channel.port2])
          })
        } finally { channel.port1.close(); channel.port2.close() }
      })
      samples.push(sample)
      return sample.clients.length === 1 && sample.clients[0] === sample.source
    }).toBe(true)
  } finally {
    await test.info().attach('native-client-retirement', { body: JSON.stringify(samples), contentType: 'application/json' })
  }
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
  await old.close();await b.close();await waitForRetiredClients(a);await a.evaluate('clientFence.assertCurrent()');await context.close()
})

// Production is normally scoped to /j/, but browser Storage and native
// custody are shared with every same-origin path, including older pages.
test('a silent same-origin window outside the worker scope holds', async ({ browser }) => {
  const context = await browser.newContext(), a = await context.newPage()
  try {
    await ready(a, '/j/')
    const old = await context.newPage()
    await old.goto(origin + '/outside/old')
    expect(await old.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true)
    expect(await a.evaluate(`(async () => { try { await clientFence.assertCurrent(); return 'success' } catch (e) { return e.name } })()`)).toBe('OrdinaryStateHold')
    await old.close()
    await a.evaluate('clientFence.assertCurrent()')
  } finally { await context.close() }
})

test('scoped modern windows still acknowledge the same-origin inventory', async ({ browser }) => {
  const context = await browser.newContext(), a = await context.newPage(), b = await context.newPage()
  try {
    await ready(a, '/j/')
    await ready(b, '/j/')
    await a.evaluate('clientFence.assertCurrent()')
    await b.evaluate('clientFence.assertCurrent()')
  } finally { await context.close() }
})

test('an outside-scope window opened during acknowledgements holds', async ({ browser }) => {
  const context = await browser.newContext(), a = await context.newPage(), b = await context.newPage()
  try {
    await ready(a, '/j/')
    await ready(b, '/j/')
    await b.evaluate(`(() => {
      clientFence.close()
      navigator.serviceWorker.addEventListener('message', event => {
        const data = event.data
        if (data?.protocol !== 'kithmoot:ordinary-state-clients-v1' || data.phase !== 'probe') return
        window.probeSeen = true
        new Promise(resolve => window.releaseProbe = resolve).then(() => event.ports[0].postMessage({ protocol: data.protocol, phase: 'ready', nonce: data.nonce }))
      })
    })()`)
    await a.evaluate(`void (window.result = clientFence.assertCurrent().then(() => 'success', e => e.name))`)
    await b.waitForFunction('window.probeSeen')
    const old = await context.newPage()
    await old.goto(origin + '/outside/old')
    expect(await old.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true)
    await b.evaluate('window.releaseProbe()')
    expect(await a.evaluate('window.result')).toBe('OrdinaryStateHold')
    await old.close()
    await b.close()
    await waitForRetiredClients(a)
    await a.evaluate('clientFence.assertCurrent()')
  } finally { await context.close() }
})

test('a modern same-origin window outside the worker scope can acknowledge', async ({ browser }) => {
  const context = await browser.newContext(), outside = await context.newPage(), a = await context.newPage()
  try {
    await outside.goto(origin + '/outside/')
    await outside.evaluate('window.clientFence = new Ordinary.OrdinaryClientFence()')
    await ready(a, '/j/')
    expect(await outside.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true)
    await a.evaluate('clientFence.assertCurrent()')
    // Responding to a genuine active worker does not invent a controller
    // or give this outside-scope page permission to pass its own fence.
    expect(await outside.evaluate(`(async () => { try { await clientFence.assertCurrent(); return 'success' } catch (e) { return e.name } })()`)).toBe('OrdinaryStateHold')
    await outside.close()
    await a.evaluate('clientFence.assertCurrent()')
  } finally { await context.close() }
})

test('a source-less probe cannot obtain a compatibility acknowledgement', async ({ browser }) => {
  const context = await browser.newContext(), page = await context.newPage()
  try {
    await page.goto(origin + '/outside/')
    const acknowledged = await page.evaluate(async () => {
      const module = (window as unknown as { Ordinary: { OrdinaryClientFence: new () => { close(): void } } }).Ordinary
      const fence = new module.OrdinaryClientFence(), channel = new MessageChannel()
      try {
        return await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), 150)
          channel.port1.onmessage = () => { clearTimeout(timer); resolve(true) }
          navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
            data: { protocol: 'kithmoot:ordinary-state-clients-v1', phase: 'probe', nonce: '1'.repeat(64) },
            ports: [channel.port2],
          }))
        })
      } finally { fence.close(); channel.port1.close(); channel.port2.close() }
    })
    expect(acknowledged).toBe(false)
  } finally { await context.close() }
})
