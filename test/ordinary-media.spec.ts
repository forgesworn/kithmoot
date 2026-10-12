import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { MEDIA_MODES, MEDIA_FAULTS } from './ordinary-media-fixture.js'

// Native custody with actual app writer cuts and
// a no-op client fence. No production root, app controls or authority proof.
const ORIGIN = 'https://ordinary-media.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-media.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `()=>{
 window.guard=()=>true;window.owner=new Ordinary.OrdinaryStateOwner();window.kind='browser';window.storage=localStorage
 window.seed=async(mode='all')=>{window.fixture=Ordinary.mediaFixture(mode);window.kind=fixture.kind;window.storage=kind==='tab'?sessionStorage:localStorage;window.owner=kind==='tab'?new Ordinary.OrdinaryStateOwner('tab:'+'a'.repeat(64),Date.now()+3600000):new Ordinary.OrdinaryStateOwner();for(const[k,v]of fixture.records)storage.setItem(k,v);return new Map(fixture.records)}
 window.source=()=>Array.from({length:storage.length},(_,i)=>{const k=storage.key(i);return[k,storage.getItem(k)]}).sort()
 window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage,selected:k=>k.startsWith('kithmoot.'),
  validate:(records,migrated)=>Ordinary.validateOrdinaryMediaSnapshot(records,migrated,{kind}),checkClients:async()=>{},live:guard})
 window.raw=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
  const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get(owner.purpose);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()}})
 window.countCrypto=()=>{const random=crypto.getRandomValues.bind(crypto),generate=crypto.subtle.generateKey.bind(crypto.subtle),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
  window.entropy=0;window.generated=0;window.encryptions=0;crypto.getRandomValues=(...a)=>{entropy++;return random(...a)}
  crypto.subtle.generateKey=(...a)=>{generated++;return generate(...a)};crypto.subtle.encrypt=(...a)=>{encryptions++;return encrypt(...a)}
  window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.generateKey=generate;crypto.subtle.encrypt=encrypt}}
}`
async function open(context: BrowserContext) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate('(' + setup + ')()'); return page
}
for (const mode of MEDIA_MODES) test(`${mode} actual media writer migrates exact bytes in native Storage and IDB`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
   const before=await seed('${mode}');countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
   const out=[generated,image.migration.phase,[...before].every(([k,v])=>image.records.get(k)===v),image.records.size,
     Object.keys(localStorage),Object.keys(sessionStorage),row.key.extractable];restoreCrypto();return out
  })()`)).toEqual([1, 'complete', true, mode === 'all' ? 7 : 1, [], [], false]); await context.close()
})
for (const fault of MEDIA_FAULTS) test(`raw media holds ${fault} before entropy, writes or source cleanup`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
   await seed();const records=new Map(fixture.records);Ordinary.damageMediaFixture(records,'${fault}');localStorage.clear()
   for(const[k,v]of records)localStorage.setItem(k,v);const before=JSON.stringify(source());countCrypto()
   const put=IDBObjectStore.prototype.put,del=IDBObjectStore.prototype.delete;let writes=0,deletes=0
   IDBObjectStore.prototype.put=function(...a){writes++;return put.apply(this,a)};IDBObjectStore.prototype.delete=function(...a){deletes++;return del.apply(this,a)}
   try{let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'}return[held,entropy,generated,encryptions,writes,deletes,
     before===JSON.stringify(source()),!(await raw())]}
   finally{restoreCrypto();IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=del}
  })()`)).toEqual([true, 0, 0, 0, 0, 0, true, true]); await context.close()
})
for (const fault of ['wrapped', 'effect', 'voice', 'blur-alternate', 'camera-empty', 'profile-browser-on'] as const)
  test(`completed media holds ${fault} without rewriting custody`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
     await seed();await migrate();const scope=await owner.capture('@damage',guard),row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),records=new Map(image.records)
     Ordinary.damageMediaFixture(records,'${fault}');await owner.mutate(scope,guard,store=>{for(const k of store.keys())store.remove(k);for(const[k,v]of records)store.set(k,v)})
     const staged=await raw();countCrypto();let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'}
     const out=[held,entropy,generated,encryptions,Ordinary.sameOrdinaryFrame(staged.frame,(await raw()).frame),Object.keys(localStorage)];restoreCrypto();return out
    })()`)).toEqual([true, 0, 0, 0, true, []]); await context.close()
  })
test('complete media custody survives page reload byte-exactly without new entropy', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  const before = await page.evaluate<{ records: [string, string][] }>(`(async()=>{await seed();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);return {records:[...image.records].sort()}})()`)
  await page.reload(); await page.evaluate('(' + setup + ')()')
  expect(await page.evaluate(`(async()=>{countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);
    const out={records:[...image.records].sort(),entropy,generated,encryptions,local:Object.keys(localStorage),tab:Object.keys(sessionStorage)};restoreCrypto();return out})()`))
    .toEqual({ ...before, entropy: 0, generated: 0, encryptions: 0, local: [], tab: [] }); await context.close()
})
test('browser media rows hold before tab relocation and mutation', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{await seed();kind='tab';countCrypto();let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'}
    const out=[held,entropy,generated,encryptions,Object.keys(localStorage).length,!(await raw())];restoreCrypto();return out})()`))
    .toEqual([true, 0, 0, 0, 7, true]); await context.close()
})

// These direct tab-purpose owners use a synthetic purpose and deadline. The
// real lifetime marker/clone/client fence and complete tab composite remain
// separate gates; these tests establish only custody scope and exact retention.
for (const mode of ['profile-tab-off', 'profile-tab-on'] as const) test(`${mode} survives reload in its synthetic tab-purpose owner`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  const before = await page.evaluate(`(async()=>{await seed('${mode}');await migrate();const row=await raw();const image=await Ordinary.openOrdinaryFrame(row.frame,row.key);return {frame:{...row.frame,nonce:Array.from(new Uint8Array(row.frame.nonce)),ciphertext:Array.from(new Uint8Array(row.frame.ciphertext))},expiresAt:image.expiresAt,purpose:owner.purpose}})()`)
  await page.reload(); await page.evaluate('(' + setup + ')()')
  expect(await page.evaluate(async before => {
    // Use the exact saved purpose and deadline, without reseeding source state.
    const w = window as any
    w.kind='tab';w.storage=sessionStorage;w.owner=new w.Ordinary.OrdinaryStateOwner(before.purpose,before.expiresAt)
    w.countCrypto();await w.migrate();const row=await w.raw(),image=await w.Ordinary.openOrdinaryFrame(row.frame,row.key)
    const result=[JSON.stringify({...row.frame,nonce:Array.from(new Uint8Array(row.frame.nonce)),ciphertext:Array.from(new Uint8Array(row.frame.ciphertext))})===JSON.stringify(before.frame),image.records.get('kithmoot.callProfile'),w.entropy,w.generated,w.encryptions,Object.keys(localStorage),Object.keys(sessionStorage)]
    w.restoreCrypto();return result
  }, before as any)).toEqual([true,mode==='profile-tab-on'?'2':'1',0,0,0,[],[]])
  await context.close()
})
