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
