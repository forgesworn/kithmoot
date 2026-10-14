import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
const ORIGIN = 'https://ordinary-operation.invalid'
let bundle = ''
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/ordinary-operation.browser-entry.ts'], bundle: true,
  write: false, format: 'iife', globalName: 'Ordinary', platform: 'browser', target: 'es2022' })).outputFiles[0]!.text })
test.beforeEach(async ({ context, page }) => {
  await context.route(ORIGIN + '/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>` }))
  await page.goto(ORIGIN); await page.clock.install()
  await page.evaluate(`(async()=>{
    window.live=true;window.guard=()=>live;window.purpose='tab:'+'3'.repeat(64);window.expiry=Date.now()+43200000;
    window.b=new Ordinary.OrdinaryStateOwner();window.t=new Ordinary.OrdinaryStateOwner(purpose,expiry);
    const migration={phase:'complete',sources:new Map(),names:[]};
    await b.prepare(guard,new Map([['fixture','original']]),migration);await t.prepare(guard,new Map(),migration);
    window.bs=await b.capture('fixture',guard);window.ts=await t.capture('fixture',guard);
    window.db=await new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    window.request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    window.end=tx=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>{}});
    window.raw=async()=>{const tx=db.transaction('owners','readonly'),finished=end(tx),store=tx.objectStore('owners');
      const keys=await request(store.getAllKeys());const rows=await Promise.all(keys.map(k=>request(store.get(k))));await finished;return keys.map((k,i)=>[k,rows[i]])};
    window.equal=(left,right)=>{if(left.length!==right.length)return false;return left.every(([key,row],i)=>{
      const [other,next]=right[i];if(key!==other)return false;if(key.startsWith('journal:')){
        const same=(a,b)=>a.byteLength===b.byteLength&&new Uint8Array(a).every((v,i)=>v===new Uint8Array(b)[i]);
        return row.version===next.version&&['browser','tab'].every(k=>same(row[k].nonce,next[k].nonce)&&same(row[k].ciphertext,next[k].ciphertext))}
      return Ordinary.sameOrdinaryFrame(row.frame,next.frame)&&Ordinary.sameOrdinaryFrame(row.pending,next.pending)})};
    // Fixture enrollment uses real native keys/crypto and one three-row IDB
    // transaction. It is not the still-unimplemented private producer.
    window.enroll=async(phase='prepared',fault='none')=>{
      const before=new Map(await raw()),br=before.get('browser'),tr=before.get(purpose);
      const bi=await Ordinary.openOrdinaryFrame(br.frame,br.key),ti=await Ordinary.openOrdinaryFrame(tr.frame,tr.key);
      const names=Ordinary.ordinaryOperationNames(purpose),id='4'.repeat(64),sequence=1;
      const marker=Ordinary.ordinaryOperationMarker({id,tab:purpose,sequence,commitment:null});bi.records.set(names.marker,marker);ti.records.set(names.marker,marker);
      bi.revision++;ti.revision++;
      const bf=await Ordinary.sealOrdinaryImage(bi,br.key),tf=await Ordinary.sealOrdinaryImage(ti,tr.key);
      const after=phase==='provider-returned'||phase==='candidate-committed',settled=phase==='settled';
      const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
      let cf=null,ct=null;if(after||settled){bi.revision++;ti.revision++;cf=await Ordinary.sealOrdinaryImage(bi,br.key);ct=await Ordinary.sealOrdinaryImage(ti,tr.key)};
      window.journal={version:1,id,tab:purpose,sequence,phase,
        source:[Ordinary.ordinaryFrameDigest(br.frame),Ordinary.ordinaryFrameDigest(tr.frame)],
        sourceRevisions:[br.frame.revision,tr.frame.revision],enrolled:[Ordinary.ordinaryFrameDigest(bf),Ordinary.ordinaryFrameDigest(tf)],enrolledRevisions:[bf.revision,tf.revision],
        target:settled||after?[Ordinary.ordinaryFrameDigest(cf),Ordinary.ordinaryFrameDigest(ct)]:null,targetRevisions:settled||after?[cf.revision,ct.revision]:null,
        requestDigest:await digest('exact request'),resultDigest:settled||after?await digest('exact signed result'):null,
        scopes:[['browser','fixture',bi.generation,0],[purpose,'fixture',ti.generation,0]],ceilings:[expiry],
        request:settled?'':'exact request',result:after?'exact signed result':null,
        secrets:phase==='provider-started'||phase==='provider-returned'?[new Uint8Array(32).fill(7)]:[],nonces:phase==='provider-started'||phase==='provider-returned'?['8'.repeat(24),'9'.repeat(24)]:null};
      if(settled){const commitment=Ordinary.ordinaryOperationCommitment(Ordinary.decodeOrdinaryOperationClassification(Ordinary.encodeOrdinaryOperationJournal(journal)));
        const settledMarker=Ordinary.ordinaryOperationMarker({id,tab:purpose,sequence,commitment});bi.records.set(names.marker,settledMarker);ti.records.set(names.marker,settledMarker);bi.revision++;ti.revision++;}
      if(fault==='wrong-scope')journal.scopes[0][2]='a'.repeat(64);
      if(fault==='wrong-target')journal.target[0]='a'.repeat(64);
      if(fault==='unsettled-revision'){bi.revision--;ti.revision--;}
      const header=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
      const owners={browser:{binding:header(bi),key:br.key},tab:{binding:header(ti),key:tr.key}};
      let control=await Ordinary.sealOrdinaryOperationControl(journal,owners);
      if(fault==='mixed-copy')control.tab=(await Ordinary.sealOrdinaryOperationControl({...journal,id:'a'.repeat(64)},owners)).tab;
      if(fault==='cipher')new Uint8Array(control.browser.ciphertext)[0]^=1;
      if(fault==='unknown-version')control.version=2;
      if(fault==='browser-marker'){bi.records.delete(names.marker);bi.revision++;}
      if(fault==='tab-marker'){ti.records.delete(names.marker);ti.revision++;}
      const browserFrame=settled||fault==='browser-marker'?await Ordinary.sealOrdinaryImage(bi,br.key):phase==='candidate-committed'?cf:bf;
      const tabFrame=settled||fault==='tab-marker'?await Ordinary.sealOrdinaryImage(ti,tr.key):phase==='candidate-committed'?ct:tf;
      const tx=db.transaction('owners','readwrite'),finished=end(tx),store=tx.objectStore('owners');
      store.put({key:br.key,frame:browserFrame},'browser');store.put({key:tr.key,frame:tabFrame},purpose);
      if(fault!=='missing-control')store.put(control,names.control);
      if(fault==='alias')store.put(control,names.control+':alias');await finished;
      window.names=names;window.before=await raw();window.callbacks=0;window.puts=0;window.randoms=0;
      const put=IDBObjectStore.prototype.put;window.restorePut=()=>IDBObjectStore.prototype.put=put;
      IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};
      const random=crypto.getRandomValues.bind(crypto);window.restoreRandom=()=>crypto.getRandomValues=random;
      crypto.getRandomValues=(...args)=>{randoms++;return random(...args)};
    };
    window.outcome=async call=>{try{await call();return 'ok'}catch(error){return error.name}};
  })()`)
})
for (const phase of ['prepared', 'provider-started', 'provider-returned', 'candidate-committed']) {
  test(`${phase} persists a barrier before ordinary callbacks or entropy`, async ({ page }) => {
    await page.evaluate(`enroll('${phase}')`)
    expect(await page.evaluate(`(async()=>{
      const pair={browser:{owner:b,scope:bs},tab:{owner:t,scope:ts},live:guard,work:()=>{callbacks++}};
      const results=[await outcome(()=>b.read(bs,guard,()=>{callbacks++})),await outcome(()=>b.mutate(bs,guard,s=>{callbacks++;s.set('fixture','changed')})),
        await outcome(()=>Ordinary.OrdinaryStateOwner.readPairMigrated(pair)),await outcome(()=>Ordinary.OrdinaryStateOwner.mutatePairMigrated(pair)),
        await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{}))];
      return [results,callbacks,puts,randoms,equal(before,await raw())]})()`))
      .toEqual([Array(5).fill('OrdinaryStateHold'),0,0,0,true])
  })
}
for (const fault of ['missing-control','browser-marker','tab-marker','mixed-copy','cipher','unknown-version','alias','wrong-scope','wrong-target','unsettled-revision']) {
  test(`settled ${fault} holds every native byte before a consumer callback`, async ({ page }) => {
    await page.evaluate(`enroll('settled','${fault}')`)
    expect(await page.evaluate(`(async()=>[await outcome(()=>b.read(bs,guard,()=>{callbacks++})),callbacks,puts,randoms,equal(before,await raw())])()`))
      .toEqual(['OrdinaryStateHold',0,0,0,true])
  })
}
test('settled native history permits ordinary reads and rejects marker stripping before nonce entropy', async ({ page }) => {
  await page.evaluate(`enroll('settled')`)
  expect(await page.evaluate(`(async()=>{
    const read=await b.read(bs,guard,s=>s.get('fixture'));
    const removal=await outcome(()=>b.mutate(bs,guard,s=>s.remove(names.marker)));
    return [read,removal,puts,randoms,equal(before,await raw())]})()`))
    .toEqual(['original','OrdinaryStateHold',0,0,true])
})
test('expired unknown operation is classified before automatic tab erasure', async ({ page }) => {
  await page.evaluate(`enroll('provider-started')`)
  await page.clock.fastForward(43_200_100)
  expect(await page.evaluate(`(async()=>[await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{})),puts,randoms,equal(before,await raw())])()`))
    .toEqual(['OrdinaryStateHold',0,0,true])
})
test('fresh owner instances still hold an enrolled unknown operation', async ({ page }) => {
  await page.evaluate(`(async()=>{await enroll('provider-started');window.fresh=new Ordinary.OrdinaryStateOwner()})()`)
  expect(await page.evaluate(`(async()=>[await outcome(()=>fresh.prepare(guard,new Map())),puts,randoms,equal(before,await raw())])()`))
    .toEqual(['OrdinaryStateHold',0,0,true])
})

test('unrelated mutations preserve compact settled lineage through later revisions', async ({ page }) => {
  await page.evaluate(`enroll('settled')`)
  expect(await page.evaluate(`(async()=>{
    const original=new Map(await raw()).get('browser');const image=await Ordinary.openOrdinaryFrame(original.frame,original.key);const marker=image.records.get(names.marker);
    await b.mutate(bs,guard,s=>s.set('fixture','later'));const read=await b.read(bs,guard,s=>s.get('fixture'));
    const next=new Map(await raw()).get('browser'),opened=await Ordinary.openOrdinaryFrame(next.frame,next.key);
    return [read,opened.records.get(names.marker)===marker,next.frame.revision===original.frame.revision+1]})()`)).toEqual(['later',true,true])
})
for(const phase of ['settled','provider-started']) {
  test(`two controls classify globally with second ${phase}`, async ({ page }) => {
    expect(await page.evaluate(`(async()=>{
      const secondPurpose='tab:'+'a'.repeat(64),second=new Ordinary.OrdinaryStateOwner(secondPurpose,expiry);
      await second.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
      await enroll('settled');restorePut();restoreRandom();window.t=second;window.purpose=secondPurpose;
      await enroll('${phase}');return [await outcome(()=>b.read(bs,guard,()=>{callbacks++})),callbacks,puts,randoms,equal(before,await raw())]})()`))
      .toEqual([phase==='settled'?'ok':'OrdinaryStateHold',phase==='settled'?1:0,0,0,true])
  })
}
for (const phase of ['provider-started', 'settled']) {
  test(`${phase} classifies an ordinary pending frame before promotion`, async ({ page }) => {
    await page.evaluate(`(async()=>{
      await enroll('${phase}');const rows=new Map(await raw()),row=rows.get('browser');
      const image=await Ordinary.openOrdinaryFrame(row.frame,row.key);image.revision++;image.records.set('fixture','pending');
      const pending=await Ordinary.sealOrdinaryImage(image,row.key),tx=db.transaction('owners','readwrite'),finished=end(tx);
      tx.objectStore('owners').put({...row,pending},'browser');await finished;window.before=await raw();puts=0;randoms=0;
    })()`)
    const result = await page.evaluate(`(async()=>{
      const status=await outcome(()=>b.read(bs,guard,s=>{callbacks++;window.value=s.get('fixture')}));
      const rows=new Map(await raw()),row=rows.get('browser');const image=await Ordinary.openOrdinaryFrame(row.frame,row.key);
      return [status,callbacks,window.value??null,puts,randoms,image.records.get(names.marker),equal(before,await raw()),!!row.pending]})()`)
    if (phase === 'provider-started') expect(result).toEqual(['OrdinaryStateHold',0,null,0,0,expect.any(String),true,true])
    else expect(result).toEqual(['ok',1,'pending',1,0,expect.any(String),false,false])
  })
}
for (const cut of ['browser-close', 'tab-close', 'live-loss', 'version-change']) {
  test(`paused control decryption joins and wipes after ${cut}`, async ({ page }) => {
    expect(await page.evaluate(`(async()=>{
      await enroll('settled');const decrypt=crypto.subtle.decrypt.bind(crypto.subtle),buffers=[];
      let release,signal;const paused=new Promise(r=>signal=r),gate=new Promise(r=>release=r);let once=false;
      crypto.subtle.decrypt=async(...args)=>{const result=await decrypt(...args);buffers.push(result);
        if(!once&&new TextDecoder().decode(args[0].additionalData).includes('kithmoot.ordinary-operation.v1')){once=true;signal();await gate}return result};
      const transaction=IDBDatabase.prototype.transaction;let native;
      IDBDatabase.prototype.transaction=function(...args){if(this.name===Ordinary.ORDINARY_DATABASE&&args[1]==='readonly')native=this;return transaction.apply(this,args)};
      const pending=outcome(()=>Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:b,scope:bs},tab:{owner:t,scope:ts},live:guard,work:()=>{callbacks++}}));
      await paused;let joined=false,closing=Promise.resolve(),upgrade;
      if('${cut}'==='browser-close'||'${cut}'==='tab-close')closing=('${cut}'==='browser-close'?b:t).close().then(()=>joined=true);
      if('${cut}'==='live-loss')live=false;
      if('${cut}'==='version-change'){
        db.close();let changed;const observed=new Promise(r=>changed=r);native.addEventListener('versionchange',()=>changed());
        upgrade=new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
        await observed;
      }
      const earlyJoin=joined;release();const status=await pending;await closing;if(upgrade)window.db=await upgrade;
      crypto.subtle.decrypt=decrypt;IDBDatabase.prototype.transaction=transaction;
      const allWiped=buffers.every(buffer=>new Uint8Array(buffer).every(v=>v===0));
      return [status,callbacks,puts,randoms,equal(before,await raw()),allWiped,earlyJoin,joined]
    })()`)).toEqual(['OrdinaryStateHold',0,0,0,true,true,false,cut.endsWith('close')])
  })
}
for (const kind of ['owner', 'control', 'total']) {
  test(`refuses over-limit ${kind} keys before callbacks or crypto`, async ({ page }) => {
    expect(await page.evaluate(`(async()=>{
      await enroll('settled');restorePut();restoreRandom();const rows=new Map(await raw()),tx=db.transaction('owners','readwrite'),finished=end(tx),store=tx.objectStore('owners');
      for(let i=0;i<65;i++){const suffix=i.toString(16).padStart(64,'0');
        if('${kind}'!=='control')store.put(rows.get('browser'),'tab:'+suffix);
        if('${kind}'!=='owner')store.put(rows.get(names.control),'journal:tab:'+suffix);
      }await finished;window.before=await raw();const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let decrypts=0;
      crypto.subtle.decrypt=(...args)=>{decrypts++;return decrypt(...args)};
      const status=await outcome(()=>b.read(bs,guard,()=>callbacks++));crypto.subtle.decrypt=decrypt;
      return [status,callbacks,decrypts,equal(before,await raw())]
    })()`)).toEqual(['OrdinaryStateHold',0,0,true])
  })
}

test('complete app composition accepts native settled marker provenance and refuses raw lookalikes', async ({ page }) => {
  await page.evaluate(`enroll('settled')`)
  expect(await page.evaluate(`(async()=>{
    return Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:b,scope:bs},tab:{owner:t,scope:ts},live:guard,work:(browser,tab,bn,tn,c)=>{
      const bm=new Map(browser.keys().map(n=>[n,browser.get(n)])),tm=new Map(tab.keys().map(n=>[n,tab.get(n)]));
      const validate=context=>Ordinary.validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},context);
      const counts=validate(Ordinary.captureOrdinarySnapshotContext(bm,tm,c));let rawHeld=false,projectedHeld=false;
      try{validate(Ordinary.captureOrdinarySnapshotContext(bm,tm))}catch(e){rawHeld=e.name==='OrdinaryStateHold'}
      const projection=Ordinary.captureOrdinaryProjectedSnapshotContext(bm,tm,c,bm,tm);const kept=validate(projection);
      const altered=new Map(bm);altered.set(names.marker,Ordinary.ordinaryOperationMarker({id:'a'.repeat(64),tab:purpose,sequence:1,commitment:'b'.repeat(64)}));
      try{Ordinary.validateOrdinarySnapshot(altered,tm,{browser:true,tab:true},Ordinary.captureOrdinaryProjectedSnapshotContext(bm,tm,c,altered,tm))}catch(e){projectedHeld=e.name==='OrdinaryStateHold'}
      let deletionHeld=false;const deleted=new Map(bm);deleted.delete(names.marker);
      try{Ordinary.validateOrdinarySnapshot(deleted,tm,{browser:true,tab:true},Ordinary.captureOrdinaryProjectedSnapshotContext(bm,tm,c,deleted,tm))}catch(e){deletionHeld=e.name==='OrdinaryStateHold'}
      return [counts.families.operationMarkers,rawHeld,kept.families.operationMarkers,projectedHeld,deletionHeld,puts,randoms];
    }})})()`)).toEqual([2,true,2,true,true,0,0])
})
test('complete composition validates preserved markers in a native writable projection', async ({ page }) => {
  await page.evaluate(`enroll('settled')`)
  expect(await page.evaluate(`(async()=>{
    await Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:b,scope:bs},tab:{owner:t,scope:ts},live:guard,work:(browser,tab,bn,tn,c)=>{
      browser.set('fixture','later');const bm=new Map(browser.keys().map(n=>[n,browser.get(n)])),tm=new Map(tab.keys().map(n=>[n,tab.get(n)]));
      const counts=Ordinary.validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},Ordinary.captureOrdinarySnapshotContext(bm,tm,c));window.count=counts.families.operationMarkers;
    }});return [count,await b.read(bs,guard,s=>s.get('fixture'))];})()`)).toEqual([2,'later'])
})

for (const reader of ['single', 'pair']) {
  test(`${reader} refuses a control-only write between classification and its consumer read`, async ({ page }) => {
    await page.evaluate(`enroll('settled')`)
    expect(await page.evaluate(`(async()=>{
      const rows=new Map(await raw()),br=rows.get('browser'),tr=rows.get(purpose);
      const bi=await Ordinary.openOrdinaryFrame(br.frame,br.key),ti=await Ordinary.openOrdinaryFrame(tr.frame,tr.key);
      const header=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
      const active=await Ordinary.sealOrdinaryOperationControl({...journal,phase:'prepared',target:null,targetRevisions:null,
        resultDigest:null,request:'exact request'}, {browser:{binding:header(bi),key:br.key},tab:{binding:header(ti),key:tr.key}});
      const expected=before.map(([name,row])=>[name,name===names.control?active:row]);puts=0;randoms=0;
      const transaction=IDBDatabase.prototype.transaction;let reads=0,injected=false,write;
      IDBDatabase.prototype.transaction=function(...args){
        if(this.name===Ordinary.ORDINARY_DATABASE&&args[1]==='readonly'&&++reads===('${reader}'==='single'?2:4)){
          const tx=transaction.call(this,'owners','readwrite');write=end(tx);tx.objectStore('owners').put(active,names.control);injected=true;
        }return transaction.apply(this,args);
      };
      const status=await outcome(()=> '${reader}'==='single'?b.read(bs,guard,()=>callbacks++):
        Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:b,scope:bs},tab:{owner:t,scope:ts},live:guard,work:()=>callbacks++}));
      if(write)await write;IDBDatabase.prototype.transaction=transaction;
      return [injected,status,callbacks,puts,randoms,equal(expected,await raw())];
    })()`)).toEqual([true,'OrdinaryStateHold',0,1,0,true])
  })
}

test('settled expired cleanup commits browser marker removal and both deletions atomically', async ({ page }) => {
  await page.evaluate(`enroll('settled')`); await page.clock.fastForward(43_200_100)
  expect(await page.evaluate(`(async()=>{
    const previous=new Map(before).get('browser');let retained;
    const status=await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,owner=>retained=owner));
    const rows=new Map(await raw()),current=rows.get('browser'),image=await Ordinary.openOrdinaryFrame(current.frame,current.key);
    return [status,rows.size,rows.has(purpose),rows.has(names.control),image.records.has(names.marker),image.records.get('fixture'),
      current.frame.revision===previous.frame.revision+1,puts,randoms,retained===undefined];
  })()`)).toEqual(['ok',1,false,false,false,'original',true,1,1,true])
})
test('settled unexpired history is left intact without nonce or mutation', async ({ page }) => {
  await page.evaluate(`enroll('settled')`)
  expect(await page.evaluate(`(async()=>[await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{})),puts,randoms,equal(before,await raw())])()`))
    .toEqual(['ok',0,0,true])
})
for (const pending of ['browser','tab','both']) {
  test(`expired settled cleanup preserves effective ${pending} pending state`, async ({ page }) => {
    await page.evaluate(`(async()=>{
      await enroll('settled');const rows=new Map(await raw());window.intended=null;const changes=[];
      for(const name of '${pending}'==='both'?['browser',purpose]:['${pending}'==='browser'?'browser':purpose]){
        const row=rows.get(name),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);image.revision++;
        image.records.set('fixture','pending-'+name);image.fences.set('pending-fence',image.revision);
        image.migration.names.push('inert-original-source');
        if(name==='browser')window.intended={revision:image.revision,records:[...image.records],fences:[...image.fences],migration:image.migration};
        changes.push([name,{...row,pending:await Ordinary.sealOrdinaryImage(image,row.key)}]);
      }const tx=db.transaction('owners','readwrite'),finished=end(tx);for(const[name,row]of changes)tx.objectStore('owners').put(row,name);await finished;
      window.before=await raw();puts=0;randoms=0;
    })()`)
    await page.clock.fastForward(43_200_100)
    expect(await page.evaluate(`(async()=>{
      const previous=new Map(before).get('browser'),effective=await Ordinary.openOrdinaryFrame(previous.pending??previous.frame,previous.key);
      await Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{});const rows=new Map(await raw()),row=rows.get('browser'),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);
      const expected=new Map(effective.records);expected.delete(names.marker);
      return [rows.size,!row.pending,image.revision===effective.revision+1,JSON.stringify([...image.records])===JSON.stringify([...expected]),
        JSON.stringify([...image.fences])===JSON.stringify([...effective.fences]),JSON.stringify(image.migration)===JSON.stringify(effective.migration),puts,randoms];
    })()`)).toEqual([1,true,true,true,true,true,1,1])
  })
}
for (const cut of [1,2,3]) for (const queued of [false,true]) {
  test(`cleanup mutation ${cut} throwing ${queued?'after':'before'} queueing preserves the complete prior`, async ({ page }) => {
    await page.evaluate(`enroll('settled')`); await page.clock.fastForward(43_200_100)
    expect(await page.evaluate(`(async()=>{
      const put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete;let calls=0;
      const wrap=(fn,store,args)=>{calls++;if(calls===${cut}&&!${queued})throw Error('fixture cut');const result=fn.apply(store,args);
        if(calls===${cut})throw Error('fixture cut after queue');return result};
      IDBObjectStore.prototype.put=function(...args){return wrap(put,this,args)};IDBObjectStore.prototype.delete=function(...args){return wrap(remove,this,args)};
      const status=await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{}));
      IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove;
      return [status,calls,equal(before,await raw()),randoms];
    })()`)).toEqual(['OrdinaryStateHold',cut,true,1])
  })
}
test('cleanup abort before mutation issues no writes and leaves all original bytes', async ({ page }) => {
  await page.evaluate(`enroll('settled')`); await page.clock.fastForward(43_200_100)
  expect(await page.evaluate(`(async()=>{
    const get=IDBObjectStore.prototype.getKey;let once=false;
    IDBObjectStore.prototype.getKey=function(...args){const result=get.apply(this,args);if(this.transaction.mode==='readwrite'&&!once){once=true;this.transaction.abort()}return result};
    const status=await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{}));IDBObjectStore.prototype.getKey=get;
    return [status,once,puts,equal(before,await raw())];
  })()`)).toEqual(['OrdinaryStateHold',true,0,true])
})

for (const mask of [0,1,2,3,4,5,6,7]) {
  test(`cleanup reconciles exact three-record combination ${mask}`, async ({ page }) => {
    await page.evaluate(`enroll('settled')`); await page.clock.fastForward(43_200_100)
    await page.evaluate(`(()=>{
      const put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete;window.cleanupState='pending';window.cleanupCandidate=null;
      IDBObjectStore.prototype.put=function(value,key){if(key==='browser'){cleanupCandidate=structuredClone(value);if(!(${mask}&1))return}return put.call(this,value,key)};
      IDBObjectStore.prototype.delete=function(key){if(key===purpose&&!(${mask}&2)||key===names.control&&!(${mask}&4))return;return remove.call(this,key)};
      window.restoreCleanup=()=>{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.delete=remove};
      window.cleanup=outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,owner=>window.retainedCleanup=owner)).then(status=>cleanupState=status);
    })()`)
    if (mask === 0 || mask === 7) {
      await page.waitForFunction(`cleanupState!=='pending'`)
      expect(await page.evaluate(`cleanupState`)).toBe(mask === 0 ? 'OrdinaryStateHold' : 'ok')
      if (mask === 0) expect(await page.evaluate(`(async()=>equal(before,await raw()))()`)).toBe(true)
      await page.evaluate(`restoreCleanup()`)
    } else {
      await page.waitForFunction(`window.retainedCleanup?.holdingRetention`)
      expect(await page.evaluate(`[cleanupState,randoms]`)).toEqual(['pending',1])
      await page.evaluate(`(async()=>{
        restoreCleanup();const tx=db.transaction('owners','readwrite'),finished=end(tx),store=tx.objectStore('owners');
        store.put(cleanupCandidate,'browser');store.delete(purpose);store.delete(names.control);await finished;
        retainedCleanup.retryRetention();await cleanup;
      })()`)
      expect(await page.evaluate(`(async()=>[cleanupState,randoms,(await raw()).length])()`)).toEqual(['ok',1,1])
    }
  })
}
for (const closing of [false,true]) {
  test(`lost cleanup completion retains exact candidate and joins close=${closing}`, async ({ page }) => {
    await page.evaluate(`enroll('settled')`); await page.clock.fastForward(43_200_100)
    await page.evaluate(`(()=>{
      const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),open=IDBFactory.prototype.open;
      let once=false;window.cleanupState='pending';window.closeState='pending';window.nativeCandidate=null;
      const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(key==='browser')nativeCandidate=structuredClone(value);return put.call(this,value,key)};
      Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this;
        if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,event=>{IDBFactory.prototype.open=function(){throw Error('fixture offline')};tx.onabort(event)})}
        else descriptor.set.call(tx,callback)}});
      window.restoreLostCompletion=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=open;IDBObjectStore.prototype.put=put};
      window.cleanup=outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,owner=>window.retainedCleanup=owner)).then(status=>cleanupState=status);
    })()`)
    await page.waitForFunction(`window.retainedCleanup?.holdingRetention`)
    expect(await page.evaluate(`[cleanupState,puts,randoms]`)).toEqual(['pending',1,1])
    if (closing) {
      await page.evaluate(`window.closing=retainedCleanup.close().then(()=>closeState='done');undefined`)
      expect(await page.evaluate(`closeState`)).toBe('pending')
    }
    await page.evaluate(`(async()=>{restoreLostCompletion();retainedCleanup.retryRetention();await cleanup;await window.closing;
      const rows=new Map(await raw()),current=rows.get('browser');window.exactCleanup=Ordinary.sameOrdinaryFrame(current.frame,nativeCandidate.frame)})()`)
    expect(await page.evaluate(`[cleanupState,puts,randoms,exactCleanup,${closing} ? closeState : 'not requested']`))
      .toEqual(['ok',1,1,true,closing?'done':'not requested'])
  })
}
test('expired settled malformed family data holds before cleanup entropy', async ({ page }) => {
  await page.evaluate(`(async()=>{await enroll('settled');const rows=new Map(await raw()),row=rows.get(purpose),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);
    image.records.set('kithmoot.future-private.v9','do not erase');image.revision++;const frame=await Ordinary.sealOrdinaryImage(image,row.key);
    const tx=db.transaction('owners','readwrite'),finished=end(tx);tx.objectStore('owners').put({...row,frame},purpose);await finished;
    window.before=await raw();puts=0;randoms=0;})()`)
  await page.clock.fastForward(43_200_100)
  expect(await page.evaluate(`(async()=>[await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{})),puts,randoms,equal(before,await raw())])()`))
    .toEqual(['OrdinaryStateHold',0,0,true])
})
test('cleanup historical validation token cannot be borrowed as a live read or retained resource', async ({ page }) => {
  await page.evaluate(`enroll('settled')`); await page.clock.fastForward(43_200_100)
  expect(await page.evaluate(`(async()=>{
    const set=WeakMap.prototype.set;let observations=0,readHeld=true,resourceHeld=true,bindingHeld=true,sizingHeld=true;
    WeakMap.prototype.set=function(token,value){const result=set.call(this,token,value);
      if(value?.kind==='historical-cleanup'){
        observations++;const bm=new Map(value.browserStore.keys().map(n=>[n,value.browserStore.get(n)])),tm=new Map(value.tabStore.keys().map(n=>[n,value.tabStore.get(n)]));
        const clock=Date.now;Date.now=()=>value.tab.expiresAt-1;
        try{Ordinary.OrdinaryStateOwner.validatePairBinding(token,{browser:{owner:value.browserOwner,scope:value.browserScope},tab:{owner:value.tabOwner,scope:value.tabScope},live:()=>{throw Error('must not evaluate')}});bindingHeld=false}catch(e){bindingHeld=bindingHeld&&e.name==='OrdinaryStateHold'}
        try{Ordinary.ordinaryPairProjectedByteLengths(token,bm,tm,{browser:bm,tab:tm});sizingHeld=false}catch(e){sizingHeld=sizingHeld&&e.name==='OrdinaryStateHold'}
        Date.now=clock;
        try{Ordinary.ordinaryPairReadCustodyFor(token,bm,tm);readHeld=false}catch(e){readHeld=readHeld&&e.name==='OrdinaryStateHold'}
        try{Ordinary.OrdinaryStateOwner.retainPairResource(token,{browser:{owner:value.browserOwner,scope:value.browserScope},tab:{owner:value.tabOwner,scope:value.tabScope},live:()=>true},{revoke:()=>{},join:async()=>{}});resourceHeld=false}catch(e){resourceHeld=resourceHeld&&e.name==='OrdinaryStateHold'}
      }return result};
    const status=await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{}));WeakMap.prototype.set=set;
    return [status,observations,readHeld,resourceHeld,bindingHeld,sizingHeld];
  })()`)).toEqual(['ok',2,true,true,true,true])
})

test('historical snapshot capture rejects an acknowledged live read token', async ({page})=>{
  await page.evaluate(`enroll('settled')`)
  expect(await page.evaluate(`(async()=>Ordinary.OrdinaryStateOwner.readPairMigrated({browser:{owner:b,scope:bs},tab:{owner:t,scope:ts},live:guard,work:(bv,tv,_bn,_tn,token)=>{
    const bm=new Map(bv.keys().map(n=>[n,bv.get(n)])),tm=new Map(tv.keys().map(n=>[n,tv.get(n)]));
    try{Ordinary.captureOrdinaryHistoricalSnapshotContext(bm,tm,token);return 'bad'}catch(e){return e.name}
  }}))()`)).toBe('OrdinaryStateHold')
})

const twoSettled = `(async()=>{
  window.targetPurpose=purpose;window.secondPurpose='tab:'+'a'.repeat(64);
  const second=new Ordinary.OrdinaryStateOwner(secondPurpose,expiry+43200000);
  await second.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});
  await enroll('settled');window.targetNames=names;restorePut();restoreRandom();
  window.t=second;window.purpose=secondPurpose;window.expiry+=43200000;await enroll('settled');
  window.otherNames=names;window.purpose=targetPurpose;window.names=targetNames;
  window.before=await raw();window.otherControl=new Map(before).get(otherNames.control);puts=0;randoms=0;
})()`
test('cleanup removes only the expired settled history and preserves an unexpired second control',async({page})=>{
  await page.evaluate(twoSettled);await page.clock.fastForward(43200100)
  expect(await page.evaluate(`(async()=>{
    await Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{});const rows=new Map(await raw());
    const image=await Ordinary.openOrdinaryFrame(rows.get('browser').frame,rows.get('browser').key);
    const original=new Map(before),prior=await Ordinary.openOrdinaryFrame(original.get('browser').frame,original.get('browser').key);
    return [rows.size,!rows.has(purpose),!rows.has(names.control),rows.has(secondPurpose),rows.has(otherNames.control),
      image.records.get(otherNames.marker)===prior.records.get(otherNames.marker),!image.records.has(names.marker),randoms,puts];
  })()`)).toEqual([3,true,true,true,true,true,true,1,1])
})
for(const boundary of ['before-writer','before-reconciliation']) for(const alteration of ['change','remove','insert']){
  test(`other control ${alteration} ${boundary} cannot inherit cleanup classification`,async({page})=>{
    await page.evaluate(twoSettled);await page.clock.fastForward(43200100)
    await page.evaluate(`(()=>{
      window.alteration='${alteration}';window.injected=false;window.cleanupState='pending';window.browserWrites=0;
      const transaction=IDBDatabase.prototype.transaction,encrypt=crypto.subtle.encrypt.bind(crypto.subtle),remove=IDBObjectStore.prototype.delete,put=IDBObjectStore.prototype.put;
      window.injectOther=()=>{
        if(injected)return;injected=true;
        const tx=transaction.call(db,'owners','readwrite'),s=tx.objectStore('owners');window.otherWrite=end(tx);
        if(alteration==='remove')s.delete(otherNames.control);
        else if(alteration==='insert')s.put(otherControl,'journal:'+'b'.repeat(64));
        else{const changed=structuredClone(otherControl);new Uint8Array(changed.browser.ciphertext)[0]^=1;s.put(changed,otherNames.control)}
      };
      IDBObjectStore.prototype.put=function(value,key){if(key==='browser')browserWrites++;return put.call(this,value,key)};
      if('${boundary}'==='before-writer')crypto.subtle.encrypt=(...args)=>{injectOther();return encrypt(...args)};
      else IDBObjectStore.prototype.delete=function(key){const request=remove.call(this,key);if(key===names.control)injectOther();return request};
      window.restoreOther=()=>{crypto.subtle.encrypt=encrypt;IDBObjectStore.prototype.delete=remove;IDBObjectStore.prototype.put=put};
      window.cleanup=outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,owner=>window.retainedCleanup=owner)).then(status=>cleanupState=status);
    })()`)
    if(boundary==='before-writer'){
      await page.waitForFunction(`cleanupState!=='pending'`)
      expect(await page.evaluate(`[cleanupState,injected,browserWrites,randoms]`)).toEqual(['OrdinaryStateHold',true,0,1])
      expect(await page.evaluate(`(async()=>{await otherWrite;const rows=new Map(await raw()),prior=new Map(before);return ['browser',purpose,names.control].every(n=>
        n===names.control?Ordinary.ordinaryOperationControlDigest(rows.get(n))===Ordinary.ordinaryOperationControlDigest(prior.get(n)):Ordinary.sameOrdinaryFrame(rows.get(n).frame,prior.get(n).frame))})()`)).toBe(true)
      await page.evaluate(`restoreOther()`)
    }else{
      await page.waitForFunction(`window.retainedCleanup?.holdingRetention`)
      expect(await page.evaluate(`[cleanupState,injected,browserWrites,randoms]`)).toEqual(['pending',true,1,1])
      await page.evaluate(`(async()=>{restoreOther();await otherWrite;const tx=db.transaction('owners','readwrite'),finished=end(tx),s=tx.objectStore('owners');
        if(alteration==='insert')s.delete('journal:'+'b'.repeat(64));else s.put(otherControl,otherNames.control);await finished;
        retainedCleanup.retryRetention();await cleanup;
      })()`)
      expect(await page.evaluate(`[cleanupState,randoms]`)).toEqual(['ok',1])
    }
  })
}

for(const cancellation of ['close','live','versionchange']) for(const cut of [1,2,3,4,5,6,7]){
  test(`${cancellation==='versionchange'?'versionchange handler':cancellation} at writer authentication ${cut} aborts cleanup before mutation`,async({page})=>{
    await page.evaluate(`enroll('settled')`);await page.clock.fastForward(43200100)
    await page.evaluate(`(()=>{
      const transaction=IDBDatabase.prototype.transaction,decrypt=crypto.subtle.decrypt.bind(crypto.subtle);
      window.inWriter=false;window.authentication=0;window.gated=false;window.cleanupState='pending';window.closeState='pending';
      IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(this.name===Ordinary.ORDINARY_DATABASE&&args[1]==='readwrite'){inWriter=true;window.writerDatabase=this}return tx};
      crypto.subtle.decrypt=async(...args)=>{const result=await decrypt(...args);if(inWriter&&++authentication===${cut}){gated=true;await new Promise(resolve=>window.releaseAuthentication=resolve)}return result};
      window.restoreAuthentication=()=>{IDBDatabase.prototype.transaction=transaction;crypto.subtle.decrypt=decrypt};
      window.cleanup=outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,owner=>window.retainedCleanup=owner)).then(status=>cleanupState=status);
    })()`)
    await page.waitForFunction(`gated`)
    await page.evaluate(`(()=>{
      if('${cancellation}'==='close')window.closing=retainedCleanup.close().then(()=>closeState='done');
      if('${cancellation}'==='live')window.live=false;
      if('${cancellation}'==='versionchange')writerDatabase.onversionchange(new IDBVersionChangeEvent('versionchange',{oldVersion:1,newVersion:2}));
    })()`)
    if(cancellation==='close')expect(await page.evaluate(`closeState`)).toBe('pending')
    await page.evaluate(`(async()=>{releaseAuthentication();await cleanup;await window.closing;restoreAuthentication()})()`)
    expect(await page.evaluate(`(async()=>[cleanupState,puts,equal(before,await raw()),authentication,randoms,${cancellation==='close'}?closeState:'not requested'])()`))
      // A fixed two-copy packet/source authentication finishes its paired
      // decryption before the private consumer checks cancellation. No writer
      // or application callback is allowed to run after that boundary.
      .toEqual(['OrdinaryStateHold',0,true,cut===3||cut===5?cut+1:cut,1,cancellation==='close'?'done':'not requested'])
  })
}

for(const cut of [1,2,3,4,5,6,7]){
  test(`native upgrade event at writer authentication ${cut} joins aborted cleanup`,async({page})=>{
    await page.evaluate(`(async()=>{await enroll('settled');await b.close();await t.close()})()`)
    await page.clock.fastForward(43200100)
    await page.evaluate(`(()=>{
      const transaction=IDBDatabase.prototype.transaction,decrypt=crypto.subtle.decrypt.bind(crypto.subtle);
      window.inWriter=false;window.authentication=0;window.gated=false;window.cleanupState='pending';
      IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(this.name===Ordinary.ORDINARY_DATABASE&&args[1]==='readwrite'){inWriter=true;window.writerDatabase=this}return tx};
      crypto.subtle.decrypt=async(...args)=>{const result=await decrypt(...args);if(inWriter&&++authentication===${cut}){gated=true;await new Promise(resolve=>window.releaseAuthentication=resolve)}return result};
      window.restoreAuthentication=()=>{IDBDatabase.prototype.transaction=transaction;crypto.subtle.decrypt=decrypt};
      window.cleanup=outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,owner=>window.retainedCleanup=owner)).then(status=>cleanupState=status);
    })()`)
    await page.waitForFunction(`gated`)
    await page.evaluate(`(async()=>{
      const observed=new Promise(resolve=>writerDatabase.addEventListener('versionchange',resolve,{once:true}));db.close();
      window.upgrade=new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      await observed;
    })()`)
    expect(await page.evaluate(`cleanupState`)).toBe('pending')
    await page.evaluate(`(async()=>{releaseAuthentication();await cleanup;window.db=await upgrade;restoreAuthentication()})()`)
    expect(await page.evaluate(`(async()=>[cleanupState,puts,equal(before,await raw()),authentication,randoms,db.version])()`))
      .toEqual(['OrdinaryStateHold',0,true,cut===3||cut===5?cut+1:cut,1,2])
  })
}
