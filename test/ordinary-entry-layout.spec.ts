import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { ENTRY_MODES, ENTRY_FAULTS, ENTRY_TAB_FAULTS, entryLayoutFixture } from './ordinary-entry-layout-fixture.js'

// Native custody with actual app writer cuts and
// a no-op client fence. No production root, app controls or authority proof.
const ORIGIN = 'https://ordinary-entry-layout.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-entry-layout.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `(config)=>{
 window.guard=()=>true;window.kind=config.kind;window.owner=new Ordinary.OrdinaryStateOwner(kind==='browser'?'browser':'tab:'+'a'.repeat(64),config.expiresAt);window.storage=kind==='browser'?localStorage:sessionStorage
 window.source=()=>Array.from({length:storage.length},(_,i)=>{const k=storage.key(i);return[k,storage.getItem(k)]}).sort()
 window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage,selected:k=>k.startsWith('kithmoot.')||k.startsWith('kithmoot:'),
  validate:(records,migrated)=>Ordinary.validateOrdinaryEntryLayoutSnapshot(records,migrated,{kind}),checkClients:async()=>{},live:guard})
 window.raw=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
  const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get(owner.purpose);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()}})
 window.countCrypto=()=>{const random=crypto.getRandomValues.bind(crypto),generate=crypto.subtle.generateKey.bind(crypto.subtle),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
  window.entropy=0;window.generated=0;window.encryptions=0;crypto.getRandomValues=(...a)=>{entropy++;return random(...a)}
  crypto.subtle.generateKey=(...a)=>{generated++;return generate(...a)};crypto.subtle.encrypt=(...a)=>{encryptions++;return encrypt(...a)}
  window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.generateKey=generate;crypto.subtle.encrypt=encrypt}}
}`
async function open(context: BrowserContext, mode: typeof ENTRY_MODES[number] = 'browser-all', override?: 'browser'|'tab') {
  const f=entryLayoutFixture(mode), config={kind:override??f.kind,expiresAt:(override??f.kind)==='tab'?Date.now()+3600000:0}
  await context.route(ORIGIN + '/**', route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>' }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate('(' + setup + ')('+JSON.stringify(config)+')');
  await page.evaluate(records => { const w=window as any; w.seed=async()=>{const before=new Map(records);for(const[k,v]of before)w.storage.setItem(k,v);return before};w.fixture={records:new Map(records)} }, [...f.records])
  return {page,config,count:f.records.size}
}
for (const mode of ENTRY_MODES) test(`${mode} writer cuts migrate exact bytes in native Storage and IDB`, async ({ browser }) => {
  const context=await browser.newContext(),{page,count}=await open(context,mode)
  expect(await page.evaluate(`(async()=>{
    const before=await seed();countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
    const out=[generated,image.migration.phase,[...before].every(([k,v])=>image.records.get(k)===v),image.records.size,
      Object.keys(localStorage),Object.keys(sessionStorage),row.key.extractable];restoreCrypto();return out
  })()`)).toEqual([1,'complete',true,count,[],[],false]);await context.close()
})
for(const [kind,mode,faults] of [['browser','browser-all',ENTRY_FAULTS],['tab','tab-account',ENTRY_TAB_FAULTS]] as const)
  for(const fault of faults) test(`raw ${kind} entry/layout holds ${fault} before entropy, writes or cleanup`,async({browser})=>{
    const context=await browser.newContext(),{page}=await open(context,mode)
    expect(await page.evaluate(`(async()=>{
      await seed();const records=new Map(fixture.records);Ordinary.damageEntryLayoutFixture(records,'${fault}');storage.clear()
      for(const[k,v]of records)storage.setItem(k,v);const before=JSON.stringify(source());countCrypto()
      const put=IDBObjectStore.prototype.put,del=IDBObjectStore.prototype.delete;let writes=0,deletes=0
      IDBObjectStore.prototype.put=function(...a){writes++;return put.apply(this,a)};IDBObjectStore.prototype.delete=function(...a){deletes++;return del.apply(this,a)}
      try{let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'}return[held,entropy,generated,encryptions,writes,deletes,
        before===JSON.stringify(source()),!(await raw())]}
      finally{restoreCrypto();IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=del}
    })()`)).toEqual([true,0,0,0,0,0,true,true]);await context.close()
  })
for(const [mode,faults] of [['browser-all',['wrapped','invited-duplicate','invited-cap','divider']],
  ['tab-account',['tab-wrapped','tab-account']]] as const)
  for(const fault of faults) test(`completed ${mode} entry/layout holds ${fault} without rewriting custody`,async({browser})=>{
    const context=await browser.newContext(),{page}=await open(context,mode)
    expect(await page.evaluate(`(async()=>{
      await seed();await migrate();const scope=await owner.capture('@damage',guard),row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),records=new Map(image.records)
      Ordinary.damageEntryLayoutFixture(records,'${fault}');await owner.mutate(scope,guard,store=>{for(const k of store.keys())store.remove(k);for(const[k,v]of records)store.set(k,v)})
      const staged=await raw();countCrypto();let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'}
      const out=[held,entropy,generated,encryptions,Ordinary.sameOrdinaryFrame(staged.frame,(await raw()).frame),Object.keys(localStorage),Object.keys(sessionStorage)];restoreCrypto();return out
    })()`)).toEqual([true,0,0,0,true,[],[]]);await context.close()
  })
for(const mode of ['browser-all','tab-account'] as const) {
  test(`${mode} entry/layout custody survives reload byte-exactly without new entropy`,async({browser})=>{
    const context=await browser.newContext(),{page,config}=await open(context,mode)
    const before=await page.evaluate<{records:[string,string][]}>(`(async()=>{await seed();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);return {records:[...image.records].sort()}})()`)
    await page.reload();await page.evaluate('('+setup+')('+JSON.stringify(config)+')')
    expect(await page.evaluate(`(async()=>{countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);
      const out={records:[...image.records].sort(),entropy,generated,encryptions,local:Object.keys(localStorage),tab:Object.keys(sessionStorage)};restoreCrypto();return out})()`))
      .toEqual({...before,entropy:0,generated:0,encryptions:0,local:[],tab:[]});await context.close()
  })
  test(`${mode} entry/layout holds in opposite physical Storage before mutation`,async({browser})=>{
    const context=await browser.newContext(),{page,count}=await open(context,mode,mode==='browser-all'?'tab':'browser')
    expect(await page.evaluate(`(async()=>{await seed();countCrypto();let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'}
      const out=[held,entropy,generated,encryptions,source().length,!(await raw())];restoreCrypto();return out})()`))
      .toEqual([true,0,0,0,count,true]);await context.close()
  })
}
