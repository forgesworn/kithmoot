import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-tab.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./ordinary-state.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })
  bundle = result.outputFiles[0]!.text
})
async function serve(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
}
const setup = `async () => {
  window.foreground=true; window.stopped=0
  window.lifetime=new Ordinary.OrdinaryTabLifetime({storage:sessionStorage,live:()=>foreground,stop:()=>stopped++})
  await lifetime.prepare()
  window.owner=lifetime.owner
  await owner.prepare(()=>lifetime.live,new Map())
  window.scope=await owner.capture('temporary',()=>lifetime.live)
  window.rows=()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
    r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners')
      const keys=s.getAllKeys(),values=s.getAll();tx.oncomplete=()=>{db.close();resolve(keys.result.map((key,i)=>[key,values.result[i]]))};tx.onabort=()=>{db.close();reject(tx.error)}}
  })
  window.saveRow=(key,value)=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
    r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners');
      if(value===undefined)s.delete(key);else s.put(value,key);tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}
  })
}`

test('temporary ciphertext survives a real reload with the same marker and fixed expiry', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  const before=await page.evaluate<{marker:string;expiresAt:number;session:string[];local:string[];extractable:boolean}>(`(async()=>{
    await owner.mutate(scope,()=>lifetime.live,s=>s.set('device-secret','exact'))
    const saved=(await rows())[0][1]
    return {marker:sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER),expiresAt:lifetime.expiresAt,
      session:Object.keys(sessionStorage),local:Object.keys(localStorage),extractable:saved.key.extractable}
  })()`)
  expect(before).toMatchObject({session:['kithmoot.ordinary-tab.v1'],local:[],extractable:false})
  expect(before.marker).toMatch(/^[0-9a-f]{64}$/)
  await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>[sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER),lifetime.expiresAt,
    await owner.read(scope,()=>lifetime.live,s=>s.get('device-secret'))])()`)).toEqual([before.marker,before.expiresAt,'exact'])
  await context.close()
})

test('an actual second window with a cloned live marker holds without another key or marker', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN);await a.evaluate(`(${setup})()`)
  const marker=await a.evaluate<string>('sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)')
  await b.evaluate(marker=>sessionStorage.setItem('kithmoot.ordinary-tab.v1',marker!),marker)
  expect(await b.evaluate(`(async()=>{
    const generate=crypto.subtle.generateKey.bind(crypto.subtle);let generated=0
    crypto.subtle.generateKey=async(...args)=>{generated++;return generate(...args)}
    let answer;try{await Ordinary.OrdinaryTabLifetime.open({storage:sessionStorage,live:()=>true,stop:()=>{}});answer='success'}catch(e){answer=e.name}
    return [answer,generated,sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)]
  })()`)).toEqual(['OrdinaryStateHold',0,marker])
  expect(await a.evaluate('lifetime.live')).toBe(true)
  await context.close()
})

test('a missing marker starts a separate empty namespace and cannot recover the orphan tab', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN);await a.evaluate(`(${setup})()`)
  await a.evaluate(`owner.mutate(scope,()=>lifetime.live,s=>s.set('orphan-secret','keep'))`)
  const marker=await a.evaluate<string>('sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)')
  await a.close();await b.evaluate(`(${setup})()`)
  const receipt=await b.evaluate<[string,string|null,number]>(`(async()=>[sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER),
    await owner.read(scope,()=>lifetime.live,s=>s.get('orphan-secret')),(await rows()).length])()`)
  expect(receipt[0]).not.toBe(marker);expect(receipt.slice(1)).toEqual([null,2]);await context.close()
})

for (const fault of ['missing-custody','invalid-marker'] as const) {
  test(`${fault} holds without replacing the marker or generating another key`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context)
    const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
    expect(await page.evaluate(`(async()=>{
      await lifetime.close()
      if('${fault}'==='missing-custody')await saveRow(owner.purpose,undefined)
      else sessionStorage.setItem(Ordinary.ORDINARY_TAB_MARKER,'device-secret-is-not-a-marker')
      const marker=sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)
      const generate=crypto.subtle.generateKey.bind(crypto.subtle);let generated=0
      crypto.subtle.generateKey=async(...args)=>{generated++;return generate(...args)}
      const failed=new Ordinary.OrdinaryTabLifetime({storage:sessionStorage,live:()=>true,stop:()=>{}})
      let answer;try{await failed.prepare();answer='success'}catch(e){answer=e.name}
      const released=await navigator.locks.request('kithmoot-ordinary-state-v1:lifetime:'+marker,{ifAvailable:true},lock=>!!lock)
      return [answer,generated,sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)===marker,released]
    })()`)).toEqual(['OrdinaryStateHold',0,true,true]);await context.close()
  })
}

test('expiry revokes writes and promotes the exact pending intent before deleting expired custody', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    const saved=(await rows())[0][1],image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    image.revision++;image.records.set('pending-secret','exact')
    const pending=await Ordinary.sealOrdinaryImage(image,saved.key)
    await saveRow(owner.purpose,{...saved,pending})
    const expiry=lifetime.expiresAt;Date.now=()=>expiry+1
    let write;try{await owner.mutate(scope,()=>lifetime.live,s=>s.set('late','no'));write='success'}catch(e){write=e.name}
    const wasLive=lifetime.live;await lifetime.close()
    const nativePut=IDBObjectStore.prototype.put,nativeDelete=IDBObjectStore.prototype.delete,steps=[]
    IDBObjectStore.prototype.put=function(value,key){steps.push(['promote',Ordinary.sameOrdinaryFrame(value.frame,pending),Object.hasOwn(value,'pending')]);return nativePut.call(this,value,key)}
    IDBObjectStore.prototype.delete=function(key){steps.push(['delete',key===owner.purpose]);return nativeDelete.call(this,key)}
    let answer;try{await Ordinary.OrdinaryTabLifetime.open({storage:sessionStorage,live:()=>true,stop:()=>{}});answer='success'}catch(e){answer=e.name}
    return [write,wasLive,answer,steps,(await rows()).length,Object.keys(sessionStorage)]
  })()`)).toEqual(['OrdinaryStateHold',false,'OrdinaryStateHold',[['promote',true,false],['delete',true]],0,['kithmoot.ordinary-tab.v1']])
  await context.close()
})

test('corrupt expired custody holds and preserves its row instead of using expiry as absence', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    const saved=(await rows())[0][1];new Uint8Array(saved.frame.ciphertext)[0]^=1
    await saveRow(owner.purpose,saved);const expiry=lifetime.expiresAt;Date.now=()=>expiry+1;await lifetime.close()
    let answer;try{await Ordinary.OrdinaryTabLifetime.open({storage:sessionStorage,live:()=>true,stop:()=>{}});answer='success'}catch(e){answer=e.name}
    return [answer,(await rows()).length,Ordinary.sameOrdinaryFrame((await rows())[0][1].frame,saved.frame)]
  })()`)).toEqual(['OrdinaryStateHold',1,true]);await context.close()
})

test('capacity holds without evicting live or orphan custody or generating a new key', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    const first=(await rows())[0][1],expiry=lifetime.expiresAt
    for(let i=1;i<Ordinary.MAX_ORDINARY_TAB_OWNERS;i++){
      const id=i.toString(16).padStart(64,'0'),purpose='tab:'+id
      const image={purpose,keyId:id,generation:id,revision:0,expiresAt:expiry,records:new Map([['secret','keep']]),fences:new Map()}
      await saveRow(purpose,{key:first.key,frame:await Ordinary.sealOrdinaryImage(image,first.key)})
    }
    await lifetime.close();sessionStorage.removeItem(Ordinary.ORDINARY_TAB_MARKER)
    const generate=crypto.subtle.generateKey.bind(crypto.subtle);let generated=0
    crypto.subtle.generateKey=async(...args)=>{generated++;return generate(...args)}
    const next=await Ordinary.OrdinaryTabLifetime.open({storage:sessionStorage,live:()=>true,stop:()=>{}})
    let answer;try{await next.owner.prepare(()=>next.live,new Map());answer='success'}catch(e){answer=e.name}
    await next.close();return [answer,generated,(await rows()).length,Ordinary.sameOrdinaryFrame((await rows()).find(x=>x[0]===owner.purpose)[1].frame,first.frame)]
  })()`)).toEqual(['OrdinaryStateHold',0,64,true]);await context.close()
})

test('closing revokes effects while an unknown write keeps the lifetime lock until exact recovery', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN);await a.evaluate(`(${setup})()`)
  const marker=await a.evaluate<string>('sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)')
  await a.evaluate(`(()=>{
    const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    window.intercepted=0;window.receipt='pending';window.closedReceipt=false
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)d.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)})
      else d.set.call(tx,callback)}})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);IDBFactory.prototype.open=nativeOpen}
    window.pending=owner.mutate(scope,()=>lifetime.live,s=>s.set('unknown','exact')).then(()=>receipt='success',e=>receipt=e.name)
  })()`)
  await a.waitForFunction('lifetime.holdingRetention')
  await a.evaluate('void(lifetime.close().then(()=>closedReceipt=true))')
  expect(await a.evaluate('[lifetime.live,stopped,closedReceipt,receipt]')).toEqual([false,1,false,'pending'])
  expect(await b.evaluate(marker=>navigator.locks.request('kithmoot-ordinary-state-v1:lifetime:'+marker,{ifAvailable:true},lock=>!!lock),marker)).toBe(false)
  await a.evaluate('restore();lifetime.retryRetention()');await a.waitForFunction('closedReceipt')
  expect(await a.evaluate('receipt')).toBe('OrdinaryStateHold')
  expect(await b.evaluate(marker=>navigator.locks.request('kithmoot-ordinary-state-v1:lifetime:'+marker,{ifAvailable:true},lock=>!!lock),marker)).toBe(true)
  await context.close()
})

for (const phase of ['promotion','deletion'] as const) {
  test(`an unknown expired ${phase} receipt holds the exact intent and locks until manual recovery`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context)
    const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN);await a.evaluate(`(${setup})()`)
    const marker=await a.evaluate<string>('sessionStorage.getItem(Ordinary.ORDINARY_TAB_MARKER)')
    await a.evaluate(`(async()=>{
      const saved=(await rows())[0][1],image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
      image.revision++;image.records.set('pending-secret','exact')
      window.intended=await Ordinary.sealOrdinaryImage(image,saved.key)
      await saveRow(owner.purpose,{...saved,pending:intended})
      const expiry=lifetime.expiresAt;Date.now=()=>expiry+1;await lifetime.close()
      const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
      window.writes=0;window.encryptions=0;window.answer='pending';window.cleanSteps=[]
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),put=IDBObjectStore.prototype.put,del=IDBObjectStore.prototype.delete
      crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)}
      IDBObjectStore.prototype.put=function(value,key){cleanSteps.push(['promote',Ordinary.sameOrdinaryFrame(value.frame,intended)]);return put.call(this,value,key)}
      IDBObjectStore.prototype.delete=function(key){cleanSteps.push(['delete',key===owner.purpose]);return del.call(this,key)}
      Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){const tx=this
        if(tx.mode==='readwrite'&&++writes===('${phase}'==='promotion'?1:2))d.set.call(tx,event=>{
          IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)
        });else d.set.call(tx,callback)}})
      window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);IDBFactory.prototype.open=nativeOpen}
      window.next=new Ordinary.OrdinaryTabLifetime({storage:sessionStorage,live:()=>true,stop:()=>{}})
      void(window.cleaning=next.prepare().then(()=>answer='success',e=>answer=e.name))
    })()`)
    await a.waitForFunction('next.holdingRetention')
    expect(await b.evaluate('navigator.locks.request("kithmoot-ordinary-state-v1:write",{ifAvailable:true},lock=>!!lock)')).toBe(false)
    expect(await b.evaluate(marker=>navigator.locks.request('kithmoot-ordinary-state-v1:lifetime:'+marker,{ifAvailable:true},lock=>!!lock),marker)).toBe(false)
    expect(await a.evaluate('[answer,encryptions]')).toEqual(['pending',0])
    await a.evaluate('restore();next.retryRetention()');await a.evaluate('cleaning');await a.evaluate('next.close()')
    expect(await a.evaluate('(async()=>[answer,encryptions,cleanSteps,(await rows()).length])()')).toEqual([
      'OrdinaryStateHold',0,[['promote',true],['delete',true]],0,
    ])
    await context.close()
  })
}

test('page lifecycle closure stops effects and allows the same retained namespace to resume', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    await owner.mutate(scope,()=>lifetime.live,s=>s.set('secret','retained'))
    window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))
    const before=[lifetime.live,stopped];await lifetime.close()
    const next=await Ordinary.OrdinaryTabLifetime.open({storage:sessionStorage,live:()=>true,stop:()=>{}})
    await next.owner.prepare(()=>next.live,new Map())
    const restoredScope=await next.owner.capture('temporary',()=>next.live)
    const value=await next.owner.read(restoredScope,()=>next.live,s=>s.get('secret'))
    await next.close();return [...before,value]
  })()`)).toEqual([false,1,'retained']);await context.close()
})
