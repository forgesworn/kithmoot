import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const ORIGIN = 'https://ordinary.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./ordinary-state.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })
  bundle = result.outputFiles[0]!.text
})
async function serve(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
}

// The blocked notification is injected; the eventual success/error and the
// database connection are native. Version-one reads cannot naturally upgrade
// an existing version-one database. Delaying delivery exposes the otherwise
// unbounded request tail without pretending an engine produced that block.
for (const operation of ['existing', 'prepare'] as const) {
  for (const outcome of ['success', 'version-error', 'absent-abort'] as const) {
    test(`open terminal tail ${operation} joins delayed native ${outcome} after injected block`, async ({ browser }) => {
      const context = await browser.newContext(); await serve(context)
      const page = await context.newPage(); await page.goto(ORIGIN)
      await page.evaluate(`(async ({operation,outcome}) => {
        const nativeOpen = indexedDB.open.bind(indexedDB), name = Ordinary.ORDINARY_DATABASE
        if (outcome !== 'absent-abort') await new Promise((yes,no) => {
          const r=nativeOpen(name,outcome==='version-error'?2:1)
          r.onupgradeneeded=()=>r.result.createObjectStore('owners')
          r.onerror=()=>no(r.error);r.onsuccess=()=>{r.result.close();yes()}
        })
        window.tail={decision:'pending',close:'pending',ready:false,kind:null,keys:0,puts:0,stores:0}
        const key=crypto.subtle.generateKey.bind(crypto.subtle), put=IDBObjectStore.prototype.put,
          create=IDBDatabase.prototype.createObjectStore
        crypto.subtle.generateKey=(...args)=>{tail.keys++;return key(...args)}
        IDBObjectStore.prototype.put=function(...args){tail.puts++;return put.apply(this,args)}
        IDBDatabase.prototype.createObjectStore=function(...args){tail.stores++;return create.apply(this,args)}
        indexedDB.open=(...args)=>{
          const request=nativeOpen(...args)
          const proxy=new Proxy(request,{
            get(target,name){const v=Reflect.get(target,name,target);return typeof v==='function'?v.bind(target):v},
            set(target,name,value){
              if(name==='onsuccess'||name==='onerror') {
                target[name]=event=>{
                  event.preventDefault();tail.kind=event.type;tail.ready=true
                  window.deliver=()=>value.call(target,event)
                };return true
              }
              return Reflect.set(target,name,value,target)
            }
          })
          queueMicrotask(()=>request.dispatchEvent(new Event('blocked')))
          return proxy
        }
        window.owner=new Ordinary.OrdinaryStateOwner()
        window.pending=(operation==='existing'?owner.openExisting(()=>true):owner.prepare(()=>true,new Map()))
          .then(()=>tail.decision='success',error=>tail.decision=error.name)
        window.finishTail=async()=>{
          deliver();await pending;await closing
          indexedDB.open=nativeOpen;crypto.subtle.generateKey=key
          IDBObjectStore.prototype.put=put;IDBDatabase.prototype.createObjectStore=create
          // A fresh native upgrade must complete: a late connection cannot
          // remain leaked after owner.close resolves. For absent storage,
          // abort the probe so the test itself does not create a database.
          const version=await new Promise((yes,no)=>{
            const r=nativeOpen(name,outcome==='version-error'?3:2);let old
            r.onupgradeneeded=e=>{old=e.oldVersion;if(outcome==='absent-abort')r.transaction.abort()}
            r.onerror=()=>{if(outcome==='absent-abort')yes(old);else no(r.error)}
            r.onsuccess=()=>{r.result.close();yes(old)}
            r.onblocked=()=>no(new Error('late native connection leaked'))
          })
          return {...tail,version,lock:await navigator.locks.request(name+':write',{ifAvailable:true},lock=>!!lock)}
        }
      })(${JSON.stringify({ operation, outcome })})`)
      await page.waitForFunction('tail.ready')
      const before = await page.evaluate(`(async()=>{
        window.closing=owner.close().then(()=>tail.close='closed')
        const lock=await navigator.locks.request(Ordinary.ORDINARY_DATABASE+':write',{ifAvailable:true},lock=>!!lock)
        let revoked=false;try{await owner.capture('room-a',()=>true)}catch{revoked=true}
        return {...tail,lock,revoked}
      })()`)
      expect(before).toEqual({ decision:'pending',close:'pending',ready:true,
        kind:outcome==='success'?'success':'error',keys:0,puts:0,stores:0,lock:false,revoked:true })
      expect(await page.evaluate('finishTail()')).toEqual({ decision:'OrdinaryStateHold',close:'closed',ready:true,
        kind:outcome==='success'?'success':'error',keys:0,puts:0,stores:0,
        version:outcome==='success'?1:outcome==='version-error'?2:0,lock:true })
      await context.close()
    })
  }
  test(`open terminal tail ${operation} closes a native connection revoked during success adoption`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context)
    const page=await context.newPage();await page.goto(ORIGIN)
    expect(await page.evaluate(`(async operation=>{
      const native=indexedDB.open.bind(indexedDB),name=Ordinary.ORDINARY_DATABASE
      await new Promise((yes,no)=>{const r=native(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('owners');
        r.onerror=()=>no(r.error);r.onsuccess=()=>{r.result.close();yes()}})
      const owner=new Ordinary.OrdinaryStateOwner();let closing,intercepted=0,keys=0,puts=0
      const key=crypto.subtle.generateKey.bind(crypto.subtle),put=IDBObjectStore.prototype.put
      crypto.subtle.generateKey=(...args)=>{keys++;return key(...args)}
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)}
      indexedDB.open=(...args)=>{
        const request=native(...args)
        return new Proxy(request,{
          get(target,name){const v=Reflect.get(target,name,target);return typeof v==='function'?v.bind(target):v},
          set(target,name,value){
            if(name==='onsuccess'){
              target.onsuccess=event=>{intercepted++;value.call(target,event);closing=owner.close()};return true
            }
            return Reflect.set(target,name,value,target)
          }
        })
      }
      let decision
      try{await(operation==='existing'?owner.openExisting(()=>true):owner.prepare(()=>true,new Map()));decision='success'}
      catch(error){decision=error.name}
      await closing;indexedDB.open=native;crypto.subtle.generateKey=key;IDBObjectStore.prototype.put=put
      const version=await new Promise((yes,no)=>{const r=native(name,2);let old;
        r.onupgradeneeded=e=>{old=e.oldVersion};r.onerror=()=>no(r.error);
        r.onsuccess=()=>{r.result.close();yes(old)};r.onblocked=()=>no(new Error('success adoption leaked a connection'))})
      return {decision,intercepted,keys,puts,version,
        lock:await navigator.locks.request(name+':write',{ifAvailable:true},lock=>!!lock)}
    })('${operation}')`)).toEqual({decision:'OrdinaryStateHold',intercepted:1,keys:0,puts:0,version:1,lock:true})
    await context.close()
  })
}
// These accessors exist only in the routed test bundle, never production.
const setup = `async () => {
  window.owner = new Ordinary.OrdinaryStateOwner()
  window.live = true
  window.guard = () => window.live
  await owner.prepare(guard, new Map())
  window.scope = await owner.capture('room-a', guard)
  window.raw = () => new Promise((resolve,reject) => {
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
    r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{ const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser');
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close() }
  })
  window.edit = work => new Promise((resolve,reject) => {
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1)
    r.onerror=()=>reject(r.error)
    r.onsuccess=()=>{ const db=r.result,tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners'),q=s.get('browser');
      q.onsuccess=()=>work(q.result,s);tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)} }
  })
}`

test('native commit retains the credential and seal together, with no plaintext Storage or row index', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context)
  const page = await context.newPage(); await page.goto(ORIGIN); await page.evaluate(`(${setup})()`)
  const receipt = await page.evaluate(`(async () => {
    const credential={id:'credential',tags:[['seal','public']],content:'signed'}
    await owner.mutate(scope,guard,store=>Ordinary.storeOwnCredentialFor(store,'room-a',credential,new Uint8Array(32).fill(7)))
    const saved=await raw(), image=await Ordinary.openOrdinaryFrame(saved.frame,saved.key)
    const plaintext=new TextDecoder().decode(saved.frame.ciphertext)
    return {credential:JSON.parse(image.records.get(Ordinary.OWN_CREDENTIAL_PREFIX+'room-a')),
      seals:JSON.parse(image.records.get(Ordinary.OWN_SEAL_PREFIX+'room-a')),extractable:saved.key.extractable,
      leaked:plaintext.includes('credential')||plaintext.includes('room-a'),local:Object.keys(localStorage),session:Object.keys(sessionStorage)}
  })()`)
  expect(receipt).toEqual({ credential: { id:'credential',tags:[['seal','public']],content:'signed' },
    seals:['07'.repeat(32)],extractable:false,leaked:false,local:[],session:[] })
  await page.evaluate('owner.close()'); await page.reload(); await page.evaluate(`(${setup})()`)
  expect(await page.evaluate('owner.read(scope,guard,s=>s.get(Ordinary.OWN_CREDENTIAL_PREFIX+"room-a"))')).toContain('credential')
  await context.close()
})

test('two tabs serialize complete images without losing either update', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context)
  const a=await context.newPage(),b=await context.newPage(); await a.goto(ORIGIN);await b.goto(ORIGIN)
  await a.evaluate(`(${setup})()`); await b.evaluate(`(${setup})()`)
  await Promise.all([a.evaluate('owner.mutate(scope,guard,s=>s.set("a","one"))'),b.evaluate('owner.mutate(scope,guard,s=>s.set("b","two"))')])
  expect(await a.evaluate('owner.read(scope,guard,s=>[s.get("a"),s.get("b")])')).toEqual(['one','two'])
  await context.close()
})

test('read helpers cannot mutate, and escaped mutation views cannot edit after acknowledgement', async ({ browser }) => {
  const context = await browser.newContext(); await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async () => {
    const result=[]
    try { await owner.read(scope,guard,s=>s.set('bad','read')) } catch(e) { result.push(e.name) }
    await owner.mutate(scope,guard,s=>{window.escaped=s;s.set('good','saved')})
    try { escaped.set('bad','escaped') } catch(e) {result.push(e.name)}
    return [result,await owner.read(scope,guard,s=>[s.get('good'),s.get('bad')])]
  })()`)).toEqual([['OrdinaryStateHold','OrdinaryStateHold'],['saved',null]])
  await context.close()
})

test('a room switch while encryption is pending cannot commit or return stale success', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async () => {
    const native=crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt=async (...args)=>{live=false;return native(...args)}
    let answer
    try {await owner.mutate(scope,guard,s=>s.set('stale','secret'));answer='success'} catch(e) {answer=e.name}
    crypto.subtle.encrypt=native;live=true
    return [answer,await owner.read(scope,guard,s=>s.get('stale'))]
  })()`)).toEqual(['OrdinaryStateHold',null])
  await context.close()
})

test('native quota/abort preserves the prior complete image and allows an exact caller retry', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async () => {
    await owner.mutate(scope,guard,s=>s.set('first','retained'))
    const native=IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put=function(){throw new DOMException('full','QuotaExceededError')}
    let answer
    try {await owner.mutate(scope,guard,s=>s.set('second','candidate'));answer='success'} catch(e) {answer=e.name}
    IDBObjectStore.prototype.put=native
    const prior=await owner.read(scope,guard,s=>[s.get('first'),s.get('second')])
    await owner.mutate(scope,guard,s=>s.set('second','candidate'))
    return [answer,prior,await owner.read(scope,guard,s=>s.get('second'))]
  })()`)).toEqual(['OrdinaryStateHold',['retained',null],'candidate'])
  await context.close()
})

for (const fault of ['missing-key','wrong-key','ciphertext','generation'] as const) {
  test(`${fault} holds without replacement identity or ciphertext`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context)
    const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
    const answer=await page.evaluate(`(async fault => {
      const wrong=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])
      await edit((row,s)=>{if(fault==='missing-key') delete row.key;else if(fault==='wrong-key') row.key=wrong;
        else if(fault==='ciphertext')new Uint8Array(row.frame.ciphertext)[0]^=1;
        else row.frame.generation='f'.repeat(64);s.put(row,'browser')})
      try {await owner.read(scope,guard,s=>s.keys());return 'success'} catch(e){return e.name}
    })('${fault}')`)
    expect(answer).toBe('OrdinaryStateHold');await context.close()
  })
}

test('a lost native commit acknowledgement reopens the exact committed candidate before returning', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async () => {
    const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete')
    let intercepted=0,encryptions=0
    const native=crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return native(...args)}
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){
      const tx=this
      if(tx.mode==='readwrite'&&!intercepted++) d.set.call(tx,event=>tx.onabort(event))
      else d.set.call(tx,callback)
    }})
    try {
      await owner.mutate(scope,guard,s=>s.set('unknown','retained'))
      return [await owner.read(scope,guard,s=>s.get('unknown')),encryptions]
    } finally {Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);crypto.subtle.encrypt=native}
  })()`)).toEqual(['retained',1])
  await context.close()
})

test('unavailable reconciliation retains the Web Lock and nonce until explicit recovery', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN)
  await a.evaluate(`(${setup})()`);await b.evaluate(`(${setup})()`)
  await a.evaluate(`(() => {
    const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'), nativeOpen=IDBFactory.prototype.open
    const nativeEncrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    window.encryptions=0;window.receipt='pending';window.intercepted=0
    crypto.subtle.encrypt=async(...args)=>{encryptions++;return nativeEncrypt(...args)}
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){
      const tx=this
      if(tx.mode==='readwrite'&&!intercepted++) d.set.call(tx,event=>{
        IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)
      });else d.set.call(tx,callback)
    }})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);IDBFactory.prototype.open=nativeOpen;crypto.subtle.encrypt=nativeEncrypt}
    window.pending=owner.mutate(scope,guard,s=>s.set('unknown','retained')).then(()=>receipt='success',e=>receipt=e.name)
  })()`)
  await a.waitForFunction('owner.holdingRetention')
  // Check the actual cross-tab Web Lock, without relying on a sleep.
  expect(await b.evaluate('navigator.locks.request("kithmoot-ordinary-state-v1:write",{ifAvailable:true},lock=>!!lock)')).toBe(false)
  const before=await a.evaluate(`(async()=>{restore();const saved=await raw();window.intended=structuredClone(saved.pending ?? saved.frame);return [receipt,encryptions]})()`)
  expect(before).toEqual(['pending',1])
  await a.evaluate('owner.retryRetention()');await a.evaluate('pending')
  expect(await a.evaluate(`(async()=>[receipt,encryptions,Ordinary.sameOrdinaryFrame(intended,(await raw()).frame),await owner.read(scope,guard,s=>s.get('unknown'))])()`)).toEqual(['success',1,true,'retained'])
  await context.close()
})

test('room deletion and its fence commit together; another tab cannot resurrect with its captured scope', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN)
  await a.evaluate(`(${setup})()`);await b.evaluate(`(${setup})()`)
  await a.evaluate('owner.mutate(scope,guard,s=>{s.set("room-a-secret","delete");s.set("room-b-secret","keep")})')
  await a.evaluate('owner.forget(scope,guard,name=>name.startsWith("room-a-"))')
  expect(await b.evaluate(`(async()=>{try{await owner.mutate(scope,guard,s=>s.set('room-a-secret','stale'));return 'success'}catch(e){return e.name}})()`)).toBe('OrdinaryStateHold')
  expect(await a.evaluate(`(async()=>{scope=await owner.capture('room-a',guard);return owner.read(scope,guard,s=>[s.get('room-a-secret'),s.get('room-b-secret')])})()`)).toEqual([null,'keep'])
  await context.close()
})

test('migration phases and exact legacy manifest survive a reload inside ciphertext', async ({ browser }) => {
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
  await page.evaluate(`owner.retainMigration(scope,guard,{phase:'cleaning',sources:new Map([['legacy','exact']]),names:['legacy']})`)
  await page.evaluate('owner.close()');await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{const m=await owner.migration(scope,guard);return [m.phase,[...m.sources],m.names]})()`)).toEqual(['cleaning',[['legacy','exact']],['legacy']])
  await page.evaluate(`owner.retainMigration(scope,guard,{phase:'complete',sources:new Map(),names:['legacy']})`)
  expect(await page.evaluate(`(async()=>{const m=await owner.migration(scope,guard);return [m.phase,[...m.sources],m.names]})()`)).toEqual(['complete',[],['legacy']])
  await context.close()
})

const migrationSetup = `() => {
  window.owner=new Ordinary.OrdinaryStateOwner();window.live=true;window.guard=()=>live
  window.migrate=()=>Ordinary.migrateOrdinaryStorage({owner,storage:localStorage,selected:name=>name.startsWith('secret.'),
    validate:records=>{for(const value of records.values())if(!/^[0-9a-f]{64}$/.test(value))throw new Ordinary.OrdinaryStateHold()},
    checkClients:async()=>{},live:guard})
}`
// These tests exercise actual Storage/IDB cuts. checkClients is deliberately a
// no-op fixture; they do not establish production old-window fencing.
for (const cut of ['none','sealed','removed-before-marker'] as const) {
  test(`migration recovers exact values after ${cut}`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context)
    const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${migrationSetup})()`)
    await page.evaluate(`localStorage.setItem('secret.identity','${'a'.repeat(64)}')`)
    if(cut!=='none') {
      const result=await page.evaluate(`(async cut=>{
        const native=cut==='sealed'?owner.prepare.bind(owner):owner.retainMigration.bind(owner)
        if(cut==='sealed')owner.prepare=async(...args)=>{await native(...args);throw new Error('cut after sealed')}
        else owner.retainMigration=async(...args)=>{if(args[2].sources.size===0)throw new Error('cut before cleanup marker');return native(...args)}
        try{await migrate();return 'unexpected'}catch(e){return e.message}
      })('${cut}')`)
      expect(result).toContain('cut ')
      await page.evaluate('owner.close()');await page.reload();await page.evaluate(`(${migrationSetup})()`)
    }
    await page.evaluate('migrate()')
    expect(await page.evaluate(`(async()=>{const s=await owner.capture('@migration',guard),m=await owner.migration(s,guard);
      return [await owner.read(s,guard,s=>s.get('secret.identity')),m.phase,[...m.sources],localStorage.getItem('secret.identity')]})()`)).toEqual(['a'.repeat(64),'complete',[],null])
    await context.close()
  })
}

for (const fault of ['changed','new','reappeared'] as const) {
  test(`migration holds ${fault} plaintext instead of deleting or replacing it`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context)
    const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${migrationSetup})()`)
    await page.evaluate(`localStorage.setItem('secret.identity','${'a'.repeat(64)}')`)
    if(fault==='reappeared')await page.evaluate('migrate()')
    else await page.evaluate(`(async()=>{const native=owner.prepare.bind(owner);owner.prepare=async(...args)=>{await native(...args);throw new Error('cut')};try{await migrate()}catch{}})()`)
    await page.evaluate('owner.close()');await page.reload();await page.evaluate(`(${migrationSetup})()`)
    const name=fault==='new'?'secret.new':'secret.identity'
    await page.evaluate(`localStorage.setItem('${name}','${'b'.repeat(64)}')`)
    expect(await page.evaluate(`(async()=>{try{await migrate();return 'success'}catch(e){return e.name}})()`)).toBe('OrdinaryStateHold')
    expect(await page.evaluate(`localStorage.getItem('${name}')`)).toBe('b'.repeat(64))
    await context.close()
  })
}

for (const receipt of ['stage','promotion'] as const) {
  test(`tab death during unknown ${receipt} recovers the same frozen frame without encryption`, async ({ browser }) => {
    const context=await browser.newContext();await serve(context)
    const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`)
    await page.evaluate(`(() => {
      const d=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
      window.writes=0;window.receipt='pending'
      Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...d,set(callback){
        const tx=this
        if(tx.mode==='readwrite'&&++writes===${receipt==='stage'?1:2})d.set.call(tx,event=>{
          IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)
        });else d.set.call(tx,callback)
      }})
      window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',d);IDBFactory.prototype.open=nativeOpen}
      window.pending=owner.mutate(scope,guard,s=>s.set('frozen','exact')).then(()=>receipt='success',e=>receipt=e.name)
    })()`)
    await page.waitForFunction('owner.holdingRetention')
    const frozen=await page.evaluate<{ pending: boolean; revision: number; nonce: number[]; ciphertext: number[]; receipt: string }>(`(async()=>{restore();const saved=await raw(),f=saved.pending??saved.frame;return {
      pending:!!saved.pending,revision:f.revision,nonce:[...new Uint8Array(f.nonce)],ciphertext:[...new Uint8Array(f.ciphertext)],receipt}})()`)
    expect(frozen.pending).toBe(receipt==='stage');expect(frozen.receipt).toBe('pending')
    // Kill the page with the unresolved handoff; close() would correctly wait
    // for reconciliation and therefore would not model a crash.
    await page.close()
    const recovered=await context.newPage();await recovered.goto(ORIGIN)
    await recovered.evaluate(`(() => {crypto.subtle.encrypt=async()=>{throw new Error('must not re-encrypt frozen custody')};crypto.subtle.generateKey=async()=>{throw new Error('must not replace custody key')}})()`)
    await recovered.evaluate(`(${setup})()`)
    const after=await recovered.evaluate(`(async()=>{const saved=await raw(),f=saved.frame;return {pending:!!saved.pending,
      revision:f.revision,nonce:[...new Uint8Array(f.nonce)],ciphertext:[...new Uint8Array(f.ciphertext)],value:await owner.read(scope,guard,s=>s.get('frozen'))}})()`)
    expect(after).toEqual({pending:false,revision:frozen.revision,nonce:frozen.nonce,ciphertext:frozen.ciphertext,value:'exact'})
    await context.close()
  })
}

test('a different window reappearing with selected plaintext permanently holds the effect owner',async({browser})=>{
  const context=await browser.newContext();await serve(context)
  const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN)
  await a.evaluate(`(()=>{window.stopped=0;window.ordinaryGuard=new Ordinary.OrdinaryLegacyGuard([{storage:localStorage,selected:name=>name.startsWith('secret.')}],()=>stopped++)})()`)
  await b.evaluate('localStorage.setItem("secret.old-client","private")')
  await a.waitForFunction('!ordinaryGuard.live')
  expect(await a.evaluate(`(()=>{try{ordinaryGuard.assertClean();return 'success'}catch(e){return [e.name,stopped,localStorage.getItem('secret.old-client')]}})()`)).toEqual(['OrdinaryStateHold',1,'private'])
  await b.evaluate('localStorage.removeItem("secret.old-client")')
  expect(await a.evaluate('ordinaryGuard.live')).toBe(false)
  await context.close()
})
test('same-window plaintext is caught at the effect boundary without relying on a storage event',async({browser})=>{
  const context=await browser.newContext();await serve(context)
  const page=await context.newPage();await page.goto(ORIGIN)
  expect(await page.evaluate(`(()=>{let stopped=0;const guard=new Ordinary.OrdinaryLegacyGuard([{storage:sessionStorage,selected:name=>name.startsWith('secret.')}],()=>stopped++);
    sessionStorage.setItem('secret.temporary','private');try{guard.assertClean();return 'success'}catch(e){return [e.name,stopped,guard.live,sessionStorage.getItem('secret.temporary')]}})()`)).toEqual(['OrdinaryStateHold',1,false,'private'])
  await context.close()
})
test('a throwing selected-name predicate in a remote Storage event permanently holds',async({browser})=>{
  const context=await browser.newContext();await serve(context)
  const a=await context.newPage(),b=await context.newPage();await a.goto(ORIGIN);await b.goto(ORIGIN)
  await a.evaluate(`(()=>{window.stopped=0;window.ordinaryGuard=new Ordinary.OrdinaryLegacyGuard([{storage:localStorage,selected:name=>{if(name==='malformed')throw new Error('unrecognised legacy name');return name.startsWith('secret.')}}],()=>stopped++)})()`)
  await b.evaluate('localStorage.setItem("malformed","retained")')
  await a.waitForFunction('!ordinaryGuard.live')
  expect(await a.evaluate('({live:ordinaryGuard.live,stopped,value:localStorage.getItem("malformed")})')).toEqual({live:false,stopped:1,value:'retained'})
  await context.close()
})
