import { build } from 'esbuild'
import { expect, test, type BrowserContext } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Native encrypted custody plus the actual SDK, with a synthetic extension.
// These are component checks, not the application's production bootstrap.
const ORIGIN = 'https://ordinary-signet.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-signet.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022' })).outputFiles[0]!.text
})
async function serve(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
}
const setup = `async () => {
  window.foreground=true;window.generation=0;window.stops=0;window.signs=0
  window.guard=()=>foreground;window.k=Ordinary.ORDINARY_SIGNET_KEYS
  window.sessionKeys=['pubkey','method','authEvent','bunkerUri','bunkerClientSk','expiresAt','displayName'].map(name=>k[name])
  window.blank=()=>Object.fromEntries(sessionKeys.map(name=>[name,null]))
  window.key=new Uint8Array(32);key[31]=1;window.account=Ordinary.getPublicKey(key)
  window.proof=(tags=[['challenge','a'.repeat(64)],['origin',location.origin],['app','KithMoot']])=>Ordinary.finalizeEvent({
    kind:21236,created_at:Math.floor(Date.now()/1000),tags,content:''},key)
  window.image=()=>({...blank(),[k.pubkey]:account,[k.method]:'nip07',[k.authEvent]:JSON.stringify(proof())})
  window.installExtension=()=>{window.nostr={getPublicKey:async()=>account,signEvent:async event=>{signs++;return Ordinary.finalizeEvent(event,key)}}}
  installExtension()
  window.raw=()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),q=tx.objectStore('owners').get('browser')
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);tx.oncomplete=()=>db.close()
    }
  })
  window.owner=new Ordinary.OrdinaryStateOwner()
  await owner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]})
  window.options={owner,generation:0,currentGeneration:()=>generation,live:guard,origin:location.origin,appName:'KithMoot',
    checkClients:async()=>{},stop:()=>{stops++;foreground=false}}
  window.storage=await Ordinary.OrdinarySignetState.open(options)
  window.seed=async values=>{
    const scope=await owner.capture('@seed',guard)
    await owner.mutateMigrated(scope,guard,store=>{for(const [name,value]of Object.entries(values)){if(value===null)store.remove(name);else store.set(name,value)}})
  }
  window.countEntropy=()=>{
    const random=crypto.getRandomValues.bind(crypto),encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    window.entropy=0;window.encryptions=0
    crypto.getRandomValues=(...args)=>{entropy++;return random(...args)}
    crypto.subtle.encrypt=(...args)=>{encryptions++;return encrypt(...args)}
    window.restoreCrypto=()=>{crypto.getRandomValues=random;crypto.subtle.encrypt=encrypt}
  }
}`
async function open(context: BrowserContext) {
  await serve(context);const page=await context.newPage();await page.goto(ORIGIN);await page.evaluate(`(${setup})()`);return page
}

test('actual SDK login and reload restore keep coherent session custody only in encrypted IndexedDB',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    window.session=await Ordinary.login({appName:'KithMoot',preferredMethod:'nip07',storage})
    const saved=await raw(),records=(await Ordinary.openOrdinaryFrame(saved.frame,saved.key)).records
    return [session.pubkey===account,session.method,signs,records.get(k.pubkey)===account,records.get(k.authEvent)===JSON.stringify(session.authEvent),
      saved.key.extractable,Object.keys(localStorage),Object.keys(sessionStorage),new TextDecoder().decode(saved.frame.ciphertext).includes(account)]
  })()`)).toEqual([true,'nip07',1,true,true,false,[],[],false])
  await page.reload();await page.evaluate(`(${setup})()`)
  expect(await page.evaluate(`(async()=>{
    countEntropy();const session=await Ordinary.restoreSession({storage})
    const result=[session.pubkey===account,session.method,signs,entropy,encryptions,Object.keys(localStorage),Object.keys(sessionStorage)]
    restoreCrypto();return result
  })()`)).toEqual([true,'nip07',0,0,0,[],[]])
  await context.close()
})

test('two native tabs race first-use CAS and retain exactly one client key',async({browser})=>{
  const context=await browser.newContext(),a=await open(context),b=await context.newPage();await b.goto(ORIGIN);await b.evaluate(`(${setup})()`)
  const candidates=['03'.repeat(32),'04'.repeat(32)]
  const won=await Promise.all([a.evaluate(`storage.compareAndSetItem(k.clientSk,null,'${candidates[0]}')`),b.evaluate(`storage.compareAndSetItem(k.clientSk,null,'${candidates[1]}')`)])
  expect(won.filter(Boolean)).toHaveLength(1)
  expect(await a.evaluate('storage.getItem(k.clientSk)')).toBe(candidates[won.indexOf(true)])
  expect(await b.evaluate(`(async()=>{
    const before=(await raw()).frame;countEntropy()
    const result=await storage.compareAndSetItem(k.clientSk,null,'05'.repeat(32))
    const out=[result,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame)]
    restoreCrypto();return out
  })()`)).toEqual([false,0,0,true])
  await context.close()
})

test('stale coherent session snapshots cannot overwrite or clear a newer login',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const initial=blank(),first=image();await storage.setItems(first,initial)
    const current=await storage.getItems(sessionKeys),next={...current,[k.displayName]:'Newer'}
    await storage.setItems(next,current);const before=(await raw()).frame;countEntropy()
    const overwritten=await storage.setItems(first,current),cleared=await storage.setItems(blank(),current)
    const out=[overwritten,cleared,(await storage.getItems(sessionKeys))[k.displayName],entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame)]
    restoreCrypto();return out
  })()`)).toEqual([false,false,'Newer',0,0,true])
  await context.close()
})

test('caller aliases cannot change a session candidate while the client fence awaits',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    let release,entered,waiting=false;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
    const other=await Ordinary.OrdinarySignetState.open({...options,checkClients:async()=>{if(waiting){entered();await gate}}})
    const candidate=image(),expected=blank(),auth=candidate[k.authEvent];waiting=true
    const pending=other.setItems(candidate,expected);await ready
    candidate[k.pubkey]='c'.repeat(64);candidate[k.authEvent]='corrupt';expected[k.pubkey]=account
    release();const acknowledged=await pending,retained=await other.getItems(sessionKeys)
    return [acknowledged,retained[k.pubkey]===account,retained[k.authEvent]===auth,stops]
  })()`)).toEqual([true,true,true,0])
  await context.close()
})

for(const corruption of ['zero-key','unknown-key','orphan-session','persisted-nsec','pubkey-casing','bad-proof','wrong-origin','wrong-app','duplicate-origin','bad-expiry','bunker-orphan','pending-fields','pending-origin','pending-secret','pending-relay'] as const)
 test(`authenticated ${corruption} holds opening without entropy, fallback or a replacement image`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const values={};const which='${corruption}'
    if(which==='zero-key')values[k.clientSk]='00'.repeat(32)
    if(which==='unknown-key')values['signet:login.future']='unexpected'
    if(which==='orphan-session')values[k.pubkey]=account
    if(['persisted-nsec','pubkey-casing','bad-proof','wrong-origin','wrong-app','duplicate-origin','bad-expiry','bunker-orphan'].includes(which)){
      Object.assign(values,image())
      if(which==='persisted-nsec')values[k.method]='nsec'
      if(which==='pubkey-casing')values[k.pubkey]=account.toUpperCase()
      if(which==='bad-proof'){const event=proof();event.sig='00'.repeat(64);values[k.authEvent]=JSON.stringify(event)}
      if(which==='wrong-origin')values[k.authEvent]=JSON.stringify(proof([['challenge','a'.repeat(64)],['origin','https://other.test'],['app','KithMoot']]))
      if(which==='wrong-app')values[k.authEvent]=JSON.stringify(proof([['challenge','a'.repeat(64)],['origin',location.origin],['app','Other']]))
      if(which==='duplicate-origin')values[k.authEvent]=JSON.stringify(proof([['challenge','a'.repeat(64)],['origin',location.origin],['origin',location.origin],['app','KithMoot']]))
      if(which==='bad-expiry')values[k.expiresAt]='01'
      if(which==='bunker-orphan')values[k.bunkerClientSk]='03'.repeat(32)
    }
    if(which.startsWith('pending-')){
      let pending={challenge:'a'.repeat(64),origin:location.origin,appName:'KithMoot',createdAt:1}
      if(which==='pending-fields')pending.extra='value'
      if(which==='pending-origin')pending.origin='https://other.test'
      if(['pending-secret','pending-relay'].includes(which)){
        pending={challenge:'a'.repeat(64),origin:location.origin,appName:'KithMoot',issuedAt:1,
          sessionSkHex:which==='pending-secret'?'00'.repeat(32):'03'.repeat(32),relayUrl:which==='pending-relay'?'https://relay.test':'wss://relay.test'}
        values[k.pendingRelayAuth]=JSON.stringify(pending)
      }else values[k.pendingRedirect]=JSON.stringify(pending)
    }
    await seed(values);const before=(await raw()).frame;countEntropy();let refusal
    try{await Ordinary.OrdinarySignetState.open(options)}catch(error){refusal=error.name}
    const out=[refusal,stops,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage),Object.keys(sessionStorage)]
    restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',1,0,0,true,[],[]])
  await context.close()
})

for(const phase of ['sealed','cleaning'] as const)test(`incomplete ${phase} migration holds the adapter before any SDK effects`,async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await owner.retainMigration(await owner.capture('@migration',guard),guard,{phase:'${phase}',sources:new Map(),names:[]})
    const before=(await raw()).frame;countEntropy();let refusal
    try{await Ordinary.OrdinarySignetState.open(options)}catch(error){refusal=error.name}
    const out=[refusal,stops,signs,entropy,encryptions,Ordinary.sameOrdinaryFrame(before,(await raw()).frame)];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',1,0,0,0,true])
  await context.close()
})

test('known-account restore rejects another valid account proof',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await seed(image());let refusal;countEntropy()
    try{await Ordinary.OrdinarySignetState.open({...options,account:'c'.repeat(64)})}catch(error){refusal=error.name}
    const out=[refusal,stops,entropy,encryptions];restoreCrypto();return out
  })()`)).toEqual(['OrdinaryStateHold',1,0,0])
  await context.close()
})

test('conditional helper false discards private edits and refuses non-boolean receipts without native effects',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    const scope=await owner.capture('@condition',guard),before=(await raw()).frame;countEntropy()
    const changed=await owner.compareAndMutateMigrated(scope,guard,store=>{store.set('discarded','private');return false})
    const errors=[]
    for(const result of [undefined,0,1,'true',Promise.resolve(true)]){
      try{await owner.compareAndMutateMigrated(scope,guard,store=>{store.set('discarded','private');return result})}catch(error){errors.push(error.name)}
    }
    const saved=await raw(),records=(await Ordinary.openOrdinaryFrame(saved.frame,saved.key)).records
    const out=[changed,errors,records.has('discarded'),entropy,encryptions,Ordinary.sameOrdinaryFrame(before,saved.frame)];restoreCrypto();return out
  })()`)).toEqual([false,Array(5).fill('OrdinaryStateHold'),false,0,0,true])
  await context.close()
})

test('foreground replacement while sealing prevents the candidate from reaching IndexedDB',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(() => {
    window.before=null;const encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    window.blocked=new Promise(resolve=>window.entered=resolve);window.gate=new Promise(resolve=>window.release=resolve)
    crypto.subtle.encrypt=async(...args)=>{const result=await encrypt(...args);entered();await gate;return result}
    window.receipt='pending';window.pending=raw().then(saved=>{before=saved.frame;return storage.compareAndSetItem(k.clientSk,null,'03'.repeat(32))}).then(()=>receipt='success',error=>receipt=error.name)
  })()`)
  await page.evaluate('blocked');await page.evaluate('generation++;release()');await page.evaluate('pending')
  expect(await page.evaluate(`(async()=>[receipt,stops,Ordinary.sameOrdinaryFrame(before,(await raw()).frame),Object.keys(localStorage)])()`)).toEqual(['OrdinaryStateHold',1,true,[]])
  await context.close()
})

test('close joins unknown receipt classification and restart promotes the exact frozen frame',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(() => {
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    let intercepted=0;countEntropy();window.receipt='pending';window.closeDone=false
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){
      const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)descriptor.set.call(tx,event=>{
        IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)
      });else descriptor.set.call(tx,callback)
    }})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen}
    window.pending=storage.compareAndSetItem(k.clientSk,null,'03'.repeat(32)).then(()=>receipt='success',error=>receipt=error.name)
  })()`)
  await page.waitForFunction('owner.holdingRetention')
  await page.evaluate('void(window.closing=storage.close().then(()=>closeDone=true))')
  expect(await page.evaluate('[receipt,closeDone,stops,entropy,encryptions]')).toEqual(['pending',false,1,1,1])
  expect(await page.evaluate(`storage.getItem(k.clientSk).then(()=>false,error=>error.name)`)).toBe('OrdinaryStateHold')
  await page.evaluate(`(async()=>{restore();window.intended=structuredClone((await raw()).pending)})()`)
  await page.evaluate('owner.retryRetention()');await page.evaluate('Promise.all([pending,closing])')
  expect(await page.evaluate('[receipt,closeDone,stops,entropy,encryptions]')).toEqual(['OrdinaryStateHold',true,1,1,1])
  expect(await page.evaluate(`(async()=>{
    foreground=true;await owner.close();owner=new Ordinary.OrdinaryStateOwner();await owner.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]})
    const other=await Ordinary.OrdinarySignetState.open({...options,owner}),saved=await raw()
    const out=[await other.getItem(k.clientSk),!!saved.pending,Ordinary.sameOrdinaryFrame(intended,saved.frame),entropy,encryptions]
    restoreCrypto();return out
  })()`)).toEqual(['03'.repeat(32),false,true,1,1])
  await context.close()
})

test('actual SDK login waits for the same encrypted candidate after an unknown native acknowledgement',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  await page.evaluate(`(() => {
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),nativeOpen=IDBFactory.prototype.open
    let intercepted=0;countEntropy();window.receipt='pending';window.session=null
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){
      const tx=this
      if(tx.mode==='readwrite'&&!intercepted++)descriptor.set.call(tx,event=>{
        IDBFactory.prototype.open=function(){throw new DOMException('offline','UnknownError')};tx.onabort(event)
      });else descriptor.set.call(tx,callback)
    }})
    window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=nativeOpen}
    window.pending=Ordinary.login({appName:'KithMoot',preferredMethod:'nip07',storage}).then(value=>{session=value;receipt='success'},error=>receipt=error.name)
  })()`)
  await page.waitForFunction('owner.holdingRetention')
  expect(await page.evaluate('[receipt,session,signs,encryptions,Object.keys(localStorage),Object.keys(sessionStorage)]')).toEqual(['pending',null,1,1,[],[]])
  await page.evaluate(`(async()=>{window.beforeEntropy=entropy;restore();window.intended=structuredClone((await raw()).pending)})()`)
  await page.evaluate('owner.retryRetention()');await page.evaluate('pending')
  expect(await page.evaluate(`(async()=>{
    const saved=await raw(),values=await storage.getItems(sessionKeys)
    const out=[receipt,session.pubkey===account,signs,encryptions,entropy===beforeEntropy,
      Ordinary.sameOrdinaryFrame(intended,saved.frame),values[k.authEvent]===JSON.stringify(session.authEvent),!!saved.pending]
    restoreCrypto();return out
  })()`)).toEqual(['success',true,1,1,true,true,true,false])
  await context.close()
})

test('SDK logout clears exactly its partition and a forgotten scope refuses late repopulation',async({browser})=>{
  const context=await browser.newContext(),page=await open(context)
  expect(await page.evaluate(`(async()=>{
    await Ordinary.login({appName:'KithMoot',preferredMethod:'nip07',storage})
    await storage.compareAndSetItem(k.clientSk,null,'03'.repeat(32));await seed({'room:keep':'value'})
    await Ordinary.logout(undefined,{storage,clearPersistentClientKey:true})
    const cleared=await storage.getItems(sessionKeys),client=await storage.getItem(k.clientSk)
    const scope=await owner.capture('@ordinary-signet',guard);await owner.forget(scope,guard,name=>Object.values(k).includes(name))
    const before=(await raw()).frame;let refusal
    try{await storage.compareAndSetItem(k.clientSk,null,'04'.repeat(32))}catch(error){refusal=error.name}
    const saved=await raw(),records=(await Ordinary.openOrdinaryFrame(saved.frame,saved.key)).records
    return [Object.values(cleared).every(value=>value===null),client,refusal,stops,records.get('room:keep'),Ordinary.sameOrdinaryFrame(before,saved.frame)]
  })()`)).toEqual([true,null,'OrdinaryStateHold',1,'value',true])
  await context.close()
})
