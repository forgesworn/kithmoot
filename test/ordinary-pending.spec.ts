import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary-pending.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-pending.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
async function serve(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
}
const setup = `async () => {
  window.foreground=true;window.roomId='a'.repeat(64)
  window.key=new Uint8Array(32);key[31]=1;window.account=Ordinary.getPublicKey(key)
  window.current={account,roomId};window.guard=()=>foreground
  const complete={phase:'complete',sources:new Map(),names:[]}
  window.owner=new Ordinary.OrdinaryStateOwner()
  window.tab=new Ordinary.OrdinaryStateOwner('tab:'+'b'.repeat(64),Date.now()+60000)
  await owner.prepare(guard,new Map(),complete);await tab.prepare(guard,new Map(),complete)
  window.options={browser:owner,tab,account,roomId,current:()=>current,live:guard,checkClients:async()=>{},stop:()=>{void window.queue?.close()},
    accepts:row=>row.event.tags.some(tag=>tag[0]==='d'&&tag[1]===roomId)&&row.event.tags.some(tag=>tag[0]==='p'&&tag[1]===account)&&row.event.content===row.id}
  window.storage=await Ordinary.OrdinaryPendingState.open(options)
  window.input=(id,durable=true)=>({id,roomId,channel:'Chat',text:'text '+id,files:[],durable,
    event:Ordinary.finalizeEvent({kind:1,created_at:1,tags:[['d',roomId],['p',account]],content:id},key)})
  window.raw=purpose=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get(purpose)
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()
    }
  })
  window.records=async()=>{
    const browser=await raw('browser'),temporary=await raw(tab.purpose)
    return [(await Ordinary.openOrdinaryFrame(browser.frame,browser.key)).records,(await Ordinary.openOrdinaryFrame(temporary.frame,temporary.key)).records]
  }
  window.queue=new Ordinary.PendingSends({storage,connected:()=>false,schedule:()=>{}})
}`

async function open(context: BrowserContext) { await serve(context); const page=await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`); return page }

test('actual pending queue retains durable and temporary signed sends under separate opaque encrypted owners', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await queue.add(input('durable'));await queue.add(input('temporary',false))
    const [durable,temporary]=await records(),name='kithmoot.account.'+account+'.kithmoot.pending.'+roomId
    const a=await raw('browser'),b=await raw(tab.purpose)
    return [JSON.parse(durable.get(name)).map(row=>row.id),JSON.parse(temporary.get(name)).map(row=>row.id),
      Object.keys(localStorage),Object.keys(sessionStorage),a.key.extractable,b.key.extractable,
      [a,b].some(row=>new TextDecoder().decode(row.frame.ciphertext).includes(account))]
  })()`)).toEqual([['durable'],['temporary'],[],[],false,false,false])
  await page.evaluate('queue.release(roomId)')
  expect(await page.evaluate('queue.restore(roomId).then(rows=>rows.map(row=>[row.id,row.durable]))')).toEqual([['durable',true],['temporary',false]])
  await context.close()
})

test('a stale adapter cannot overwrite a newer full pending image or merge it implicitly', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const other=await Ordinary.OrdinaryPendingState.open(options)
    const second=new Ordinary.PendingSends({storage:other,connected:()=>false,schedule:()=>{}})
    await queue.add(input('first'))
    let refusal;try{await second.add(input('second'))}catch(error){refusal=error.name}
    let recovery;try{await other.load(roomId)}catch(error){recovery=error.name}
    const [saved]=await records()
    return [refusal,recovery,second.items().length,JSON.parse([...saved.values()][0]).map(row=>row.id)]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,['first']])
  await context.close()
})

test('changing the account in the same room holds the captured queue without publishing or writing', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const before=(await raw('browser')).frame
    current={account:'c'.repeat(64),roomId};let published=0,refusal
    try{await queue.add({...input('wrong-account'),publish:async()=>published++})}catch(error){refusal=error.name}
    return [refusal,published,queue.items().length,Ordinary.sameOrdinaryFrame(before,(await raw('browser')).frame)]
  })()`)).toEqual(['OrdinaryStateHold',0,0,true])
  await context.close()
})

test('cross-owner changes are refused before any native candidate is created', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const before=[(await raw('browser')).frame,(await raw(tab.purpose)).frame]
    const row=id=>{const value=input(id);return JSON.stringify([{id,channel:value.channel,text:value.text,files:value.files,event:value.event,state:'waiting'}])}
    let refusal;try{await storage.retain(roomId,row('durable'),row('temporary'))}catch(error){refusal=error.name}
    return [refusal,Ordinary.sameOrdinaryFrame(before[0],(await raw('browser')).frame),Ordinary.sameOrdinaryFrame(before[1],(await raw(tab.purpose)).frame)]
  })()`)).toEqual(['OrdinaryStateHold',true,true])
  await context.close()
})

test('mixed arrivals acknowledge each partition separately, and preserve the second row if that partition holds', async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await queue.add(input('durable'));await queue.add(input('temporary',false))
    const real=storage.retain.bind(storage)
    storage.retain=async(room,durable,transient)=>{
      if(durable===null&&transient===null)throw new Ordinary.OrdinaryStateHold()
      await real(room,durable,transient)
    }
    let refusal;try{await queue.arrived(['durable','temporary'])}catch(error){refusal=error.name}
    const [a,b]=await records()
    return [refusal,queue.items().map(row=>row.id),a.size,JSON.parse([...b.values()][0]).map(row=>row.id)]
  })()`)).toEqual(['OrdinaryStateHold',['temporary'],0,['temporary']])
  await context.close()
})

for (const purpose of ['browser','tab'] as const) test(`unknown ${purpose} receipt holds the actual queue and publisher until the same frozen native frame is acknowledged`, async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context),other=await context.newPage();await other.goto(ORIGIN)
  await page.evaluate(`(() => {
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open,nativeEncrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    window.encryptions=0;window.receipt='pending';window.published=0;window.intercepted=0
    let writes=0;window.sendGate=new Promise(resolve=>window.releaseSend=resolve)
    window.queue=new Ordinary.PendingSends({storage:{load:room=>storage.load(room),retain:async(...args)=>{if(++writes===2)await sendGate;await storage.retain(...args)}},connected:()=>true,schedule:()=>{}})
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return nativeEncrypt(...args)}
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){
      const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)descriptor.set.call(tx,event=>{
        IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)
      });else descriptor.set.call(tx,callback)
    }})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen;crypto.subtle.encrypt=nativeEncrypt}
    window.pending=queue.add({...input('held',${purpose==='browser'}),publish:async()=>published++}).then(()=>receipt='success',error=>receipt=error.name)
  })()`)
  await page.waitForFunction(purpose==='browser'?'owner.holdingRetention':'tab.holdingRetention')
  expect(await other.evaluate('navigator.locks.request("kithmoot-ordinary-state-v1:pending",{ifAvailable:true},lock=>!!lock)')).toBe(false)
  expect(await page.evaluate('[receipt,published,queue.items().length,encryptions]')).toEqual(['pending',0,0,1])
  await page.evaluate(`(async()=>{restore();window.intended=structuredClone((await raw(${purpose==='browser'?"'browser'":"tab.purpose"})).pending)})()`)
  await page.evaluate(`${purpose==='browser'?'owner':'tab'}.retryRetention()`);await page.evaluate('pending')
  expect(await page.evaluate(`(async()=>[receipt,published,queue.items().length,encryptions,Ordinary.sameOrdinaryFrame(intended,(await raw(${purpose==='browser'?"'browser'":"tab.purpose"})).frame)])()`)).toEqual(['success',0,1,1,true])
  await page.evaluate('releaseSend()');await page.waitForFunction('published===1 && queue.items()[0]?.acknowledged')
  expect(await page.evaluate('published')).toBe(1)
  await context.close()
})

for(const corruption of ['signature','binding'] as const)test(`authenticated ${corruption} failures hold restore without generating replacement state`, async ({ browser }) => {
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const scope=await owner.capture('room:'+roomId,guard),value=input('bad')
    if('${corruption}'==='signature')value.event.sig='00'.repeat(64)
    else value.id='wrong-inner-message'
    await owner.mutateMigrated(scope,guard,store=>store.set('kithmoot.account.'+account+'.kithmoot.pending.'+roomId,JSON.stringify([{id:value.id,channel:'Chat',text:'bad',files:[],event:value.event,state:'waiting'}])))
    const before=(await raw('browser')).frame;let refusal
    try{await queue.restore(roomId)}catch(error){refusal=error.name}
    return [refusal,queue.items().length,Ordinary.sameOrdinaryFrame(before,(await raw('browser')).frame)]
  })()`)).toEqual(['OrdinaryStateHold',0,true])
  await context.close()
})

for(const phase of ['sealed','cleaning'] as const)test(`incomplete ${phase} migration is checked in the authenticated read that supplies pending records`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const scope=await owner.capture('@migration',guard)
    await owner.retainMigration(scope,guard,{phase:'${phase}',sources:new Map(),names:[]})
    const before=(await raw('browser')).frame;let refusal
    try{await storage.load(roomId)}catch(error){refusal=error.name}
    return [refusal,Ordinary.sameOrdinaryFrame(before,(await raw('browser')).frame)]
  })()`)).toEqual(['OrdinaryStateHold',true])
  await context.close()
})

test('the room tombstone blocks old adapter scopes from repopulating either native owner',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await queue.add(input('first'))
    const scope=await owner.capture('room:'+roomId,guard)
    await owner.forget(scope,guard,name=>name.includes('kithmoot.pending.'))
    const before=(await raw('browser')).frame;let refusal
    try{await queue.add(input('stale'))}catch(error){refusal=error.name}
    return [refusal,Ordinary.sameOrdinaryFrame(before,(await raw('browser')).frame)]
  })()`)).toEqual(['OrdinaryStateHold',true])
  await context.close()
})

test('a no-op validates the other authenticated owner and holds an unexpected temporary send',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const scope=await tab.capture('room:'+roomId,guard),value=input('foreign',false)
    await tab.mutateMigrated(scope,guard,store=>store.set('kithmoot.account.'+account+'.kithmoot.pending.'+roomId,JSON.stringify([{id:value.id,channel:'Chat',text:'foreign',files:[],event:value.event,state:'waiting'}])))
    const before=[(await raw('browser')).frame,(await raw(tab.purpose)).frame];let refusal
    try{await storage.retain(roomId,null,null)}catch(error){refusal=error.name}
    return [refusal,Ordinary.sameOrdinaryFrame(before[0],(await raw('browser')).frame),Ordinary.sameOrdinaryFrame(before[1],(await raw(tab.purpose)).frame)]
  })()`)).toEqual(['OrdinaryStateHold',true,true])
  await context.close()
})

test('the immutable captured account namespaces a new adapter in the same room separately',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await queue.add(input('original'))
    const oldAccount=account;current={account:'c'.repeat(64),roomId}
    const other=await Ordinary.OrdinaryPendingState.open({...options,account:current.account})
    const fresh=await other.load(roomId),[image]=await records()
    let refusal;try{await storage.load(roomId)}catch(error){refusal=error.name}
    return [fresh,refusal,image.has('kithmoot.account.'+oldAccount+'.kithmoot.pending.'+roomId),image.has('kithmoot.account.'+current.account+'.kithmoot.pending.'+roomId)]
  })()`)).toEqual([{durable:null,transient:null},'OrdinaryStateHold',true,false])
  await context.close()
})

test('concurrent stale adapters cannot independently write opposite partitions from the same old pair',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    let second
    const other=await Ordinary.OrdinaryPendingState.open({...options,stop:()=>{void second?.close()}})
    second=new Ordinary.PendingSends({storage:other,connected:()=>false,schedule:()=>{}})
    const results=await Promise.allSettled([queue.add(input('durable')),second.add(input('temporary',false))])
    const [a,b]=await records()
    return [results.map(result=>result.status).sort(),[...a.values(),...b.values()].flatMap(raw=>JSON.parse(raw)).map(row=>row.id)]
  })()`)).toEqual([['fulfilled','rejected'],['durable']])
  await context.close()
})

test('a post-commit client-fence failure preserves committed bytes and synchronously revokes the queue without publication',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await queue.close();await storage.close()
    let checks=0,published=0,revoked=0,refusal
    storage=await Ordinary.OrdinaryPendingState.open({...options,checkClients:async()=>{if(++checks===4)throw new Ordinary.OrdinaryStateHold()},stop:()=>{revoked++;void queue?.close()}})
    queue=new Ordinary.PendingSends({storage,connected:()=>true,schedule:()=>{}})
    try{await queue.add({...input('committed'),publish:async()=>published++})}catch(error){refusal=error.name}
    let recovery;try{await storage.load(roomId)}catch(error){recovery=error.name}
    const [a]=await records()
    return [refusal,recovery,published,queue.items().length,revoked,JSON.parse([...a.values()][0]).map(row=>row.id)]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',0,0,1,['committed']])
  await context.close()
})

test('a throwing authenticated binding validator cannot modify either encrypted image',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await queue.close();await storage.close()
    storage=await Ordinary.OrdinaryPendingState.open({...options,accepts:()=>{throw new Error('binding failed')}})
    queue=new Ordinary.PendingSends({storage,connected:()=>true,schedule:()=>{}})
    const before=[(await raw('browser')).frame,(await raw(tab.purpose)).frame];let refusal,published=0
    try{await queue.add({...input('bad'),publish:async()=>published++})}catch(error){refusal=error.message}
    return [refusal,published,queue.items().length,Ordinary.sameOrdinaryFrame(before[0],(await raw('browser')).frame),Ordinary.sameOrdinaryFrame(before[1],(await raw(tab.purpose)).frame)]
  })()`)).toEqual(['binding failed',0,0,true,true])
  await context.close()
})

test('closing while queued for the outer lock revokes immediately and creates no native candidate',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(() => {
    window.blocked=new Promise(resolve=>window.blockedReady=resolve)
    window.lockWork=navigator.locks.request('kithmoot-ordinary-state-v1:pending',async()=>{
      blockedReady();await new Promise(resolve=>window.releaseLock=resolve)
    })
  })()`)
  await page.evaluate('blocked')
  await page.evaluate(`(() => {
    window.published=0;window.receipt='pending'
    window.pending=queue.add({...input('closed'),publish:async()=>published++}).then(()=>receipt='success',error=>receipt=error.name)
  })()`)
  await page.waitForFunction(async()=> (await navigator.locks.query()).pending.some(lock=>lock.name==='kithmoot-ordinary-state-v1:pending'))
  await page.evaluate('void(window.closing=storage.close())')
  expect(await page.evaluate('[published,queue.items().length]')).toEqual([0,0])
  await page.evaluate('releaseLock()');await page.evaluate('Promise.all([pending,closing,lockWork])')
  expect(await page.evaluate(`(async()=>[receipt,published,...(await records()).map(image=>image.size)])()`)).toEqual(['OrdinaryStateHold',0,0,0])
  await context.close()
})

for(const purpose of ['browser','tab'] as const)test(`close during unknown ${purpose} custody revokes immediately, joins classification and leaves the same staged frame for restart`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(() => {
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    window.receipt='pending';window.published=0;window.intercepted=0
    queue=new Ordinary.PendingSends({storage,connected:()=>true,schedule:()=>{}})
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){
      const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)descriptor.set.call(tx,event=>{
        IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)
      });else descriptor.set.call(tx,callback)
    }})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen}
    window.pending=queue.add({...input('closed-unknown',${purpose==='browser'}),publish:async()=>published++}).then(()=>receipt='success',error=>receipt=error.name)
  })()`)
  await page.waitForFunction(purpose==='browser'?'owner.holdingRetention':'tab.holdingRetention')
  await page.evaluate('window.joined=false;void(window.closing=storage.close().then(()=>joined=true))')
  expect(await page.evaluate('[published,queue.items().length,joined]')).toEqual([0,0,false])
  await page.evaluate(`(async()=>{restore();window.intended=structuredClone((await raw(${purpose==='browser'?"'browser'":"tab.purpose"})).pending)})()`)
  await page.evaluate(`${purpose==='browser'?'owner':'tab'}.retryRetention()`);await page.evaluate('Promise.all([pending,closing])')
  expect(await page.evaluate(`(async()=>[receipt,published,joined,Ordinary.sameOrdinaryFrame(intended,(await raw(${purpose==='browser'?"'browser'":"tab.purpose"})).pending)])()`)).toEqual(['OrdinaryStateHold',0,true,true])
  expect(await page.evaluate(`(async()=>{
    const recovering=${purpose==='browser'?"new Ordinary.OrdinaryStateOwner()":"new Ordinary.OrdinaryStateOwner(tab.purpose,tab.expiresAt)"}
    await recovering.prepare(guard,new Map())
    const next=await Ordinary.OrdinaryPendingState.open({...options,${purpose==='browser'?'browser':'tab'}:recovering,stop:()=>{}})
    const saved=await next.load(roomId)
    return [JSON.parse(saved.${purpose==='browser'?'durable':'transient'})[0].id,Ordinary.sameOrdinaryFrame(intended,(await raw(${purpose==='browser'?"'browser'":"tab.purpose"})).frame)]
  })()`)).toEqual(['closed-unknown',true])
  await context.close()
})
