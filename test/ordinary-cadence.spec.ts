import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Actual custody writer/builder/crypto with fixture receipts; native Storage,
// IDB and AES. Noop client fence, no live Link/box authority or handoff.
const ORIGIN = 'https://ordinary-cadence.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-cadence.browser-entry.ts', import.meta.url))], bundle: true,
    format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `async()=>{
  window.live=true;window.guard=()=>live;window.kind='browser';window.storage=localStorage
  window.owner=new Ordinary.OrdinaryStateOwner();window.lifetime=undefined
  window.seed=async(mode='client-excluded')=>{
    window.fixture=await Ordinary.cadenceFixture(mode);window.checks=fixture.checks
    for(const [name,value]of fixture.records)storage.setItem(name,value)
    return new Map(fixture.records)
  }
  window.validate=Ordinary.validateOrdinaryCadenceSnapshot
  window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage,selected:name=>name.startsWith('kithmoot.')&&name!==Ordinary.ORDINARY_TAB_MARKER,
    validate:(records,migrated)=>validate(records,migrated,{...checks,kind}),checkClients:async()=>{},live:guard})
  window.raw=()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get(kind==='tab'?'tab:'+sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER):'browser')
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()
    }
  })
  window.countCrypto=()=>{
    const random=crypto.getRandomValues.bind(crypto),generate=crypto.subtle.generateKey.bind(crypto.subtle),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    window.entropy=0;window.generated=0;window.encryptions=0
    crypto.getRandomValues=(...args)=>{entropy++;return random(...args)}
    crypto.subtle.generateKey=(...args)=>{generated++;return generate(...args)}
    crypto.subtle.encrypt=(...args)=>{encryptions++;return encrypt(...args)}
    window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.generateKey=generate;crypto.subtle.encrypt=encrypt}
  }
  window.damage=(records,fault)=>Ordinary.damageCadenceFixture(fixture,records,fault)
}`
async function open(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`); return page
}
for (const mode of ['client-excluded','staged','active','cover','ended','person','slot-one','expired','history'])
 test(`${mode} actual lease custody migrates exact request/receipt bytes without delegation or release`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    const initial=await seed('${mode}');countCrypto();await migrate()
    const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,checks)
    const out=[generated,image.migration.phase,[...initial].every(([name,value])=>image.records.get(name)===value),summary.leases.length,
      summary.leases[0].ownership,Object.keys(localStorage),Object.keys(sessionStorage),row.key.extractable]
    restoreCrypto();return out
  })()`)).toEqual([1,'complete',true,1,mode === 'client-excluded' ? 'client-excluded' : mode === 'ended' ? 'ended' : 'box-owned',[],[],false]); await context.close()
})
const RAW_FAULTS = ['physical-room','physical-generation','mirror-start','profile','counter','credential-signature','credential-room',
  'credential-duplicate','credential-expiry','credential-post-window','drop-curve','drop-derived','traffic-room','grant','relay-auth','dest-overlap',
  'ownership','receipt-missing','receipt-state','receipt-code','receipt-scope','receipt-history','receipt-staged-state','receipt-staged-ended','receipt-staged-queue','receipt-staged-sent','receipt-staged-failed','overlap','legacy-scoped','duplicate-json','tab-relocation']
for (const fault of RAW_FAULTS)
 test(`${fault} holds raw possibly delegated counters before AES or cleanup`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    if('${fault}'==='tab-relocation'){kind='tab';storage=sessionStorage;lifetime=await Ordinary.OrdinaryTabLifetime.open({storage,live:guard,stop:()=>{live=false}});owner=lifetime.owner}
    await seed('active');const records=new Map(fixture.records);damage(records,'${fault}')
    for(const name of Object.keys(storage))if(name!==Ordinary.ORDINARY_TAB_MARKER&&!records.has(name))storage.removeItem(name)
    for(const [name,value]of records)storage.setItem(name,value)
    const before=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]));countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]))
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
    restoreCrypto();await lifetime?.close();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true]); await context.close()
})
for (const fault of ['counter','credential-signature','drop-derived','traffic-room','grant','ownership','receipt-missing','receipt-state','credential-post-window','receipt-staged-state','receipt-staged-ended','receipt-staged-queue','receipt-staged-sent','receipt-staged-failed','overlap','duplicate-json'])
 test(`completed cadence custody holds ${fault} without rewriting the retained handoff`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed('active');await migrate();const scope=await owner.capture('@damage',guard),row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),records=new Map(image.records)
    damage(records,'${fault}');await owner.mutate(scope,guard,store=>{
      for(const name of store.keys())if(!records.has(name))store.remove(name);for(const [name,value]of records)store.set(name,value)
    });const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]]); await context.close()
})
test('uncertain client-excluded handoff survives plaintext cleanup interruption and actual reload byte-exactly', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  const before = await page.evaluate<[string,string,string[]]>(`(async()=>{
    await seed();const initial=JSON.stringify([...fixture.records]),remove=Storage.prototype.removeItem
    Storage.prototype.removeItem=function(name){remove.call(this,name);if(this===localStorage)throw new Error('cut after cadence cleanup')}
    try{await migrate()}catch(error){window.cut=error.message}finally{Storage.prototype.removeItem=remove}
    await owner.close();return [initial,cut,Object.keys(localStorage)]
  })()`)
  expect(before).toEqual([expect.any(String),'cut after cadence cleanup',[]])
  await page.reload(); await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    fixture=await Ordinary.cadenceFixture();checks=fixture.checks;countCrypto();await migrate()
    const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,checks)
    const out=[generated,JSON.stringify([...image.records]),image.migration.phase,summary.leases[0].ownership,Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([0,before[0],'complete','client-excluded',[]]); await context.close()
})
test('ended receipt custody reload retains exact history without proving fresh box termination', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  const before = await page.evaluate(`(async()=>{await seed('ended');await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);await owner.close();return JSON.stringify([...image.records])})()`)
  await page.reload(); await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    fixture=await Ordinary.cadenceFixture('ended');checks=fixture.checks;countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
    const out=[generated,JSON.stringify([...image.records]),Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([0,before,[]]); await context.close()
})
