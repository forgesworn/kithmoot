import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

const ORIGIN = 'https://ordinary-member-renewal.kithmoot.test'
let bundle = ''
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: [fileURLToPath(new URL('./ordinary-renewal-enrollment.browser-entry.ts', import.meta.url))],
    bundle: true, format: 'iife', globalName: 'Ordinary', platform: 'browser', write: false, target: 'es2022',
    plugins: [{ name: 'renewal-error-observation-fixture', setup(builder) {
      builder.onLoad({ filter: /ordinary-persistent-bootstrap\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = '}catch(error){\n            if(!commitStarted&&!closed){'
        if (source.split(marker).length !== 2) throw Error('renewal observation fixture marker drift')
        const settledMarker = '            settled=await OrdinaryStateOwner.settleMemberRenewalCandidate(candidate)\n'
        if (source.split(settledMarker).length !== 2) throw Error('settlement observation fixture marker drift')
        const postReadMarker='              if(nativeView!.snapshot().credential.id!==credential!.id)hold()'
        const resumeMarker='            // A new generation owns restatement; it cannot sit below the'
        if(source.split(postReadMarker).length!==2||source.split(resumeMarker).length!==2)throw Error('post-adoption observation marker drift')
        const checks=[['session','nativeView!.check(plan!);'],['carrier','OrdinaryRelayCarrier.checkSuccessor(carrier!,carrierPlan!,b,t,c)'],
          ['receipt','                  OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settled!,c)'],
          ['role','                  validateOrdinaryRenewalSettledCandidate(obligation!,b,t,c)'],
          ['fore','                  if(this.#options.account!==null&&OrdinaryForegroundSigner.nativeDeadline(']]
        let observed=source.replace(postReadMarker,'              ;(globalThis as any).beforeAdoptedRead?.()\n'+postReadMarker)
        const beforeResume='            if (!memberLive()) hold()\n            protocol!.work.resume(root)\n'+resumeMarker
        if(observed.split(beforeResume).length!==2)throw Error('post-adoption memberLive marker drift')
        observed=observed.replace(beforeResume,'            ;(globalThis as any).afterAdoptedRead?.()\n'+beforeResume)
        for(const [point,marker]of checks){if(observed.split(marker).length!==2)throw Error('native check marker drift '+point)
          observed=observed.replace(marker,`;((globalThis as any).adoptionCheck)?.('${point}');`+marker)}
        const operationMarker = 'try { result = await started.pending } catch (error) {'
        if (source.split(operationMarker).length !== 2) throw Error('operation observation fixture marker drift')
        return { loader: 'ts', contents: observed.replace(settledMarker, settledMarker+'            ;(globalThis as any).afterSettlement?.(settled)\n').replace(marker,
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
  await page.evaluate(`(()=>{
    window.readRenewalRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();
      tx.oncomplete=()=>{db.close();resolve(new Map(keys.result.map((key,i)=>[key,values.result[i]])))};tx.onabort=()=>reject(tx.error)}});
    window.renewalState=async()=>{
      const rows=await readRenewalRows(),br=rows.get('browser'),tr=rows.get(tabPurpose),names=Ordinary.ordinaryOperationNames(tabPurpose);
      if(!rows.has(names.control))return {phase:null};
      const b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
      const j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});
      try{const result={phase:j.phase,result:j.result,secretCount:j.secrets.length,nonces:j.nonces,request:j.request,id:j.id,sequence:j.sequence,
        source:j.source,target:j.target,targetRevisions:j.targetRevisions,requestDigest:j.requestDigest,resultDigest:j.resultDigest,rows:rows.size,
        markers:[b.records.get(names.marker),t.records.get(names.marker)],revisions:[b.revision,t.revision]};
        if(j.phase!=='candidate-committed'&&j.phase!=='settled'){
          Ordinary.restoreOrdinaryRenewalPredecessor(b,t,j.request,{id:j.id,sequence:j.sequence});result.predecessorRecords=[...b.records];result.predecessorTabRecords=[...t.records]
        }
        return result;
      }finally{j.secrets.forEach(key=>key.fill(0))}
    }
  })()`)
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
    await page.evaluate(`window.closeState='pending';window.closing=${close}.then(()=>closeState='ok',error=>closeState=error.name);undefined`)
    expect(await page.evaluate('closeState')).toBe('pending')
    await page.evaluate('releaseSigner();undefined')
    await page.evaluate('closing')
    expect(await page.evaluate('[closeState,signCalls,sockets.every(s=>s.readyState===3),frames.filter(r=>r[0][0]==="EVENT"&&r[0][1].kind===20460).length]'))
      .toEqual([lifetime==='forget'?'OrdinaryStateHold':'ok', 2, true, 0])
    expect(await page.evaluate(`(async()=>{const j=await renewalState();return [j.phase,j.result!==null,j.secretCount,j.rows,
      JSON.stringify([j.predecessorRecords,j.predecessorTabRecords])===JSON.stringify(before)]})()`)).toEqual(['provider-returned',true,1,3,true])
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
    await page.evaluate('member.close()')
    expect(await page.evaluate(`(async()=>{const j=await renewalState();return [j.phase,j.result,j.secretCount,j.rows,
      JSON.stringify([j.predecessorRecords,j.predecessorTabRecords])===JSON.stringify(before),await outcome(()=>bootstrap.load())]})()`))
      .toEqual(['provider-started',null,1,3,true,'OrdinaryStateHold'])
    expect(await page.evaluate('[signCalls,sockets.every(s=>s.readyState===3)]')).toEqual([2, true])
  })
}

for (const fault of ['throw-first', 'throw-second', 'throw-third', 'abort-second']) {
  test(`typed ${fault} abort preserves predecessor and resumes live chat`, async ({ page }) => {
    await start(page)
    await page.evaluate(`(async()=>{window.before=await rawBoth();const put=IDBObjectStore.prototype.put;window.puts=0;
      IDBObjectStore.prototype.put=function(...args){puts++;
        if('${fault}'==='throw-first'&&puts===1||'${fault}'==='throw-second'&&puts===2||'${fault}'==='throw-third'&&puts===3){IDBObjectStore.prototype.put=put;throw new DOMException('quota','QuotaExceededError')}
        const result=put.apply(this,args);if('${fault}'==='abort-second'&&puts===2){IDBObjectStore.prototype.put=put;this.transaction.abort()}return result
      };window.restorePut=()=>{IDBObjectStore.prototype.put=put}})()`)
    await page.clock.fastForward(901_000)
    await page.waitForFunction('puts>0')
    expect(await page.evaluate('(async()=>{const after=await rawBoth();return after.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,before[i].frame))})()')).toBe(true)
    await expect.poll(() => page.evaluate('member.send("after definite abort").then(()=>true,()=>false)')).toBe(true)
    expect(await page.evaluate('(async()=>[(await member.messages()).some(m=>m.text==="after definite abort"),signCalls,frames.every(row=>row[1])])()'))
      .toEqual([true, 1, true])
    expect(await page.evaluate('renewalState().then(j=>j.phase)')).toBe(null)
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
  test(`unknown enrollment acknowledgement owns the same E cohort through reconciliation, closing=${closing}, mixed=${mixed}`, async ({ page }) => {
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
    expect(await page.evaluate('[signCalls,puts,sockets.every(s=>s.readyState===3)]')).toEqual([1, 3, true])
    await page.evaluate('window.heldFrames=frames.length;window.heldEntropy=randomness.length')
    // While acknowledgement is unknown, time and attempted outgoing work
    // cannot create another signer, seal, frame pair or relay generation.
    await page.clock.fastForward(10_000)
    expect(await page.evaluate('member.send("unknown must stay private").then(()=>false,()=>true)')).toBe(true)
    expect(await page.evaluate('[signCalls,puts,frames.length===heldFrames,randomness.length===heldEntropy]')).toEqual([1, 3, true, true])
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
      expect(await page.evaluate('[signCalls,puts,frames.length===heldFrames,randomness.length===heldEntropy]')).toEqual([1, 3, true, true])
      if (closing) expect(await page.evaluate('closeState')).toBe('pending')
      await page.evaluate('editRows(store=>{store.put(candidates[0],"browser");store.put(candidates[1],tabPurpose)})')
    }
    await page.evaluate('browserOwner.retryRetention();undefined')
    if (closing) {
      await page.evaluate('closing')
      expect(await page.evaluate('[closeState,signCalls,frames.length===heldFrames,sockets.every(s=>s.readyState===3)]'))
        .toEqual(['ok', 1, true, true])
      expect(await page.evaluate(`(async()=>{const j=await renewalState();return [j.phase,j.result,j.secretCount,await outcome(()=>open())]})()`))
        .toEqual(['prepared',null,0,'OrdinaryStateHold'])
    } else {
      await seals(page, 2)
      await page.evaluate('member.send("reconciled live successor")')
      expect(await page.evaluate('[signCalls,frames.every(row=>row[1])]')).toEqual([2, true])
    }
    if(closing)expect(await page.evaluate('(async()=>{const rows=await rawBoth();return rows.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,candidates[i].frame))})()')).toBe(true)
    else expect(await page.evaluate('renewalState().then(j=>[j.phase,j.secretCount,j.result,j.request,j.nonces])')).toEqual(['settled',0,null,'',null])
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
      .toEqual([1, true])
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
  test(`changed E ${changed} retains provider completion until exact source repair`,async({page})=>{
    await start(page)
    await page.evaluate('gateSigner()');await page.clock.fastForward(901000);await page.waitForFunction('signing')
    await page.evaluate(`(async()=>{
      const [b,t]=await rawBoth();window.exactE=[b,t];const image=await Ordinary.openOrdinaryFrame(b.frame,b.key);
      if('${changed}'==='migration-names')image.migration.names.push('retained-inert-source');else image.fences.set('unrelated-retained-fence',0);
      const changed={key:b.key,frame:await Ordinary.sealOrdinaryImage(image,b.key)};
      window.editRows=work=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
        const db=r.result,tx=db.transaction('owners','readwrite');work(tx.objectStore('owners'));tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)}});
      await editRows(store=>store.put(changed,'browser'));
      window.exactChanged=changed;window.writesAfterChange=0;const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args){writesAfterChange++;return put.apply(this,args)};window.restoreDigestCut=()=>IDBObjectStore.prototype.put=put;
    })()`)
    await page.evaluate('releaseSigner();undefined')
    await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
    await page.evaluate('window.closeState="pending";window.closing=member.close().then(()=>closeState="ok");undefined')
    expect(await page.evaluate(`(async()=>{const [b,t]=await rawBoth();return [closeState,signCalls,writesAfterChange,
      Ordinary.sameOrdinaryFrame(b.frame,exactChanged.frame),Ordinary.sameOrdinaryFrame(t.frame,exactE[1].frame),
      frames.filter(row=>row[0][0]==='EVENT'&&row[0][1].kind===20460).length]})()`)).toEqual(['pending',2,0,true,true,0])
    await page.evaluate('restoreDigestCut();editRows(store=>store.put(exactE[0],"browser"))')
    await page.evaluate('browserOwner.retryRetention();undefined');
    await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention');
    expect(await page.evaluate('closeState')).toBe('pending');
    await page.evaluate('browserOwner.retryRetention();undefined');await page.evaluate('closing')
    expect(await page.evaluate(`(async()=>{const j=await renewalState(),[b,t]=await rawBoth();return [closeState,signCalls,j.phase,j.result!==null,
      Ordinary.sameOrdinaryFrame(b.frame,exactE[0].frame),Ordinary.sameOrdinaryFrame(t.frame,exactE[1].frame),
      frames.filter(row=>row[0][0]==='EVENT'&&row[0][1].kind===20460).length]})()`)).toEqual(['ok',2,'provider-returned',true,true,true,0])
  })
}

for(const visitor of [false,true])for(const keep of [false,true]){
  test(`settled receipt requires exact live read custody, visitor=${visitor}, keep=${keep}`,async({page})=>{
    await start(page,visitor,keep)
    await page.evaluate('window.afterSettlement=receipt=>{window.settledReceipt=receipt}')
    await page.clock.fastForward(901000);await seals(page,2)
    // Drain normal credential restatement before isolating validation entropy.
    // A custody receipt grants no permission to resume this closed controller.
    await page.evaluate('member.close()')
    expect(await page.evaluate(`(async()=>{const scopesNow=await scopes(),prior=await rawBoth(),entropy=randomness.length,signs=signCalls;
      const input={browser:{owner:browserOwner,scope:scopesNow.b},tab:{owner:tabOwner,scope:scopesNow.t},live:guard};let saved,getters=0;
      const forged={get enrollment(){getters++;throw Error('never invoked')}};
      const valid=await Ordinary.OrdinaryStateOwner.readPairMigrated({...input,work:(_b,_t,_bn,_tn,c)=>{
        saved=c;Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settledReceipt,c);return true}});
      const expired=await outcome(()=>Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settledReceipt,saved));
      const fake=await Ordinary.OrdinaryStateOwner.readPairMigrated({...input,work:(_b,_t,_bn,_tn,c)=>outcomeSync(forged,c)});
      const mutation=await outcome(()=>Ordinary.OrdinaryStateOwner.mutatePairMigrated({...input,work:(_b,_t,_bn,_tn,c)=>{
        Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settledReceipt,c)}}));
      const nowRows=await rawBoth(),j=await renewalState();return [valid,expired,fake,mutation,getters,randomness.length===entropy,signCalls===signs,
        nowRows.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,prior[i].frame)),j.phase,j.secretCount,j.result,j.request,j.nonces];
      function outcomeSync(receipt,c){try{Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(receipt,c);return 'bad'}catch(e){return e.name}}
    })()`)).toEqual([true,'OrdinaryStateHold','OrdinaryStateHold','OrdinaryStateHold',0,true,true,true,'settled',0,null,'',null])
    await page.evaluate('member.close()')
  })
}
for(const cut of ['fore','selection','member','browser','tab','session-selection']){
  test(`current ${cut} revocation after S refuses adoption and retains settled custody`,async({page})=>{
    await start(page)
    await page.evaluate(`window.priorFrames=frames.length;window.afterSettlement=receipt=>{
      window.cutReached=true;window.cutEntropy=randomness.length;window.settledReceipt=receipt;
      if('${cut}'==='fore')identity.revoke();else if('${cut}'==='selection')current={...current,keep:!keep};
      else if('${cut}'==='session-selection')sessionSelected=false;else{
        const owner='${cut}'==='member'?member:'${cut}'==='browser'?browserOwner:tabOwner;window.cutClosing=owner.close();void cutClosing.catch(()=>{})
      }};`)
    await page.clock.fastForward(901000);await page.waitForFunction('window.cutReached&&sockets.every(s=>s.readyState===3)')
    await page.evaluate('member.close()')
    expect(await page.evaluate(`(async()=>{const j=await renewalState();return [j.phase,j.secretCount,j.result,j.request,j.nonces,signCalls,
      frames.length===priorFrames,randomness.length===cutEntropy,await member.send('must remain private').then(()=>false,()=>true)]})()`))
      .toEqual(['settled',0,null,'',null,2,true,true,true])
  })
}

for(const cut of ['read','member-live']){
  test(`post-adoption ${cut} refusal closes terminally and permits cold reopen from S`,async({page})=>{
    await start(page)
    await page.evaluate(`window.priorFrames=frames.length;window.${cut==='read'?'beforeAdoptedRead':'afterAdoptedRead'}=()=>{
      window.postCutReached=true;window.postCutEntropy=randomness.length;sessionSelected=false
    }`)
    await page.clock.fastForward(901000);await page.waitForFunction('window.postCutReached&&sockets.every(s=>s.readyState===3)')
    await page.evaluate('member.close()')
    expect(await page.evaluate(`(async()=>{const j=await renewalState();return [j.phase,signCalls,frames.length===priorFrames,
      randomness.length===postCutEntropy,await member.send('terminal generation').then(()=>false,()=>true)]})()`)).toEqual(['settled',2,true,true,true])
    await page.evaluate(`(async()=>{beforeAdoptedRead=undefined;afterAdoptedRead=undefined;sessionSelected=true;await bootstrap.close();bootstrap=await open();
      const result=await bootstrap.load();ownCredential=result.credential;Ordinary.wipeOrdinaryPersistentBootstrapResult(result);
      member=await bootstrap.openMemberSession(sessionOptions);await member.join();await member.send('cold S generation')})()`)
    expect(await page.evaluate('(async()=>[signCalls,(await member.messages()).some(m=>m.text==="cold S generation")])()')).toEqual([2,true])
    await page.evaluate('member.close()')
  })
}
for(const visitor of [false,true]){
  test(`old settled receipt refuses renewal N plus one, visitor=${visitor}`,async({page})=>{
    await start(page,visitor)
    await page.evaluate('window.receipts=[];window.afterSettlement=receipt=>receipts.push(receipt)')
    await page.clock.fastForward(901000);await seals(page,2)
    // Stored S is visible before successor adoption and restatement finish.
    // Exercise the resumed generation before advancing its next deadline.
    await page.evaluate("member.send('first receipt generation')")
    await page.clock.fastForward(901000);await seals(page,3)
    await page.evaluate("member.send('second receipt generation')")
    await page.evaluate('member.close()')
    expect(await page.evaluate(`(async()=>{const s=await scopes();return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,
      work:(_b,_t,_bn,_tn,c)=>{let stale,copied;try{Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(receipts[0],c)}catch(e){stale=e.name}
        try{Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt({...receipts[1]},c)}catch(e){copied=e.name}
        Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(receipts[1],c);return [receipts.length,stale,copied]}})})()`))
      .toEqual([2,'OrdinaryStateHold','OrdinaryStateHold'])
  })
}
test('foreign read owner instances cannot present exact S bytes as this receipt',async({page})=>{
  await start(page);await page.evaluate('window.afterSettlement=receipt=>{window.settledReceipt=receipt}')
  await page.clock.fastForward(901000);await seals(page,2);await page.evaluate('member.close()')
  expect(await page.evaluate(`(async()=>{const otherBrowser=new Ordinary.OrdinaryStateOwner(),otherTab=new Ordinary.OrdinaryStateOwner(tabPurpose,tabExpiry);
    try{const migration={phase:'complete',sources:new Map(),names:[]};await otherBrowser.prepare(guard,new Map(),migration);await otherTab.prepare(guard,new Map(),migration);
      const b=await otherBrowser.capture(invScopeName,guard),t=await otherTab.capture(invScopeName,guard);
      return await Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:otherBrowser,scope:b},tab:{owner:otherTab,scope:t},live:guard,
        work:(_b,_t,_bn,_tn,c)=>{try{Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settledReceipt,c);return 'bad'}catch(e){return e.name}}})
    }finally{await otherBrowser.close();await otherTab.close()}})()`)).toBe('OrdinaryStateHold')
})
test('settled receipt is exact for selected pair and controls while unrelated owner may advance',async({page})=>{
  await start(page);await page.evaluate('window.afterSettlement=receipt=>{window.settledReceipt=receipt}')
  await page.clock.fastForward(901000);await seals(page,2);await page.evaluate('member.close()')
  expect(await page.evaluate(`(async()=>{const other=new Ordinary.OrdinaryStateOwner('tab:'+'e'.repeat(64),tabExpiry),migration={phase:'complete',sources:new Map(),names:[]};
    try{await other.prepare(guard,new Map(),migration);const otherScope=await other.capture('@unrelated-owner',guard);
      await other.mutateMigrated(otherScope,guard,store=>store.set('inert-unrelated-record','retained'));
      const s=await scopes();return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:browserOwner,scope:s.b},tab:{owner:tabOwner,scope:s.t},live:guard,
        work:(_b,_t,_bn,_tn,c)=>{Ordinary.OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settledReceipt,c);return true}})
    }finally{await other.close()}})()`)).toBe(true)
})
for(const point of ['session','carrier','receipt','role','fore']){
  test(`reentrant ${point} check revocation refuses the adoption swap`,async({page})=>{
    await start(page)
    await page.evaluate(`window.priorFrames=frames.length;window.adoptionCheck=point=>{if(point==='${point}'){
      window.checkCut=true;window.checkEntropy=randomness.length;identity.revoke()
    }}`)
    await page.clock.fastForward(901000);await page.waitForFunction('window.checkCut&&sockets.every(s=>s.readyState===3)');await page.evaluate('member.close()')
    expect(await page.evaluate(`(async()=>{const j=await renewalState();return [j.phase,signCalls,frames.length===priorFrames,randomness.length===checkEntropy,
      await member.send('no changed generation').then(()=>false,()=>true)]})()`)).toEqual(['settled',2,true,true,true])
  })
}
