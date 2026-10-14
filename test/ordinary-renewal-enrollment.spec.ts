import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { test,expect,type Page } from '@playwright/test'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'
const ORIGIN='https://ordinary-renewal-enrollment.invalid'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:['test/ordinary-renewal-enrollment.browser-entry.ts'],bundle:true,write:false,format:'iife',globalName:'Ordinary',platform:'browser',target:'es2022',
    plugins:[{name:'actual-private-factory-enrollment-slice',setup(builder){builder.onLoad({filter:/ordinary-persistent-bootstrap\.ts$/},async input=>{
      const source=await readFile(input.path,'utf8'),marker='            const selected = source\n'
      if(source.split(marker).length!==2)throw Error('enrollment factory observation marker drift')
      return {loader:'ts',contents:source.replace('const oldImage = await this.#read((b,t,c) => protocol!.enterLifecycle(root,b,t,c,() => this.#image(b,t,c,true)))', 'const oldImage = await this.#read((b,t,c) => protocol!.enterLifecycle(root,b,t,c,() => this.#image(b,t,c,true))).catch(error=>{(globalThis as any).renewPreflightError=error.stack;throw error})').replace('            }))\n            const selected = source', '            })).catch(error=>{(globalThis as any).renewPreflightError=error.stack;throw error})\n            const selected = source').replace(marker,`            const observer=globalThis as any
            observer.enrollmentObligation=obligation
            observer.randoms=0;observer.puts=0
            observer.beforeEnrollment?.()
            try { observer.enrollmentOutcome=await OrdinaryStateOwner.enrollMemberRenewal(obligation!) }
            catch(error){observer.enrollmentError=(error as Error).name}
            observer.enrollmentDone=true
            if(observer.performSigning&&observer.enrollmentOutcome?.status==='enrolled'){
              observer.beforeSigning?.()
              try{observer.signingReturned=await OrdinaryStateOwner.signMemberRenewal(observer.enrollmentOutcome.enrollment)}
              catch(error){observer.signingError=(error as Error).stack}
              observer.signingDone=true
            }
            await new Promise<void>(resolve=>observer.releaseEnrollment=resolve)
            protocol!.close(); return
`+marker)}
    })}}]})).outputFiles[0]!.text
})
test.beforeEach(async({context,page})=>{
  await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
  await page.goto(ORIGIN);await page.clock.install();await page.evaluate('window.memberEpochTimeoutMs=10000')
})
async function start(page:Page,visitor=false,keep=true,defer=false){
  await page.evaluate(`(${setup.replaceAll('checkClients:async()=>{}','checkClients:async()=>{window.clientCheckCount=(window.clientCheckCount??0)+1;await window.clientHook?.()}')})(${JSON.stringify({visitor,keep,noRelays:true})})`)
  if(defer)await page.evaluate('window.deferMemberCreation=true');await page.evaluate(`(${controls})()`);if(!defer)await page.evaluate('join()')
  await page.evaluate(`(async()=>{window.prior=await rawBoth();window.beforeSigns=signCalls;window.puts=0;window.randoms=0;
    const put=IDBObjectStore.prototype.put,random=crypto.getRandomValues.bind(crypto);
    IDBObjectStore.prototype.put=function(...args){puts++;return put.apply(this,args)};crypto.getRandomValues=(...args)=>{randoms++;return random(...args)};
    window.restoreEnrollmentCrypto=()=>{IDBObjectStore.prototype.put=put;crypto.getRandomValues=random};
    window.readAll=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),keys=s.getAllKeys(),values=s.getAll();
      tx.oncomplete=()=>{db.close();resolve(keys.result.map((key,i)=>[key,values.result[i]]))};tx.onabort=()=>reject(tx.error)}});
    window.outcome=async call=>{try{await call();return 'ok'}catch(error){return error.name}}
  })()`)
}
async function finish(page:Page){await page.evaluate(`(async()=>{releaseEnrollment();await member.close();restoreEnrollmentCrypto()})()`)}
for(const visitor of [false,true])for(const keep of [false,true]){
  test(`actual factory enrolls exact P E images and prepared control, visitor=${visitor}, keep=${keep}`,async({page})=>{
    await start(page,visitor,keep);await page.clock.fastForward(901000);await page.waitForFunction('window.enrollmentDone===true')
    expect(await page.evaluate(`(async()=>{
      if(window.enrollmentError)return [window.enrollmentError];const rows=new Map(await readAll()),br=rows.get('browser'),tr=rows.get(tabPurpose),names=Ordinary.ordinaryOperationNames(tabPurpose);
      const b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
      const journal=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});
      const request=Ordinary.readOrdinaryRenewalRequest(journal.request),marker=Ordinary.ordinaryOperationMarker({id:journal.id,tab:tabPurpose,sequence:1,commitment:null});
      const priorB=await Ordinary.openOrdinaryFrame(prior[0].frame,prior[0].key),priorT=await Ordinary.openOrdinaryFrame(prior[1].frame,prior[1].key);
      const changed=[b.records.get(names.marker)===marker,t.records.get(names.marker)===marker,b.revision===priorB.revision+1,t.revision===priorT.revision+1];
      Ordinary.restoreOrdinaryRenewalPredecessor(b,t,journal.request,{id:journal.id,sequence:journal.sequence});
      const same=(a,b)=>{const x=Ordinary.encodeOrdinaryImage(a),y=Ordinary.encodeOrdinaryImage(b);return x.length===y.length&&x.every((v,i)=>v===y[i])};
      return [enrollmentOutcome.status,rows.size,journal.phase,journal.secrets.length,journal.nonces,...changed,same(b,priorB),same(t,priorT),
        request.intent.semanticDigest===Ordinary.ordinaryOperationSemanticDigest(priorB,priorT),request.intent.account===account,signCalls===beforeSigns,puts,randoms];
    })()`)).toEqual(['enrolled',3,'prepared',0,null,true,true,true,true,true,true,true,true,true,3,5])
    expect(await page.evaluate(`(async()=>{const signs=signCalls,entropy=randoms,writes=puts,s=await scopes().catch(()=>null);
      const held=await outcome(()=>bootstrap.load());const expired=await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{}));
      const duplicated=await outcome(()=>Ordinary.OrdinaryStateOwner.enrollMemberRenewal(enrollmentObligation));
      return [s===null,held,expired,duplicated,signCalls===signs,randoms===entropy,puts===writes];
    })()`)).toEqual([true,'OrdinaryStateHold','OrdinaryStateHold','OrdinaryStateHold',true,true,true])
    await finish(page)
  })
}
test('fabricated obligation objects cannot start enrollment or invoke their getters',async({page})=>{
  expect(await page.evaluate(`(async()=>{let getters=0;const fake={get binding(){getters++;throw Error('must not read')}};let randoms=0;
    crypto.getRandomValues=()=>{randoms++;throw Error('must not allocate')};
    return [await (async()=>{try{await Ordinary.OrdinaryStateOwner.enrollMemberRenewal(fake);return 'bad'}catch(e){return e.name}})(),getters,randoms];
  })()`)).toEqual(['OrdinaryStateHold',0,0])
})

for(const cut of [1,2,3])for(const queued of [false,true]){
  test(`enrollment put ${cut} throws ${queued?'after':'before'} queue and reports exact prior`,async({page})=>{
    await start(page)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let calls=0;
      IDBObjectStore.prototype.put=function(...args){calls++;if(calls===${cut}&&!${queued})throw Error('fixture cut');const r=put.apply(this,args);if(calls===${cut})throw Error('fixture after queue');return r};
      window.restoreCut=()=>IDBObjectStore.prototype.put=put;
    })()`)
    await page.clock.fastForward(901000);await page.waitForFunction('window.enrollmentDone===true')
    expect(await page.evaluate(`(async()=>{const rows=await rawBoth();return [enrollmentOutcome?.status??window.enrollmentError,
      rows.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,prior[i].frame)),(await readAll()).length,signCalls===beforeSigns,randoms];})()`))
      .toEqual(['definite-abort',true,2,true,5])
    await page.evaluate('restoreCut()');await finish(page)
  })
}
for(const mask of [0,1,2,3,4,5,6,7]){
  test(`enrollment reconciles complete three-record combination ${mask} without reminting`,async({page})=>{
    await start(page)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;window.candidateRows=new Map();
      IDBObjectStore.prototype.put=function(value,key){candidateRows.set(key,structuredClone(value));
        const bit=key==='browser'?1:key===tabPurpose?2:4;if(!(${mask}&bit))return;return put.call(this,value,key)};
      window.restoreMixed=()=>IDBObjectStore.prototype.put=put;
    })()`)
    await page.clock.fastForward(901000)
    if(mask===0||mask===7){
      await page.waitForFunction('window.enrollmentDone===true')
      expect(await page.evaluate(`[enrollmentOutcome.status,signCalls===beforeSigns,randoms]`)).toEqual([mask===0?'definite-abort':'enrolled',true,5])
    }else{
      await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
      expect(await page.evaluate(`[window.enrollmentDone===true,signCalls===beforeSigns,randoms]`)).toEqual([false,true,5])
      await page.evaluate(`(async()=>{restoreMixed();const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');
        for(const[key,value]of candidateRows)tx.objectStore('owners').put(value,key);await new Promise(resolve=>tx.oncomplete=resolve);db.close();bootstrap.retryRetention()})()`)
      await page.waitForFunction('window.enrollmentDone===true')
      expect(await page.evaluate(`[enrollmentOutcome.status,signCalls===beforeSigns,randoms]`)).toEqual(['enrolled',true,5])
    }
    await page.evaluate('restoreMixed()');await finish(page)
  })
}

for(const lifetime of ['browser','tab','fore','root']){
  test(`${lifetime} revocation before enrollment performs no entropy or write and joins the real root`,async({page})=>{
    await start(page)
    await page.evaluate(`(()=>{window.closeState='pending';window.beforeEnrollment=()=>{
      if('${lifetime}'==='fore')window.closing=identity.close().then(()=>closeState='done');
      else if('${lifetime}'==='root'){bootstrap.revoke();window.closing=bootstrap.close().then(()=>closeState='done')}
      else window.closing=('${lifetime}'==='browser'?browserOwner:tabOwner).close().then(()=>closeState='done');
    }})()`)
    await page.clock.fastForward(901000);await page.waitForFunction('window.enrollmentDone===true')
    expect(await page.evaluate(`(async()=>{const rows=await rawBoth();return [!!window.enrollmentError,puts,randoms,signCalls===beforeSigns,
      rows.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame))]})()`)).toEqual([true,0,0,true,true])
    if(lifetime!=='fore')expect(await page.evaluate('closeState')).toBe('pending')
    await finish(page);await page.evaluate('closing');expect(await page.evaluate('closeState')).toBe('done')
  })
}
for(const lifetime of ['browser','tab','fore','selector','expiry','versionchange'])for(const phase of ['frame','control']){
  test(`${lifetime} during ${phase} crypto refuses enrollment before any put`,async({page})=>{
    await start(page)
    await page.evaluate(`(()=>{const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),transaction=IDBDatabase.prototype.transaction;
      window.cryptoGated=false;window.nativeDatabases=new Set();
      IDBDatabase.prototype.transaction=function(...args){if(this.name===Ordinary.ORDINARY_DATABASE)nativeDatabases.add(this);return transaction.apply(this,args)};
      crypto.subtle.encrypt=async(...args)=>{const result=await encrypt(...args),aad=new TextDecoder().decode(args[0].additionalData);
        if(!cryptoGated&&aad.includes('${phase==='frame'?'kithmoot.ordinary-state':'kithmoot.ordinary-operation.v1'}')){cryptoGated=true;await new Promise(resolve=>window.releaseCrypto=resolve)}return result};
      window.restoreCryptoGate=()=>{crypto.subtle.encrypt=encrypt;IDBDatabase.prototype.transaction=transaction};
    })()`)
    await page.clock.fastForward(901000);await page.waitForFunction('window.cryptoGated===true')
    if(lifetime==='expiry')await page.clock.fastForward(await page.evaluate('tabOwner.expiresAt-Date.now()+1'))
    else await page.evaluate(`(()=>{window.closeState='pending';
      if('${lifetime}'==='fore')window.closing=identity.close().then(()=>closeState='done');
      else if('${lifetime}'==='selector')window.current={...current,link:current.link+'#changed'};
      else if('${lifetime}'==='versionchange'){
        window.versionChanged=new Promise(resolve=>{const dbs=[...nativeDatabases].filter(db=>db.onversionchange!==null);let remaining=dbs.length;for(const db of dbs)db.addEventListener('versionchange',()=>{if(--remaining===0)resolve()},{once:true});if(!remaining)throw Error('no native database observed')});
        window.upgrade=new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      }else window.closing=('${lifetime}'==='browser'?browserOwner:tabOwner).close().then(()=>closeState='done');
    })()`)
    if(lifetime==='versionchange'){
      await page.evaluate('versionChanged')
    }
    await page.evaluate('releaseCrypto();undefined');await page.waitForFunction('window.enrollmentDone===true')
    expect(await page.evaluate(`[!!window.enrollmentError,puts,signCalls===beforeSigns,randoms===${phase==='frame'?2:5}]`))
      .toEqual([true,0,true,true])
    await page.evaluate('restoreCryptoGate()');await finish(page);await page.evaluate('window.closing')
    if(lifetime==='versionchange'){
      expect(await page.evaluate(`(async()=>{const db=await upgrade,tx=db.transaction('owners'),s=tx.objectStore('owners'),b=s.get('browser'),t=s.get(tabPurpose);await new Promise(resolve=>tx.oncomplete=resolve);db.close();return [b.result,t.result].every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame))})()`)).toBe(true)
    }else expect(await page.evaluate(`(async()=>{const rows=await rawBoth();return rows.every((r,i)=>Ordinary.sameOrdinaryFrame(r.frame,prior[i].frame))})()`)).toBe(true)
  })
}
for(const closing of [false,true]){
  test(`lost completion after all three puts retains exact E and joins browser close=${closing}`,async({page})=>{
    await start(page)
    await page.evaluate(`(()=>{const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete'),open=IDBFactory.prototype.open;let once=false;
      window.beforeEnrollment=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(callback){const tx=this;
        if(tx.mode==='readwrite'&&!once){once=true;descriptor.set.call(tx,event=>{IDBFactory.prototype.open=()=>{throw Error('fixture offline')};tx.onabort(event)})}
        else descriptor.set.call(tx,callback)}})};
      window.restoreLost=()=>{Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor);IDBFactory.prototype.open=open};
    })()`)
    await page.clock.fastForward(901000);await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
    expect(await page.evaluate('[window.enrollmentDone===true,puts,randoms,signCalls===beforeSigns]')).toEqual([false,3,5,true])
    if(closing){await page.evaluate(`window.closeState='pending';window.closing=browserOwner.close().then(()=>closeState='done');undefined`);expect(await page.evaluate('closeState')).toBe('pending')}
    await page.evaluate('restoreLost();bootstrap.retryRetention();undefined');await page.waitForFunction('window.enrollmentDone===true')
    expect(await page.evaluate('[enrollmentOutcome.status,puts,randoms,signCalls===beforeSigns]')).toEqual(['enrolled',3,5,true])
    if(closing)expect(await page.evaluate('closeState')).toBe('pending')
    await finish(page);if(closing){await page.evaluate('closing');expect(await page.evaluate('closeState')).toBe('done')}
  })
}

// Authenticated settled-history fixtures are installed before the actual
// renewal root captures P. They confer no production enrolment capability.
async function settleFixture(page:Page,purpose:string,sequence:number){
  await page.evaluate(`(async()=>{
    const purpose=${JSON.stringify(purpose)},sequence=${sequence};
    if(purpose!==tabPurpose){const other=new Ordinary.OrdinaryStateOwner(purpose,tabExpiry);await other.prepare(guard,new Map(),{phase:'complete',sources:new Map(),names:[]});await other.close()}
    const rows=new Map(await readAll()),br=rows.get('browser'),tr=rows.get(purpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key);
    const names=Ordinary.ordinaryOperationNames(purpose),id='4'.repeat(64),marker=Ordinary.ordinaryOperationMarker({id,tab:purpose,sequence,commitment:null});
    b.records.set(names.marker,marker);t.records.set(names.marker,marker);b.revision++;t.revision++;
    const bf=await Ordinary.sealOrdinaryImage(b,br.key),tf=await Ordinary.sealOrdinaryImage(t,tr.key);b.revision++;t.revision++;
    const cf=await Ordinary.sealOrdinaryImage(b,br.key),ct=await Ordinary.sealOrdinaryImage(t,tr.key);
    const journal={version:1,id,tab:purpose,sequence,phase:'settled',source:[Ordinary.ordinaryFrameDigest(br.frame),Ordinary.ordinaryFrameDigest(tr.frame)],sourceRevisions:[br.frame.revision,tr.frame.revision],
      enrolled:[Ordinary.ordinaryFrameDigest(bf),Ordinary.ordinaryFrameDigest(tf)],enrolledRevisions:[bf.revision,tf.revision],target:[Ordinary.ordinaryFrameDigest(cf),Ordinary.ordinaryFrameDigest(ct)],targetRevisions:[cf.revision,ct.revision],
      requestDigest:'1'.repeat(64),resultDigest:'2'.repeat(64),scopes:[['browser','fixture',b.generation,0],[purpose,'fixture',t.generation,0]],ceilings:[tabExpiry],request:'',result:null,secrets:[],nonces:null};
    const commitment=Ordinary.ordinaryOperationCommitment(Ordinary.decodeOrdinaryOperationClassification(Ordinary.encodeOrdinaryOperationJournal(journal)));
    const finalMarker=Ordinary.ordinaryOperationMarker({id,tab:purpose,sequence,commitment});b.records.set(names.marker,finalMarker);t.records.set(names.marker,finalMarker);b.revision++;t.revision++;
    const header=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
    const control=await Ordinary.sealOrdinaryOperationControl(journal,{browser:{binding:header(b),key:br.key},tab:{binding:header(t),key:tr.key}});
    const nextB=await Ordinary.sealOrdinaryImage(b,br.key),nextT=await Ordinary.sealOrdinaryImage(t,tr.key);
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners');
    s.put({key:br.key,frame:nextB},'browser');s.put({key:tr.key,frame:nextT},purpose);s.put(control,names.control);await new Promise(resolve=>tx.oncomplete=resolve);db.close();
  })()`)
}
for(const aborted of [false,true])test(`replacement of prior settled sequence preserves unrelated settled history, aborted=${aborted}`,async({page})=>{
  await start(page,false,true,true)
  const other='tab:'+'b'.repeat(64)
  await settleFixture(page,other,3);await settleFixture(page,'tab:'+'a'.repeat(64),7)
  await page.evaluate('(async()=>{await bootstrap.close();bootstrap=await open();member=await bootstrap.openMemberSession(sessionOptions);await join()})()')
  await page.evaluate(`(async()=>{window.prior=await rawBoth();window.otherPrior=new Map(await readAll());
    if(${aborted}){const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=()=>{throw Error('definite abort')};window.restoreAbort=()=>IDBObjectStore.prototype.put=put}
  })()`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.enrollmentDone===true||!!window.renewPreflightError');expect(await page.evaluate('window.renewPreflightError')).toBeUndefined()
  expect(await page.evaluate(`(async()=>{if(window.enrollmentError)return [enrollmentError];const rows=new Map(await readAll()),names=Ordinary.ordinaryOperationNames(tabPurpose),br=rows.get('browser'),tr=rows.get(tabPurpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),header=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
    const journal=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),{browser:{binding:header(b),key:br.key},tab:{binding:header(t),key:tr.key}});
    const other=${JSON.stringify(other)},on=Ordinary.ordinaryOperationNames(other),old=otherPrior.get(on.control),next=rows.get(on.control),same=(x,y)=>x.byteLength===y.byteLength&&new Uint8Array(x).every((v,i)=>v===new Uint8Array(y)[i]);
    const preserved=Ordinary.sameOrdinaryFrame(rows.get(other).frame,otherPrior.get(other).frame)&&['browser','tab'].every(k=>same(old[k].nonce,next[k].nonce)&&same(old[k].ciphertext,next[k].ciphertext));
    const pb=await Ordinary.openOrdinaryFrame(prior[0].frame,prior[0].key),pt=await Ordinary.openOrdinaryFrame(prior[1].frame,prior[1].key);
    if(!${aborted})Ordinary.restoreOrdinaryRenewalPredecessor(b,t,journal.request,{id:journal.id,sequence:journal.sequence});
    return [enrollmentOutcome.status,journal.sequence,journal.phase,preserved,Ordinary.ordinaryOperationSemanticDigest(b,t)===Ordinary.ordinaryOperationSemanticDigest(pb,pt),signCalls===beforeSigns,randoms];})()`))
    .toEqual([aborted?'definite-abort':'enrolled',aborted?7:8,aborted?'settled':'prepared',true,true,true,5])
  if(aborted)await page.evaluate('restoreAbort()');await finish(page)
})

for(const lifetime of ['browser','tab','fore','selector','expiry'])for(const cut of [1,2,3])test(`${lifetime} revocation after queued put ${cut} reconciles custody without provider effects`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let calls=0;IDBObjectStore.prototype.put=function(...args){const r=put.apply(this,args);if(++calls===${cut}){
    if('${lifetime}'==='browser'||'${lifetime}'==='tab'){window.closing=('${lifetime}'==='browser'?browserOwner:tabOwner).close()}
    else if('${lifetime}'==='fore')window.closing=identity.close();
    else if('${lifetime}'==='selector')window.current={...current,link:current.link+'#changed'};
    else {const now=Date.now;Date.now=()=>tabOwner.expiresAt+1;window.restoreDate=()=>Date.now=now}
  }return r};window.restorePutCut=()=>IDBObjectStore.prototype.put=put})()`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.enrollmentDone===true')
  const abort=lifetime==='browser'||lifetime==='tab'
  expect(await page.evaluate(`[window.enrollmentOutcome?.status??window.enrollmentError,signCalls===beforeSigns,randoms]`)).toEqual([abort?'definite-abort':'enrolled',true,5])
  await page.evaluate('restorePutCut();window.restoreDate?.()');await finish(page);await page.evaluate('window.closing')
})

for(const lifetime of ['browser','tab','root','forget','expiry','versionchange'])test(`${lifetime} preserves mixed enrollment until exact read-only reconciliation`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;window.candidateRows=new Map();
    IDBObjectStore.prototype.put=function(value,key){candidateRows.set(key,structuredClone(value));if(key==='browser')return put.call(this,value,key)};
    window.restoreMixed=()=>IDBObjectStore.prototype.put=put;
    const transaction=IDBDatabase.prototype.transaction;window.nativeDatabases=new Set();IDBDatabase.prototype.transaction=function(...args){if(this.name===Ordinary.ORDINARY_DATABASE)nativeDatabases.add(this);return transaction.apply(this,args)};
    window.restoreTransactions=()=>IDBDatabase.prototype.transaction=transaction;
  })()`)
  await page.clock.fastForward(901000);await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
  if(lifetime==='expiry')await page.clock.fastForward(await page.evaluate('tabOwner.expiresAt-Date.now()+1'))
  else await page.evaluate(`(()=>{window.closeState='pending';
    if('${lifetime}'==='versionchange'){
      const dbs=[...nativeDatabases].filter(db=>db.onversionchange!==null);if(!dbs.length)throw Error('no native connection observed');window.versionChanged=new Promise(resolve=>{for(const db of dbs)db.addEventListener('versionchange',resolve,{once:true})});
      window.upgrade=new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,2);r.onupgradeneeded=()=>r.transaction.abort();r.onsuccess=()=>{r.result.close();reject(Error('upgrade must abort'))};r.onerror=()=>resolve(null)});
    }else {const close='${lifetime}'==='forget'?bootstrap.forget():'${lifetime}'==='root'?bootstrap.close():('${lifetime}'==='browser'?browserOwner:tabOwner).close();
      window.closing=close.then(()=>closeState='done',e=>closeState=e.name)}
  })()`)
  if(lifetime==='versionchange')await page.evaluate('versionChanged')
  else if(lifetime!=='expiry')expect(await page.evaluate('closeState')).toBe(lifetime==='forget'?'OrdinaryStateHold':'pending')
  expect(await page.evaluate('[window.enrollmentDone===true,signCalls===beforeSigns,randoms,browserOwner.holdingRetention,tabOwner.holdingRetention]')).toEqual([false,true,5,true,true])
  if(lifetime==='forget'){
    expect(await page.evaluate(`(async()=>{const before=puts;return [await outcome(()=>bootstrap.load()),await outcome(()=>bootstrap.openMemberSession(sessionOptions)),puts===before,signCalls===beforeSigns]})()`)).toEqual(['OrdinaryStateHold','OrdinaryStateHold',true,true])
    await page.evaluate("window.joinState='pending';window.joinClose=bootstrap.close().then(()=>joinState='done');undefined");expect(await page.evaluate('joinState')).toBe('pending')
  }
  await page.evaluate(`(async()=>{restoreMixed();restoreTransactions();const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');
    for(const[key,value]of candidateRows)tx.objectStore('owners').put(value,key);await new Promise(resolve=>tx.oncomplete=resolve);db.close();bootstrap.retryRetention()})()`)
  await page.waitForFunction('window.enrollmentDone===true')
  expect(await page.evaluate('[enrollmentOutcome.status,signCalls===beforeSigns,randoms]')).toEqual(['enrolled',true,5])
  if(lifetime==='browser'||lifetime==='tab'||lifetime==='root')expect(await page.evaluate('closeState')).toBe('pending')
  if(lifetime==='versionchange')await page.evaluate('upgrade')
  await finish(page);await page.evaluate('window.closing')
  if(lifetime==='forget'){expect(await page.evaluate('closeState')).toBe('OrdinaryStateHold');await page.evaluate('joinClose');expect(await page.evaluate('joinState')).toBe('done')}
  else if(lifetime!=='expiry'&&lifetime!=='versionchange')expect(await page.evaluate('closeState')).toBe('done')
})


for(const visitor of [false,true])for(const keep of [false,true])test(`fixed signing persists started before one provider and canonical result, visitor=${visitor}, keep=${keep}`,async({page})=>{
  await start(page,visitor,keep)
  await page.evaluate(`(()=>{window.performSigning=true;window.providerPhase=null;const original=window.nostr?.signEvent;
    if(original){nostr.signEvent=async event=>{if(event.kind===20460){const rows=new Map(await readAll());const br=rows.get('browser'),tr=rows.get(tabPurpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),header=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});const j=await Ordinary.openOrdinaryOperationControl(rows.get(Ordinary.ordinaryOperationNames(tabPurpose).control),{browser:{binding:header(b),key:br.key},tab:{binding:header(t),key:tr.key}});window.providerPhase=j.phase;window.providerKeyPersisted=j.secrets.length===1&&j.nonces!==null;j.secrets.forEach(k=>k.fill(0));window.providerObserved=true}return original(event)}}
  })()`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.signingDone===true')
  expect(await page.evaluate('window.signingError')).toBeUndefined()
  expect(await page.evaluate(`(async()=>{const rows=new Map(await readAll()),br=rows.get('browser'),tr=rows.get(tabPurpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),header=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
    const j=await Ordinary.openOrdinaryOperationControl(rows.get(Ordinary.ordinaryOperationNames(tabPurpose).control),{browser:{binding:header(b),key:br.key},tab:{binding:header(t),key:tr.key}});
    const pB=await Ordinary.openOrdinaryFrame(prior[0].frame,prior[0].key),pT=await Ordinary.openOrdinaryFrame(prior[1].frame,prior[1].key),result=JSON.parse(j.result);
    const held=await outcome(()=>bootstrap.load()),duplicate=await outcome(()=>Ordinary.OrdinaryStateOwner.signMemberRenewal(enrollmentOutcome.enrollment));
    const answer=[j.phase,j.secrets.length,j.nonces.every(n=>n.length===24),b.revision===pB.revision+1,t.revision===pT.revision+1,result.kind,result.pubkey===participant,
      result.created_at===Ordinary.readOrdinaryRenewalRequest(j.request).intent.issuedAt,held,duplicate,signCalls-beforeSigns,puts,randoms];j.secrets.forEach(k=>k.fill(0));return answer;})()`))
    .toEqual(['candidate-prepared',1,true,true,true,20460,true,true,'OrdinaryStateHold','OrdinaryStateHold',visitor?0:1,6,15])
  if(!visitor)expect(await page.evaluate('[providerPhase,providerKeyPersisted]')).toEqual(['provider-started',true])
  await finish(page)
})


for(const sync of [false,true])test(`fixed signing permanently blocks transient provider retry, synchronous=${sync}`,async({page})=>{
  await start(page)
  await page.evaluate(`window.performSigning=true;window.signHook=()=>{${sync?"throw Error('Extension context invalidated')":"return Promise.reject(Error('Extension context invalidated'))"}}`)
  await page.clock.fastForward(901000);await page.waitForFunction('signCalls===beforeSigns+1')
  await page.clock.fastForward(300);await page.waitForFunction('window.signingDone===true')
  expect(await page.evaluate(`(async()=>{const rows=new Map(await readAll()),br=rows.get('browser'),tr=rows.get(tabPurpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),h=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
    const j=await Ordinary.openOrdinaryOperationControl(rows.get(Ordinary.ordinaryOperationNames(tabPurpose).control),{browser:{binding:h(b),key:br.key},tab:{binding:h(t),key:tr.key}}),answer=[!!window.signingError,signCalls-beforeSigns,j.phase,j.result,puts,randoms];j.secrets.forEach(k=>k.fill(0));return answer})()`))
    .toEqual([true,1,'provider-started',null,4,12])
  await page.clock.fastForward(1000);expect(await page.evaluate('signCalls-beforeSigns')).toBe(1);await finish(page)
})
for(const field of ['restamp','room','device','expiry','seal','signature','extra','cache-false'])test(`fixed signing refuses provider ${field} substitution before result persistence`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{window.performSigning=true;window.signHook=async event=>{
    if('${field}'==='restamp')event.created_at++
    if('${field}'==='room')event.tags[0][1]='1'.repeat(64)
    if('${field}'==='device')event.tags[1][1]=participant
    if('${field}'==='expiry')event.tags[2][1]=String(Number(event.tags[2][1])+1)
    if('${field}'==='seal')event.tags[3][1]=participant
    const result=await signer.call(identity,event)
    if('${field}'==='signature')result.sig='0'.repeat(128)
    if('${field}'==='extra')result.extra=true
    if('${field}'==='cache-false')for(const symbol of Object.getOwnPropertySymbols(result))result[symbol]=false
    return result
  }})()`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.signingDone===true')
  expect(await page.evaluate('[!!window.signingError,signCalls-beforeSigns,puts,randoms]')).toEqual([true,1,4,13]);await finish(page)
})


interface SigningState {phase:string;result:string|null;target:readonly [string,string]|null;nonces:readonly [string,string]|null;secretCount:number;signCalls:number;puts:number;randoms:number;error:boolean;done:boolean}
async function signingState(page:Page):Promise<SigningState>{return page.evaluate<SigningState>(`(async()=>{
  const rows=new Map(await readAll()),br=rows.get('browser'),tr=rows.get(tabPurpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),h=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
  const j=await Ordinary.openOrdinaryOperationControl(rows.get(Ordinary.ordinaryOperationNames(tabPurpose).control),{browser:{binding:h(b),key:br.key},tab:{binding:h(t),key:tr.key}});
  try{return {phase:j.phase,result:j.result,target:j.target,nonces:j.nonces,secretCount:j.secrets.length,signCalls:signCalls-beforeSigns,puts,randoms,error:!!window.signingError,done:window.signingDone===true}}
  finally{j.secrets.forEach(k=>k.fill(0))}
})()`)}
for(const phase of ['started','returned'])for(const fault of ['before','after','corrupt','unavailable'])test(`fixed signing retains exact ${phase} candidate through ${fault} custody and retries without resigning`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{window.performSigning=true;window.beforeSigning=()=>{
    const put=IDBObjectStore.prototype.put,open=IDBFactory.prototype.open;let calls=0;
    IDBObjectStore.prototype.put=function(value,key){if(++calls===${phase==='started'?1:2}){
      window.phaseCandidate=structuredClone(value);window.phaseKey=key;
      if('${fault}'==='before')throw Error('phase before queue');
      if('${fault}'==='corrupt'){const bad=structuredClone(value);new Uint8Array(bad.browser.ciphertext)[0]^=1;return put.call(this,bad,key)}
      const r=put.call(this,value,key);
      if('${fault}'==='after')throw Error('phase after queue');
      IDBFactory.prototype.open=()=>{throw Error('phase read unavailable')};return r;
    }return put.call(this,value,key)};
    window.restorePhase=()=>{IDBObjectStore.prototype.put=put;IDBFactory.prototype.open=open};
  }})()`)
  await page.clock.fastForward(901000);await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
  expect(await page.evaluate('[window.signingDone===true,signCalls-beforeSigns,randoms]')).toEqual([false,phase==='started'?0:1,phase==='started'?12:13])
  expect(await page.evaluate(`(async()=>{const entropy=randoms,writes=puts,signs=signCalls;return [await outcome(()=>bootstrap.load()),writes===puts,entropy===randoms,signs===signCalls]})()`)).toEqual(['OrdinaryStateHold',true,true,true])
  await page.evaluate(`(async()=>{restorePhase();const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');
    tx.objectStore('owners').put(phaseCandidate,phaseKey);await new Promise(resolve=>tx.oncomplete=resolve);db.close();bootstrap.retryRetention()})()`)
  await page.waitForFunction('window.signingDone===true');expect(await page.evaluate('window.signingError')).toBeUndefined()
  const state=await signingState(page);expect([state.phase,state.signCalls,state.randoms,state.secretCount]).toEqual(['candidate-prepared',1,15,1])
  if(phase==='returned')expect(await page.evaluate(`(async()=>{const rows=new Map(await readAll()),br=rows.get('browser'),tr=rows.get(tabPurpose),b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),h=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt}),keys={browser:{binding:h(b),key:br.key},tab:{binding:h(t),key:tr.key}};
    const old=await Ordinary.openOrdinaryOperationControl(phaseCandidate,keys),now=await Ordinary.openOrdinaryOperationControl(rows.get(phaseKey),keys);
    try{return old.phase==='provider-returned'&&old.target===null&&now.phase==='candidate-prepared'&&old.result===now.result&&JSON.stringify(old.nonces)===JSON.stringify(now.nonces)}finally{old.secrets.forEach(k=>k.fill(0));now.secrets.forEach(k=>k.fill(0))}})()`)).toBe(true)
  await finish(page)
})
for(const lifetime of ['fore','browser','tab','root'])test(`fixed signing ${lifetime} close joins the actual provider and retains its exact result without C`,async({page})=>{
  await start(page)
  await page.evaluate('window.performSigning=true;gateSigner()');await page.clock.fastForward(901000);await page.waitForFunction('window.signing===true')
  expect((await signingState(page)).phase).toBe('provider-started')
  await page.evaluate(`window.closeState='pending';window.closing=${lifetime==='fore'?'identity':lifetime==='root'?'bootstrap':lifetime+'Owner'}.close().then(()=>closeState='done');undefined`)
  expect(await page.evaluate('[closeState,window.signingDone===true]')).toEqual(['pending',false])
  await page.evaluate('releaseSigner();undefined');await page.waitForFunction('window.signingDone===true')
  const state=await signingState(page);expect([state.phase,state.result,state.signCalls,state.puts,state.randoms,state.error]).toEqual(['provider-returned',expect.any(String),1,5,13,true])
  expect(state.target).toBeNull()
  if(lifetime!=='fore')expect(await page.evaluate('closeState')).toBe('pending')
  await finish(page);await page.evaluate('closing');expect(await page.evaluate('closeState')).toBe('done')
})
for(const lifetime of ['fore','browser','tab','root'])test(`fixed signing ${lifetime} revocation before started produces no extra entropy or provider`,async({page})=>{
  await start(page)
  await page.evaluate(`window.performSigning=true;window.beforeSigning=()=>{window.closing=${lifetime==='fore'?'identity':lifetime==='root'?'bootstrap':lifetime+'Owner'}.close()}`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.signingDone===true')
  const state=await signingState(page);expect([state.phase,state.result,state.signCalls,state.puts,state.randoms,state.error]).toEqual(['prepared',null,0,3,5,true])
  await finish(page);await page.evaluate('closing')
})


for(const cut of [1,2,3,4])test(`fixed signing preserves client fence at check ${cut}`,async({page})=>{
  await start(page)
  await page.evaluate(`window.performSigning=true;window.beforeSigning=()=>{window.clientCheckCount=0;window.clientHook=()=>{if(clientCheckCount===${cut})throw Error('current client fence refuses')}}`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.signingDone===true')
  const state=await signingState(page),before=cut===1
  expect([state.phase,state.result,state.signCalls,state.puts,state.randoms,state.error]).toEqual([before?'prepared':cut===4?'provider-returned':'provider-started',cut===4?expect.any(String):null,cut===4?1:0,before?3:cut===4?5:4,before?5:cut===4?13:12,true])
  await finish(page)
})
for(const lifetime of ['fore','browser','tab','expiry','versionchange'])for(const stage of ['started','returned'])test(`fixed signing ${lifetime} revocation during ${stage} control crypto stops the next phase`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{window.performSigning=true;window.beforeSigning=()=>{
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle),transaction=IDBDatabase.prototype.transaction;let calls=0;
    window.nativeDatabases=new Set();IDBDatabase.prototype.transaction=function(...args){if(this.name===Ordinary.ORDINARY_DATABASE)nativeDatabases.add(this);return transaction.apply(this,args)};
    crypto.subtle.encrypt=async(...args)=>{const result=await encrypt(...args),aad=new TextDecoder().decode(args[0].additionalData);
      if(aad.includes('kithmoot.ordinary-operation.v1')&&++calls===${stage==='started'?1:3}){window.phaseCryptoWaiting=true;await new Promise(resolve=>window.releasePhaseCrypto=resolve)}return result};
    window.restorePhaseCrypto=()=>{crypto.subtle.encrypt=encrypt;IDBDatabase.prototype.transaction=transaction};
  }})()`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.phaseCryptoWaiting===true')
  if(lifetime==='expiry')await page.clock.fastForward(await page.evaluate('tabOwner.expiresAt-Date.now()+1'))
  else await page.evaluate(`(()=>{
    if('${lifetime}'==='fore')window.closing=identity.close()
    else if('${lifetime}'==='versionchange'){
      const dbs=[...nativeDatabases].filter(db=>db.onversionchange!==null);if(!dbs.length)throw Error('missing live database');window.versionChanged=new Promise(resolve=>{for(const db of dbs)db.addEventListener('versionchange',resolve,{once:true})});
      window.upgrade=new Promise(resolve=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,2);r.onupgradeneeded=()=>r.transaction.abort();r.onerror=()=>resolve();r.onsuccess=()=>{r.result.close();throw Error('upgrade must abort')}})
    }else window.closing=('${lifetime}'==='browser'?browserOwner:tabOwner).close()
  })()`)
  if(lifetime==='versionchange')await page.evaluate('versionChanged')
  await page.evaluate('releasePhaseCrypto();undefined');await page.waitForFunction('window.signingDone===true')
  const state=await signingState(page),before=stage==='started'
  expect([state.phase,state.result,state.signCalls,state.puts,state.error]).toEqual([before?'prepared':'provider-returned',before?null:expect.any(String),before?0:1,before?3:5,true])
  await page.evaluate('restorePhaseCrypto()');await finish(page);await page.evaluate('window.closing');if(lifetime==='versionchange')await page.evaluate('upgrade')
})
for(const closing of ['fore','browser','tab','root','forget'])for(const stage of ['started','returned'])test(`fixed signing ${closing} waits for unknown ${stage} custody facts before draining`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{window.performSigning=true;window.beforeSigning=()=>{const put=IDBObjectStore.prototype.put;let calls=0;
    IDBObjectStore.prototype.put=function(value,key){if(++calls===${stage==='started'?1:2}){window.phaseCandidate=structuredClone(value);window.phaseKey=key;const bad=structuredClone(value);new Uint8Array(bad.tab.ciphertext)[0]^=1;return put.call(this,bad,key)}return put.call(this,value,key)};
    window.restorePhase=()=>IDBObjectStore.prototype.put=put;
  }})()`)
  await page.clock.fastForward(901000);await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
  await page.evaluate(`window.closeState='pending';window.closing=${closing==='forget'?'bootstrap.forget()':(closing==='fore'?'identity':closing==='root'?'bootstrap':closing+'Owner')+'.close()'}.then(()=>closeState='done',e=>closeState=e.name);undefined`)
  expect(await page.evaluate('[closeState,window.signingDone===true]')).toEqual([closing==='forget'?'OrdinaryStateHold':'pending',false])
  await page.evaluate(`(async()=>{restorePhase();const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');tx.objectStore('owners').put(phaseCandidate,phaseKey);await new Promise(resolve=>tx.oncomplete=resolve);db.close();bootstrap.retryRetention()})()`)
  await page.waitForFunction('window.signingDone===true');const state=await signingState(page)
  expect([state.phase,state.signCalls,state.error]).toEqual([stage==='started'?'provider-started':'provider-returned',stage==='started'?0:1,true])
  await finish(page);await page.evaluate('closing');expect(await page.evaluate('closeState')).toBe(closing==='forget'?'OrdinaryStateHold':'done')
})


for(const closing of ['fore','browser','tab','root'])for(const copy of [1,2])test(`fixed signing retains result through copy ${copy} crypto failure and ${closing} close`,async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{window.performSigning=true;window.beforeSigning=()=>{
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let calls=0,failed=false,original;
    crypto.subtle.encrypt=async(...args)=>{
      const aad=new TextDecoder().decode(args[0].additionalData),operation=aad.includes('kithmoot.ordinary-operation.v1');
      if(operation&&++calls===${2+copy}){failed=true;original=[Uint8Array.from(args[0].iv),Uint8Array.from(args[2])];throw Error('result custody crypto interrupted')}
      if(failed&&operation){const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
        window.sameResultPlaintext=same(original[1],new Uint8Array(args[2]));
        if(++window.retryResultCopies===${copy})window.sameResultNonce=same(original[0],new Uint8Array(args[0].iv));
      }
      return encrypt(...args)
    };window.retryResultCopies=0;window.restoreResultCrypto=()=>{crypto.subtle.encrypt=encrypt;original?.forEach(bytes=>bytes.fill(0))};
  }})()`)
  await page.clock.fastForward(901000);await page.waitForFunction('browserOwner.holdingRetention&&tabOwner.holdingRetention')
  expect(await page.evaluate('[signCalls-beforeSigns,randoms,window.signingDone===true]')).toEqual([1,13,false])
  await page.evaluate(`window.closeState='pending';window.closing=${closing==='fore'?'identity':closing==='root'?'bootstrap':closing+'Owner'}.close().then(()=>closeState='done');undefined`)
  expect(await page.evaluate('closeState')).toBe('pending')
  await page.evaluate('bootstrap.retryRetention()');await page.waitForFunction('window.signingDone===true')
  const state=await signingState(page)
  expect([state.phase,state.target,state.result,state.signCalls,state.puts,state.randoms,state.error]).toEqual(['provider-returned',null,expect.any(String),1,5,13,true])
  expect(await page.evaluate('[sameResultPlaintext,sameResultNonce]')).toEqual([true,true])
  await page.evaluate('restoreResultCrypto()');await finish(page);await page.evaluate('closing');expect(await page.evaluate('closeState')).toBe('done')
})
for(const visitor of [false,true])test(`fixed signing retains result before any candidate image encryption, visitor=${visitor}`,async({page})=>{
  await start(page,visitor)
  await page.evaluate(`(()=>{window.performSigning=true;window.beforeSigning=()=>{
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let held=false;
    crypto.subtle.encrypt=async(...args)=>{if(!held&&new TextDecoder().decode(args[0].additionalData).includes('kithmoot.ordinary-state')){
      held=true;window.candidateCryptoWaiting=true;await new Promise(resolve=>window.releaseCandidateCrypto=resolve)}return encrypt(...args)};
    window.restoreCandidateCrypto=()=>crypto.subtle.encrypt=encrypt;
  }})()`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.candidateCryptoWaiting===true')
  const before=await signingState(page)
  expect([before.phase,before.target,before.result,before.puts,before.randoms,before.done]).toEqual(['provider-returned',null,expect.any(String),5,13,false])
  await page.evaluate('window.closing=bootstrap.close();releaseCandidateCrypto();undefined');await page.waitForFunction('window.signingDone===true')
  const after=await signingState(page)
  expect([after.phase,after.target,after.result,after.puts,after.randoms,after.error]).toEqual(['provider-returned',null,before.result,5,13,true])
  await page.evaluate('restoreCandidateCrypto()');await finish(page);await page.evaluate('closing')
})
test('fixed signing captures an immutable result before the provider object changes during custody crypto',async({page})=>{
  await start(page)
  await page.evaluate(`(()=>{window.performSigning=true;window.signHook=async event=>{window.providerObject=await signer.call(identity,event);window.originalProviderJSON=JSON.stringify(providerObject);return providerObject};
    window.beforeSigning=()=>{const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let calls=0;
      crypto.subtle.encrypt=async(...args)=>{if(new TextDecoder().decode(args[0].additionalData).includes('kithmoot.ordinary-operation.v1')&&++calls===3){
        window.returnedCryptoWaiting=true;await new Promise(resolve=>window.releaseReturnedCrypto=resolve)}return encrypt(...args)};
      window.restoreReturnedCrypto=()=>crypto.subtle.encrypt=encrypt;
    }
  })()`)
  await page.clock.fastForward(901000);await page.waitForFunction('window.returnedCryptoWaiting===true')
  await page.evaluate(`providerObject.sig='0'.repeat(128);providerObject.tags[0][1]='1'.repeat(64);releaseReturnedCrypto();undefined`)
  await page.waitForFunction('window.signingDone===true');const state=await signingState(page)
  expect([state.phase,state.target,state.result,state.signCalls,state.puts,state.randoms,state.error]).toEqual(['provider-returned',null,expect.any(String),1,5,13,true])
  expect(JSON.parse(state.result!)).toEqual(JSON.parse(await page.evaluate<string>('originalProviderJSON')))
  await page.evaluate('restoreReturnedCrypto()');await finish(page)
})
