import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-participant.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./ordinary-participant.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })
  bundle = result.outputFiles[0]!.text
})
async function serve(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
}
const setup = `async()=>{
  window.foreground=true;window.generation=0;window.allowed=true;window.owner=new Ordinary.OrdinaryStateOwner()
  await owner.prepare(()=>foreground,new Map());window.scope=await owner.capture('@ordinary-participant',()=>foreground)
  window.options={owner,generation,currentGeneration:()=>generation,live:()=>foreground,allowCreate:()=>allowed}
  window.participant=await Ordinary.OrdinaryParticipantState.open(options)
  window.raw=()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser')
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()}
  })
}`

test('first identity is retained before return and real reload reuses the same encrypted key', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`)
  const key = await page.evaluate(`(async()=>{
    const key=await participant.key(),saved=await raw(),image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    if(image.records.get('kithmoot.participant')!==Ordinary.bytesToHex(key))throw Error('unretained identity')
    if(localStorage.length||sessionStorage.length)throw Error('plaintext identity storage')
    await participant.close();await owner.close();return Ordinary.bytesToHex(key)
  })()`)
  await page.reload(); await page.evaluate(`(${setup})()`)
  expect(await page.evaluate('(async()=>Ordinary.bytesToHex(await participant.load()))()')).toBe(key)
  await context.close()
})

test('simultaneous tabs create one participant identity under the native owner lock', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context); const a = await context.newPage(), b = await context.newPage()
  await a.goto(ORIGIN); await b.goto(ORIGIN); await a.evaluate(`(${setup})()`); await b.evaluate(`(${setup})()`)
  const keys = await Promise.all([a, b].map(page => page.evaluate('(async()=>Ordinary.bytesToHex(await participant.key()))()')))
  expect(keys[0]).toBe(keys[1]); await context.close()
})

for (const fault of ['malformed', 'zero', 'upper-case', 'secondary-legacy', 'secondary-scoped', 'creation-disallowed']) {
  test(`${fault} cannot create a replacement participant or change the encrypted image`, async ({ browser }) => {
    const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`)
    expect(await page.evaluate(`(async()=>{
      const fault='${fault}'
      if(fault==='creation-disallowed')allowed=false
      else await owner.mutate(scope,()=>foreground,store=>{
        if(fault==='secondary-legacy')store.set('kithmoot.credential.'+'a'.repeat(64),'corrupt secondary still blocks creation')
        else if(fault==='secondary-scoped')store.set('kithmoot.account.'+'b'.repeat(64)+'.kithmoot.credential.'+'a'.repeat(64),'secondary')
        else store.set('kithmoot.participant',fault==='zero'?'0'.repeat(64):fault==='upper-case'?'A'.repeat(64):'invalid')
      })
      const previous=(await raw()).frame,native=crypto.getRandomValues.bind(crypto);let entropy=0
      crypto.getRandomValues=(...args)=>{entropy++;return native(...args)}
      let answer;try{await participant.key();answer='success'}catch(e){answer=e.name}
      crypto.getRandomValues=native
      return [answer,entropy,Ordinary.sameOrdinaryFrame(previous,(await raw()).frame)]
    })()`)).toEqual(['OrdinaryStateHold', 0, true]); await context.close()
  })
}

test('unknown creation retains one exact key candidate before any identity result or later operation', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`)
  await page.evaluate(`(()=>{
    const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    window.intercepted=0;window.returned=false;window.later=false
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)d.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)})
      else d.set.call(tx,callback)}})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);IDBFactory.prototype.open=nativeOpen}
    void(window.creating=participant.key().then(key=>{window.first=key;returned=true}))
  })()`)
  await page.waitForFunction('owner.holdingRetention'); await page.evaluate('void(window.loading=participant.load().then(key=>{window.second=key;later=true}))')
  expect(await page.evaluate('[returned,later]')).toEqual([false, false])
  await page.evaluate('(async()=>{restore();window.intended=(await raw()).pending;owner.retryRetention()})()')
  await page.evaluate('creating'); await page.evaluate('loading')
  expect(await page.evaluate('(async()=>[returned,later,Ordinary.bytesToHex(first)===Ordinary.bytesToHex(second),Ordinary.sameOrdinaryFrame(intended,(await raw()).frame)])()')).toEqual([true, true, true, true])
  await context.close()
})

for (const invalidation of ['generation', 'creation-permission', 'close']) {
  test(`${invalidation} during creation suppresses the identity, wipes its actual buffer and preserves prior ciphertext`, async ({ browser }) => {
    const context = await browser.newContext(); await serve(context); const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`)
    await page.evaluate(`(async()=>{
      window.previous=(await raw()).frame;window.encrypting=false;window.answer='pending';window.closedReceipt=false
      const NativeBytes=Uint8Array;window.allocated=[]
      const capture=bytes=>{if(bytes.length===32)allocated.push(bytes);return bytes}
      window.restoreBytes=()=>{window.Uint8Array=NativeBytes}
      window.Uint8Array=new Proxy(NativeBytes,{
        construct(target,args){return capture(Reflect.construct(target,args,target))},
        get(target,name,receiver){if(name==='fromHex'&&typeof target.fromHex==='function')return(...args)=>capture(Reflect.apply(target.fromHex,target,args));return Reflect.get(target,name,receiver)}
      })
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),gate=new Promise(resolve=>window.releaseEncrypt=resolve)
      crypto.subtle.encrypt=async(...args)=>{
        const encoded=JSON.parse(new TextDecoder().decode(args[2]))[6].find(pair=>pair[0]==='kithmoot.participant')[1]
        window.created=allocated.filter(bytes=>Ordinary.bytesToHex(bytes)===encoded);restoreBytes()
        encrypting=true;await gate;return encrypt(...args)
      }
      void(window.creating=participant.key().then(()=>answer='success',e=>answer=e.name))
    })()`)
    await page.waitForFunction('encrypting'); expect(await page.evaluate('created.length')).toBeGreaterThan(0)
    if (invalidation === 'generation') await page.evaluate('generation++')
    else if (invalidation === 'creation-permission') await page.evaluate('allowed=false')
    else { await page.evaluate('void(participant.close().then(()=>closedReceipt=true))'); expect(await page.evaluate('closedReceipt')).toBe(false) }
    await page.evaluate('releaseEncrypt()'); await page.evaluate('creating')
    if (invalidation === 'close') await page.waitForFunction('closedReceipt')
    expect(await page.evaluate('(async()=>[answer,created.every(bytes=>bytes.every(byte=>byte===0)),Ordinary.sameOrdinaryFrame(previous,(await raw()).frame)])()')).toEqual(['OrdinaryStateHold', true, true])
    await context.close()
  })
}
