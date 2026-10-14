import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Actual native custody and transaction tests. Fixture records carry no
// membership, signing, successor Session or production authority.
const ORIGIN = 'https://ordinary-pair-commit.kithmoot.test'
let bundle = ''
test.beforeAll(async () => { bundle = (await build({
  entryPoints: [fileURLToPath(new URL('./ordinary-pair-commit.browser-entry.ts', import.meta.url))],
  bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022',
})).outputFiles[0]!.text })
const setup = `async()=>{
 window.live=true;window.guard=()=>live;window.tabPurpose='tab:'+'a'.repeat(64);
 window.rawBoth=()=>new Promise((resolve,reject)=>{
  const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);
  r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners');
   const b=s.get('browser'),t=s.get(tabPurpose);tx.oncomplete=()=>{db.close();resolve([b.result,t.result])};
   tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.editBoth=work=>new Promise((resolve,reject)=>{
  const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);
  r.onsuccess=()=>{const db=r.result,tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners');
   const b=s.get('browser'),t=s.get(tabPurpose);t.onsuccess=()=>work([b.result,t.result],s);
   tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}});
 window.browserOwner=new Ordinary.OrdinaryStateOwner();window.tabOwner=new Ordinary.OrdinaryStateOwner(tabPurpose,Date.UTC(2030,0,1));
 const migration={phase:'complete',sources:new Map(),names:['legacy.fixture']};
 await browserOwner.prepare(guard,new Map([['old','browser']]),migration);
 await tabOwner.prepare(guard,new Map([['old','tab']]),migration);
 window.browserScope=await browserOwner.capture('room',guard);window.tabScope=await tabOwner.capture('room',guard);
 window.binding=()=>({browser:{owner:browserOwner,scope:browserScope},tab:{owner:tabOwner,scope:tabScope},live:guard});
 window.commit=(beforeWrite=()=>{},work=(b,t)=>{b.set('proof','candidate');t.set('admission','candidate')})=>
  Ordinary.OrdinaryStateOwner.commitPairMigrated({...binding(),work,beforeWrite});
 window.consume=(receipt,work=(b,t)=>[b.get('proof'),t.get('admission')],extra={})=>
  Ordinary.OrdinaryStateOwner.consumePairCommit({...binding(),receipt,work,...extra});
 window.outcome=async work=>{try{return await work()}catch(e){return e.name}};
 window.values=async()=>{const rows=await rawBoth(),images=await Promise.all(rows.map(r=>Ordinary.openOrdinaryFrame(r.frame,r.key)));
  return [images[0].records.get('proof')??null,images[1].records.get('admission')??null]};
}`
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html',
    body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN); await page.evaluate(`(${setup})()`)
})

test('prewrite sees only freshly authenticated readonly predecessor bytes in the active two-put transaction', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
   const put=IDBObjectStore.prototype.put,getKey=IDBObjectStore.prototype.getKey;let writer,mutationToken,readToken,escaped,checks=0;
   const order=[];IDBObjectStore.prototype.getKey=function(...args){writer=this.transaction;return getKey.apply(this,args)};
   IDBObjectStore.prototype.put=function(...args){order.push(['put',this.transaction===writer]);return put.apply(this,args)};
   const result=await commit((b,t,bn,tn,c)=>{checks++;escaped=b;readToken=c;
    const imageB=new Map(b.keys().map(n=>[n,b.get(n)])),imageT=new Map(t.keys().map(n=>[n,t.get(n)]));
    const headers=Ordinary.ordinaryPairReadCustodyFor(c,imageB,imageT);
    order.push(['barrier',writer.mode,b.get('old'),t.get('old'),b.get('proof'),t.get('admission'),bn,tn,headers.browser.revision]);
    try{b.set('illegal','value');throw Error('writable')}catch(e){if(e.message==='writable')throw e}
    try{Ordinary.ordinaryPairReadCustodyFor(mutationToken,imageB,imageT);throw Error('old token survived')}catch(e){if(e.message==='old token survived')throw e}
   },(b,t,bn,tn,c)=>{mutationToken=c;b.set('proof','candidate');t.set('admission','candidate')});
   IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.getKey=getKey;
   const adopted=await consume(result.receipt,(b,t,bn,tn,c)=>{
    Ordinary.ordinaryPairReadCustodyFor(c,new Map(b.keys().map(n=>[n,b.get(n)])),new Map(t.keys().map(n=>[n,t.get(n)])));
    return [b.get('proof'),t.get('admission')]
   });
   return [result.status,Reflect.ownKeys(result).sort(),Reflect.ownKeys(result.receipt),checks,order,adopted,
    await outcome(()=>escaped.get('old')),await outcome(()=>Ordinary.ordinaryPairReadCustodyFor(readToken,new Map(),new Map()))]
  })()`)).toEqual(['committed',['receipt','status'],[],1,[
    ['barrier','readwrite','browser','tab',null,null,['legacy.fixture'],['legacy.fixture'],0],['put',true],['put',true],
  ],['candidate','candidate'],'OrdinaryStateHold','OrdinaryStateHold'])
})

for (const fault of ['throw','foreground','browser-close','tab-close','purpose','value'] as const) {
  test(`prewrite ${fault} refuses before puts without a fabricated abort or receipt`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
     const prior=await rawBoth(),put=IDBObjectStore.prototype.put;let puts=0,checks=0,closing;
     IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};
     const result=await outcome(()=>commit(()=>{checks++;
      if(fault==='throw')throw Error('refused');if(fault==='foreground')live=false;
      if(fault==='browser-close')closing=browserOwner.close();if(fault==='tab-close')closing=tabOwner.close();
      if(fault==='purpose')Object.defineProperty(tabOwner,'purpose',{get:()=>tabPurpose});if(fault==='value')return true;
     }));await closing;IDBObjectStore.prototype.put=put;tabOwner.purpose=tabPurpose;live=true;
     return [result,puts,checks,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame)),await values()]
    })('${fault}')`)).toEqual(['OrdinaryStateHold',0,1,true,[null,null]])
  })
}
for (const phase of ['mutation','prewrite','consume'] as const) {
  test(`${phase} thenable body remains owned through close and cannot release a receipt or view`, async ({ page }) => {
    await page.evaluate(`(async phase=>{
     window.phase=phase;window.checks=0;window.puts=0;window.receipt='pending';window.closure='pending';
     const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};
     const body=(b)=>{checks++;window.escaped=b;return new Promise(resolve=>window.finishBody=resolve)};
     window.restore=()=>IDBObjectStore.prototype.put=put;
     if(phase==='consume'){
      const result=await commit();window.nativeResult=result;
      window.pending=consume(result.receipt,body).then(()=>receipt='bad',e=>receipt=e.name)
     }else window.pending=commit(phase==='prewrite'?body:()=>{},phase==='mutation'?body:undefined).then(()=>receipt='bad',e=>receipt=e.name);
    })('${phase}')`)
    await page.waitForFunction('checks===1 && typeof finishBody==="function"')
    await page.evaluate('window.closing=browserOwner.close().then(()=>closure="done");undefined')
    expect(await page.evaluate('[receipt,closure]')).toEqual(['pending','pending'])
    expect(await page.evaluate('outcome(()=>escaped.get("old"))')).toBe('OrdinaryStateHold')
    await page.evaluate('finishBody();Promise.all([pending,closing])')
    expect(await page.evaluate('[receipt,closure,puts]')).toEqual(['OrdinaryStateHold','done',phase==='consume'?2:0])
    await page.evaluate('restore()')
  })
}
for (const fault of ['throw-first','throw-second','abort-second','throw-after-first-queued'] as const) {
  test(`${fault} gives definite-abort only after native proof of both unchanged rows`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
     const prior=await rawBoth(),put=IDBObjectStore.prototype.put;let puts=0,checks=0;
     IDBObjectStore.prototype.put=function(...args){puts++;
      if(fault==='throw-first'&&puts===1||fault==='throw-second'&&puts===2)throw new DOMException('quota','QuotaExceededError');
      const result=put.apply(this,args);if(fault==='abort-second'&&puts===2)this.transaction.abort();
      if(fault==='throw-after-first-queued'&&puts===1)throw Error('receipt lost after queue');return result
     };
     const result=await commit(()=>{checks++});IDBObjectStore.prototype.put=put;
     return [result,checks,(await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame)),await values()]
    })('${fault}')`)).toEqual([{status:'definite-abort'},1,true,[null,null]])
  })
}

test('an observed native abort before either put can report absence without publishing candidate material', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
   const getKey=IDBObjectStore.prototype.getKey;let once=false,checks=0;
   IDBObjectStore.prototype.getKey=function(...args){const result=getKey.apply(this,args);if(this.transaction.mode==='readwrite'&&!once){once=true;this.transaction.abort()}return result};
   const result=await commit(()=>{checks++});IDBObjectStore.prototype.getKey=getKey;
   return [result,checks,await values()]
  })()`)).toEqual([{status:'definite-abort'},0,[null,null]])
})

test('a transaction completion with only one put cannot acknowledge a committed pair', async ({ page }) => {
  await page.evaluate(`(()=>{
   const put=IDBObjectStore.prototype.put,encrypt=crypto.subtle.encrypt.bind(crypto.subtle);window.puts=0;window.encryptions=0;window.checks=0;window.receipt='pending';window.candidates=[];
   let first;IDBObjectStore.prototype.put=function(value,name){puts++;candidates.push(structuredClone(value));if(puts===2)return first;first=put.call(this,value,name);return first};
   crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)};
   window.restore=()=>{IDBObjectStore.prototype.put=put;crypto.subtle.encrypt=encrypt};
   window.pending=commit(()=>{checks++}).then(result=>{window.nativeResult=result;receipt=result.status},e=>receipt=e.name)
  })()`)
  await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
  expect(await page.evaluate('[receipt,puts,encryptions,checks]')).toEqual(['pending',2,2,1])
  await page.evaluate('restore();editBoth((_,s)=>{s.put(candidates[0],"browser");s.put(candidates[1],tabPurpose)})')
  await page.evaluate('browserOwner.retryRetention();pending')
  expect(await page.evaluate('[receipt,encryptions,checks]')).toEqual(['committed',2,1])
  expect(await page.evaluate('consume(nativeResult.receipt)')).toEqual(['candidate','candidate'])
})

for (const fault of ['prior','candidate','mixed','missing','wrong-key'] as const) {
  test(`lost acknowledgement ${fault} reconciles both exact rows without replacing frames`, async ({ page }) => {
    await page.evaluate(`(async()=>{
     window.prior=await rawBoth();const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),open=IDBFactory.prototype.open;
     const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);window.encryptions=0;window.checks=0;window.receipt='pending';let once=false;
     crypto.subtle.encrypt=async(...args)=>{encryptions++;return encrypt(...args)};
     Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this;
      if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,e=>{IDBFactory.prototype.open=function(){throw Error('offline')};tx.onabort(e)})}
      else descriptor.set.call(tx,callback)}});
     window.restore=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=open;crypto.subtle.encrypt=encrypt};
     window.pending=commit(()=>{checks++}).then(result=>{window.nativeResult=result;receipt=result.status},e=>receipt=e.name)
    })()`)
    await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
    await page.evaluate(`(async fault=>{
     restore();window.candidates=await rawBoth();
     if(fault==='prior')await editBoth((_,s)=>{s.put(prior[0],'browser');s.put(prior[1],tabPurpose)});
     if(fault==='mixed')await editBoth((_,s)=>s.put(prior[1],tabPurpose));
     if(fault==='missing')await editBoth((_,s)=>s.delete(tabPurpose));
     if(fault==='wrong-key'){const wrong=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await editBoth((r,s)=>{r[1].key=wrong;s.put(r[1],tabPurpose)})}
     browserOwner.retryRetention()
    })('${fault}')`)
    if (fault!=='prior'&&fault!=='candidate') {
      await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
      expect(await page.evaluate('[receipt,encryptions,checks]')).toEqual(['pending',2,1])
      await page.evaluate('editBoth((_,s)=>{s.put(candidates[0],"browser");s.put(candidates[1],tabPurpose)})')
      await page.evaluate('tabOwner.retryRetention()')
    }
    await page.evaluate('pending')
    expect(await page.evaluate('[receipt,encryptions,checks]')).toEqual([fault==='prior'?'definite-abort':'committed',2,1])
    expect(await page.evaluate(`(async()=>{const intended=${fault==='prior'?'prior':'candidates'};return (await rawBoth()).every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,intended[i].frame))})()`)).toBe(true)
    if (fault==='prior') expect(await page.evaluate('Reflect.ownKeys(nativeResult)')).toEqual(['status'])
    else expect(await page.evaluate('consume(nativeResult.receipt)')).toEqual(['candidate','candidate'])
  })
}

for (const fault of ['foreground','browser-close','tab-close'] as const) {
  test(`commit remains a custody fact after post-complete ${fault}, and grants no adoption`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
     const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');let once=false,closing;
     Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this;
      if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,e=>{
       if(fault==='foreground')live=false;else closing=(fault==='browser-close'?browserOwner:tabOwner).close();callback(e)
      })}else descriptor.set.call(tx,callback)}});
     const result=await commit();Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);await closing;
     let effects=0;const adopted=await outcome(()=>consume(result.receipt,()=>{effects++}));
     live=true;const replay=await outcome(()=>consume(result.receipt,()=>{effects++}));
     return [result.status,Reflect.ownKeys(result.receipt),adopted,replay,effects,await values()]
    })('${fault}')`)).toEqual(['committed',[],'OrdinaryStateHold','OrdinaryStateHold',0,['candidate','candidate']])
  })
}

for (const fault of ['forged','cloned','cross-owner','scope-name','scope-fence','scope-generation'] as const) {
  test(`${fault} receipt/binding never enters the successor callback`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
     const result=await commit();let effects=0,extra={},token=result.receipt;
     if(fault==='forged'||fault==='cloned')token=fault==='forged'?{}:structuredClone(token);
     if(fault==='cross-owner')extra={browser:{owner:new Ordinary.OrdinaryStateOwner(),scope:browserScope}};
     if(fault.startsWith('scope-'))extra={tab:{owner:tabOwner,scope:{...tabScope,...fault==='scope-name'?{name:'different'}:fault==='scope-fence'?{fence:tabScope.fence+1}:{generation:'f'.repeat(64)}}}};
     const answer=await outcome(()=>consume(token,()=>{effects++},extra));
     const replay=await outcome(()=>consume(token,()=>{effects++}));return [answer,replay,effects]
    })('${fault}')`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',0])
  })
}

test('receipt is consumed before reentrant callback code and cannot be replayed', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
   const result=await commit();let effects=0,reentrant;
   const adopted=await consume(result.receipt,(b,t)=>{effects++;reentrant=outcome(()=>consume(result.receipt,()=>{effects++}));return [b.get('proof'),t.get('admission')]});
   return [adopted,await reentrant,await outcome(()=>consume(result.receipt,()=>{effects++})),effects]
  })()`)).toEqual([['candidate','candidate'],'OrdinaryStateHold','OrdinaryStateHold',1])
})

test('successor callback refusal spends the receipt without rolling either committed row back', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
   const result=await commit();let effects=0;
   const answer=await outcome(()=>consume(result.receipt,()=>{effects++;throw new Ordinary.OrdinaryStateHold()}));
   return [answer,await outcome(()=>consume(result.receipt,()=>{effects++})),effects,await values()]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',1,['candidate','candidate']])
})

for (const fault of ['browser-frame','tab-frame','swapped','wrong-key','closed','expired','later-write'] as const) {
  test(`${fault} after commit refuses the exact successor before callback`, async ({ page }) => {
    expect(await page.evaluate(`(async fault=>{
     const result=await commit();let effects=0;
     if(fault==='browser-frame'||fault==='tab-frame')await editBoth((rows,s)=>{const i=fault==='browser-frame'?0:1;rows[i].frame.nonce=new Uint8Array(12).buffer;s.put(rows[i],i===0?'browser':tabPurpose)});
     if(fault==='swapped')await editBoth((r,s)=>{s.put(r[1],'browser');s.put(r[0],tabPurpose)});
     if(fault==='wrong-key'){const wrong=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await editBoth((r,s)=>{r[1].key=wrong;s.put(r[1],tabPurpose)})}
     if(fault==='closed')await browserOwner.close();if(fault==='expired')Date.now=()=>Date.UTC(2030,0,1);
     if(fault==='later-write')await Ordinary.OrdinaryStateOwner.mutatePairMigrated({...binding(),work:(b,t)=>{b.set('newer','yes');t.set('newer','yes')}});
     const answer=await outcome(()=>consume(result.receipt,()=>{effects++}));return [answer,effects,await outcome(()=>consume(result.receipt,()=>{effects++}))]
    })('${fault}')`)).toEqual(['OrdinaryStateHold',0,'OrdinaryStateHold'])
  })
}

for (const which of ['browser','tab'] as const) {
  test(`${which} wrong key during sealing refuses the barrier and both puts`, async ({ page, context }) => {
    const other=await context.newPage();await other.goto(ORIGIN);await other.evaluate(`(${setup})()`)
    await page.evaluate(`(()=>{
     const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),put=IDBObjectStore.prototype.put;let once=false;window.puts=0;window.checks=0;window.sealing=false;
     crypto.subtle.encrypt=async(...args)=>{if(!once){once=true;sealing=true;await new Promise(resolve=>window.resume=resolve)}return encrypt(...args)};
     IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};
     window.pending=outcome(()=>commit(()=>{checks++}));window.restore=()=>{crypto.subtle.encrypt=encrypt;IDBObjectStore.prototype.put=put}
    })()`)
    await page.waitForFunction('sealing')
    await other.evaluate(`(async which=>{const wrong=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await editBoth((r,s)=>{const i=which==='browser'?0:1;r[i].key=wrong;s.put(r[i],i===0?'browser':tabPurpose)})})('${which}')`)
    await page.evaluate('resume()');expect(await page.evaluate('pending')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('[puts,checks]')).toEqual([0,0]);await page.evaluate('restore()')
  })
}

const graphSetup = `async()=>{
 let active,expected;
 const image=(b,t,c)=>{const bm=new Map(b.keys().sort().map(n=>[n,b.get(n)])),tm=new Map(t.keys().sort().map(n=>[n,t.get(n)]));
  const h=Ordinary.ordinaryPairReadCustodyFor(c,bm,tm);return JSON.stringify([[...bm],[...tm],h.browser,h.tab,[...h.browser.fences],[...h.tab.fences]])};
 const validate=(b,t,c)=>{Ordinary.OrdinaryStateOwner.validatePairBinding(c,binding());const value=image(b,t,c);
  if(expected!==undefined&&value!==expected)throw new Ordinary.OrdinaryStateHold();expected??=value;
  Ordinary.OrdinaryStateOwner.validatePairBinding(c,binding())};
 const retain=p=>Ordinary.OrdinaryStateOwner.joinPairLifetime(browserOwner,tabOwner,p);
 const native={retain,check:()=>{if(!active)throw new Ordinary.OrdinaryStateHold();validate(active.b,active.t,active.c)},
  run:(_operation,effect)=>Ordinary.OrdinaryStateOwner.readPairMigrated({...binding(),work:(b,t,_bn,_tn,c)=>{
   const previous=active;validate(b,t,c);active={b,t,c};try{const value=effect();validate(b,t,c);return value}finally{active=previous}
  }})};
 window.workGraph=new Ordinary.OrdinaryProtocolWork(native,()=>{live=false});
 window.predecessorBoundary=(scope,b,t,c,effect)=>{const previous=active;validate(b,t,c);active={b,t,c};
  try{return workGraph.enter(scope,'prewrite',effect)}finally{active=previous}};
 window.successorBoundary=(scope,b,t,c,effect)=>{
  // Fixture composition only: these records are not a signed member lease.
  if(b.get('proof')!=='candidate'||t.get('admission')!=='candidate')throw new Ordinary.OrdinaryStateHold();
  Ordinary.OrdinaryStateOwner.validatePairBinding(c,binding());const previous=active;expected=image(b,t,c);active={b,t,c};
  try{return workGraph.enter(scope,'successor',effect)}finally{active=previous}
 };
}`

test('exact native root commits, consumes an authenticated receipt and swaps its fixture view in one callback', async ({ page }) => {
  await page.evaluate(`(${graphSetup})()`)
  expect(await page.evaluate(`(async()=>{
   window.adopted='predecessor';let checks=0,transitions=0,old;
   const root=workGraph.startRoot(async scope=>{old=scope;await workGraph.suspend(scope);workGraph.checkQuiescent(scope);
    const result=await commit((b,t,bn,tn,c)=>predecessorBoundary(scope,b,t,c,()=>{workGraph.checkTransition(scope);checks++}));
    await consume(result.receipt,(b,t,bn,tn,c)=>successorBoundary(scope,b,t,c,()=>{
     workGraph.checkTransition(scope);adopted=b.get('proof');transitions++;workGraph.checkTransition(scope)
    }));workGraph.checkQuiescent(scope);workGraph.resume(scope)
   });workGraph.execution.retainRoot(root);await root;await workGraph.join();
   const fresh=await workGraph.execution.run('fresh adopted view',()=>adopted);
   return [checks,transitions,fresh,workGraph.suspended,await outcome(()=>old.run('stale',()=>{})),await values()]
  })()`)).toEqual([1,1,'candidate',false,'OrdinaryProtocolSuspended',['candidate','candidate']])
})

test('prewrite refuses a live graph child, joins its body and performs neither candidate put', async ({ page }) => {
  await page.evaluate(`(${graphSetup})()`)
  await page.evaluate(`(()=>{
   const put=IDBObjectStore.prototype.put;window.puts=0;window.receipt='pending';window.closure='pending';window.barrierEntered=false;
   IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};window.restore=()=>IDBObjectStore.prototype.put=put;
   window.root=workGraph.startRoot(async scope=>{await workGraph.suspend(scope);
    try{await commit((b,t,bn,tn,c)=>predecessorBoundary(scope,b,t,c,()=>{
     const pending=new Promise(resolve=>window.finishChild=resolve);scope.retain(pending);barrierEntered=true;workGraph.checkTransition(scope)
    }))}catch(e){workGraph.close();throw e}
   });workGraph.execution.retainRoot(root);void root.catch(e=>receipt=e.name);
  })()`)
  await page.waitForFunction('barrierEntered')
  await page.evaluate('window.closing=Promise.all([workGraph.join(),browserOwner.close()]).then(()=>closure="done");undefined')
  expect(await page.evaluate('[puts,closure]')).toEqual([0,'pending'])
  await page.evaluate('finishChild();closing')
  expect(await page.evaluate('[puts,closure,receipt]')).toEqual([0,'done','OrdinaryStateHold'])
  expect(await page.evaluate('values()')).toEqual([null,null]);await page.evaluate('restore()')
})

test('a successor callback cannot complete the native root while it creates a child', async ({ page }) => {
  await page.evaluate(`(${graphSetup})()`)
  await page.evaluate(`(()=>{
   window.adopted='predecessor';window.entered=false;window.closure='pending';window.receipt='pending';
   window.root=workGraph.startRoot(async scope=>{await workGraph.suspend(scope);
    try{const result=await commit((b,t,bn,tn,c)=>predecessorBoundary(scope,b,t,c,()=>workGraph.checkTransition(scope)));
     await consume(result.receipt,(b,t,bn,tn,c)=>successorBoundary(scope,b,t,c,()=>{
      scope.retain(new Promise(resolve=>window.finishChild=resolve));entered=true;workGraph.checkTransition(scope);adopted='bad'
     }));workGraph.resume(scope)
    }catch(e){workGraph.close();throw e}
   });workGraph.execution.retainRoot(root);void root.catch(e=>receipt=e.name)
  })()`)
  await page.waitForFunction('entered')
  await page.evaluate('window.closing=Promise.all([workGraph.join(),browserOwner.close()]).then(()=>closure="done");undefined')
  expect(await page.evaluate('[adopted,closure]')).toEqual(['predecessor','pending'])
  await page.evaluate('finishChild();closing')
  expect(await page.evaluate('[adopted,closure,receipt]')).toEqual(['predecessor','done','OrdinaryProtocolSuspended'])
  expect(await page.evaluate('values()')).toEqual(['candidate','candidate'])
})


test('native predecessor views and owner identities cannot be replaced with callback-backed methods', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
   let ownerGetter=0,viewGetter=0;let ownerRefused=false;
   try{Object.defineProperty(browserOwner,'purpose',{get:()=>{ownerGetter++;return 'browser'}})}catch{ownerRefused=true}
   const result=await outcome(()=>commit(b=>Object.defineProperty(b,'get',{value:()=>{viewGetter++;return 'forged'}})));
   return [ownerRefused,result,ownerGetter,viewGetter,await values()]
  })()`)).toEqual([true,'OrdinaryStateHold',0,0,[null,null]])
})

test('a reentrant true selector cannot close the other owner during the final prewrite check and still put', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
   const put=IDBObjectStore.prototype.put;let armed=false,calls=0,puts=0,checks=0,closing;
   const selected=()=>{if(armed&&++calls===2)closing=browserOwner.close();return true};
   IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};
   const result=await outcome(()=>Ordinary.OrdinaryStateOwner.commitPairMigrated({...binding(),live:selected,
    work:(b,t)=>{b.set('proof','candidate');t.set('admission','candidate')},beforeWrite:()=>{checks++;armed=true}
   }));await closing;IDBObjectStore.prototype.put=put;return [result,checks,puts,await values()]
  })()`)).toEqual(['OrdinaryStateHold',1,0,[null,null]])
})

test('truthy non-boolean selectors cannot acquire native commit or successor effects', async ({ page }) => {
  expect(await page.evaluate(`(async()=>{
   let effects=0;
   const result=await outcome(()=>Ordinary.OrdinaryStateOwner.commitPairMigrated({...binding(),live:()=>1,
    work:()=>{effects++},beforeWrite:()=>{effects++}}));
   const committed=await commit();const consumed=await outcome(()=>consume(committed.receipt,()=>{effects++},{live:()=>1}));
   return [result,consumed,effects]
  })()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',0])
})
