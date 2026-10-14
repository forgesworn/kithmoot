import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Actual writer and cryptographic bindings, native Storage/IDB/AES. Noop
// client fence only; production same-image evidence construction, root startup,
// async counter retention and quiet emission/recovery remain separate gates.
const ORIGIN = 'https://ordinary-quiet.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-quiet.browser-entry.ts', import.meta.url))], bundle: true,
    format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `async()=>{
  window.live=true;window.guard=()=>live;window.kind='browser';window.storage=localStorage
  window.owner=new Ordinary.OrdinaryStateOwner();window.lifetime=undefined
  window.seed=async(mode='queued')=>{
    window.fixture=await Ordinary.quietFixture(mode);window.checks=fixture.checks
    for(const [name,value]of fixture.records)storage.setItem(name,value)
    return new Map(fixture.records)
  }
  window.validate=Ordinary.validateOrdinaryQuietSnapshot
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
  window.damage=(records,fault)=>{
    const saved=JSON.parse(records.get(fixture.name)),used=saved.used[fixture.participant],event=saved.queued[0]
    if(fault==='counter-range')used.counters=[16]
    if(fault==='counter-duplicate')used.counters=[7,7]
    if(fault==='counter-fraction')used.counters=[0.5]
    if(fault==='counter-owner')saved.used={['a'.repeat(64)]:used}
    if(fault==='counter-hour')used.epoch=-1
    if(fault==='empty-row'){delete saved.used;saved.queued=[]}
    if(fault==='unknown-field')saved.future=true
    if(fault==='room-epoch')saved.epoch=1
    if(fault==='signature')event.sig='0'.repeat(128)
    if(fault==='queue-duplicate')saved.queued.push(event)
    if(fault==='queue-oversize')saved.queued=Array(257).fill(event)
    if(fault==='plaintext')saved.queued[0]=fixture.sign({...event,content:'secret text'.repeat(20)})
    if(fault==='wrong-channel')saved.queued[0]=fixture.sign({...event,tags:[['d','a'.repeat(64)]]})
    if(fault==='cipher-version'){
      const bytes=Ordinary.base64.decode(event.content);bytes[0]=1;saved.queued[0]=fixture.sign({...event,content:Ordinary.base64.encode(bytes)})
    }
    records.set(fixture.name,JSON.stringify(saved))
    if(fault==='physical-room'){records.set(fixture.name.replace(fixture.roomId,'b'.repeat(64)),records.get(fixture.name));records.delete(fixture.name)}
    if(fault==='unsupported-version'){records.set(fixture.name.replace('.v1.','.v2.'),records.get(fixture.name));records.delete(fixture.name)}
    if(fault==='scoped-coexistence')records.set('kithmoot.account.'+fixture.participant+'.'+fixture.name,records.get(fixture.name))
  }
}`
async function open(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`); return page
}
for (const mode of ['queued', 'counters', 'queue-only', 'legacy', 'epoch', 'named', 'expired'])
 test(`${mode} actual quiet writer migrates byte-exactly without counter reset or queue pruning`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    const initial=await seed('${mode}'),posts=fixture.published.length;countCrypto();await migrate()
    const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,checks)
    const out=[generated,image.migration.phase,[...initial].every(([name,value])=>image.records.get(name)===value),summary.rooms.length,
      summary.rooms[0].queued,fixture.published.length===posts,Object.keys(localStorage),Object.keys(sessionStorage),row.key.extractable]
    restoreCrypto();return out
  })()`)).toEqual([1, 'complete', true, 1, mode === 'counters' ? 0 : 1, true, [], [], false]); await context.close()
})
for (const fault of ['counter-range', 'counter-duplicate', 'counter-fraction', 'counter-owner', 'counter-hour', 'unknown-field', 'room-epoch',
  'signature', 'queue-duplicate', 'queue-oversize', 'plaintext', 'wrong-channel', 'cipher-version', 'physical-room', 'unsupported-version', 'scoped-coexistence', 'tab-relocation', 'empty-row'])
 test(`${fault} holds raw quiet state before AES and cleanup`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    if('${fault}'==='tab-relocation'){kind='tab';storage=sessionStorage;lifetime=await Ordinary.OrdinaryTabLifetime.open({storage,live:guard,stop:()=>{live=false}});owner=lifetime.owner}
    await seed();const records=new Map(fixture.records);damage(records,'${fault}')
    for(const name of Object.keys(storage))if(name!==Ordinary.ORDINARY_TAB_MARKER&&!records.has(name))storage.removeItem(name)
    for(const [name,value]of records)storage.setItem(name,value)
    const before=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]));countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]))
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
    restoreCrypto();await lifetime?.close();return out
  })()`)).toEqual(['OrdinaryStateHold', 0, 0, 0, true, true]); await context.close()
})
for (const fault of ['counter-range', 'counter-owner', 'room-epoch', 'signature', 'wrong-channel', 'physical-room', 'scoped-coexistence', 'empty-row'])
 test(`completed quiet custody holds ${fault} without rewriting the frame`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();await migrate();const scope=await owner.capture('@damage',guard),row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),records=new Map(image.records)
    damage(records,'${fault}');await owner.mutate(scope,guard,store=>{
      for(const name of store.keys())if(!records.has(name))store.remove(name);for(const [name,value]of records)store.set(name,value)
    });const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold', 0, 0, 0, true, []]); await context.close()
})
test('cut after quiet plaintext cleanup resumes exact sealed counters and queue after reload', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  const before = await page.evaluate<[string, string, string[]]>(`(async()=>{
    await seed();const initial=JSON.stringify([...fixture.records]),remove=Storage.prototype.removeItem
    Storage.prototype.removeItem=function(name){remove.call(this,name);if(this===localStorage)throw new Error('cut after quiet cleanup')}
    try{await migrate()}catch(error){window.cut=error.message}finally{Storage.prototype.removeItem=remove}
    await owner.close();return [initial,cut,Object.keys(localStorage)]
  })()`)
  expect(before).toEqual([expect.any(String), 'cut after quiet cleanup', []])
  await page.reload(); await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    fixture=await Ordinary.quietFixture();checks=fixture.checks;countCrypto();await migrate()
    const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
    const out=[generated,JSON.stringify([...image.records]),image.migration.phase,Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([0, before[0], 'complete', []]); await context.close()
})
test('completed quiet custody retains exact spent counter and queued signed event across reload', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  const before = await page.evaluate(`(async()=>{await seed('named');await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);await owner.close();return JSON.stringify([...image.records])})()`)
  await page.reload(); await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    fixture=await Ordinary.quietFixture('named');checks=fixture.checks;countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,checks)
    const out=[generated,JSON.stringify([...image.records]),summary.rooms[0].counterSources,summary.rooms[0].queued,Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([0, before, 1, 1, []]); await context.close()
})
