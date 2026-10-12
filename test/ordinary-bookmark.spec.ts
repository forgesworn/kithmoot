import { build } from 'esbuild'
import { expect,test,type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Exact real writer/signature/NIP-44 fixtures with offline relays and a noop
// client fence. Production bootstrap, signer verification of cached plaintext,
// remaining inventory, effects and coordinated forget are still open.
const ORIGIN='https://ordinary-bookmark.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-bookmark.browser-entry.ts',import.meta.url))],bundle:true,
    format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text
})
const setup=`async()=>{
  window.live=true;window.guard=()=>live;window.kind='browser';window.storage=localStorage
  window.owner=new Ordinary.OrdinaryStateOwner();window.lifetime=undefined
  window.seed=async(mode='signed')=>{
    window.fixture=await Ordinary.bookmarkFixture(mode)
    for(const [name,value]of fixture.records)storage.setItem(name,value)
    return new Map(fixture.records)
  }
  window.validate=Ordinary.validateOrdinaryRoomBookmarkSnapshot
  window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage,selected:name=>name.startsWith('kithmoot.')&&name!==Ordinary.ORDINARY_TAB_MARKER,
    validate:(records,migrated)=>validate(records,migrated,{kind}),checkClients:async()=>{},live:guard})
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
  window.damage=async(records,fault)=>{
    const name=fixture.name,saved=JSON.parse(records.get(name)),record=saved.record
    if(fault==='signature')record.event.sig='0'.repeat(128)
    if(fault==='event-account')record.event.pubkey='a'.repeat(64)
    if(fault==='event-time')record.event.created_at++
    if(fault==='event-id')record.id='a'.repeat(64)
    if(fault==='event-kind')record.event=fixture.sign({...record.event,kind:1})
    if(fault==='duplicate-d')record.event=fixture.sign({...record.event,tags:[...record.event.tags,record.event.tags.find(tag=>tag[0]==='d')]})
    if(fault==='plaintext-content')record.event=fixture.sign({...record.event,content:'plaintext admission '+record.admission.secret})
    if(fault==='cipher-version'){const bytes=Ordinary.base64.decode(record.event.content);bytes[0]=1;record.event=fixture.sign({...record.event,content:Ordinary.base64.encode(bytes)})}
    if(['event-kind','duplicate-d','plaintext-content','cipher-version'].includes(fault))record.id=record.event.id
    if(fault==='wrong-secret')record.admission.secret='6'.repeat(64)
    if(fault==='orphan-admission')delete record.room
    if(fault==='unknown-policy'){
      const payload=JSON.parse(new TextDecoder().decode(Ordinary.base64urlnopad.decode(new URL(record.room.link).hash.slice(1))))
      payload.a={tier:'open',futureRestriction:true};record.room.link='${ORIGIN}/#'+Ordinary.base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
    }
    if(fault==='malformed-pending')saved.pending={d:record.d,value:{roomId:fixture.roomId,at:-1}}
    if(['zero-address','wrong-version','wrong-variant'].includes(fault)){
      const parts=record.d.slice('kithmoot.rooms.v1.'.length).split('-')
      if(fault==='wrong-version')parts[2]='1'+parts[2].slice(1)
      if(fault==='wrong-variant')parts[3]='0'+parts[3].slice(1)
      record.d='kithmoot.rooms.v1.'+(fault==='zero-address'?'00000000-0000-0000-0000-000000000000':parts.join('-'))
      if(record.event){record.event=fixture.sign({...record.event,tags:[['d',record.d],['l','kithmoot.rooms.v1']]});record.id=record.event.id}
    }
    if(fault==='same-event-conflict'){
      const {d,id,event,...plain}=record;saved.pending={d,event,value:{...plain,room:{...plain.room,name:'Conflicting pending value'}}}
    }
    if(fault==='conflicting-root'){
      const {d,id,event,...plain}=record,payload=JSON.parse(new TextDecoder().decode(Ordinary.base64urlnopad.decode(new URL(plain.room.link).hash.slice(1))))
      payload.h='a'.repeat(64)
      saved.pending={d,value:{...plain,at:plain.at+1000,room:{...plain.room,link:'${ORIGIN}/#'+Ordinary.base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))}}}
    }
    records.set(name,JSON.stringify(fault==='empty'?{}:saved))
    if(fault==='bad-key'){records.set('kithmoot.bookmarks.invalid.'+fixture.roomId,records.get(name));records.delete(name)}
    if(fault==='cross-room-address'){
      const other=await Ordinary.bookmarkFixture('signed',{rootSeed:6,bearerSeed:8}),second=JSON.parse(other.records.get(other.name))
      second.record.d=record.d;second.record.event=other.sign({...second.record.event,tags:[['d',record.d],['l','kithmoot.rooms.v1']]});second.record.id=second.record.event.id
      for(const [key,value]of other.records)records.set(key,key===other.name?JSON.stringify(second):value)
    }
    if(fault==='old-event-reuse'){
      const other=await Ordinary.bookmarkFixture('older',{rootSeed:6,bearerSeed:8}),second=JSON.parse(other.records.get(other.name));second.record.id=record.id
      for(const [key,value]of other.records)records.set(key,key===other.name?JSON.stringify(second):value)
    }
  }
}`
async function open(context:BrowserContext){
  await context.route(`${ORIGIN}/**`,route=>route.fulfill({status:200,contentType:'text/html',
    body:`<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`);return page
}
for(const mode of ['signed','older','unsigned-pending','signed-pending','record-pending','tombstone','pending-tombstone'] as const)
 test(`${mode} actual bookmark cache migrates byte-exactly without signing, repair or publication`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const initial=await seed('${mode}'),published=fixture.published.length;countCrypto();await migrate()
    const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key),summary=validate(image.records,true,{kind})
    const out=[generated,image.migration.phase,image.records.size===initial.size,[...initial].every(([name,value])=>image.records.get(name)===value),
      summary.bookmarks.length,summary.bookmarks[0].removed,fixture.published.length===published,Object.keys(localStorage),Object.keys(sessionStorage),saved.key.extractable]
    restoreCrypto();return out
  })()`)).toEqual([1,'complete',true,true,1,['tombstone','pending-tombstone'].includes(mode),true,[],[],false]);await context.close()
})
for(const fault of ['signature','event-account','event-time','event-id','event-kind','duplicate-d','plaintext-content','cipher-version','wrong-secret','orphan-admission','unknown-policy','empty','malformed-pending','bad-key','tab-relocation','cross-room-address','same-event-conflict','conflicting-root','old-event-reuse','zero-address','wrong-version','wrong-variant'] as const)
 test(`${fault} holds raw bookmark state before key generation, encryption or plaintext cleanup`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    if('${fault}'==='tab-relocation'){kind='tab';storage=sessionStorage;lifetime=await Ordinary.OrdinaryTabLifetime.open({storage,live:guard,stop:()=>{live=false}});owner=lifetime.owner}
    await seed('${['zero-address','wrong-version','wrong-variant'].includes(fault)?'older':'signed'}');const records=new Map(Object.keys(storage).map(name=>[name,storage.getItem(name)]));await damage(records,'${fault}')
    for(const name of Object.keys(storage))if(!records.has(name))storage.removeItem(name)
    for(const [name,value]of records)storage.setItem(name,value)
    const before=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]));countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(storage).map(name=>[name,storage.getItem(name)]))
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
    restoreCrypto();await lifetime?.close();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true]);await context.close()
})
for(const fault of ['signature','wrong-secret','unknown-policy','cross-room-address','same-event-conflict','conflicting-root','old-event-reuse','zero-address','wrong-version','wrong-variant'] as const)
 test(`completed custody holds ${fault} without changing the encrypted image`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed('${['zero-address','wrong-version','wrong-variant'].includes(fault)?'older':'signed'}');await migrate();const scope=await owner.capture('@damage',guard)
    const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),damaged=new Map(image.records)
    await damage(damaged,'${fault}');await owner.mutate(scope,guard,store=>{for(const [name,value]of damaged)store.set(name,value)})
    const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]]);await context.close()
})
test('partial bookmark cleanup validates the sealed whole cache after actual reload',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(async()=>{
    await seed('signed-pending');const remove=Storage.prototype.removeItem;let removed=false
    Storage.prototype.removeItem=function(name){remove.call(this,name);if(this===localStorage&&!removed){removed=true;throw new Error('cut after bookmark cleanup')}}
    try{await migrate()}catch(error){window.cut=error.message}finally{Storage.prototype.removeItem=remove}
  })()`)
  expect(await page.evaluate('[cut,Object.keys(localStorage).length]')).toEqual(['cut after bookmark cleanup',1])
  await page.evaluate('owner.close()');await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    window.visits=[];const strict=validate;validate=(records,migrated,options)=>{visits.push([records.size,migrated]);return strict(records,migrated,options)}
    countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
    const out=[generated,visits,image.records.size,image.migration.phase,Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([0,[[2,false]],2,'complete',[]]);await context.close()
})
test('completed pending tombstone survives reload unchanged without stale room resurrection',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  const before=await page.evaluate<string>(`(async()=>{await seed('pending-tombstone');await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);await owner.close();return JSON.stringify([...image.records])})()`)
  await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,{kind})
    const out=[generated,JSON.stringify([...image.records]),summary.bookmarks[0].pending,summary.bookmarks[0].removed,Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([0,before,true,true,[]]);await context.close()
})
test('an account bookmark pins creator custody even when the room list was never written',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();for(const name of Object.keys(localStorage))if(name!==fixture.name)localStorage.removeItem(name)
    const owned=Ordinary.roomAccessFixture({owner:true,persistent:true})
    for(const [name,value]of owned.records)if(name.startsWith('kithmoot.invitation-owner.'))localStorage.setItem(name,value)
    countCrypto();await migrate();const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key),summary=validate(image.records,true,{kind})
    const out=[generated,image.records.size,summary.bookmarks.length,summary.access.invitations.length,Object.keys(localStorage)];restoreCrypto();return out
  })()`)).toEqual([1,2,1,1,[]]);await context.close()
})
