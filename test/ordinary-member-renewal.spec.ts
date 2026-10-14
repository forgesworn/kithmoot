import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

const ORIGIN = 'https://ordinary-member-renewal.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-bootstrap.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022',
    plugins: [{ name: 'renewal-error-observation-fixture', setup(builder) {
      builder.onLoad({ filter: /ordinary-persistent-bootstrap\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = '}catch(error){\n            if(!commitStarted&&!closed){'
        if (source.split(marker).length !== 2) throw Error('renewal observation fixture marker drift')
        const operationMarker = 'try { result = await started.pending } catch (error) {'
        if (source.split(operationMarker).length !== 2) throw Error('operation observation fixture marker drift')
        return { loader: 'ts', contents: source.replace(marker,
          '}catch(error){\n            (globalThis as any).renewalError = {name:(error as Error).name,stack:(error as Error).stack};\n            if(!commitStarted&&!closed){').replace(operationMarker,
          operationMarker + '\n            (globalThis as any).operationError = {operation,name:(error as Error).name,message:(error as Error).message};') }
      })
    } }] })).outputFiles[0]!.text
})
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html',
    body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN)
  await page.clock.install()
  // Cold admission includes actual retained-seal verification/decryption.
  // This positive security fixture is not a one-second performance gate.
  await page.evaluate('window.memberEpochTimeoutMs=10000')
})
async function start(page: Page, visitor = false, keep = true) {
  await page.evaluate(`(${setup})(${JSON.stringify({ visitor, keep, noRelays: true })})`)
  await page.evaluate(`(${controls})()`)
  await page.evaluate('join()')
}
async function seals(page: Page, length: number) {
  await expect.poll(() => page.evaluate(async count => {
    const w = window as any
    try {
      const current = await w.bootstrap.load()
      try { return current.sealKeys?.length === count } finally { w.Ordinary.wipeOrdinaryPersistentBootstrapResult(current) }
    } catch { return false }
  }, length)).toBe(true)
}

test('projection validation cannot manufacture read custody or foreground signing authority', async ({ page }) => {
  await start(page)
  expect(await page.evaluate(`(async()=>{const s=await scopes(),beforeSigns=signCalls,beforeEntropy=randomness.length;
    const answer=await Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,
      work:(b,t,_bn,_tn,c)=>{const bm=new Map(b.keys().map(n=>[n,b.get(n)])),tm=new Map(t.keys().map(n=>[n,t.get(n)])),proposed=new Map(bm);
        proposed.set('projection-only','inert');const context=Ordinary.captureOrdinaryProjectedSnapshotContext(bm,tm,c,proposed,tm);
        Ordinary.validateOrdinarySnapshot(proposed,tm,{browser:true,tab:true},context);
        let readHeld=false,signHeld=false;
        try{Ordinary.ordinaryPairReadCustodyFor(c,proposed,tm)}catch(e){readHeld=e.name==='OrdinaryStateHold'};
        const readonly=records=>({get:n=>records.get(n)??null,keys:()=>[...records.keys()],set:()=>{throw Error('readonly')},remove:()=>{throw Error('readonly')}});
        try{Ordinary.OrdinaryForegroundSigner.nativeDeadline(identity,readonly(proposed),readonly(tm),c,participant)}catch(e){signHeld=e.name==='OrdinaryStateHold'};
        Ordinary.ordinaryPairReadCustodyFor(c,bm,tm);return[readHeld,signHeld]
      }});return[...answer,signCalls===beforeSigns,randomness.length===beforeEntropy]})()`)).toEqual([true,true,true,true])
  await page.evaluate('member.close()')
})

for (const visitor of [true, false]) for (const keep of [true, false]) {
  test(`two actual renewals survive bootstrap expiry and cold reopen, visitor=${visitor}, keep=${keep}`, async ({ page }) => {
    test.setTimeout(60_000)
    await start(page, visitor, keep)
    await page.evaluate('(async()=>{window.channel=await member.channel("continuous");window.oldDevice=member.device})()')
    for (const count of [2, 3]) {
      await page.clock.fastForward(901_000)
      await seals(page, count)
      await page.evaluate(`member.send('renewal ${count}')`)
      await page.evaluate(`channel.send('channel ${count}')`)
    }
    expect(await page.evaluate(`(async()=>{const current=await bootstrap.load();try{return[
      Math.floor(Date.now()/1000)>credentialExpiresAt,member.device===oldDevice,current.sealKeys.length,
      Number(current.credential.tags[2][1])<=now+3600,signCalls,
      (await member.messages()).some(m=>m.text==='renewal 3'),(await channel.messages()).some(m=>m.text==='channel 3'),frames.every(row=>row[1])
    ]}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(current)}})()`))
      .toEqual([true, true, 3, true, visitor ? 0 : 3, true, true, true])
    await page.evaluate(`(async()=>{await member.close();await bootstrap.close();bootstrap=await open();
      const current=await bootstrap.load();ownCredential=current.credential;Ordinary.wipeOrdinaryPersistentBootstrapResult(current);
      member=await bootstrap.openMemberSession(sessionOptions);try{await member.join()}catch(error){throw Error(JSON.stringify(window.operationError))};await member.send('cold successor')})()`)
    expect(await page.evaluate('(async()=>[member.device===oldDevice,(await member.messages()).some(m=>m.text==="cold successor")])()'))
      .toEqual([true, true])
    await page.evaluate('member.close()')
  })
}

for (const lifetime of ['member', 'bootstrap', 'forget', 'browser', 'tab']) {
  test(`${lifetime} close joins an unabortable renewal signer and releases no replacement`, async ({ page }) => {
    await start(page)
    await page.evaluate('(async()=>{window.before=await records();gateSigner()})()')
    await page.clock.fastForward(901_000)
    await page.waitForFunction('signing')
    const close = lifetime === 'forget' ? 'bootstrap.forget()' :
      (lifetime === 'member' || lifetime === 'bootstrap' ? lifetime : lifetime + 'Owner') + '.close()'
    await page.evaluate(`window.closeState='pending';window.closing=${close}.then(()=>closeState='ok');undefined`)
    expect(await page.evaluate('closeState')).toBe('pending')
    await page.evaluate('releaseSigner();undefined')
    await page.evaluate('closing')
    expect(await page.evaluate('[closeState,signCalls,sockets.every(s=>s.readyState===3),frames.filter(r=>r[0][0]==="EVENT"&&r[0][1].kind===20460).length]'))
      .toEqual(['ok', 2, true, 0])
    if (lifetime !== 'forget') expect(await page.evaluate('(async()=>JSON.stringify(before)===JSON.stringify(await records()))()')).toBe(true)
    await page.evaluate('member.close()')
  })
}

for (const fault of ['reject', 'restamp', 'wrong-device', 'signature']) {
  test(`renewal signer ${fault} cannot persist a changed template`, async ({ page }) => {
    await start(page)
    await page.evaluate(`(()=>{window.before=undefined;signHook=event=>{
      if('${fault}'==='reject')return Promise.reject(Error('user declined'));
      if('${fault}'==='restamp')return signer.call(identity,{...event,created_at:event.created_at+1});
      if('${fault}'==='wrong-device')return signer.call(identity,{...event,tags:event.tags.map(t=>t[0]==='device'?['device','b'.repeat(64)]:t)});
      return signer.call(identity,event).then(signed=>({...signed,sig:'0'.repeat(128)}))
    }})()`)
    await page.evaluate('(async()=>{window.before=await records();window.oldEntropy=randomness.length})()')
    await page.clock.fastForward(901_000)
    await page.waitForFunction('signCalls===2')
    // This native read queues behind the entire failed signing handoff.
    expect(await page.evaluate('(async()=>JSON.stringify(before)===JSON.stringify(await records()))()')).toBe(true)
    await page.evaluate('member.close()')
    expect(await page.evaluate('[signCalls,sockets.every(s=>s.readyState===3)]')).toEqual([2, true])
  })
}

for (const fault of ['throw-first', 'throw-second', 'abort-second']) {
  test(`typed ${fault} abort preserves predecessor and resumes live chat`, async ({ page }) => {
    await start(page)
    await page.evaluate(`(async()=>{window.before=await rawBoth();const put=IDBObjectStore.prototype.put;window.puts=0;
      IDBObjectStore.prototype.put=function(...args){puts++;
        if('${fault}'==='throw-first'&&puts===1||'${fault}'==='throw-second'&&puts===2){IDBObjectStore.prototype.put=put;throw new DOMException('quota','QuotaExceededError')}
        const result=put.apply(this,args);if('${fault}'==='abort-second'&&puts===2){IDBObjectStore.prototype.put=put;this.transaction.abort()}return result
      };window.restorePut=()=>{IDBObjectStore.prototype.put=put}})()`)
    await page.clock.fastForward(901_000)
    await page.waitForFunction('puts>0')
    expect(await page.evaluate('(async()=>{const after=await rawBoth();return after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))})()')).toBe(true)
    await expect.poll(() => page.evaluate('member.send("after definite abort").then(()=>true,()=>false)')).toBe(true)
    expect(await page.evaluate('(async()=>[(await member.messages()).some(m=>m.text==="after definite abort"),signCalls,frames.every(row=>row[1])])()'))
      .toEqual([true, 2, true])
    await page.evaluate('restorePut();member.close()')
  })
}

for (const keep of [true, false]) for(const slots of [0,1]) {
  test(`native image with ${slots} free slots refuses staged renewal before seal entropy or signing, keep=${keep}`, async ({ page }) => {
    await page.evaluate(`(${setup})(${JSON.stringify({ visitor: false, keep, noRelays: true })})`)
    await page.evaluate('window.deferMemberCreation=true')
    await page.evaluate(`(${controls})()`)
    // Allow for the browser round trip while its installed clock is still running.
    await page.clock.pauseAt(new Date(await page.evaluate('Date.now()+1000')))
    await page.evaluate(`(async()=>{const s=await scopes(),owner=${keep ? 'browserOwner' : 'tabOwner'},scope=${keep ? 's.b' : 's.t'};
      await owner.mutateMigrated(scope,guard,store=>{const needed=16384-${slots}-store.keys().length;
        for(let i=0;i<needed;i++)store.set('capacity-fixture-'+String(i).padStart(5,'0'),'x')});
      await bootstrap.close();bootstrap=await open();member=await bootstrap.openMemberSession(sessionOptions);await member.join();window.before=await rawBoth();window.beforeEntropy=randomness.length})()`)
    await page.clock.fastForward(901_000)
    expect(await page.evaluate('(async()=>{const after=await rawBoth();return[signCalls,randomness.length===beforeEntropy,after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))]})()'))
      .toEqual([1, true, true])
    await page.evaluate('member.close()')
  })
}

test('a late renewal timer cannot commit a successor below the cold-reopen floor', async ({ page }) => {
  await start(page)
  // Heartbeats remain legitimate before the renewal latch. Count actual seal
  // allocation, and prove this observer sees the first successful renewal.
  await page.evaluate(`(()=>{const random=crypto.getRandomValues.bind(crypto);window.sealAllocations=0;
    crypto.getRandomValues=(...args)=>{if(new Error().stack.includes('generateSealKey'))sealAllocations++;return random(...args)}})()`)
  await page.clock.fastForward(1_700_000)
  await seals(page, 2)
  await page.evaluate('member.send("late first successor")')
  expect(await page.evaluate('sealAllocations')).toBe(1)
  await page.evaluate('(async()=>{window.before=await rawBoth()})()')
  await page.clock.fastForward(1_501_000)
  expect(await page.evaluate('(async()=>{const after=await rawBoth();return[signCalls,sealAllocations,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]})()'))
    .toEqual([2, 1, true])
  await page.evaluate('member.close()')
})

for (const closing of [false, true]) for (const mixed of [false, true]) {
  test(`unknown renewal acknowledgement owns the same candidate through reconciliation, closing=${closing}, mixed=${mixed}`, async ({ page }) => {
    await start(page)
    await page.evaluate('(async()=>{window.priorRows=await rawBoth()})()')
    await page.evaluate(`(()=>{
      const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),open=IDBFactory.prototype.open;
      const put=IDBObjectStore.prototype.put;window.puts=0;window.candidates=[];let once=false;
      IDBObjectStore.prototype.put=function(value,name){puts++;candidates.push(structuredClone(value));return put.call(this,value,name)};
      Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this;
        if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,event=>{
          IDBFactory.prototype.open=function(){throw Error('fixture offline')};tx.onabort(event)
        })}else descriptor.set.call(tx,callback)}});
      window.restoreAck=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=open;IDBObjectStore.prototype.put=put}
    })()`)
    await page.clock.fastForward(901_000)
    await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
    expect(await page.evaluate('[signCalls,puts,sockets.every(s=>s.readyState===3)]')).toEqual([2, 2, true])
    await page.evaluate('window.heldFrames=frames.length;window.heldEntropy=randomness.length')
    // While acknowledgement is unknown, time and attempted outgoing work
    // cannot create another signer, seal, frame pair or relay generation.
    await page.clock.fastForward(10_000)
    expect(await page.evaluate('member.send("unknown must stay private").then(()=>false,()=>true)')).toBe(true)
    expect(await page.evaluate('[signCalls,puts,frames.length===heldFrames,randomness.length===heldEntropy]')).toEqual([2, 2, true, true])
    if (closing) {
      await page.evaluate('window.closeState="pending";window.closing=member.close().then(()=>closeState="ok");undefined')
      expect(await page.evaluate('closeState')).toBe('pending')
    }
    await page.evaluate(`(()=>{restoreAck();window.editRows=work=>new Promise((resolve,reject)=>{
      const request=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const db=request.result,tx=db.transaction('owners','readwrite');work(tx.objectStore('owners'));
        tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}}})})()`)
    if (mixed) {
      await page.evaluate('editRows(store=>store.put(priorRows[1],tabPurpose))')
      await page.evaluate('browserOwner.retryRetention();undefined')
      await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
      expect(await page.evaluate('[signCalls,puts,frames.length===heldFrames,randomness.length===heldEntropy]')).toEqual([2, 2, true, true])
      if (closing) expect(await page.evaluate('closeState')).toBe('pending')
      await page.evaluate('editRows(store=>{store.put(candidates[0],"browser");store.put(candidates[1],tabPurpose)})')
    }
    await page.evaluate('browserOwner.retryRetention();undefined')
    if (closing) {
      await page.evaluate('closing')
      expect(await page.evaluate('[closeState,signCalls,frames.length===heldFrames,sockets.every(s=>s.readyState===3)]'))
        .toEqual(['ok', 2, true, true])
      await page.evaluate(`(async()=>{await bootstrap.close();bootstrap=await open();const current=await bootstrap.load();
        ownCredential=current.credential;window.sealCount=current.sealKeys.length;Ordinary.wipeOrdinaryPersistentBootstrapResult(current);
        member=await bootstrap.openMemberSession(sessionOptions);await member.join();await member.send('reconciled cold reopen')})()`)
      expect(await page.evaluate('[sealCount,signCalls]')).toEqual([2, 2])
    } else {
      await seals(page, 2)
      await page.evaluate('member.send("reconciled live successor")')
      expect(await page.evaluate('[signCalls,frames.every(row=>row[1])]')).toEqual([2, true])
    }
    expect(await page.evaluate('(async()=>{const rows=await rawBoth();return rows.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,candidates[i].frame))})()')).toBe(true)
    await page.evaluate('member.close()')
  })
}

for (const phase of ['prewrite', 'abort-resume']) {
  test(`Fore revocation at ${phase} terminally refuses without replacing the predecessor`, async ({ page }) => {
    await start(page)
    await page.evaluate(`(async()=>{
      window.before=await rawBoth();window.revoked=false;
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),put=IDBObjectStore.prototype.put;let once=false;
      if('${phase}'==='prewrite')crypto.subtle.encrypt=async(...args)=>{if(!once){once=true;revoked=true;identity.revoke()}return encrypt(...args)};
      else IDBObjectStore.prototype.put=function(...args){if(!once){once=true;revoked=true;identity.revoke();throw new DOMException('quota','QuotaExceededError')}return put.apply(this,args)};
      window.restoreFault=()=>{crypto.subtle.encrypt=encrypt;IDBObjectStore.prototype.put=put}
    })()`)
    await page.clock.fastForward(901_000)
    await page.waitForFunction('revoked&&sockets.every(s=>s.readyState===3)')
    await page.evaluate('member.close();restoreFault()')
    expect(await page.evaluate('(async()=>{const after=await rawBoth();return[signCalls,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]})()'))
      .toEqual([2, true])
  })
}

for (const keep of [true, false]) for (const safe of [true, false]) {
  test(`128-seal history ${safe ? 'prunes only a retired seal' : 'holds rather than prune the current seal'}, keep=${keep}`, async ({ page }) => {
    test.setTimeout(180_000)
    await start(page, false, keep)
    await page.clock.fastForward(901_000)
    await seals(page, 2)
    await page.evaluate('member.send("first seal generation")')
    // Allow for the browser round trip while its installed clock is still running.
    await page.clock.pauseAt(new Date(await page.evaluate('Date.now()+1000')))
    await page.evaluate(`(async()=>{
      await member.close();await bootstrap.close();
      await pair((b,t)=>{const owner=${keep ? 'b' : 't'},name=prefix+Ordinary.OWN_SEAL_PREFIX+roomId,existing=JSON.parse(owner.get(name));
        const extras=Array.from({length:126},(_,i)=>(i+101).toString(16).padStart(64,'0'));
        owner.set(name,JSON.stringify(${safe ? '[existing[0],...extras,existing[1]]' : '[existing[1],existing[0],...extras]'}))});
      bootstrap=await open();const current=await bootstrap.load();ownCredential=current.credential;
      window.previousCredential=current.credential.id;Ordinary.wipeOrdinaryPersistentBootstrapResult(current);
      member=await bootstrap.openMemberSession(sessionOptions);await member.join();window.before=await rawBoth();window.beforeEntropy=randomness.length
    })()`)
    await page.evaluate(`(()=>{const random=crypto.getRandomValues.bind(crypto);window.sealAllocations=0;
      crypto.getRandomValues=(...args)=>{if(new Error().stack.includes('generateSealKey'))sealAllocations++;return random(...args)}})()`)
    await page.clock.fastForward(901_000)
    if (safe) {
      await expect.poll(() => page.evaluate(`(async()=>{try{const current=await bootstrap.load();try{return {changed:current.credential.id!==previousCredential&&current.sealKeys.length===128,signCalls,error:window.renewalError}}
        finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(current)}}catch{return {changed:false,signCalls,error:window.renewalError}}})()`), { timeout: 60_000 }).toEqual(expect.objectContaining({changed:true}))
      await page.evaluate('member.send("bounded new seal")')
      expect(await page.evaluate('(async()=>[signCalls,sealAllocations,(await member.messages()).some(m=>m.text==="bounded new seal"),frames.every(r=>r[1])])()'))
        .toEqual([3, 1, true, true])
    } else {
      expect(await page.evaluate('(async()=>{const after=await rawBoth();return[signCalls,sealAllocations,after.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,before[i].frame))]})()'))
        .toEqual([2, 0, true])
    }
    await page.evaluate('member.close()')
  })
}


for(const changed of ['migration-names','unrelated-fence']){
  test(`complete predecessor digest refuses ${changed} change during actual provider wait`,async({page})=>{
    await start(page)
    await page.evaluate(`gateSigner()`);await page.clock.fastForward(901000);await page.waitForFunction('signing')
    await page.evaluate(`(async()=>{
      const [b,t]=await rawBoth(),image=await Ordinary.openOrdinaryFrame(b.frame,b.key);
      if('${changed}'==='migration-names')image.migration.names.push('retained-inert-source');else image.fences.set('unrelated-retained-fence',0);
      const changed={key:b.key,frame:await Ordinary.sealOrdinaryImage(image,b.key)};
      const db=await new Promise(resolve=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onsuccess=()=>resolve(r.result)}),tx=db.transaction('owners','readwrite');
      tx.objectStore('owners').put(changed,'browser');await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();
      window.exactChanged=changed;window.originalTab=t;window.writesAfterChange=0;const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args){writesAfterChange++;return put.apply(this,args)};window.restoreDigestCut=()=>IDBObjectStore.prototype.put=put;
    })()`)
    await page.evaluate('releaseSigner();undefined')
    await page.evaluate('member.close()')
    expect(await page.evaluate(`(async()=>{const [b,t]=await rawBoth();return [signCalls,writesAfterChange,
      Ordinary.sameOrdinaryFrame(b.frame,exactChanged.frame),Ordinary.sameOrdinaryFrame(t.frame,originalTab.frame),
      frames.filter(row=>row[0][0]==='EVENT'&&row[0][1].kind===20460).length]})()`))
      .toEqual([2,0,true,true,0])
    await page.evaluate('restoreDigestCut()')
  })
}
