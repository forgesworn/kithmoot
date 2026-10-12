import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Native migration of the existing epoch-cache family only. No production
// root/client fence, signed rekey authority or before-transition acceptance.
const ORIGIN='https://ordinary-epoch.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-epoch.browser-entry.ts',import.meta.url))],bundle:true,
    format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text
})
const setup=`async()=>{
  window.live=true;window.guard=()=>live;window.root=new Uint8Array(32).fill(5);window.room=Ordinary.deriveRoom(root).roomId
  window.owner=new Ordinary.OrdinaryStateOwner();window.v1='kithmoot.room-epoch.v1.'+room;window.v2='kithmoot.room-epoch.v2.'+room
  window.seed=()=>{
    const store=Ordinary.memoryDeviceStore()
    Ordinary.storeKeptRoomEpoch(store,room,{epoch:{epoch:3,secret:new Uint8Array(32).fill(43)},
      past:[{epoch:2,secret:new Uint8Array(32).fill(42),leftAt:90},{epoch:0,secret:root,leftAt:80}],removed:['b'.repeat(64)],members:['a'.repeat(64)]},100)
    for(const name of store.keys())localStorage.setItem(name,store.get(name))
  }
  window.setV1=(n)=>{const keys=Ordinary.deriveEpoch({epoch:n,secret:new Uint8Array(32).fill(n+40)});localStorage.setItem(v1,JSON.stringify({epoch:n,id:keys.id,key:Ordinary.bytesToHex(keys.key)}));keys.key.fill(0)}
  window.validate=Ordinary.validateOrdinaryEpochSnapshot
  window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage:localStorage,selected:name=>name.startsWith('kithmoot.'),
    validate:(records,migrated)=>validate(records,migrated),checkClients:async()=>{},live:guard})
  window.raw=()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser')
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
}`
async function open(context:BrowserContext){
  await context.route(`${ORIGIN}/**`,route=>route.fulfill({status:200,contentType:'text/html',
    body:`<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`);return page
}

for(const format of ['current','v1-only','v1-ahead','v2-only','v1-behind'] as const)
 test(`${format} native legacy epoch custody migrates byte-exactly without pruning`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  const expected=format==='v1-only'?{roomId:'',watchedEpoch:3}:format==='v1-ahead'?{roomId:'',watchedEpoch:4,keptEpoch:3}:{roomId:'',watchedEpoch:3,keptEpoch:3}
  const result=await page.evaluate(`(async()=>{
    seed();const format='${format}'
    if(format==='v1-only')localStorage.removeItem(v2)
    if(format==='v2-only')localStorage.removeItem(v1)
    if(format==='v1-ahead')setV1(4)
    if(format==='v1-behind')setV1(2)
    const initial=new Map(Object.keys(localStorage).map(name=>[name,localStorage.getItem(name)]));countCrypto();await migrate()
    const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key),summary=validate(image.records,true)
    const out=[generated,image.migration.phase,image.records.size===initial.size,[...initial].every(([name,value])=>image.records.get(name)===value),
      {...summary.rooms[0],roomId:''},Object.keys(localStorage),Object.keys(sessionStorage),saved.key.extractable]
    restoreCrypto();return out
  })()`)
  expect(result).toEqual([1,'complete',true,true,expected,[],[],false]);await context.close()
})

for(const fault of ['bad-history','duplicate-history','wrong-root','mismatched-v1','unsupported-version','removed-member','invalid-room','scoped-legacy','shared-v1','shared-v2','shared-secret'] as const)
 test(`${fault} epoch snapshot holds before key creation, encryption or cleanup`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    seed();const fault='${fault}',value=JSON.parse(localStorage.getItem(v2))
    if(fault==='bad-history')value.past.push(null)
    if(fault==='duplicate-history')value.past.push(value.past[0])
    if(fault==='wrong-root')value.past[1].secret='6'.repeat(64)
    if(fault==='removed-member')value.members.push(value.removed[0])
    localStorage.setItem(v2,JSON.stringify(value))
    if(fault==='mismatched-v1'){const value=JSON.parse(localStorage.getItem(v1));value.key='0'.repeat(64);localStorage.setItem(v1,JSON.stringify(value))}
    if(fault==='unsupported-version')localStorage.setItem('kithmoot.room-epoch.v3.'+room,localStorage.getItem(v1))
    if(fault==='invalid-room')localStorage.setItem('kithmoot.room-epoch.v1.invalid',localStorage.getItem(v1))
    if(fault==='scoped-legacy'){for(const name of [v1,v2]){localStorage.setItem('kithmoot.account.'+'a'.repeat(64)+'.'+name,localStorage.getItem(name));localStorage.removeItem(name)}}
    if(fault==='shared-v1')localStorage.setItem('kithmoot.room-epoch.v1.'+'c'.repeat(64),localStorage.getItem(v1))
    if(fault==='shared-v2'||fault==='shared-secret'){
      const copy=JSON.parse(localStorage.getItem(v2));copy.past=[];if(fault==='shared-secret')copy.epoch=4
      localStorage.setItem('kithmoot.room-epoch.v2.'+'c'.repeat(64),JSON.stringify(copy))
    }
    const before=Object.fromEntries(Object.keys(localStorage).map(name=>[name,localStorage.getItem(name)]));countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(localStorage).map(name=>[name,localStorage.getItem(name)]))
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true]);await context.close()
})

test('restart after partial epoch cleanup validates both sealed records rather than a remaining v1 or v2 fragment',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(async()=>{
    seed();const remove=Storage.prototype.removeItem;let removed=false
    Storage.prototype.removeItem=function(name){remove.call(this,name);if(this===localStorage&&!removed){removed=true;throw new Error('cut after epoch plaintext removal')}}
    try{await migrate()}catch(error){window.cut=error.message}finally{Storage.prototype.removeItem=remove}
  })()`)
  expect(await page.evaluate('[cut,Object.keys(localStorage).length]')).toEqual(['cut after epoch plaintext removal',1])
  const prior=await page.evaluate<string[]>(`(async()=>{const frame=(await raw()).frame;return [frame.keyId,frame.generation]})()`)
  await page.evaluate('owner.close()');await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    window.visits=[];const strict=validate;validate=(records,migrated)=>{visits.push([records.size,migrated]);return strict(records,migrated)}
    countCrypto();await migrate();const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    const out=[generated,visits,image.records.size,image.migration.phase,Object.keys(localStorage),saved.frame.keyId,saved.frame.generation]
    restoreCrypto();return out
  })()`)).toEqual([0,[[2,false]],2,'complete',[],...prior]);await context.close()
})

test('completed encrypted custody with conflicting epoch keys holds unchanged even after all plaintext is gone',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    seed();await migrate();const scope=await owner.capture('@damage',guard)
    await owner.mutate(scope,guard,store=>{const value=JSON.parse(store.get(v1));value.id='0'.repeat(64);store.set(v1,JSON.stringify(value))})
    const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]]);await context.close()
})

test('completed custody cannot retain legacy and account-scoped caches for the same room',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    seed();await migrate();const scope=await owner.capture('@damage',guard)
    await owner.mutate(scope,guard,store=>{for(const name of [v1,v2])store.set('kithmoot.account.'+'a'.repeat(64)+'.'+name,store.get(name))})
    const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]]);await context.close()
})
