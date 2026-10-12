import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { METADATA_MODES, METADATA_FAULTS } from './ordinary-metadata-fixture.js'

// Native Storage/IDB/AES, real metadata writers and a noop client fence.
// These tests do not establish the production root or notification authority.
const ORIGIN = 'https://ordinary-metadata.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-metadata.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `()=>{
 window.guard=()=>true;window.owner=new Ordinary.OrdinaryStateOwner();window.kind='browser';window.validate=Ordinary.validateOrdinaryMetadataSnapshot
 window.seed=(mode='all')=>{window.fixture=Ordinary.metadataFixture(mode);for(const[name,value]of fixture.records)localStorage.setItem(name,value);return new Map(fixture.records)}
 window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage:localStorage,selected:name=>name.startsWith('kithmoot.'),
   validate:(records,migrated)=>validate(records,migrated,{kind}),checkClients:async()=>{},live:guard})
 window.raw=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
  const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()
 }})
 window.countCrypto=()=>{const random=crypto.getRandomValues.bind(crypto),generate=crypto.subtle.generateKey.bind(crypto.subtle),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
  window.entropy=0;window.generated=0;window.encryptions=0;crypto.getRandomValues=(...args)=>{entropy++;return random(...args)}
  crypto.subtle.generateKey=(...args)=>{generated++;return generate(...args)};crypto.subtle.encrypt=(...args)=>{encryptions++;return encrypt(...args)}
  window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.generateKey=generate;crypto.subtle.encrypt=encrypt}
 }
}`
async function open(context: BrowserContext) {
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate('(' + setup + ')()'); return page
}
for (const mode of METADATA_MODES) test(`${mode} actual metadata writer rows migrate byte-exactly with no plaintext identifiers left`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
   const before=seed('${mode}');countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
   const out=[generated,image.migration.phase,[...before].every(([name,value])=>image.records.get(name)===value),image.records.size,
     Object.keys(localStorage),Object.keys(sessionStorage),row.key.extractable];restoreCrypto();return out
  })()`)).toEqual([1, 'complete', true, mode === 'all' ? 9 : mode === 'empty' ? 0 : mode === 'notifications' ? 4 : mode === 'pins' ? 1 : 2, [], [], false])
  await context.close()
})
for (const fault of METADATA_FAULTS) test(`raw metadata holds ${fault} before key creation or plaintext cleanup`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
   seed();const records=new Map(fixture.records);Ordinary.damageMetadataFixture(fixture,records,'${fault}');localStorage.clear()
   for(const[name,value]of records)localStorage.setItem(name,value);const before=JSON.stringify(Object.entries(localStorage).sort());countCrypto()
   let held=false;try{await migrate()}catch{held=true}const out=[held,entropy,generated,encryptions,before===JSON.stringify(Object.entries(localStorage).sort()),!(await raw())]
   restoreCrypto();return out
  })()`)).toEqual([true, 0, 0, 0, true, true]); await context.close()
})
for (const fault of ['volume-duplicate-json', 'pins-duplicate', 'notification-room', 'project-name', 'wrapped'] as const)
  test(`completed metadata holds ${fault} without rewriting the retained frame`, async ({ browser }) => {
    const context = await browser.newContext(), page = await open(context)
    expect(await page.evaluate(`(async()=>{
     seed();await migrate();const scope=await owner.capture('@damage',guard),row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),records=new Map(image.records)
     Ordinary.damageMetadataFixture(fixture,records,'${fault}');await owner.mutate(scope,guard,store=>{for(const name of store.keys())store.remove(name);for(const[name,value]of records)store.set(name,value)})
     const staged=await raw(),before=JSON.stringify(staged.frame);countCrypto();let held=false;try{await migrate()}catch{held=true}
     const out=[held,entropy,generated,encryptions,before===JSON.stringify((await raw()).frame),Object.keys(localStorage)];restoreCrypto();return out
    })()`)).toEqual([true, 0, 0, 0, true, []]); await context.close()
  })
