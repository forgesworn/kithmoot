import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-device.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const result=await build({entryPoints:[fileURLToPath(new URL('./ordinary-device.browser-entry.ts',import.meta.url))],
    bundle:true,format:'iife',globalName:'Ordinary',platform:'browser',write:false,target:'es2022'})
  bundle=result.outputFiles[0]!.text
})
async function serve(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`,route=>route.fulfill({status:200,contentType:'text/html',
    body:`<!doctype html><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
}
const setup=`async()=>{
  window.secret=new Uint8Array(32).fill(23);window.roomId=Ordinary.deriveRoom(secret).roomId
  window.identity=Ordinary.localIdentity(Ordinary.generateSecretKey());window.account=identity.pubkey
  window.current={account,roomId};window.foreground=true
  window.nameFor=logical=>'kithmoot.account.'+account+'.'+logical
  window.owner=new Ordinary.OrdinaryStateOwner();await owner.prepare(()=>foreground,new Map())
  window.devices=await Ordinary.OrdinaryRoomDeviceState.open({owner,account,roomId,current:()=>current,live:()=>foreground})
  window.deviceSk=await devices.deviceKey(Math.floor(Date.now()/1000))
  window.scope=await owner.capture('room:'+roomId,()=>foreground)
  window.raw=()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser')
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()}
  })
  window.ownCredential=async(seal)=>Ordinary.createDeviceCredential({identity,devicePubkey:Ordinary.getPublicKey(deviceSk),roomId,
    expiresAt:Math.floor(Date.now()/1000)+3600,...(seal?{seal:Ordinary.getPublicKey(seal)}:{})})
}`

test('the actual RoomSession required callback retains its signed credential and complete seal before joining', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    const relay=new Ordinary.SimRelay();let handed
    const session=new Ordinary.RoomSession({secret,identity,deviceSk,transport:new Ordinary.SimTransport(relay),epochSettleMs:0,
      retainCredential:async(credential,seal)=>{handed=credential;await devices.retainOwnCredential(credential,seal)},announceJitterMs:0})
    await session.join([],{});const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    const kept=JSON.parse(image.records.get(nameFor(Ordinary.OWN_CREDENTIAL_PREFIX+roomId))),seals=JSON.parse(image.records.get(nameFor(Ordinary.OWN_SEAL_PREFIX+roomId)))
    const receipt=[kept.id===handed.id,seals.length,session.participants().length,relay.published.length>0,Object.keys(localStorage),Object.keys(sessionStorage)]
    await session.leave();await devices.close();await owner.close();return receipt
  })()`)).toEqual([true,1,1,true,[],[]]);await context.close()
})

test('unknown native credential retention holds actual RoomSession effects until exact recovery', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  await page.evaluate(`(()=>{
    const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    window.intercepted=0;window.joined=false;window.handovers=0;window.relay=new Ordinary.SimRelay()
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)d.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)})
      else d.set.call(tx,callback)}})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);IDBFactory.prototype.open=nativeOpen}
    window.session=new Ordinary.RoomSession({secret,identity,deviceSk,transport:new Ordinary.SimTransport(relay),epochSettleMs:0,
      retainCredential:(credential,seal)=>{handovers++;return devices.retainOwnCredential(credential,seal)},announceJitterMs:0})
    void(window.joining=session.join([],{}).then(()=>joined=true))
  })()`)
  await page.waitForFunction('owner.holdingRetention')
  expect(await page.evaluate('[joined,handovers,relay.published.length,session.participants().length]')).toEqual([false,1,0,0])
  await page.evaluate(`(async()=>{restore();window.intended=(await raw()).pending;owner.retryRetention()})()`)
  await page.evaluate('joining')
  expect(await page.evaluate(`(async()=>{const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    return [joined,handovers,Ordinary.sameOrdinaryFrame(intended,saved.frame),image.records.has(nameFor(Ordinary.OWN_CREDENTIAL_PREFIX+roomId)),image.records.has(nameFor(Ordinary.OWN_SEAL_PREFIX+roomId))]})()`)).toEqual([true,1,true,true,true])
  await page.evaluate('session.leave()');await context.close()
})

test('room-scoped device pruning preserves another room and retained keys survive a reload', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  const key=await page.evaluate(`(async()=>{
    await owner.mutate(scope,()=>foreground,s=>s.set('kithmoot.device.'+'b'.repeat(64),JSON.stringify({sk:'01'.repeat(32),at:0})))
    const key=await devices.deviceKey(Math.floor(Date.now()/1000))
    return Ordinary.bytesToHex(key)
  })()`)
  expect(await page.evaluate(`owner.read(scope,()=>foreground,s=>s.get('kithmoot.device.'+'b'.repeat(64)))`)).not.toBeNull()
  await page.evaluate('devices.close()');await page.evaluate('owner.close()');await page.reload()
  // Restore the original account/room explicitly; no fresh participant or device key is generated.
  expect(await page.evaluate(`(async()=>{
    const owner=new Ordinary.OrdinaryStateOwner();await owner.prepare(()=>true,new Map())
    const scope=await owner.capture('inspect',()=>true);const records=await owner.read(scope,()=>true,s=>s.keys().filter(k=>k.includes('kithmoot.device.')))
    const values=await owner.read(scope,()=>true,s=>records.map(k=>JSON.parse(s.get(k)).sk))
    await owner.close();return values
  })()`)).toContain(key);await context.close()
})

for (const change of ['account','room'] as const) {
  test(`${change} change during encryption suppresses the adapter result and leaves the prior key`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
    expect(await page.evaluate(`(async()=>{
      const previous=await raw(),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
      crypto.subtle.encrypt=async(...args)=>{current={...current,...('${change}'==='account'?{account:'f'.repeat(64)}:{roomId:'f'.repeat(64)})};return encrypt(...args)}
      let answer;try{await devices.deviceKey(Math.floor(Date.now()/1000));answer='success'}catch(e){answer=e.name}
      crypto.subtle.encrypt=encrypt;return [answer,Ordinary.sameOrdinaryFrame(previous.frame,(await raw()).frame)]
    })()`)).toEqual(['OrdinaryStateHold',true]);await context.close()
  })
}

test('an orphan credential cannot silently mint a replacement device key', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    const credential=await ownCredential();await devices.retainOwnCredential(credential)
    await owner.mutate(scope,()=>foreground,s=>s.remove(nameFor('kithmoot.device.'+roomId)))
    const previous=await raw();let entropy=0;const random=crypto.getRandomValues.bind(crypto)
    crypto.getRandomValues=(...args)=>{entropy++;return random(...args)}
    let answer;try{await devices.deviceKey(Math.floor(Date.now()/1000));answer='success'}catch(e){answer=e.name}
    crypto.getRandomValues=random;return [answer,entropy,Ordinary.sameOrdinaryFrame(previous.frame,(await raw()).frame)]
  })()`)).toEqual(['OrdinaryStateHold',0,true]);await context.close()
})

test('malformed stored seals and a mismatched newly retained seal hold without altering ciphertext', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    const seal=Ordinary.generateSecretKey(),credential=await ownCredential(seal),previous=await raw()
    let mismatch;try{await devices.retainOwnCredential(credential,Ordinary.generateSecretKey());mismatch='success'}catch(e){mismatch=e.name}
    const unchanged=Ordinary.sameOrdinaryFrame(previous.frame,(await raw()).frame)
    await owner.mutate(scope,()=>foreground,s=>s.set(nameFor(Ordinary.OWN_SEAL_PREFIX+roomId),'["broken"]'))
    const corrupted=await raw();let malformed;try{await devices.sealKeys();malformed='success'}catch(e){malformed=e.name}
    return [mismatch,unchanged,malformed,Ordinary.sameOrdinaryFrame(corrupted.frame,(await raw()).frame)]
  })()`)).toEqual(['OrdinaryStateHold',true,'OrdinaryStateHold',true]);await context.close()
})

test('caller changes to credential/seal inputs cannot replace an already captured native candidate', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  const receipt=await page.evaluate<[string,string[],string,string]>(`(async()=>{
    const seal=Ordinary.generateSecretKey(),hex=Ordinary.bytesToHex(seal),credential=await ownCredential(seal),id=credential.id
    const retaining=devices.retainOwnCredential(credential,seal)
    seal.fill(0);credential.id='f'.repeat(64);credential.tags.length=0
    await retaining
    return [await owner.read(scope,()=>foreground,s=>JSON.parse(s.get(nameFor(Ordinary.OWN_CREDENTIAL_PREFIX+roomId))).id),
      await owner.read(scope,()=>foreground,s=>JSON.parse(s.get(nameFor(Ordinary.OWN_SEAL_PREFIX+roomId)))),id,hex]
  })()`)
  expect(receipt[0]).toBe(receipt[2]);expect(receipt[1]).toEqual([receipt[3]])
  // Compare the actual retained values, rather than just successful acknowledgement.
  expect(await page.evaluate(`(async()=>{const saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    const credential=JSON.parse(image.records.get(nameFor(Ordinary.OWN_CREDENTIAL_PREFIX+roomId))),seals=JSON.parse(image.records.get(nameFor(Ordinary.OWN_SEAL_PREFIX+roomId)))
    return credential.tags.find(t=>t[0]==='seal')[1]===Ordinary.getPublicKey(Uint8Array.from(seals[0].match(/../g),x=>parseInt(x,16)))})()`)).toBe(true)
  await context.close()
})

test('account-specific custody stays distinct even after the first account credential expires', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    const firstAccount=account,firstKey=Ordinary.bytesToHex(deviceSk),credential=await ownCredential()
    await devices.retainOwnCredential(credential)
    const expired=await devices.ownCredential(Number(credential.tags.find(t=>t[0]==='expiration')[1])+1)
    await devices.close();const secondIdentity=Ordinary.localIdentity(Ordinary.generateSecretKey())
    current={account:secondIdentity.pubkey,roomId}
    const second=await Ordinary.OrdinaryRoomDeviceState.open({owner,account:secondIdentity.pubkey,roomId,current:()=>current,live:()=>foreground})
    const secondKey=await second.deviceKey(Math.floor(Date.now()/1000));await second.close()
    current={account:firstAccount,roomId}
    const restored=await Ordinary.OrdinaryRoomDeviceState.open({owner,account:firstAccount,roomId,current:()=>current,live:()=>foreground})
    const restoredKey=await restored.loadDeviceKey()
    const bindings=await owner.read(scope,()=>foreground,s=>s.keys().filter(k=>k.includes('kithmoot.device-owner.')).map(k=>JSON.parse(s.get(k)).account))
    return [expired===undefined,firstKey!==Ordinary.bytesToHex(secondKey),Ordinary.bytesToHex(restoredKey)===firstKey,new Set(bindings).size]
  })()`)).toEqual([true,true,true,2]);await context.close()
})

for (const fault of ['binding','own-credential','secondary-credential','uppercase-seal','missing-seal'] as const) {
  test(`authenticated ${fault} inconsistency holds all device reads without changing ciphertext`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
    expect(await page.evaluate(`(async()=>{
      const seal=Ordinary.generateSecretKey(),own=await ownCredential(seal)
      await devices.retainOwnCredential(own,seal)
      const foreign=await Ordinary.createDeviceCredential({identity:Ordinary.localIdentity(Ordinary.generateSecretKey()),devicePubkey:Ordinary.getPublicKey(deviceSk),roomId,expiresAt:Math.floor(Date.now()/1000)+3600})
      await owner.mutate(scope,()=>foreground,s=>{
        if('${fault}'==='binding')s.set(nameFor('kithmoot.device-owner.'+roomId),JSON.stringify({account:'f'.repeat(64),roomId}))
        else if('${fault}'==='own-credential')s.set(nameFor(Ordinary.OWN_CREDENTIAL_PREFIX+roomId),JSON.stringify(foreign))
        else if('${fault}'==='secondary-credential')s.set(nameFor('kithmoot.credential.'+roomId),JSON.stringify(foreign))
        else if('${fault}'==='uppercase-seal')s.set(nameFor(Ordinary.OWN_SEAL_PREFIX+roomId),JSON.stringify([Ordinary.bytesToHex(seal).toUpperCase()]))
        else s.remove(nameFor(Ordinary.OWN_SEAL_PREFIX+roomId))
      })
      const previous=await raw(),answers=[]
      for(const read of [()=>devices.loadDeviceKey(),()=>devices.sealKeys(),()=>devices.ownCredential(Math.floor(Date.now()/1000)),
        ()=>Ordinary.OrdinaryRoomDeviceState.open({owner,account,roomId,current:()=>current,live:()=>foreground})]){
        try{await read();answers.push('success')}catch(e){answers.push(e.name)}
      }
      return [answers,Ordinary.sameOrdinaryFrame(previous.frame,(await raw()).frame)]
    })()`)).toEqual([Array(4).fill('OrdinaryStateHold'),true]);await context.close()
  })
}

test('unbound legacy device-only custody requires explicit migration without guessing its account', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    await owner.mutate(scope,()=>foreground,s=>s.set('kithmoot.device.'+roomId,JSON.stringify({sk:Ordinary.bytesToHex(deviceSk),at:0})))
    const previous=await raw();let answer
    try{await Ordinary.OrdinaryRoomDeviceState.open({owner,account,roomId,current:()=>current,live:()=>foreground});answer='success'}catch(e){answer=e.name}
    return [answer,Ordinary.sameOrdinaryFrame(previous.frame,(await raw()).frame)]
  })()`)).toEqual(['OrdinaryStateHold',true]);await context.close()
})

test('the shared room deletion fence prevents a captured adapter from recreating forgotten device custody', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    await owner.forget(scope,()=>foreground,name=>name.startsWith('kithmoot.account.'+account+'.'))
    const previous=await raw(),answers=[]
    for(const work of [()=>devices.loadDeviceKey(),()=>devices.deviceKey(Math.floor(Date.now()/1000))]){
      try{await work();answers.push('success')}catch(e){answers.push(e.name)}
    }
    return [answers,Ordinary.sameOrdinaryFrame(previous.frame,(await raw()).frame)]
  })()`)).toEqual([['OrdinaryStateHold','OrdinaryStateHold'],true]);await context.close()
})

test('adapter close during crypto joins its work, wipes the unreturned key and suppresses native commit', async ({ browser }) => {
  const context=await browser.newContext();await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  await page.evaluate(`(async()=>{
    window.previous=(await raw()).frame;window.encrypting=false;window.closedReceipt=false;window.answer='pending'
    const NativeBytes=Uint8Array;window.allocated=[]
    window.restoreBytes=()=>{window.Uint8Array=NativeBytes}
    const capture=bytes=>{if(bytes.length===32)allocated.push(bytes);return bytes}
    window.Uint8Array=new Proxy(NativeBytes,{
      construct(target,args){return capture(Reflect.construct(target,args,target))},
      get(target,name,receiver){if(name==='fromHex'&&typeof target.fromHex==='function')return(...args)=>capture(Reflect.apply(target.fromHex,target,args));return Reflect.get(target,name,receiver)}
    })
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),gate=new Promise(resolve=>window.releaseEncrypt=resolve)
    crypto.subtle.encrypt=async(...args)=>{encrypting=true;await gate;return encrypt(...args)}
    void(window.mutating=devices.deviceKey(Math.floor(Date.now()/1000)).then(()=>answer='success',e=>answer=e.name))
  })()`)
  await page.waitForFunction('encrypting');await page.evaluate(`window.unreturned=allocated.filter(bytes=>bytes.every((value,index)=>value===deviceSk[index]));restoreBytes();void(devices.close().then(()=>closedReceipt=true))`)
  expect(await page.evaluate('unreturned.length')).toBeGreaterThan(0)
  expect(await page.evaluate('[closedReceipt,answer]')).toEqual([false,'pending'])
  await page.evaluate('releaseEncrypt()');await page.evaluate('mutating');await page.waitForFunction('closedReceipt')
  expect(await page.evaluate('(async()=>[answer,Ordinary.sameOrdinaryFrame(previous,(await raw()).frame),unreturned.every(bytes=>bytes.every(value=>value===0))])()')).toEqual(['OrdinaryStateHold',true,true])
  await context.close()
})
