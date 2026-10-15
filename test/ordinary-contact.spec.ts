import { build } from 'esbuild'
import { expect,test,type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { CONTACT_MODES } from './ordinary-contact-fixture.js'

// Actual storage writers/card signatures; native Storage/IDB/AES. The client
// fence is noop. These cached rows do not supply live discovery authority.
const ORIGIN='https://ordinary-contact.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-contact.browser-entry.ts',import.meta.url))],bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text})
const setup=`async()=>{
 window.live=true;window.guard=()=>live;window.kind='browser';window.storage=localStorage;window.lifetime=undefined
 window.owner=new Ordinary.OrdinaryStateOwner();window.validate=Ordinary.validateOrdinaryContactSnapshot
 window.seed=(mode='card')=>{window.fixture=Ordinary.contactFixture(mode);for(const[name,value]of fixture.records)storage.setItem(name,value);return new Map(fixture.records)}
 window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage,selected:name=>name.startsWith('kithmoot.')&&name!==Ordinary.ORDINARY_TAB_MARKER,
   validate:(records,migrated)=>validate(records,migrated,{kind}),checkClients:async()=>{},live:guard})
 window.raw=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get(kind==='tab'?'tab:'+sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER):'browser')
   q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()
 }})
 window.countCrypto=()=>{const random=crypto.getRandomValues.bind(crypto),generate=crypto.subtle.generateKey.bind(crypto.subtle),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
   window.entropy=0;window.generated=0;window.encryptions=0
   crypto.getRandomValues=(...args)=>{entropy++;return random(...args)};crypto.subtle.generateKey=(...args)=>{generated++;return generate(...args)}
   crypto.subtle.encrypt=(...args)=>{encryptions++;return encrypt(...args)};window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.generateKey=generate;crypto.subtle.encrypt=encrypt}
 }
 window.damage=(records,fault)=>Ordinary.damageContactFixture(fixture,records,fault)
}`
async function open(context:BrowserContext){await context.route(ORIGIN+'/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>'}));const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate('('+setup+')()');return page}
for(const mode of CONTACT_MODES)test(`${mode} actual contact and local observation custody migrates byte-exactly without discovery authority`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{
   const initial=seed('${mode}');if('${mode}'==='expired')Date.now=()=>fixture.historicalNow*1000;countCrypto();await migrate()
   const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,{kind})
   const out=[generated,image.migration.phase,[...initial].every(([name,value])=>image.records.get(name)===value),summary.contacts.length,
     summary.rendezvous,summary.observations.filter(item=>!item.observer).length,Object.keys(localStorage),Object.keys(sessionStorage),row.key.extractable]
   restoreCrypto();return out
 })()`)).toEqual([1,'complete',true,['empty','self-only'].includes(mode)?0:1,!['empty','rotated'].includes(mode),['empty','self-only'].includes(mode)?0:1,[],[],false]);await context.close()
})
const RAW_FAULTS=['physical-participant','participant-curve','contact-version','nested-wrapped','name','bond-extra','issued','relays','node','serial',
 'card-signature','card-padding','refreshed-time','refreshed-hints','scalar-zero','scalar-overflow','scalar-empty','rendezvous-version','verified-physical','verified-name','observer-version','observer-wrapped']
for(const fault of RAW_FAULTS)test(`${fault} holds raw contact state before entropy, AES or cleanup`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{
   seed('${fault}'.startsWith('refreshed-')?'refreshed':'card');const records=new Map(fixture.records);damage(records,'${fault}')
   for(const name of Object.keys(storage))if(!records.has(name))storage.removeItem(name);for(const[name,value]of records)storage.setItem(name,value)
   const before=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]));countCrypto();let refusal
   try{await migrate()}catch(error){refusal=error.name}
   const after=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)])),out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
   restoreCrypto();return out
 })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true]);await context.close()
})
for(const fault of ['card-signature','node','serial','scalar-zero','refreshed-hints','verified-physical','observer-version','wrapped','row-duplicate'])
 test(`completed contact custody holds ${fault} without replacing or pruning retained records`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{
   seed('${fault}'==='refreshed-hints'?'refreshed':'card');await migrate();const scope=await owner.capture('@damage',guard),row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),records=new Map(image.records)
   damage(records,'${fault}');await owner.mutate(scope,guard,store=>{for(const name of store.keys())if(!records.has(name))store.remove(name);for(const[name,value]of records)store.set(name,value)})
   const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
   try{await migrate()}catch(error){refusal=error.name}
   const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)];restoreCrypto();return out
 })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]]);await context.close()
})
for(const family of ['contact','rendezvous','verified','checks'])test(`${family} relocated into temporary tab custody holds intact before AES`,async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 expect(await page.evaluate(`(async()=>{
   kind='tab';storage=sessionStorage;lifetime=await Ordinary.OrdinaryTabLifetime.open({storage,live:guard,stop:()=>{live=false}});owner=lifetime.owner
   fixture=Ordinary.contactFixture();for(const[name,value]of fixture.records)if(name.startsWith('kithmoot.${family}.'))storage.setItem(name,value)
   const before=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]));countCrypto();let refusal
   try{await migrate()}catch(error){refusal=error.name}
   const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]))),(await raw())===undefined]
   restoreCrypto();await lifetime.close();return out
 })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true]);await context.close()
})
test('partial contact cleanup resumes exact history and unattributed observations after actual reload',async({browser})=>{
 const context=await browser.newContext(),page=await open(context)
 const before=await page.evaluate<[string,string,number]>(`(async()=>{
   seed('multi-observer');const initial=JSON.stringify([...fixture.records].sort(([a],[b])=>a<b?-1:a>b?1:0)),remove=Storage.prototype.removeItem
   Storage.prototype.removeItem=function(name){remove.call(this,name);if(this===localStorage)throw new Error('cut after first contact cleanup')}
   try{await migrate()}catch(error){window.cut=error.message}finally{Storage.prototype.removeItem=remove}
   await owner.close();return [initial,cut,Object.keys(localStorage).length]
 })()`)
 expect(before).toEqual([expect.any(String),'cut after first contact cleanup',4])
 await page.reload();await page.evaluate('('+setup+')()')
 expect(await page.evaluate(`(async()=>{countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,{kind});const out=[generated,JSON.stringify([...image.records]),image.migration.phase,summary.observations.filter(item=>!item.observer).length,Object.keys(localStorage)];restoreCrypto();return out})()`)).toEqual([0,before[0],'complete',1,[]]);await context.close()
})
