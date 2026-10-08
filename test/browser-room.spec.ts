import { build } from 'esbuild'
import { test, expect, type Page } from '@playwright/test'
const origin = 'https://browser-room.kithmoot.test'
const alias = 'e'.repeat(64)
const room = 'a'.repeat(64), account = 'b'.repeat(64)
const run = (page: Page, code: string) => page.evaluate(`(${code})()`)
let bundle: string
test.beforeAll(async () => {
  bundle = (await build({ entryPoints:['test/browser-room.browser-entry.ts'], bundle:true, write:false, format:'iife', globalName:'R',
    define:{'import.meta.env.BASE_URL':'"/"'} })).outputFiles[0].text
})
test('a non-answering tab holds the closure barrier; an explicit release allows retry', async ({ browser }) => {
  const context = await browser.newContext()
  await context.route(origin+'/**', r => r.fulfill({ contentType:'text/html', body:`<script>${bundle}</script>` }))
  const a = await context.newPage(), b = await context.newPage()
  for (const page of [a,b]) {
    await page.goto(origin)
    await run(page, `() => { window.barrier = new R.BrowserRoomBarrier(navigator.locks, new BroadcastChannel('fixture'), async () => {}); }`)
  }
  await run(b, `async () => { window.release = await barrier.publicLease('${room}') }`)
  expect(await run(a, `async () => { try { await barrier.closed('${room}', async () => {}, 40); return false } catch (e) { return e.message.includes('Another tab still has this room open') } }`)).toBe(true)
  await run(b, '() => release()')
  expect(await run(a, `async () => { let ran=false; await barrier.closed('${room}', async () => {ran=true}); return ran }`)).toBe(true)
  await context.close()
})

test('durable private intent closes every public pool and never reopens it after reload or another account', async ({ browser }) => {
  const context = await browser.newContext()
  await context.route(origin+'/**', r => r.fulfill({ contentType:'text/html', body:`<script>${bundle}</script>` }))
  const a = await context.newPage(), b = await context.newPage()
  const setup = async (page: Page, identity = account, scope = room) => {
    await page.goto(origin)
    await run(page, `() => {
      window.vault = new R.BrowserRoomConsents();
      window.barrier = new R.BrowserRoomBarrier(navigator.locks, new BroadcastChannel('fixture'), async () => {});
      window.publicStarts=0; window.publicClosed=0; window.privateStarts=0; window.received=0;
      window.pool=new R.BrowserRoomPool({room:'${scope}',account:()=>'${identity}',store:vault,barrier,
        publicPool:()=>{ publicStarts++; return {subscribe:(_f,receive)=>{window.oldReceive=receive;return ()=>{}},publish:async()=>{},close:()=>{publicClosed++}} },
        privatePool:async()=>{ privateStarts++; return {subscribe:()=>()=>{},publish:async()=>{},close:()=>{}} }
      });
      pool.subscribe([{kinds:[1460],'#d':['${room}']}],()=>{received++});
    }`)
  }
  await setup(a); await setup(b, account, alias)
  await expect.poll(()=>run(a,'()=>publicStarts')).toBe(1)
  await expect.poll(()=>run(b,'()=>publicStarts')).toBe(1)
  await run(a, `async () => {
    window.consent={account:'${account}',room:'${room}',device:'${'c'.repeat(64)}',box:{routeId:'route',eventUrl:'ws://${'a'.repeat(52)}/events'},
      phase:'installing',expires:Math.floor(Date.now()/1000)+3600,grants:[],scopes:['${room}'],aliases:['lookup:${alias}']};
    await vault.put(consent); barrier.changed();
    await barrier.closed('${room}',async()=>{consent.phase='active';await vault.put(consent)}); barrier.changed();
  }`)
  await expect.poll(()=>run(b,'()=>publicClosed')).toBe(1)
  await expect.poll(()=>run(b,'()=>privateStarts')).toBeGreaterThan(0)
  await run(b, '()=>oldReceive({})')
  expect(await run(b, '()=>received')).toBe(0)
  expect(await run(b, '()=>publicStarts')).toBe(1)
  await b.reload(); await setup(b, 'd'.repeat(64), alias)
  await run(b, 'async()=>{await new Promise(r=>setTimeout(r,100));}')
  expect(await run(b,'()=>({publicStarts,privateStarts})')).toEqual({publicStarts:0,privateStarts:0})
  expect(await run(b,'()=>Object.keys(localStorage)')).toEqual([])
  await context.close()
})
