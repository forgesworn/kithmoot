import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Actual Storage/IDB migration of the identity family. Other production
// inventory families and the real root/client fence are still separate gates.
const ORIGIN='https://ordinary-identity.kithmoot.test'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:[fileURLToPath(new URL('./ordinary-identity.browser-entry.ts',import.meta.url))],bundle:true,
    format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})).outputFiles[0]!.text
})
async function serve(context:BrowserContext){
  await context.route(`${ORIGIN}/**`,route=>route.fulfill({status:200,contentType:'text/html',
    body:`<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
}
const setup=`async()=>{
  window.live=true;window.guard=()=>live;window.room='a'.repeat(64)
  window.key=new Uint8Array(32);key[31]=1;window.device=new Uint8Array(32);device[31]=2;window.seal=new Uint8Array(32);seal[31]=3
  window.account=Ordinary.getPublicKey(key)
  window.owner=new Ordinary.OrdinaryStateOwner()
  window.seed=async(secondary=false)=>{
    const event=await Ordinary.createDeviceCredential({identity:Ordinary.localIdentity(key),devicePubkey:Ordinary.getPublicKey(device),roomId:room,
      expiresAt:200,now:()=>100,...(secondary?{}:{seal:Ordinary.getPublicKey(seal)})})
    const records=new Map([['kithmoot.device.'+room,JSON.stringify({sk:Ordinary.bytesToHex(device),at:100})],
      [(secondary?'kithmoot.credential.':'kithmoot.own-credential.')+room,JSON.stringify(event)]])
    if(!secondary){records.set('kithmoot.participant',Ordinary.bytesToHex(key));records.set('kithmoot.own-seal.'+room,JSON.stringify([Ordinary.bytesToHex(seal)]))}
    for(const [name,value]of records)localStorage.setItem(name,value)
    return records
  }
  window.validate=Ordinary.validateOrdinaryIdentitySnapshot
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
async function open(context:BrowserContext){await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`);return page}

for(const secondary of [false,true])test(`actual ${secondary?'secondary':'primary'} legacy identity migrates byte-exactly before plaintext cleanup`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const initial=await seed(${secondary});countCrypto();await migrate()
    const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key),role=validate(image.records,true)
    const out=[generated,image.migration.phase,[...image.migration.sources].length,initial.size===image.records.size,
      [...initial].every(([name,value])=>image.records.get(name)===value),role.secondary,!!role.participant,
      Object.keys(localStorage),Object.keys(sessionStorage),saved.key.extractable]
    restoreCrypto();return out
  })()`)).toEqual([1,'complete',0,true,true,secondary,!secondary,[],[],false])
  await context.close()
})

test('restart after partial plaintext cleanup validates the sealed whole identity rather than incomplete sources',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(async()=>{
    await seed();const remove=Storage.prototype.removeItem;let removed=false
    Storage.prototype.removeItem=function(name){remove.call(this,name);if(this===localStorage&&!removed){removed=true;throw new Error('cut after plaintext removal')}}
    try{await migrate()}catch(error){window.cut=error.message}finally{Storage.prototype.removeItem=remove}
  })()`)
  expect(await page.evaluate('[cut,Object.keys(localStorage).length]')).toEqual(['cut after plaintext removal',3])
  const prior=await page.evaluate<string[]>(`(async()=>{const frame=(await raw()).frame;return [frame.keyId,frame.generation]})()`)
  await page.evaluate('owner.close()');await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    window.visits=[];const strict=validate;validate=(records,migrated)=>{visits.push([records.size,migrated]);return strict(records,migrated)}
    countCrypto();await migrate();const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    const out=[generated,visits,image.records.size,image.migration.phase,Object.keys(localStorage),saved.frame.keyId,saved.frame.generation]
    restoreCrypto();return out
  })()`)).toEqual([0,[[4,false]],4,'complete',[],...prior])
  await context.close()
})

for(const fault of ['signature','device-orphan','credential-orphan','seal-orphan','zero-key','duplicate-device','invalid-room','obsolete-shared'] as const)
 test(`${fault} holds the complete plaintext identity before key creation or deletion`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();const fault='${fault}'
    if(fault==='signature'){const name='kithmoot.own-credential.'+room,value=JSON.parse(localStorage.getItem(name));value.sig='00'.repeat(64);localStorage.setItem(name,JSON.stringify(value))}
    if(fault==='device-orphan')localStorage.removeItem('kithmoot.device.'+room)
    if(fault==='credential-orphan')localStorage.removeItem('kithmoot.own-credential.'+room)
    if(fault==='seal-orphan')localStorage.removeItem('kithmoot.own-seal.'+room)
    if(fault==='zero-key')localStorage.setItem('kithmoot.participant','00'.repeat(32))
    if(fault==='duplicate-device'){
      const name='kithmoot.own-credential.'+room,event=JSON.parse(localStorage.getItem(name));event.tags.push(['device',Ordinary.getPublicKey(device)])
      localStorage.setItem(name,JSON.stringify(Ordinary.finalizeEvent({kind:event.kind,created_at:event.created_at,tags:event.tags,content:event.content},key)))
    }
    if(fault==='invalid-room')localStorage.setItem('kithmoot.device.invalid',JSON.stringify({sk:Ordinary.bytesToHex(device),at:100}))
    if(fault==='obsolete-shared')localStorage.setItem('kithmoot.device',Ordinary.bytesToHex(device))
    const before=Object.fromEntries(Object.keys(localStorage).map(name=>[name,localStorage.getItem(name)]));countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(localStorage).map(name=>[name,localStorage.getItem(name)]))
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true])
  await context.close()
})

test('a validator alias cannot rewrite the native migration candidate',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const initial=await seed(),strict=validate
    validate=(records,migrated)=>{const role=strict(records,migrated);window.alias=records;records.clear();records.set('injected','bad');return role}
    await migrate();const image=await Ordinary.openOrdinaryFrame((await raw()).frame,(await raw()).key)
    return [alias.size,image.records.size,image.records.has('injected'),[...initial].every(([name,value])=>image.records.get(name)===value)]
  })()`)).toEqual([0,4,false,true])
  await context.close()
})

for(const shared of ['device','seal-history'] as const)for(const differentAccount of [false,true])
 test(`shared ${shared} across rooms with different accounts=${differentAccount} holds before encryption or cleanup`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();const secondRoom='b'.repeat(64),secondAccount=new Uint8Array(32),secondDevice=new Uint8Array(32),secondSeal=new Uint8Array(32)
    secondAccount[31]=4;secondDevice[31]=5;secondSeal[31]=6
    const chosenDevice=${shared==='device'?'device':'secondDevice'}
    const event=await Ordinary.createDeviceCredential({identity:Ordinary.localIdentity(${differentAccount?'secondAccount':'key'}),
      devicePubkey:Ordinary.getPublicKey(chosenDevice),roomId:secondRoom,expiresAt:200,now:()=>100,seal:Ordinary.getPublicKey(secondSeal)})
    localStorage.setItem('kithmoot.device.'+secondRoom,JSON.stringify({sk:Ordinary.bytesToHex(chosenDevice),at:100}))
    localStorage.setItem('kithmoot.own-credential.'+secondRoom,JSON.stringify(event))
    localStorage.setItem('kithmoot.own-seal.'+secondRoom,JSON.stringify([Ordinary.bytesToHex(secondSeal)${shared==='seal-history'?',Ordinary.bytesToHex(seal)':''}]))
    const before=Object.fromEntries(Object.keys(localStorage).map(name=>[name,localStorage.getItem(name)]));countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const after=Object.fromEntries(Object.keys(localStorage).map(name=>[name,localStorage.getItem(name)]))
    const out=[refusal,generated,entropy,encryptions,JSON.stringify(before)===JSON.stringify(after),(await raw())===undefined]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true])
  await context.close()
})

test('completed custody cannot share a device between two scoped accounts in one room',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();await migrate();const scope=await owner.capture('@damage',guard),otherKey=new Uint8Array(32);otherKey[31]=4
    const otherAccount=Ordinary.getPublicKey(otherKey)
    await owner.mutate(scope,guard,store=>{
      for(const pub of [account,otherAccount]){
        const prefix='kithmoot.account.'+pub+'.'
        store.set(prefix+'kithmoot.device.'+room,JSON.stringify({sk:Ordinary.bytesToHex(device),at:100}))
        store.set(prefix+'kithmoot.device-owner.'+room,JSON.stringify({account:pub,roomId:room}))
      }
      for(const name of ['kithmoot.device.','kithmoot.own-credential.','kithmoot.own-seal.'])store.remove(name+room)
    })
    const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]])
  await context.close()
})

for(const reject of [false,true])test(`an asynchronous ${reject?'rejecting':'resolving'} validator cannot initialise custody`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();validate=async()=>{${reject?"throw new Error('unsupported asynchronous validation')":"return true"}}
    countCrypto();let refusal;try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Object.keys(localStorage).length,(await raw())===undefined]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,4,true])
  await context.close()
})

test('a completed encrypted image is revalidated before startup even with no remaining plaintext',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed();await migrate();const scope=await owner.capture('@damage',guard)
    await owner.mutate(scope,guard,store=>store.set('kithmoot.participant','00'.repeat(32)))
    const before=(await raw()).frame;await owner.close();owner=new Ordinary.OrdinaryStateOwner();countCrypto();let refusal
    try{await migrate()}catch(error){refusal=error.name}
    const out=[refusal,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,[]])
  await context.close()
})

test('a prepared validation view is immutable and closes immediately after the helper',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const values=await seed();window.escaped=null
    await owner.prepare(guard,values,{phase:'sealed',sources:values,names:[...values.keys()]},store=>{escaped=store;validate(new Map(store.keys().map(name=>[name,store.get(name)])),false)})
    let refused;try{escaped.get('kithmoot.participant')}catch(error){refused=error.name}
    await owner.close();owner=new Ordinary.OrdinaryStateOwner();const before=(await raw()).frame;countCrypto();let mutation
    try{await owner.prepare(guard,values,undefined,store=>store.set('injected','value'))}catch(error){mutation=error.name}
    const out=[refused,mutation,generated,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame)];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,0,true])
  await context.close()
})

test('canonical image bounds refuse initialisation before custom validation or key entropy',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    countCrypto();let validators=0,refusal
    try{await owner.prepare(guard,new Map([['x'.repeat(513),'value']]),undefined,()=>validators++)}catch(error){refusal=error.name}
    const out=[refusal,validators,generated,entropy,encryptions,(await raw())===undefined];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',0,0,0,0,true])
  await context.close()
})
