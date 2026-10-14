import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Native origin-local custody tests. These records are fixtures, not signed
// invitations, membership authority, or production startup acceptance.
const ORIGIN = 'https://ordinary-pair.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./ordinary-state.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })
  bundle = result.outputFiles[0]!.text
})
const setup = `async () => {
  window.live = true; window.guard = () => live
  window.tabPurpose = 'tab:'+'a'.repeat(64)
  window.rawBoth = () => new Promise((resolve,reject) => {
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
    r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners')
      const b=s.get('browser'),t=s.get(tabPurpose)
      tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};tx.onabort=()=>{db.close();reject(tx.error)}}
  })
  window.editBoth = work => new Promise((resolve,reject) => {
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
    r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners')
      const b=s.get('browser'),t=s.get(tabPurpose)
      t.onsuccess=()=>work([b.result,t.result],s)
      tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}
  })
  window.browserOwner = new Ordinary.OrdinaryStateOwner()
  window.tabOwner = new Ordinary.OrdinaryStateOwner(tabPurpose,Date.UTC(2030,0,1))
  const migration={phase:'complete',sources:new Map(),names:['legacy.fixture']}
  await browserOwner.prepare(guard,new Map([['old','browser']]),migration)
  await tabOwner.prepare(guard,new Map([['old','tab']]),migration)
  window.browserScope=await browserOwner.capture('room',guard)
  window.tabScope=await tabOwner.capture('room',guard)
  window.pair = (work=(b,t)=>{b.set('proof','operation-1');t.set('admission','operation-1');return 'ack'}) =>
    Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:browserScope},
      tab:{owner:tabOwner,scope:tabScope},live:guard,work})
  window.values = async () => {
    const rows=await rawBoth(),images=await Promise.all(rows.map(r=>Ordinary.openOrdinaryFrame(r.frame,r.key)))
    return [images[0].records.get('proof')??null,images[1].records.get('admission')??null]
  }
  window.outcome = async work => {try{return await work()}catch(e){return e.name}}
}`
test.beforeEach(async ({ context, page }) => {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN); await page.evaluate(`(${setup})()`)
})

test('paired read authenticates one coherent final readonly transaction without encrypting or allowing escaped views', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
    await pair();const transactions=[],get=IDBObjectStore.prototype.get,encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let escaped
    IDBObjectStore.prototype.get=function(...args){if(this.transaction.mode==='readonly')transactions.push(this.transaction);return get.apply(this,args)}
    crypto.subtle.encrypt=async()=>{throw Error('read encrypted')}
    const value=await Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:browserScope},
      tab:{owner:tabOwner,scope:tabScope},live:guard,work:(b,t,bNames,tNames)=>{escaped=b;return [b.get('proof'),t.get('admission'),bNames,tNames]}})
    crypto.subtle.encrypt=encrypt;IDBObjectStore.prototype.get=get
    return [value,transactions.length,transactions[0]===transactions[1],transactions.at(-1)===transactions.at(-2),await outcome(()=>escaped.get('proof'))]
  })()`)).toEqual([['operation-1','operation-1',['legacy.fixture'],['legacy.fixture']],6,true,true,'OrdinaryStateHold'])
})

for (const operation of ['set','remove','thenable'] as const) {
  test(`paired read refuses ${operation} and preserves both frames`, async ({ page }) => {
    expect(await page.evaluate(`(async operation=>{
      const before=await rawBoth(),result=await outcome(()=>Ordinary.OrdinaryStateOwner.readPairMigrated({
        browser:{owner:browserOwner,scope:browserScope},tab:{owner:tabOwner,scope:tabScope},live:guard,
        work:(b,t)=>operation==='set'?b.set('changed','bad'):operation==='remove'?t.remove('old'):Promise.resolve('escaped')}))
      const after=await rawBoth();return [result,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]
    })('${operation}')`)).toEqual(['OrdinaryStateHold',true])
  })
}

test('paired forget increments both fences atomically even without records and blocks captured read/write scopes', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
    await Ordinary.OrdinaryStateOwner.forgetPairMigrated({browser:{owner:browserOwner,scope:browserScope},
      tab:{owner:tabOwner,scope:tabScope},live:guard,work:(b,t)=>{b.remove('absent');t.remove('absent')}})
    const images=await Promise.all((await rawBoth()).map(r=>Ordinary.openOrdinaryFrame(r.frame,r.key)))
    const read=await outcome(()=>Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:browserScope},
      tab:{owner:tabOwner,scope:tabScope},live:guard,work:()=> 'bad'})),write=await outcome(()=>pair())
    return [images.map(i=>i.fences.get('room')),read,write]
  })()`)).toEqual([[1,1],'OrdinaryStateHold','OrdinaryStateHold'])
})

test('an aborted paired forget changes neither image nor deletion fence', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
    const before=await rawBoth(),put=IDBObjectStore.prototype.put;let count=0
    IDBObjectStore.prototype.put=function(...args){const r=put.apply(this,args);if(++count===2)this.transaction.abort();return r}
    const result=await outcome(()=>Ordinary.OrdinaryStateOwner.forgetPairMigrated({browser:{owner:browserOwner,scope:browserScope},
      tab:{owner:tabOwner,scope:tabScope},live:guard,work:(b,t)=>{b.remove('old');t.remove('old')}}))
    IDBObjectStore.prototype.put=put;const after=await rawBoth()
    return [result,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame)),await pair()]
  })()`)).toEqual(['OrdinaryStateHold',true,'ack'])
})

test('both final images use one native transaction and survive restart without replacement keys or ciphertext', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
    const native=IDBObjectStore.prototype.put;window.transactions=[];window.rows=[]
    IDBObjectStore.prototype.put=function(value,name){transactions.push(this.transaction);rows.push(name);return native.call(this,value,name)}
    const result=await pair();IDBObjectStore.prototype.put=native
    const saved=await rawBoth();window.frozen=saved.map(r=>structuredClone(r.frame))
    return [result,transactions.length,transactions[0]===transactions[1],rows,
      saved.map(r=>!!r.pending),await values(),Object.keys(localStorage),Object.keys(sessionStorage)]
  })()`)).toEqual(['ack',2,true,['browser','tab:'+'a'.repeat(64)],[false,false],['operation-1','operation-1'],[],[]])
  const frozen = await page.evaluate(`frozen.map(f=>({revision:f.revision,nonce:[...new Uint8Array(f.nonce)],ciphertext:[...new Uint8Array(f.ciphertext)]}))`)
  await page.evaluate('Promise.all([browserOwner.close(),tabOwner.close()])'); await page.reload()
  await page.evaluate(`(()=>{crypto.subtle.encrypt=async()=>{throw Error('replacement ciphertext')};crypto.subtle.generateKey=async()=>{throw Error('replacement key')}})()`)
  await page.evaluate(`(${setup})()`)
  expect(await page.evaluate('values()')).toEqual(['operation-1','operation-1'])
  expect(await page.evaluate(`(async()=> (await rawBoth()).map(r=>({revision:r.frame.revision,nonce:[...new Uint8Array(r.frame.nonce)],ciphertext:[...new Uint8Array(r.frame.ciphertext)]})))()`)).toEqual(frozen)
})

for (const fault of ['throw-first','throw-second','abort-second'] as const) {
  test(`${fault} preserves both prior images, including when the first put was queued`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
      const prior=await rawBoth(),native=IDBObjectStore.prototype.put;let puts=0
      IDBObjectStore.prototype.put=function(...args){puts++
        if(fault==='throw-first'&&puts===1||fault==='throw-second'&&puts===2)throw new DOMException('quota','QuotaExceededError')
        const r=native.apply(this,args);if(fault==='abort-second'&&puts===2)this.transaction.abort();return r}
      const result=await outcome(()=>pair());IDBObjectStore.prototype.put=native
      const saved=await rawBoth();return [result,await values(),saved.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame))]
    })('${fault}')`)).toEqual(['OrdinaryStateHold',[null,null],true])
  })
}

test('lost acknowledgement authenticates both candidate rows without rerunning the callback or encryption', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),native=crypto.subtle.encrypt.bind(crypto.subtle)
    let intercepted=false,encryptions=0,callbacks=0,reads=0
    const transaction=IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction=function(...args){if(intercepted&&args[1]==='readonly')reads++;return transaction.apply(this,args)}
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return native(...args)}
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!intercepted){intercepted=true;descriptor.set.call(tx,e=>tx.onabort(e))}else descriptor.set.call(tx,callback)}})
    const answer=await pair((b,t)=>{callbacks++;b.set('proof','same');t.set('admission','same');return 'ack'})
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);crypto.subtle.encrypt=native;IDBDatabase.prototype.transaction=transaction
    return [answer,encryptions,callbacks,reads,await values()]
  })()`)).toEqual(['ack',2,1,1,['same','same']])
})

test('unavailable reconciliation holds one shared lock and either owner retries the exact pair', async ({ page, context }) => {
  const other=await context.newPage();await other.goto(ORIGIN)
  await page.evaluate(`(()=>{
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),open=IDBFactory.prototype.open,
      encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    window.encryptions=0;window.callbacks=0;window.receipt='pending';let once=false
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)}
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,e=>{IDBFactory.prototype.open=function(){throw Error('unavailable')};tx.onabort(e)})}
      else descriptor.set.call(tx,callback)}})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=open;crypto.subtle.encrypt=encrypt}
    window.pending=pair((b,t)=>{callbacks++;b.set('proof','frozen');t.set('admission','frozen')}).then(()=>receipt='ack',e=>receipt=e.name)
  })()`)
  await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
  expect(await other.evaluate(`navigator.locks.request('kithmoot-ordinary-state-v1:write',{ifAvailable:true},lock=>!!lock)`)).toBe(false)
  expect(await page.evaluate(`(async()=>{restore();window.intended=(await rawBoth()).map(r=>structuredClone(r.frame));return [receipt,encryptions,callbacks]})()`)).toEqual(['pending',2,1])
  await page.evaluate('tabOwner.retryRetention()');await page.evaluate('pending')
  expect(await page.evaluate(`(async()=>[receipt,encryptions,callbacks,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,intended[i])),await values()])()`)).toEqual(['ack',2,1,true,['frozen','frozen']])
})

for (const fault of ['mixed','missing','pending','wrong-key','corrupt','generation'] as const) {
  test(`uncertain ${fault} custody remains held until both exact authenticated candidates return`, async ({ page }) => {
    await page.evaluate(`(async fault=>{
      window.prior=await rawBoth();const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),open=IDBFactory.prototype.open
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);window.encryptions=0;window.callbacks=0;window.receipt='pending';let once=false
      crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)}
      Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
        if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,e=>{IDBFactory.prototype.open=function(){throw Error('offline')};tx.onabort(e)})}
        else descriptor.set.call(tx,callback)}})
      window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=open;crypto.subtle.encrypt=encrypt}
      window.pending=pair((b,t)=>{callbacks++;b.set('proof','exact');t.set('admission','exact')}).then(()=>receipt='ack',e=>receipt=e.name)
    })('${fault}')`)
    await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
    await page.evaluate(`(async fault=>{
      restore();window.candidates=await rawBoth();window.oldRetry=browserOwner.retryRetention
      const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])
      await editBoth((rows,s)=>{
        if(fault==='mixed')s.put(prior[1],tabPurpose)
        else if(fault==='missing')s.delete(tabPurpose)
        else {const r=rows[1];if(fault==='pending'){r.pending=r.frame;delete r.frame}
          else if(fault==='wrong-key')r.key=key
          else if(fault==='corrupt')new Uint8Array(r.frame.ciphertext)[0]^=1
          else r.frame.generation='f'.repeat(64);s.put(r,tabPurpose)}
      })
      window.readRounds=0;const native=IDBObjectStore.prototype.get
      IDBObjectStore.prototype.get=function(...args){if(this.transaction.mode==='readonly')readRounds++;return native.apply(this,args)}
      window.restoreGet=()=>{IDBObjectStore.prototype.get=native};browserOwner.retryRetention()
    })('${fault}')`)
    await page.waitForFunction('readRounds>=2 && browserOwner.holdingRetention && tabOwner.holdingRetention')
    expect(await page.evaluate('[receipt,encryptions,callbacks]')).toEqual(['pending',2,1])
    await page.evaluate(`(async()=>{restoreGet();await editBoth((_,s)=>{s.put(candidates[0],'browser');s.put(candidates[1],tabPurpose)});browserOwner.retryRetention()})()`)
    await page.evaluate('pending')
    expect(await page.evaluate('[receipt,encryptions,callbacks]')).toEqual(['ack',2,1])
    expect(await page.evaluate('values()')).toEqual(['exact','exact'])
  })
}

for (const owner of ['browser','tab'] as const) {
  for (const fault of ['incomplete-migration','stale-fence','stale-generation'] as const) {
    test(`${owner} ${fault} refuses before callback or ciphertext`, async ({ page }) => {
      expect(await page.evaluate(`(async([which,fault])=>{
        const o=which==='browser'?browserOwner:tabOwner,s=which==='browser'?browserScope:tabScope
        if(fault==='incomplete-migration')await o.retainMigration(s,guard,{phase:'sealed',sources:new Map(),names:[]})
        else if(fault==='stale-fence')await o.forget(s,guard,()=>false)
        else {if(which==='browser')browserScope={...s,generation:'f'.repeat(64)};else tabScope={...s,generation:'f'.repeat(64)}}
        let callbacks=0,nonces=0;const random=crypto.getRandomValues.bind(crypto)
        crypto.getRandomValues=(...args)=>{nonces++;return random(...args)}
        const answer=await outcome(()=>pair(()=>callbacks++));crypto.getRandomValues=random
        return [answer,callbacks,nonces,await values()]
      })(['${owner}','${fault}'])`)).toEqual(['OrdinaryStateHold',0,0,[null,null]])
    })
  }
}

for (const fault of ['browser-capacity','tab-capacity','callback-throws','async-callback'] as const) {
  test(`${fault} discards both helper views before any nonce or native put`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
      const random=crypto.getRandomValues.bind(crypto),put=IDBObjectStore.prototype.put;let nonces=0,puts=0
      crypto.getRandomValues=(...args)=>{nonces++;return random(...args)}
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)}
      const answer=await outcome(()=>pair((b,t)=>{window.escaped=[b,t];b.set('proof','candidate');t.set('admission','candidate')
        if(fault==='browser-capacity'||fault==='tab-capacity')(fault==='browser-capacity'?b:t).set('huge','x'.repeat(Ordinary.ORDINARY_VALUE_BYTES+1))
        else if(fault==='callback-throws')throw new Ordinary.OrdinaryStateHold()
        else return Promise.reject(new Error('not synchronous'))
      }))
      crypto.getRandomValues=random;IDBObjectStore.prototype.put=put
      const errors=escaped.map(s=>{try{s.set('bad','escape');return 'written'}catch(e){return e.name}})
      return [answer,nonces,puts,errors,await values()]
    })('${fault}')`)).toEqual(['OrdinaryStateHold',0,0,['OrdinaryStateHold','OrdinaryStateHold'],[null,null]])
  })
}

for (const cut of [1,2] as const) {
  test(`foreground loss after encryption ${cut} retains both prior images`, async ({ page }) => {
    expect(await page.evaluate(`(async()=>{
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let calls=0,puts=0;const put=IDBObjectStore.prototype.put
      crypto.subtle.encrypt=async(...args)=>{const result=await encrypt(...args);if(++calls===${cut})live=false;return result}
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)}
      const answer=await outcome(()=>pair());crypto.subtle.encrypt=encrypt;IDBObjectStore.prototype.put=put;live=true
      return [answer,calls,puts,await values()]
    })()`)).toEqual(['OrdinaryStateHold',cut,0,[null,null]])
  })
}

for (const which of ['browser','tab'] as const) {
  test(`${which} close joins uncertain pair custody and suppresses its acknowledgement`, async ({ page }) => {
    await page.evaluate(`(()=>{
      const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),open=IDBFactory.prototype.open;let once=false
      Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
        if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,e=>{IDBFactory.prototype.open=function(){throw Error('offline')};tx.onabort(e)})}
        else descriptor.set.call(tx,callback)}})
      window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=open}
      window.receipt='pending';window.pending=pair().then(()=>receipt='ack',e=>receipt=e.name)
    })()`)
    await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
    await page.evaluate(`(()=>{window.closeReceipt='pending';window.closing=${which==='browser'?'browserOwner':'tabOwner'}.close().then(()=>closeReceipt='done')})()`)
    expect(await page.evaluate('[closeReceipt,receipt]')).toEqual(['pending','pending'])
    await page.evaluate('restore();tabOwner.retryRetention()');await page.evaluate('Promise.all([pending,closing])')
    expect(await page.evaluate('[closeReceipt,receipt]')).toEqual(['done','OrdinaryStateHold'])
    expect(await page.evaluate('values()')).toEqual(['operation-1','operation-1'])
  })
}

test('a restarted page recovers both final frames after death during uncertain acknowledgement', async ({ page, context }) => {
  await page.evaluate(`(()=>{
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');let once=false
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,e=>{IDBFactory.prototype.open=function(){throw Error('offline')};tx.onabort(e)})}
      else descriptor.set.call(tx,callback)}})
    void pair()
  })()`)
  await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention');await page.close()
  const restarted=await context.newPage();await restarted.goto(ORIGIN)
  await restarted.evaluate(`(()=>{crypto.subtle.encrypt=async()=>{throw Error('must not replace candidate')};crypto.subtle.generateKey=async()=>{throw Error('must not replace key')}})()`)
  await restarted.evaluate(`(${setup})()`)
  expect(await restarted.evaluate('values()')).toEqual(['operation-1','operation-1'])
})

test('another page cannot lose either image when its pair waits for the same origin lock', async ({ page, context }) => {
  const other=await context.newPage();await other.goto(ORIGIN);await other.evaluate(`(${setup})()`)
  await Promise.all([page.evaluate(`pair((b,t)=>{b.set('one','browser-1');t.set('one','tab-1')})`),
    other.evaluate(`pair((b,t)=>{b.set('two','browser-2');t.set('two','tab-2')})`)])
  expect(await page.evaluate(`(async()=>{const rows=await rawBoth();return Promise.all(rows.map(async r=>{
    const image=await Ordinary.openOrdinaryFrame(r.frame,r.key);return [image.records.get('one'),image.records.get('two')]}))})()`)).toEqual([['browser-1','browser-2'],['tab-1','tab-2']])
})

for (const fault of ['same-owner','wrong-browser-purpose','wrong-tab-purpose','uninitialised-browser','uninitialised-tab','expired-tab'] as const) {
  test(`${fault} refuses before acquiring a write lock or running the helper`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
      const browser={owner:browserOwner,scope:browserScope},tab={owner:tabOwner,scope:tabScope}
      if(fault==='same-owner')tab.owner=browser.owner
      else if(fault==='wrong-browser-purpose')browser.owner=tabOwner
      else if(fault==='wrong-tab-purpose')tab.owner=browserOwner
      else if(fault==='uninitialised-browser')browser.owner=new Ordinary.OrdinaryStateOwner()
      else if(fault==='uninitialised-tab')tab.owner=new Ordinary.OrdinaryStateOwner(tabPurpose,Date.UTC(2030,0,1))
      const now=Date.now;if(fault==='expired-tab')Date.now=()=>Date.UTC(2030,0,1)
      const locks=navigator.locks.request.bind(navigator.locks);let requests=0,callbacks=0
      navigator.locks.request=(...args)=>{requests++;return locks(...args)}
      const answer=await outcome(()=>Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser,tab,live:guard,work:()=>callbacks++}))
      navigator.locks.request=locks;Date.now=now;return [answer,requests,callbacks,await values()]
    })('${fault}')`)).toEqual(['OrdinaryStateHold',0,0,[null,null]])
  })
}

for (const which of ['browser','tab'] as const) {
  test(`${which} prior pending intent is promoted before either new nonce or callback`, async ({ page }) => {
    expect(await page.evaluate(`(async which=>{
      const rows=await rawBoth(),i=which==='browser'?0:1
      const image=await Ordinary.openOrdinaryFrame(rows[i].frame,rows[i].key);image.revision++;image.records.set('recovered','prior-intent')
      const pending=await Ordinary.sealOrdinaryImage(image,rows[i].key)
      await editBoth((r,s)=>{r[i].pending=pending;s.put(r[i],which==='browser'?'browser':tabPurpose)})
      const put=IDBObjectStore.prototype.put,encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let order=[]
      IDBObjectStore.prototype.put=function(...args){order.push('put:'+args[1]);return put.apply(this,args)}
      crypto.subtle.encrypt=async(...args)=>{order.push('encrypt');return encrypt(...args)}
      const answer=await pair((b,t)=>{order.push('callback');if((which==='browser'?b:t).get('recovered')!=='prior-intent')throw Error('lost intent')
        b.set('proof','after');t.set('admission','after');return 'ack'})
      IDBObjectStore.prototype.put=put;crypto.subtle.encrypt=encrypt
      return [answer,order,(await rawBoth()).map(r=>!!r.pending),await values()]
    })('${which}')`)).toEqual(['ack',['put:'+(which==='browser'?'browser':'tab:'+'a'.repeat(64)),'callback','encrypt','encrypt','put:browser','put:tab:'+'a'.repeat(64)],
      [false,false],['after','after']])
  })
}

test('tab expiry after uncertain commit suppresses acknowledgement while retaining both final records', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),now=Date.now;let once=false
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this
      if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,e=>{Date.now=()=>Date.UTC(2030,0,1);tx.onabort(e)})}
      else descriptor.set.call(tx,callback)}})
    const answer=await outcome(()=>pair());Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);Date.now=now
    return [answer,await values()]
  })()`)).toEqual(['OrdinaryStateHold',['operation-1','operation-1']])
})

test('success revokes both escaped views and preserves migration manifests separately', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
    const result=await pair((b,t,bn,tn)=>{window.escaped=[b,t];b.set('proof','bound');t.set('admission','bound')
      return [bn,tn,Object.isFrozen(bn),Object.isFrozen(tn),bn===tn]})
    const refused=escaped.map(s=>{try{return s.keys()}catch(e){return e.name}})
    const rows=await rawBoth(),images=await Promise.all(rows.map(r=>Ordinary.openOrdinaryFrame(r.frame,r.key)))
    return [result,refused,images.map(i=>[i.migration.phase,i.migration.names,[...i.migration.sources]])]
  })()`)).toEqual([[['legacy.fixture'],['legacy.fixture'],true,true,false],['OrdinaryStateHold','OrdinaryStateHold'],
    [['complete',['legacy.fixture'],[]],['complete',['legacy.fixture'],[]]]])
})

for (const which of ['browser','tab'] as const) {
  test(`${which} key changed by another page during sealing is refused without healing or counterpart writes`, async ({ page, context }) => {
    const other=await context.newPage();await other.goto(ORIGIN);await other.evaluate(`(${setup})()`)
    await page.evaluate(`(()=>{
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),put=IDBObjectStore.prototype.put
      window.puts=0;window.encryptions=0;window.callbacks=0;window.sealing=false;let once=false
      crypto.subtle.encrypt=async(...args)=>{encryptions++;if(!once){once=true;sealing=true;await new Promise(resolve=>window.resume=resolve)}return encrypt(...args)}
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)}
      window.pending=outcome(()=>pair((b,t)=>{callbacks++;b.set('proof','candidate');t.set('admission','candidate')}))
      window.restore=()=>{crypto.subtle.encrypt=encrypt;IDBObjectStore.prototype.put=put}
    })()`)
    await page.waitForFunction('sealing')
    await other.evaluate(`(async which=>{
      window.before=await rawBoth();const i=which==='browser'?0:1
      window.wrong=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])
      await editBoth((rows,s)=>{rows[i].key=wrong;s.put(rows[i],i===0?'browser':tabPurpose)})
    })('${which}')`)
    await page.evaluate('resume()')
    expect(await page.evaluate('pending')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('[puts,callbacks,encryptions]')).toEqual([0,1,2])
    expect(await other.evaluate(`(async which=>{
      const rows=await rawBoth(),i=which==='browser'?0:1
      let refused=false;try{await Ordinary.openOrdinaryFrame(rows[i].frame,rows[i].key)}catch{refused=true}
      const iv=new Uint8Array(12),probe=new Uint8Array([1,2,3])
      const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},wrong,probe)
      const preserved=[...new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv},rows[i].key,encrypted))]
      const other=await Ordinary.openOrdinaryFrame(rows[1-i].frame,rows[1-i].key)
      return [refused,preserved,rows.every((r,j)=>Ordinary.sameOrdinaryFrame(r.frame,before[j].frame)),
        other.records.get(i===0?'admission':'proof')??null]
    })('${which}')`)).toEqual([true,[1,2,3],true,null])
    await page.evaluate('restore()')
  })
}

for (const fault of ['expired','foreground-lost'] as const) {
  test(`${fault} during write-time authentication aborts both puts and drains crypto`, async ({ page }) => {
    await page.evaluate(`(()=>{
      const decrypt=crypto.subtle.decrypt.bind(crypto.subtle),put=IDBObjectStore.prototype.put,now=Date.now
      let calls=0;window.puts=0;window.authenticating=false;window.pairReceipt='pending'
      crypto.subtle.decrypt=async(...args)=>{if(++calls===3){authenticating=true;await new Promise(resolve=>window.resume=resolve)}return decrypt(...args)}
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)}
      window.pending=pair().then(()=>pairReceipt='ack',e=>pairReceipt=e.name)
      window.restore=()=>{crypto.subtle.decrypt=decrypt;IDBObjectStore.prototype.put=put;Date.now=now;live=true}
    })()`)
    await page.waitForFunction('authenticating')
    await page.evaluate(`${fault==='expired'?'Date.now=()=>Date.UTC(2030,0,1)':'live=false'}`)
    expect(await page.evaluate('[pairReceipt,puts]')).toEqual(['pending',0])
    await page.evaluate('resume()');await page.evaluate('pending')
    expect(await page.evaluate('[pairReceipt,puts,browserOwner.holdingRetention,tabOwner.holdingRetention]')).toEqual(['OrdinaryStateHold',0,false,false])
    await page.evaluate('restore()');expect(await page.evaluate('values()')).toEqual([null,null])
  })
}

test('fresh-key authentication retains the native writer transaction until a successful active-callback commit', async ({ page, context }) => {
  const other=await context.newPage();await other.goto(ORIGIN);await other.evaluate(`(${setup})()`)
  await page.evaluate(`(()=>{
    const decrypt=crypto.subtle.decrypt.bind(crypto.subtle),put=IDBObjectStore.prototype.put,getKey=IDBObjectStore.prototype.getKey,transaction=IDBDatabase.prototype.transaction
    let held=false,writer=false;window.puts=0;window.keepalives=0;window.callbacks=0;window.authenticating=false;window.pairReceipt='pending'
    IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(this.name===Ordinary.ORDINARY_DATABASE&&tx.mode==='readwrite')writer=true;return tx}
    crypto.subtle.decrypt=async(...args)=>{if(writer&&!held){held=true;authenticating=true;await new Promise(resolve=>window.resume=resolve)}return decrypt(...args)}
    IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)}
    IDBObjectStore.prototype.getKey=function(...args){if(this.transaction.mode==='readwrite')keepalives++;return getKey.apply(this,args)}
    window.pending=pair((b,t)=>{callbacks++;b.set('proof','held-transaction');t.set('admission','held-transaction')}).then(()=>pairReceipt='ack',e=>pairReceipt=e.name)
    window.restore=()=>{crypto.subtle.decrypt=decrypt;IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.getKey=getKey;IDBDatabase.prototype.transaction=transaction}
  })()`)
  await page.waitForFunction('authenticating && keepalives>=10')
  await other.evaluate(`(async()=>{
    window.competingReceipt='queued'
    await new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
      r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners')
        const b=s.get('browser'),t=s.get(tabPurpose)
        window.competing=new Promise((done,fail)=>{tx.oncomplete=()=>{db.close();competingReceipt='acquired';window.competingRows=[b.result,t.result];done()}
          tx.onabort=()=>{db.close();fail(tx.error)}});resolve()}})
    // Complete real native work on an independent database while the competing
    // owners request is queued; this is an event barrier, not a timed sleep.
    await new Promise((resolve,reject)=>{const r=indexedDB.open('pair-test-event-barrier',1)
      r.onupgradeneeded=()=>r.result.createObjectStore('probe');r.onerror=()=>reject(r.error)
      r.onsuccess=()=>{const db=r.result,tx=db.transaction('probe','readwrite');tx.objectStore('probe').put('barrier','x')
        tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}})
  })()`)
  expect(await other.evaluate('competingReceipt')).toBe('queued')
  expect(await page.evaluate('[pairReceipt,puts,callbacks]')).toEqual(['pending',0,1])
  await page.evaluate('resume()');await page.evaluate('pending');await other.evaluate('competing')
  expect(await page.evaluate('[pairReceipt,puts,callbacks]')).toEqual(['ack',2,1])
  expect(await other.evaluate(`(async()=>{const images=await Promise.all(competingRows.map(r=>Ordinary.openOrdinaryFrame(r.frame,r.key)))
    return [competingReceipt,images[0].records.get('proof'),images[1].records.get('admission')]})()`)).toEqual(['acquired','held-transaction','held-transaction'])
  await page.evaluate('restore()')
})

for (const which of ['browser','tab'] as const) {
  test(`${which} close during write-time key authentication drains crypto and refuses both puts`, async ({ page }) => {
    await page.evaluate(`(()=>{
      const decrypt=crypto.subtle.decrypt.bind(crypto.subtle),put=IDBObjectStore.prototype.put,transaction=IDBDatabase.prototype.transaction
      let held=false,writer=false;window.puts=0;window.authenticating=false;window.pairReceipt='pending'
      IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(this.name===Ordinary.ORDINARY_DATABASE&&tx.mode==='readwrite')writer=true;return tx}
      crypto.subtle.decrypt=async(...args)=>{if(writer&&!held){held=true;authenticating=true;await new Promise(resolve=>window.resume=resolve)}return decrypt(...args)}
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)}
      window.pending=pair().then(()=>pairReceipt='ack',e=>pairReceipt=e.name)
      window.restore=()=>{crypto.subtle.decrypt=decrypt;IDBObjectStore.prototype.put=put;IDBDatabase.prototype.transaction=transaction}
    })()`)
    await page.waitForFunction('authenticating')
    await page.evaluate(`(()=>{window.closeReceipt='pending';window.closing=${which==='browser'?'browserOwner':'tabOwner'}.close().then(()=>closeReceipt='done')})()`)
    expect(await page.evaluate('[pairReceipt,closeReceipt,puts]')).toEqual(['pending','pending',0])
    await page.evaluate('resume()');await page.evaluate('Promise.all([pending,closing])')
    expect(await page.evaluate('[pairReceipt,closeReceipt,puts]')).toEqual(['OrdinaryStateHold','done',0])
    await page.evaluate('restore()');expect(await page.evaluate('values()')).toEqual([null,null])
  })
}
