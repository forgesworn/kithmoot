import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Capacity/profile construction only. The deliberately no-op family validator
// is not the production composite or authentication of an encrypted journal.
const ORIGIN = 'https://ordinary-capacity.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-capacity.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
const setup = `()=>{
 window.guard=()=>true;window.owner=new Ordinary.OrdinaryStateOwner()
 window.seed=async()=>{window.fixture=await Ordinary.largeContextJournal();for(const[k,v]of fixture.records)localStorage.setItem(k,v)}
 window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage:localStorage,selected:k=>k.startsWith('kithmoot.'),validate:()=>{},checkClients:async()=>{},live:guard})
 window.raw=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
 const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()}})
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
test('actual >2 MiB context writer migrates and reopens byte-exactly in native Storage and IDB', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
    const out=[Ordinary.ordinaryUtf8Length(fixture.raw)>2*1024*1024,image.records.get([...fixture.records.keys()][0])===fixture.raw,
      image.migration.phase,image.records.size,generated,row.key.extractable,Object.keys(localStorage),Object.keys(sessionStorage)]
    window.retained={key:[...fixture.records.keys()][0],raw:fixture.raw};restoreCrypto();await owner.close();owner=new Ordinary.OrdinaryStateOwner()
    countCrypto();await migrate();const reopened=await raw(),again=await Ordinary.openOrdinaryFrame(reopened.frame,reopened.key)
    out.push(again.records.get(retained.key)===retained.raw,entropy,generated,encryptions,Ordinary.sameOrdinaryFrame(row.frame,reopened.frame));restoreCrypto();return out
  })()`)).toEqual([true, true, 'complete', 1, 1, false, [], [], true, 0, 0, 0, true])
  await context.close()
})
for (const phase of ['initial', 'cleaning'] as const) test(`large journal injected quota write fault at ${phase} retains exact native plaintext and prior frame`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();const key=[...fixture.records.keys()][0],native=IDBObjectStore.prototype.put;let puts=0,prior
    IDBObjectStore.prototype.put=function(value,...args){puts++;if(puts===2)prior=structuredClone(value.frame)
      if(puts===${phase === 'initial' ? 1 : 3})throw new DOMException('fixture full','QuotaExceededError');return native.call(this,value,...args)}
    let held=false;try{await migrate()}catch(e){held=e.name==='OrdinaryStateHold'}finally{IDBObjectStore.prototype.put=native}
    const saved=await raw(),out=[held,localStorage.getItem(key)===fixture.raw,${phase === 'initial' ? '!saved' : 'Ordinary.sameOrdinaryFrame(prior,saved.frame)'}]
    await migrate();const after=await raw(),image=await Ordinary.openOrdinaryFrame(after.frame,after.key)
    out.push(image.records.get(key)===fixture.raw,image.migration.phase,Object.keys(localStorage));return out
  })()`)).toEqual([true, true, true, true, 'complete', []]); await context.close()
})
test('large candidate survives lost staging acknowledgement without re-encryption', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),put=IDBObjectStore.prototype.put
    let intercepted=0,candidate;IDBObjectStore.prototype.put=function(row,...args){if(row.pending&&!candidate)candidate=structuredClone(row.pending);return put.call(this,row,...args)}
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){const tx=this;
      if(tx.mode==='readwrite'&&!intercepted++)d.set.call(tx,event=>tx.onabort(event));else d.set.call(tx,callback)}})
    countCrypto();try{await owner.prepare(guard,fixture.records,{phase:'sealed',sources:fixture.records,names:[...fixture.records.keys()]},()=>{})
      const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
      return[encryptions,generated,Ordinary.sameOrdinaryFrame(candidate,row.frame),image.records.get([...fixture.records.keys()][0])===fixture.raw,
        localStorage.getItem([...fixture.records.keys()][0])===fixture.raw,row.key.extractable]
    }finally{restoreCrypto();IDBObjectStore.prototype.put=put;Object.defineProperty(IDBTransaction.prototype,'oncomplete',d)}
  })()`)).toEqual([1, 1, true, true, true, false]); await context.close()
})
// A browser may refuse an over-profile value in localStorage itself. These
// overflow snapshots use an explicit in-memory Storage adapter; IDB, Web Locks
// and crypto are native. This does not claim native Storage supports 8 MiB.
for (const fault of ['value-utf8', 'aggregate-escaping'] as const) test(`injected overflow source ${fault} holds before entropy, owner-row writes or source cleanup`, async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    const key='kithmoot.context.v1.'+'3'.repeat(64),value=${fault === 'value-utf8' ? "'🧭'.repeat(Ordinary.ORDINARY_VALUE_BYTES/4)+'x'" : "'\\u0000'.repeat(3*1024*1024)"}
    const records=new Map([[key,value]]);let cleanup=0
    const storage={get length(){return records.size},key:i=>[...records.keys()][i]??null,getItem:k=>records.get(k)??null,
      removeItem:k=>{cleanup++;records.delete(k)}}
    const put=IDBObjectStore.prototype.put,del=IDBObjectStore.prototype.delete;let writes=0,deletes=0
    IDBObjectStore.prototype.put=function(...a){writes++;return put.apply(this,a)};IDBObjectStore.prototype.delete=function(...a){deletes++;return del.apply(this,a)}
    countCrypto();let held=false;try{await Ordinary.migrateOrdinaryStorage({owner,storage,selected:()=>true,validate:()=>{},checkClients:async()=>{},live:guard})}catch(e){held=e.name==='OrdinaryStateHold'}
    const out=[held,entropy,generated,encryptions,writes,deletes,cleanup,records.get(key)===value,!(await raw())];restoreCrypto();IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=del;return out
  })()`)).toEqual([true, 0, 0, 0, 0, 0, 0, true, true]); await context.close()
})
test('native codec bounds an exact UTF-8 value independently from its UTF-16 length', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const value='🧭'.repeat(Ordinary.ORDINARY_VALUE_BYTES/4),image={purpose:'browser',keyId:'1'.repeat(64),generation:'2'.repeat(64),revision:0,
      expiresAt:0,records:new Map([['large',value]]),fences:new Map()}
    const encoded=Ordinary.encodeOrdinaryImage(image);encoded.fill(0);let held=false
    try{Ordinary.encodeOrdinaryImage({...image,records:new Map([['large',value+'x']])})}catch(e){held=e.name==='OrdinaryStateHold'}
    return[Ordinary.ordinaryUtf8Length(value),value.length,held,image.records.get('large')===value]
  })()`)).toEqual([8 * 1024 * 1024, 4 * 1024 * 1024, true, true]); await context.close()
})
test('injected exact-ceiling sealed source holds before entropy because its cleaning successor cannot fit', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(async()=>{
    let names=['a','b'],records=new Map(names.map(k=>[k,'']))
    const make=()=>({purpose:'browser',keyId:'1'.repeat(64),generation:'2'.repeat(64),revision:0,expiresAt:0,records,fences:new Map(),
      migration:{phase:'sealed',sources:records,names}})
    let overhead=Ordinary.ordinaryImageByteLength(make())
    if((Ordinary.ORDINARY_IMAGE_BYTES-overhead)%2){names=['a','bb'];records=new Map(names.map(k=>[k,'']));overhead=Ordinary.ordinaryImageByteLength(make())}
    const first='x'.repeat(Ordinary.ORDINARY_VALUE_BYTES),second='y'.repeat((Ordinary.ORDINARY_IMAGE_BYTES-overhead)/2-Ordinary.ORDINARY_VALUE_BYTES)
    records=new Map([[names[0],first],[names[1],second]]);const fits=Ordinary.ordinaryImageByteLength(make())===Ordinary.ORDINARY_IMAGE_BYTES
    let writes=0,deletes=0,cleanup=0,strings=0;const put=IDBObjectStore.prototype.put,del=IDBObjectStore.prototype.delete,stringify=JSON.stringify
    const storage={get length(){return records.size},key:i=>[...records.keys()][i]??null,getItem:k=>records.get(k)??null,removeItem:k=>{cleanup++;records.delete(k)}}
    IDBObjectStore.prototype.put=function(...a){writes++;return put.apply(this,a)};IDBObjectStore.prototype.delete=function(...a){deletes++;return del.apply(this,a)}
    JSON.stringify=function(value,...a){if(Array.isArray(value)&&value[0]===1&&value[1]==='browser')strings++;return stringify(value,...a)}
    countCrypto();try{let held=false;try{await Ordinary.migrateOrdinaryStorage({owner,storage,selected:()=>true,validate:()=>{},checkClients:async()=>{},live:guard})}catch(e){held=e.name==='OrdinaryStateHold'}
      return[fits,held,entropy,generated,encryptions,writes,deletes,cleanup,strings,records.get(names[0])===first&&records.get(names[1])===second,!(await raw())]
    }finally{restoreCrypto();IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=del;JSON.stringify=stringify}
  })()`)).toEqual([true, true, 0, 0, 0, 0, 0, 0, 0, true, true]); await context.close()
})
test('native frame parser accepts the 32 MiB plus GCM tag ceiling and holds the next byte', async ({ browser }) => {
  const context = await browser.newContext(), page = await open(context)
  expect(await page.evaluate(`(()=>{
    const frame={version:1,purpose:'browser',keyId:'1'.repeat(64),generation:'2'.repeat(64),revision:0,expiresAt:0,
      nonce:new ArrayBuffer(12),ciphertext:new ArrayBuffer(Ordinary.ORDINARY_IMAGE_BYTES+16)}
    const owned=Ordinary.validateOrdinaryFrame(frame);let held=false
    try{Ordinary.validateOrdinaryFrame({...frame,ciphertext:new ArrayBuffer(Ordinary.ORDINARY_IMAGE_BYTES+17)})}catch(e){held=e.name==='OrdinaryStateHold'}
    return[owned.ciphertext.byteLength,held,owned.ciphertext!==frame.ciphertext]
  })()`)).toEqual([32 * 1024 * 1024 + 16, true, true]); await context.close()
})
