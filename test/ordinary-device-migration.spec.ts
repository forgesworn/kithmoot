import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-device-migration.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./ordinary-device.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })
  bundle = result.outputFiles[0]!.text
})
async function serve(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
}
const setup = `async(fault)=>{
  window.secret=new Uint8Array(32).fill(23);window.roomId=Ordinary.deriveRoom(secret).roomId
  window.identity=Ordinary.localIdentity(Ordinary.generateSecretKey());window.account=identity.pubkey
  window.deviceSk=Ordinary.generateSecretKey();window.seal=Ordinary.generateSecretKey();window.foreground=true
  window.current={account,roomId};window.owner=new Ordinary.OrdinaryStateOwner()
  window.options={owner,account,roomId,current:()=>current,live:()=>foreground}
  window.nameFor=logical=>'kithmoot.account.'+account+'.'+logical
  const issuer=fault==='wrong-account'?Ordinary.localIdentity(Ordinary.generateSecretKey()):identity
  const device=fault==='wrong-device'?Ordinary.generateSecretKey():deviceSk
  window.saved=await Ordinary.createDeviceCredential({identity:issuer,devicePubkey:Ordinary.getPublicKey(device),roomId,
    expiresAt:Math.floor(Date.now()/1000)+(fault==='expired'?-100:3600),seal:Ordinary.getPublicKey(seal)})
  window.sources=new Map([
    ['kithmoot.device.'+roomId,JSON.stringify({sk:Ordinary.bytesToHex(deviceSk),at:Math.floor(Date.now()/1000)})],
    ['kithmoot.own-credential.'+roomId,JSON.stringify(saved)],
    ['kithmoot.own-seal.'+roomId,JSON.stringify([Ordinary.bytesToHex(seal)])]
  ])
  if(fault==='device-only')sources.delete('kithmoot.own-credential.'+roomId)
  if(fault==='missing-seal')sources.delete('kithmoot.own-seal.'+roomId)
  if(fault==='secondary'){sources.set('kithmoot.credential.'+roomId,sources.get('kithmoot.own-credential.'+roomId));sources.delete('kithmoot.own-credential.'+roomId)}
  for(const [name,value]of sources)localStorage.setItem(name,value)
  // This exercises the native cross-store mechanism with fixture validation;
  // the complete production inventory/client fence is a separate open gate.
  await Ordinary.migrateOrdinaryStorage({owner,storage:localStorage,selected:name=>sources.has(name),
    validate:records=>{if(records.size!==sources.size||[...records].some(([name,value])=>sources.get(name)!==value))throw Error('fixture changed')},checkClients:async()=>{},live:()=>foreground})
  window.scope=await owner.capture('room:'+roomId,()=>foreground)
  window.raw=()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser')
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()}
  })
}`

for (const source of ['own', 'expired', 'secondary']) {
  test(`${source} signed custody proves an atomic legacy account binding without replacement keys`, async ({ browser }) => {
    const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})('${source}')`)
    expect(await page.evaluate(`(async()=>{
      await Ordinary.OrdinaryRoomDeviceState.migrateLegacyRoom(options)
      await Ordinary.OrdinaryRoomDeviceState.migrateLegacyRoom(options)
      const adapter=await Ordinary.OrdinaryRoomDeviceState.open(options),key=await adapter.loadDeviceKey()
      const row=await raw(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key)
      return [Ordinary.bytesToHex(key)===Ordinary.bytesToHex(deviceSk),localStorage.length,
        [...sources].every(([name,value])=>!image.records.has(name)&&image.records.get(nameFor(name))===value),
        image.records.get(nameFor('kithmoot.device-owner.'+roomId))===JSON.stringify({account,roomId})]
    })()`)).toEqual([true, 0, true, true]); await context.close()
  })
}

for (const fault of ['device-only', 'wrong-account', 'wrong-device', 'missing-seal', 'incomplete-cleanup', 'mixed-custody', 'undeclared-record', 'declared-missing-record', 'all-declared-records-missing']) {
  test(`${fault} holds legacy conversion without changing ciphertext or guessing ownership`, async ({ browser }) => {
    const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})('${fault}')`)
    expect(await page.evaluate(`(async()=>{
      const fault='${fault}'
      if(fault==='incomplete-cleanup')await owner.retainMigration(scope,()=>foreground,{phase:'cleaning',sources:new Map(),names:[...sources.keys()]})
      if(fault==='mixed-custody')await owner.mutate(scope,()=>foreground,store=>store.set(nameFor('kithmoot.device.'+roomId),sources.get('kithmoot.device.'+roomId)))
      if(fault==='undeclared-record')await owner.retainMigration(scope,()=>foreground,{phase:'complete',sources:new Map(),names:[...sources.keys()].filter(name=>name!=='kithmoot.own-credential.'+roomId)})
      if(fault==='declared-missing-record')await owner.mutate(scope,()=>foreground,store=>store.remove('kithmoot.own-seal.'+roomId))
      if(fault==='all-declared-records-missing')await owner.mutate(scope,()=>foreground,store=>{for(const name of sources.keys())store.remove(name)})
      const previous=(await raw()).frame
      const before=await owner.read(scope,()=>foreground,store=>[...sources.keys()].map(name=>store.get(name)))
      let answer;try{await Ordinary.OrdinaryRoomDeviceState.migrateLegacyRoom(options);answer='success'}catch(e){answer=e.name}
      return [answer,Ordinary.sameOrdinaryFrame(previous,(await raw()).frame),await owner.read(scope,()=>foreground,store=>[...sources.keys()].every((name,index)=>store.get(name)===before[index]))]
    })()`)).toEqual(['OrdinaryStateHold', true, true]); await context.close()
  })
}

test('unknown native conversion retains the exact complete rename candidate before exposing the account adapter', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})('own')`)
  await page.evaluate(`(()=>{
    const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    window.intercepted=0;window.converted=false;window.opened=false
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)d.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)})
      else d.set.call(tx,callback)}})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);IDBFactory.prototype.open=nativeOpen}
    void(window.converting=Ordinary.OrdinaryRoomDeviceState.migrateLegacyRoom(options).then(()=>converted=true))
  })()`)
  await page.waitForFunction('owner.holdingRetention')
  await page.evaluate('void(window.opening=Ordinary.OrdinaryRoomDeviceState.open(options).then(adapter=>{window.adapter=adapter;opened=true}))')
  expect(await page.evaluate('[converted,opened]')).toEqual([false, false])
  await page.evaluate('(async()=>{restore();window.intended=(await raw()).pending;owner.retryRetention()})()'); await page.evaluate('converting'); await page.evaluate('opening')
  expect(await page.evaluate('(async()=>[converted,opened,Ordinary.sameOrdinaryFrame(intended,(await raw()).frame),Ordinary.bytesToHex(await adapter.loadDeviceKey())===Ordinary.bytesToHex(deviceSk)])()')).toEqual([true, true, true, true])
  await context.close()
})

test('room ownership change during conversion preserves the exact legacy image and releases no success', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})('own')`)
  expect(await page.evaluate(`(async()=>{
    const previous=(await raw()).frame,encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt=async(...args)=>{current={account,roomId:'f'.repeat(64)};return encrypt(...args)}
    let answer;try{await Ordinary.OrdinaryRoomDeviceState.migrateLegacyRoom(options);answer='success'}catch(e){answer=e.name}
    crypto.subtle.encrypt=encrypt
    return [answer,Ordinary.sameOrdinaryFrame(previous,(await raw()).frame),await owner.read(scope,()=>foreground,store=>[...sources].every(([name,value])=>store.get(name)===value))]
  })()`)).toEqual(['OrdinaryStateHold', true, true]); await context.close()
})

test('cleanup completion is checked inside the conversion snapshot even if it changes after scope capture', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})('own')`)
  expect(await page.evaluate(`(async()=>{
    const mutate=owner.mutateMigrated.bind(owner)
    owner.mutateMigrated=async(...args)=>{
      await owner.retainMigration(scope,()=>foreground,{phase:'cleaning',sources:new Map(),names:[...sources.keys()]})
      window.changed=(await raw()).frame
      return mutate(...args)
    }
    let answer;try{await Ordinary.OrdinaryRoomDeviceState.migrateLegacyRoom(options);answer='success'}catch(e){answer=e.name}
    return [answer,Ordinary.sameOrdinaryFrame(changed,(await raw()).frame),await owner.read(scope,()=>foreground,store=>[...sources].every(([name,value])=>store.get(name)===value))]
  })()`)).toEqual(['OrdinaryStateHold', true, true]); await context.close()
})
