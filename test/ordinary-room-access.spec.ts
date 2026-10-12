import { build } from 'esbuild'
import { expect,test,type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Family migration only: synthetic startup links and noop client fence.
// Production bootstrap, bookmark caches and cross-owner inventory remain open.
const ORIGIN='https://ordinary-room-access.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-room-access.browser-entry.ts',import.meta.url))],bundle:true,
    format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text
})
const setup=`async()=>{
  window.live=true;window.guard=()=>live;window.kind='browser';window.storage=localStorage;window.links=[]
  window.owner=new Ordinary.OrdinaryStateOwner();window.lifetime=undefined
  window.openOwner=async(mode)=>{
    kind=mode;storage=mode==='tab'?sessionStorage:localStorage
    if(mode==='tab'){lifetime=await Ordinary.OrdinaryTabLifetime.open({storage:sessionStorage,live:guard,stop:()=>{live=false}});owner=lifetime.owner}
  }
  window.seed=(mode='meeting-kept')=>{
    window.fixture=Ordinary.roomAccessFixture({owner:mode.includes('owner'),persistent:mode.includes('group'),tab:mode.startsWith('tab')})
    for(const [name,value]of fixture.records)storage.setItem(name,value)
    if(mode==='owner-before-list'){storage.removeItem(fixture.roomName);links=[fixture.url]}
    return new Map(Object.keys(storage).filter(name=>name!==Ordinary.ORDINARY_TAB_MARKER).map(name=>[name,storage.getItem(name)]))
  }
  window.validate=Ordinary.validateOrdinaryRoomAccessSnapshot
  window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage,selected:name=>name.startsWith('kithmoot.')&&name!==Ordinary.ORDINARY_TAB_MARKER,
    validate:(records,migrated)=>validate(records,migrated,{kind,links}),checkClients:async()=>{},live:guard})
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
}`
async function open(context:BrowserContext){
  await context.route(`${ORIGIN}/**`,route=>route.fulfill({status:200,contentType:'text/html',
    body:`<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`);return page
}
for(const mode of ['meeting-owner','group-owner','meeting-kept','group-kept','owner-before-list','tab-meeting','tab-group'] as const)
 test(`${mode} actual access records migrate byte-exactly to their browser or leased tab owner`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context),tab=mode.startsWith('tab')
  expect(await page.evaluate(`(async()=>{
    await openOwner('${tab?'tab':'browser'}');const initial=seed('${mode}');countCrypto();await migrate()
    const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key),summary=validate(image.records,true,{kind,links})
    const out=[generated,image.migration.phase,image.records.size===initial.size,[...initial].every(([name,value])=>image.records.get(name)===value),
      summary.invitations.length,Object.keys(localStorage),Object.keys(sessionStorage),saved.key.extractable,kind==='tab'?image.expiresAt===lifetime.expiresAt:image.expiresAt===0]
    restoreCrypto();await lifetime?.close();return out
  })()`)).toEqual([1,'complete',true,true,1,[],tab?['kithmoot.ordinary-tab.v1']:[],false,true]);await context.close()
})

for(const fault of ['signature','wrong-room','wrong-delegate','missing-link','duplicate-room','malformed-room','ambiguous-link','relocated-tab','invalid-owner','shared-delegate','shared-owner','cross-role','null-policy','unknown-policy-field'] as const)
 test(`${fault} holds raw access state before key creation, encryption or plaintext cleanup`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const fault='${fault}';seed(fault==='invalid-owner'||fault==='shared-owner'||fault==='cross-role'?'meeting-owner':'meeting-kept')
    const adm='kithmoot.admission-kept.v1.'+fixture.id
    if(fault==='signature'||fault==='wrong-room'||fault==='wrong-delegate'){
      const value=JSON.parse(storage.getItem(adm))
      if(fault==='signature')value.delegation[0].sig='0'.repeat(128)
      if(fault==='wrong-room')value.delegation[0].room='a'.repeat(64)
      if(fault==='wrong-delegate')value.delegateSk='0'.repeat(63)+'3'
      storage.setItem(adm,JSON.stringify(value))
    }
    if(fault==='missing-link')storage.removeItem(fixture.roomName)
    if(fault==='duplicate-room')storage.setItem('kithmoot.room.'+'a'.repeat(64),storage.getItem(fixture.roomName))
    if(fault==='malformed-room')storage.setItem(fixture.roomName,'{')
    if(fault==='ambiguous-link'||fault==='null-policy'||fault==='unknown-policy-field'){
      const value=JSON.parse(storage.getItem(fixture.roomName)),payload=JSON.parse(new TextDecoder().decode(Ordinary.base64urlnopad.decode(new URL(value.link).hash.slice(1))))
      if(fault==='ambiguous-link')payload.s=Ordinary.base64urlnopad.encode(new Uint8Array(32).fill(5))
      if(fault==='null-policy')payload.a=null
      if(fault==='unknown-policy-field')payload.a={tier:'open',futureRestrictiveRule:true}
      value.link='${ORIGIN}/#'+Ordinary.base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)));storage.setItem(fixture.roomName,JSON.stringify(value))
    }
    if(fault==='relocated-tab'){const value=JSON.parse(storage.getItem(adm));delete value.createdAt;storage.removeItem(adm);storage.setItem('kithmoot.admission.v1.'+fixture.id,JSON.stringify(value))}
    if(fault==='invalid-owner'){const name='kithmoot.invitation-owner.v1.'+fixture.id,value=JSON.parse(storage.getItem(name));value.inviterSk='0'.repeat(64);storage.setItem(name,JSON.stringify(value))}
    if(fault==='shared-delegate'||fault==='shared-owner'||fault==='cross-role'){
      const other=Ordinary.roomAccessFixture({owner:fault==='shared-owner',rootSeed:fault==='shared-owner'?5:6,inviterSeed:fault==='shared-owner'?1:3,requesterSeed:fault==='cross-role'?1:2,bearerSeed:8})
      for(const [name,value]of other.records)storage.setItem(name,value)
      links=[fixture.url,other.url]
    }
    const before=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]));countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]))
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true]);await context.close()
})


for(const family of ['room','owner','kept','cache','way-back','switch'] as const)
 for(const completed of [false,true])
 test(`${family} relocation holds ${completed?'encrypted custody':'raw records'} in the other lifetime`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context),browserFamily=['room','owner','kept'].includes(family)
  expect(await page.evaluate(`(async()=>{
    await openOwner('${browserFamily?'tab':'browser'}')
    const foreign=Ordinary.roomAccessFixture({owner:'${family}'==='owner',tab:${!browserFamily}})
    const name='${family}'==='room'?foreign.roomName:'${family}'==='owner'?'kithmoot.invitation-owner.v1.'+foreign.id:
      '${family}'==='kept'?'kithmoot.admission-kept.v1.'+foreign.id:'${family}'==='cache'?'kithmoot.admission.v1.'+foreign.id:
      '${family}'==='way-back'?'kithmoot.way-back':'kithmoot.room-switch.v1'
    links=[foreign.url]
    if(${completed}){
      seed('${browserFamily?'tab-meeting':'meeting-kept'}');await migrate()
      const scope=await owner.capture('@relocate',guard)
      await owner.mutate(scope,guard,store=>store.set(name,foreign.records.get(name)))
      if(kind==='tab'){await lifetime.close();live=true;await openOwner('tab')}
      else{await owner.close();owner=new Ordinary.OrdinaryStateOwner()}
    }else storage.setItem(name,foreign.records.get(name))
    const before=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)])),frame=${completed}?(await raw()).frame:undefined
    countCrypto();let refusal;try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)])),saved=await raw()
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),
      ${completed}?Ordinary.sameOrdinaryFrame(frame,saved.frame):saved===undefined]
    restoreCrypto();await lifetime?.close();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true]);await context.close()
})

test('partial access cleanup restarts against sealed room and delegation together',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(async()=>{
    seed();const remove=Storage.prototype.removeItem;let removed=false
    Storage.prototype.removeItem=function(name){remove.call(this,name);if(this===localStorage&&!removed){removed=true;throw new Error('cut after access plaintext removal')}}
    try{await migrate()}catch(error){window.cut=error.message}finally{Storage.prototype.removeItem=remove}
  })()`)
  expect(await page.evaluate('[cut,Object.keys(localStorage).length]')).toEqual(['cut after access plaintext removal',1])
  await page.evaluate('owner.close()');await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    window.visits=[];const strict=validate;validate=(records,migrated,options)=>{visits.push([records.size,migrated]);return strict(records,migrated,options)}
    countCrypto();await migrate();const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    const out=[generated,visits,image.records.size,image.migration.phase,Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([0,[[2,false]],2,'complete',[]]);await context.close()
})

test('tab admission and navigation survive actual reload without extending the lease or retaining raw secrets',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  const prior=await page.evaluate<string[]>(`(async()=>{await openOwner('tab');seed('tab-meeting');await migrate();const row=await raw();return [String(lifetime.expiresAt),row.frame.keyId,sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)]})()`)
  await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    await openOwner('tab');countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
    const out=[generated,String(lifetime.expiresAt),row.frame.keyId,sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER),image.records.size,Object.keys(localStorage),Object.keys(sessionStorage)]
    restoreCrypto();await lifetime.close();return out
  })()`)).toEqual([0,...prior,3,[],['kithmoot.ordinary-tab.v1']]);await context.close()
})

for(const fault of ['signature','mixed-scope','null-policy','unknown-policy-field','cross-role'] as const)test(`completed encrypted access custody holds ${fault} unchanged with no plaintext remaining`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    seed('${fault}'==='cross-role'?'meeting-owner':'meeting-kept');await migrate();const scope=await owner.capture('@damage',guard),name='kithmoot.admission-kept.v1.'+fixture.id
    await owner.mutate(scope,guard,store=>{
      if('${fault}'==='mixed-scope')store.set('kithmoot.account.'+'a'.repeat(64)+'.'+name,store.get(name))
      else if('${fault}'==='cross-role'){const other=Ordinary.roomAccessFixture({rootSeed:6,inviterSeed:3,requesterSeed:1,bearerSeed:8});for(const [key,value]of other.records)store.set(key,value)}
      else if('${fault}'==='null-policy'||'${fault}'==='unknown-policy-field'){
        const value=JSON.parse(store.get(fixture.roomName)),payload=JSON.parse(new TextDecoder().decode(Ordinary.base64urlnopad.decode(new URL(value.link).hash.slice(1))))
        payload.a='${fault}'==='null-policy'?null:{tier:'open',futureRestrictiveRule:true}
        value.link='${ORIGIN}/#'+Ordinary.base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)));store.set(fixture.roomName,JSON.stringify(value))
      }
      else{const value=JSON.parse(store.get(name));value.delegation[0].sig='0'.repeat(128);store.set(name,JSON.stringify(value))}
    })
    const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]]);await context.close()
})
