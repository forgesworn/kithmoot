import {build} from 'esbuild'
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {test,expect,chromium,firefox,webkit,type Page} from '@playwright/test'
import {setup} from './ordinary-bootstrap.setup.js'
import {controls} from './ordinary-member-session.setup.js'
const ORIGIN='https://ordinary-renewal-startup.invalid'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:['test/ordinary-renewal-enrollment.browser-entry.ts'],bundle:true,write:false,format:'iife',globalName:'Ordinary',platform:'browser',target:'es2022',
    plugins:[{name:'actual-private-renewal-startup-cut',setup(builder){builder.onLoad({filter:/ordinary-persistent-bootstrap\.ts$/},async input=>{
      const source=await readFile(input.path,'utf8'),marker='            const selected = source\n'
      if(source.split(marker).length!==2)throw Error('startup private factory fixture drift')
      return {loader:'ts',contents:source.replace(marker,`            const observer=globalThis as any
            if(observer.skipStartupCuts>0){observer.skipStartupCuts--}else{
            const outcome=await OrdinaryStateOwner.enrollMemberRenewal(obligation!)
            if(outcome.status!=='enrolled')throw Error('startup fixture did not enroll')
            observer.actualStage='prepared'
            if(observer.requestedStage!=='prepared'){
              observer.beforeActualSigning?.()
              const returned=await OrdinaryStateOwner.signMemberRenewal(outcome.enrollment)
              observer.actualStage='candidate-prepared'
              if(observer.requestedStage==='candidate-committed'||observer.requestedStage==='settled'){
                const committed=await OrdinaryStateOwner.commitMemberRenewalCandidate(returned)
                observer.actualStage='candidate-committed'
                if(observer.requestedStage==='settled'){
                  await OrdinaryStateOwner.settleMemberRenewalCandidate(committed)
                  observer.actualStage='settled'
                }
              }
            }
            await new Promise<void>(resolve=>observer.releaseStartupCut=resolve)
            protocol!.close();return
            }
`+marker)}
    });builder.onLoad({filter:/ordinary-renewal-candidate\.ts$/},async input=>{
      const source=await readFile(input.path,'utf8'),marker='        if(intent.keep)b.set(persistentProofName(verified.proof.binding),proofRaw)'
      if(source.split(marker).length!==2)throw Error('historical lineage comparison fixture drift')
      const candidateMarker='  return candidate\n'
      if(source.split(candidateMarker).length!==2)throw Error('historical candidate comparison fixture drift')
      return{loader:'ts',contents:source.replace(marker,'        ;(globalThis as any).compareHistoricalLease?.(request,proofRaw,lease,enrolled)\n'+marker)
        .replace(candidateMarker,'  ;(globalThis as any).compareHistoricalCandidate?.(request,result,seal,enrolled,candidate)\n'+candidateMarker)}
    })}}]})).outputFiles[0]!.text
})
test.beforeEach(async({context,page})=>{
  await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
  await page.goto(ORIGIN);await page.clock.install();await page.evaluate('window.memberEpochTimeoutMs=10000')
})
async function stage(page:Page,phase:string,visitor=false,keep=true){
  await page.evaluate(`(${setup})(${JSON.stringify({visitor,keep,noRelays:true})})`);await page.evaluate(`(${controls})()`);await page.evaluate('join()')
  await page.evaluate(`window.requestedStage='${phase}';window.beforeActualSigning=()=>{
    if(requestedStage==='provider-started'){
      if(account!==null)gateSigner();else{
        const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let blocked=false;
        crypto.subtle.decrypt=async(...args)=>{const result=await decrypt(...args);
          if(!blocked&&new TextDecoder().decode(args[0].additionalData).includes('kithmoot.ordinary-operation.v1')){
            const header=Ordinary.decodeOrdinaryOperationClassification(new Uint8Array(result));
            if(header.phase==='provider-started'){blocked=true;window.actualStage='provider-started';await new Promise(()=>{})}
          }return result}
      }
    }
    if(requestedStage==='provider-returned'){
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let blocked=false;
      crypto.subtle.encrypt=async(...args)=>{if(!blocked&&new TextDecoder().decode(args[0].additionalData).includes('kithmoot.ordinary-state')){
        blocked=true;window.actualStage='provider-returned';await new Promise(()=>{})}return encrypt(...args)}
    }};`)
  await page.clock.fastForward(901000)
  if(phase==='provider-started'&&!visitor)await page.waitForFunction('window.signing===true')
  else await page.waitForFunction(`window.actualStage==='${phase}'`)
  await page.evaluate(`window.readStartupRaw=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
    const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),keys=s.getAllKeys(),values=s.getAll();
    tx.oncomplete=()=>{db.close();resolve(keys.result.map((key,i)=>[key,values.result[i]]))};tx.onabort=()=>reject(tx.error)}})`)
}
async function reloadInspector(page:Page,recovery=false){
  await page.reload()
  await page.evaluate(`(()=>{window.puts=0;window.entropy=0;window.providers=0;window.live=true;window.guard=()=>live;
    const random=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=(...args)=>{entropy++;if(${recovery})return random(...args);throw Error('startup must not allocate')};
    for(const name of ['put','delete','clear']){const original=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){puts++;if(${recovery})return original.apply(this,args);throw Error('startup must not write')}};
    window.nostr={getPublicKey:()=>{providers++;throw Error('startup must not ask a provider')},signEvent:()=>{providers++;throw Error('startup must not sign')}};
    window.fresh=new Ordinary.OrdinaryStateOwner()
  })()`)
}
async function restartCommitted(page:Page){
  await stage(page,'candidate-committed')
  const purpose=await page.evaluate<string>('tabPurpose')
  await reloadInspector(page,true)
  await page.evaluate(`window.purpose='${purpose}';window.readRecoveryRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
    const db=r.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();
    tx.oncomplete=()=>{db.close();resolve(keys.result.map((key,i)=>[key,values.result[i]]))};tx.onabort=()=>reject(tx.error)}});
    window.recoveryOutcome='pending';window.beginRecovery=()=>{window.recovering=fresh.recoverCommittedRenewalAtStartup(purpose,guard).then(result=>{recoveryOutcome=result.status},e=>{recoveryOutcome=e.name})}`)
}
async function recoveryDigests(page:Page){
  return page.evaluate(`readRecoveryRows().then(rows=>rows.map(([name,row])=>[name,name.startsWith(Ordinary.ORDINARY_OPERATION_CONTROL_PREFIX)?Ordinary.ordinaryOperationControlDigest(row):Ordinary.ordinaryFrameDigest(row.frame)]))`)
}
async function restartRetained(page:Page,phase:string,visitor=false,keep=true,expired=false){
  await stage(page,phase,visitor,keep);const purpose=await page.evaluate<string>('tabPurpose')
  await reloadInspector(page,true)
  if(expired){await page.clock.install();await page.clock.fastForward(43_200_000)}
  await page.evaluate(`window.purpose='${purpose}';window.readRecoveryRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
    const db=r.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();
    tx.oncomplete=()=>{db.close();resolve(keys.result.map((key,i)=>[key,values.result[i]]))};tx.onabort=()=>reject(tx.error)}});
    window.retainedOutcome='pending';window.beginRetained=()=>{window.retaining=fresh.recoverRetainedRenewalAtStartup(purpose,guard).then(result=>{retainedOutcome=result.status},e=>{retainedOutcome=e.name})};
    window.retainedState=async()=>{const rows=new Map(await readRecoveryRows()),br=rows.get('browser'),tr=rows.get(purpose),names=Ordinary.ordinaryOperationNames(purpose),
      b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
      const j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});
      try{return {phase:j.phase,request:j.request,result:j.result,history:[j.id,j.sequence,j.source,j.enrolled,j.sourceRevisions,j.enrolledRevisions,j.requestDigest,j.resultDigest,j.scopes,j.ceilings],
        target:j.target,targetRevisions:j.targetRevisions,revisions:[b.revision,t.revision],digests:[Ordinary.ordinaryFrameDigest(br.frame),Ordinary.ordinaryFrameDigest(tr.frame)],
        secrets:j.secrets.length,nonces:j.nonces,markers:[b.records.get(names.marker),t.records.get(names.marker)]}}finally{j.secrets.forEach(key=>key.fill(0))}}`)
}
for(const phase of ['prepared','provider-started','provider-returned','candidate-prepared','candidate-committed','settled'])for(const visitor of [false,true])for(const keep of [false,true]){
  test(`page restart classifies ${phase} without effects, visitor=${visitor}, keep=${keep}`,async({page})=>{
    await stage(page,phase,visitor,keep)
    const before=await page.evaluate('(async()=>{const rows=await readStartupRaw();return rows.map(([name,row])=>[name,name.startsWith(Ordinary.ORDINARY_OPERATION_CONTROL_PREFIX)?Ordinary.ordinaryOperationControlDigest(row):[Ordinary.ordinaryFrameDigest(row.frame),row.pending]])})()')
    await reloadInspector(page)
    expect(await page.evaluate(`(async()=>{const result=await fresh.inspectRenewalStartup(guard);return[result.status,result.operations.map(op=>op.phase),
      Object.isFrozen(result)&&Object.isFrozen(result.operations)&&result.operations.every(Object.isFrozen),puts,entropy,providers]})()`))
      .toEqual([phase==='settled'?'ordinary':'recovery-required',[phase],true,0,0,0])
    expect(await page.evaluate(`(async()=>{try{await fresh.prepare(guard,new Map());return 'ok'}catch(e){return e.name}})()`)).toBe(phase==='settled'?'ok':'OrdinaryStateHold')
    expect(await page.evaluate('[puts,entropy,providers]')).toEqual([0,0,0])
    const after=await page.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),s=tx.objectStore('owners'),keys=s.getAllKeys(),values=s.getAll();
      tx.oncomplete=()=>{db.close();resolve(keys.result.map((name,i)=>[name,name.startsWith(Ordinary.ORDINARY_OPERATION_CONTROL_PREFIX)?Ordinary.ordinaryOperationControlDigest(values.result[i]):[Ordinary.ordinaryFrameDigest(values.result[i].frame),values.result[i].pending]]))};tx.onabort=()=>reject(tx.error)}})`)
    expect(after).toEqual(before);await page.evaluate('fresh.close()')
  })
}
test('absent startup inspection leaves no database, provider, nonce or key',async({page})=>{
  await reloadInspector(page)
  expect(await page.evaluate(`(async()=>{const before=await indexedDB.databases(),result=await fresh.inspectRenewalStartup(guard),after=await indexedDB.databases();
    return[result.status,result.operations.length,before.some(db=>db.name===Ordinary.ORDINARY_DATABASE),after.some(db=>db.name===Ordinary.ORDINARY_DATABASE),puts,entropy,providers]})()`))
    .toEqual(['empty',0,false,false,0,0,0]);await page.evaluate('fresh.close()')
})
for(const phase of ['prepared','provider-started','provider-returned','candidate-prepared','candidate-committed']){
  test(`expired ${phase} remains recovery-required before tab expiry`,async({page})=>{
    await stage(page,phase);await reloadInspector(page);await page.clock.install();await page.clock.fastForward(43_200_000)
    expect(await page.evaluate(`(async()=>{const result=await fresh.inspectRenewalStartup(guard);let expired;
      try{await Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{})}catch(e){expired=e.name};return[result.status,result.operations[0].phase,expired,puts,entropy,providers]})()`))
      .toEqual(['recovery-required',phase,'OrdinaryStateHold',0,0,0]);await page.evaluate('fresh.close()')
  })
}

for(const [phase,fault]of [['prepared','device'],['prepared','link'],['prepared','semantic'],['prepared','source'],['prepared','expiry'],
  ['provider-started','device'],['provider-started','ceilings'],['provider-returned','signature'],['provider-returned','extra-result'],
  ['candidate-prepared','enrolled'],['candidate-committed','link'],['candidate-committed','proof'],['candidate-committed','epoch-id'],['candidate-committed','target'],['settled','mixed-copy'],['prepared','cipher'],['prepared','alias'],
  ['prepared','missing-tab'],['prepared','unexpected-key'],['prepared','pending'],
  ['candidate-committed','missing-tab'],['candidate-committed','unexpected-key'],['candidate-committed','pending'],['candidate-committed','cipher'],['candidate-committed','alias']]){
  test(`startup refuses authenticated ${phase} ${fault} mismatch before any effect`,async({page})=>{
    await stage(page,phase)
    const purpose=await page.evaluate<string>('tabPurpose')
    await page.evaluate(`(async()=>{const rows=new Map(await readStartupRaw()),br=rows.get('browser'),tr=rows.get(tabPurpose),names=Ordinary.ordinaryOperationNames(tabPurpose);
      const b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
      const input={browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}},j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),input);
      const digest=async raw=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),v=>v.toString(16).padStart(2,'0')).join('');
      if(['device','link','semantic','expiry','proof','epoch-id'].includes('${fault}')){
        const request=JSON.parse(j.request);if('${fault}'==='device')request.intent.device='b'.repeat(64);if('${fault}'==='link')request.intent.linkDigest='b'.repeat(64);
        if('${fault}'==='proof')request.intent.proof='b'.repeat(64);if('${fault}'==='epoch-id')request.intent.epochId='b'.repeat(64);
        if('${fault}'==='semantic')request.intent.semanticDigest='b'.repeat(64);if('${fault}'==='expiry')request.intent.expiresAt--;
        j.request=Ordinary.encodeOrdinaryRenewalRequest(request);j.requestDigest=await digest(j.request)
      }
      if('${fault}'==='source')j.source=['b'.repeat(64),j.source[1]];
      if('${fault}'==='enrolled')j.enrolled=['b'.repeat(64),j.enrolled[1]];
      if('${fault}'==='target')j.target=['b'.repeat(64),j.target[1]];
      if('${fault}'==='ceilings')j.ceilings[1]--;
      if('${fault}'==='signature'||'${fault}'==='extra-result'){
        const event=JSON.parse(j.result);if('${fault}'==='signature')event.sig='0'.repeat(128);else event.extra=true;
        j.result=JSON.stringify(event);j.resultDigest=await digest(j.result)
      }
      let control=await Ordinary.sealOrdinaryOperationControl(j,input);
      if('${fault}'==='mixed-copy')control.tab=(await Ordinary.sealOrdinaryOperationControl({...j,id:'b'.repeat(64)},input)).tab;
      if('${fault}'==='cipher')new Uint8Array(control.browser.ciphertext)[0]^=1;
      const db=await new Promise(resolve=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onsuccess=()=>resolve(r.result)}),tx=db.transaction('owners','readwrite'),store=tx.objectStore('owners');
      store.put(control,names.control);if('${fault}'==='alias')store.put(control,names.control+':alias');if('${fault}'==='missing-tab')store.delete(tabPurpose);
      if('${fault}'==='unexpected-key')store.put({},'unexpected-startup-row');if('${fault}'==='pending')store.put({...br,pending:br.frame},'browser');
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();j.secrets.forEach(key=>key.fill(0))})()`)
    await reloadInspector(page)
    expect(await page.evaluate(`(async()=>{let result;try{await fresh.inspectRenewalStartup(guard);result='bad'}catch(e){result=e.name};return[result,puts,entropy,providers]})()`))
      .toEqual(['OrdinaryStateHold',0,0,0]);await page.evaluate('fresh.close()')
    if(phase==='candidate-committed'){
      // Use the actual native tab captured before reloading the page.
      expect(await page.evaluate(`(async()=>{const owner=new Ordinary.OrdinaryStateOwner();try{return await owner.recoverCommittedRenewalAtStartup('${purpose}',guard).then(()=>['bad',puts,entropy,providers],e=>[e.name,puts,entropy,providers])}finally{await owner.close()}})()`))
        .toEqual(['OrdinaryStateHold',0,0,0])
    }
  })
}
test('startup selector revocation refuses before opening or installing state',async({page})=>{
  await reloadInspector(page)
  expect(await page.evaluate(`(async()=>{let state;try{await fresh.inspectRenewalStartup(()=>{window.closing=fresh.close();return true});state='bad'}catch(e){state=e.name};await closing;
    return[state,puts,entropy,providers,(await indexedDB.databases()).some(db=>db.name===Ordinary.ORDINARY_DATABASE)]})()`))
    .toEqual(['OrdinaryStateHold',0,0,0,false])
})
test('startup owner close joins gated native decryption without releasing disposition',async({page})=>{
  await stage(page,'provider-returned');await reloadInspector(page)
  await page.evaluate(`(()=>{const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let first=true;
    crypto.subtle.decrypt=async(...args)=>{if(first){first=false;window.decrypting=true;await new Promise(resolve=>window.releaseDecrypt=resolve)}return decrypt(...args)};
    window.inspectionState='pending';window.inspecting=fresh.inspectRenewalStartup(guard).then(()=>inspectionState='bad',e=>inspectionState=e.name)})()`)
  await page.waitForFunction('window.decrypting===true')
  await page.evaluate('window.closeState="pending";window.closing=fresh.close().then(()=>closeState="done");undefined')
  expect(await page.evaluate('[inspectionState,closeState,puts,entropy,providers]')).toEqual(['pending','pending',0,0,0])
  await page.evaluate('releaseDecrypt();undefined');await page.evaluate('closing')
  expect(await page.evaluate('[inspectionState,closeState,puts,entropy,providers]')).toEqual(['OrdinaryStateHold','done',0,0,0])
})

for(const phase of ['provider-started','candidate-committed']){
  test(`clean browser-process restart preserves ${phase} CryptoKey custody and phase`,async({browserName},info)=>{
    test.setTimeout(60_000)
    const prefix=info.outputPath('native-startup-profile-');await mkdir(dirname(prefix),{recursive:true});const profile=await mkdtemp(prefix)
    const engine={chromium,firefox,webkit}[browserName];let context:Awaited<ReturnType<typeof engine.launchPersistentContext>>|undefined
    try{
      context=await engine.launchPersistentContext(profile,{headless:true})
      await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
      const page=context.pages()[0]??await context.newPage();await page.goto(ORIGIN);await page.clock.install();await page.evaluate('window.memberEpochTimeoutMs=10000')
      await stage(page,phase);const purpose=await page.evaluate<string>('tabPurpose'),firstBrowser=context.browser();await context.close();context=undefined
      expect(firstBrowser!.isConnected()).toBe(false)
      // Reopen the exact native profile in a fresh browser process. No exported
      // storage state, plaintext snapshot, replacement key or fixture import.
      context=await engine.launchPersistentContext(profile,{headless:true})
      await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
      const next=context.pages()[0]??await context.newPage();await next.goto(ORIGIN);await reloadInspector(next)
      expect(await next.evaluate(`(async()=>{const disposition=await fresh.inspectRenewalStartup(guard);let held;
        try{await fresh.prepare(guard,new Map());held='bad'}catch(e){held=e.name};return[disposition.status,disposition.operations[0].phase,held,puts,entropy,providers]})()`))
        .toEqual(['recovery-required',phase,'OrdinaryStateHold',0,0,0]);await next.evaluate('fresh.close()')
      if(phase==='candidate-committed'){
        await reloadInspector(next,true);await next.clock.install();await next.clock.fastForward(43_200_000)
        expect(await next.evaluate(`fresh.recoverCommittedRenewalAtStartup('${purpose}',guard)`)).toEqual({status:'settled'})
        expect(await next.evaluate('fresh.inspectRenewalStartup(guard).then(result=>[result.status,puts,entropy,providers])')).toEqual(['ordinary',3,4,0])
        await next.evaluate('fresh.close()')
      }
    }finally{await context?.close();await rm(profile,{recursive:true,force:true})}
  })
}

for(const visitor of [false,true])for(const keep of [false,true])for(const expired of [false,true]){
  test(`restart neutral C settlement preserves history, visitor=${visitor}, keep=${keep}, expired=${expired}`,async({page})=>{
    await stage(page,'candidate-committed',visitor,keep)
    const purpose=await page.evaluate('tabPurpose')
    await reloadInspector(page,true)
    if(expired){await page.clock.install();await page.clock.fastForward(43_200_000)}
    await page.evaluate(`window.purpose='${purpose}';window.readStartupRows=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();
      tx.oncomplete=()=>{db.close();resolve(new Map(keys.result.map((key,i)=>[key,values.result[i]])))};tx.onabort=()=>reject(tx.error)}})`)
    const before=await page.evaluate<{records:[string,string][][];history:unknown[];revisions:number[]}>(`(async()=>{const rows=await readStartupRows(),br=rows.get('browser'),tr=rows.get(purpose),names=Ordinary.ordinaryOperationNames(purpose);
      const b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt}),
        j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});
      return {records:[[...b.records].filter(([n])=>n!==names.marker),[...t.records].filter(([n])=>n!==names.marker)],history:[j.source,j.enrolled,j.target,j.sourceRevisions,j.enrolledRevisions,j.targetRevisions,j.requestDigest,j.resultDigest],revisions:[b.revision,t.revision]}})()`)
    expect(await page.evaluate('fresh.recoverCommittedRenewalAtStartup(purpose,guard)')).toEqual({status:'settled'})
    expect(await page.evaluate('[puts,entropy,providers]')).toEqual([3,4,0])
    const after=await page.evaluate<{records:[string,string][][];history:unknown[];revisions:number[];state:unknown[];equalMarkers:boolean}>(`(async()=>{const rows=await readStartupRows(),br=rows.get('browser'),tr=rows.get(purpose),names=Ordinary.ordinaryOperationNames(purpose);
      const b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt}),
        j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),{browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}});
      return {records:[[...b.records].filter(([n])=>n!==names.marker),[...t.records].filter(([n])=>n!==names.marker)],history:[j.source,j.enrolled,j.target,j.sourceRevisions,j.enrolledRevisions,j.targetRevisions,j.requestDigest,j.resultDigest],revisions:[b.revision,t.revision],
        state:[j.phase,j.request,j.result,j.secrets.length,j.nonces],equalMarkers:b.records.get(names.marker)===t.records.get(names.marker)}})()`)
    expect(after.records).toEqual(before.records);expect(after.history).toEqual(before.history);expect(after.revisions).toEqual(before.revisions.map(n=>n+1))
    expect(after.state).toEqual(['settled','',null,0,null]);expect(after.equalMarkers).toBe(true)
    expect(await page.evaluate('fresh.inspectRenewalStartup(guard).then(result=>result.status)')).toBe('ordinary')
    expect(await page.evaluate('fresh.recoverCommittedRenewalAtStartup(purpose,guard)')).toEqual({status:'already-settled'})
    expect(await page.evaluate('[puts,entropy,providers]')).toEqual([3,4,0]);await page.evaluate('fresh.close()')
  })
}

for(const cut of [1,2,3])for(const queued of [false,true]){
  test(`startup settlement put ${cut} throws ${queued?'after':'before'} queue and retries identical S`,async({page})=>{
    await restartCommitted(page);const prior=await recoveryDigests(page)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let calls=0;window.firstCohort=[];window.retryCohort=[];window.retrying=false;
      IDBObjectStore.prototype.put=function(value,key){(retrying?retryCohort:firstCohort).push([key,structuredClone(value)]);
        if(++calls===${cut}&&!${queued})throw Error('before queue');const result=put.call(this,value,key);if(calls===${cut})throw Error('after queue');return result};
      window.restorePut=()=>IDBObjectStore.prototype.put=put;window.allowRetry=()=>{retrying=true;calls=100};beginRecovery()})()`)
    await page.waitForFunction('fresh.holdingRetention')
    expect(await page.evaluate('[recoveryOutcome,entropy,providers]')).toEqual(['pending',4,0])
    expect(await recoveryDigests(page)).toEqual(prior)
    await page.evaluate('allowRetry();fresh.retryRetention();undefined');await page.evaluate('recovering')
    expect(await page.evaluate(`[recoveryOutcome,entropy,providers,(()=>{const same=(a,b)=>a.byteLength===b.byteLength&&new Uint8Array(a).every((v,i)=>v===new Uint8Array(b)[i]);
      return firstCohort.every(([key,value])=>{const next=retryCohort.find(([name])=>name===key)?.[1];return key===Ordinary.ordinaryOperationNames(purpose).control?
        ['browser','tab'].every(k=>same(value[k].nonce,next[k].nonce)&&same(value[k].ciphertext,next[k].ciphertext)):Ordinary.sameOrdinaryFrame(value.frame,next.frame)})})()]`))
      .toEqual(['settled',4,0,true])
    await page.evaluate('restorePut();fresh.close()')
  })
}
for(const cut of [1,2,3]){
  test(`startup settlement close after put ${cut} drains exact prior without retry`,async({page})=>{
    await restartCommitted(page);const prior=await recoveryDigests(page)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let calls=0;
      IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);if(++calls===${cut})window.closing=fresh.close();return result};
      window.restorePut=()=>IDBObjectStore.prototype.put=put;beginRecovery()})()`)
    await page.evaluate('recovering');await page.evaluate('closing')
    expect(await page.evaluate('[recoveryOutcome,puts,entropy,providers]')).toEqual(['OrdinaryStateHold',cut,4,0])
    expect(await recoveryDigests(page)).toEqual(prior);await page.evaluate('restorePut()')
  })
}
for(const copy of [1,2,3,4]){
  test(`startup settlement close joins crypto copy ${copy} and stops entropy`,async({page})=>{
    await restartCommitted(page);const prior=await recoveryDigests(page)
    await page.evaluate(`(()=>{const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let calls=0;
      crypto.subtle.encrypt=async(...args)=>{const value=await encrypt(...args);if(++calls===${copy}){window.cryptoWaiting=true;await new Promise(resolve=>window.releaseCrypto=resolve)}return value};beginRecovery()})()`)
    await page.waitForFunction('window.cryptoWaiting===true')
    await page.evaluate(`window.closeState='pending';window.closing=fresh.close().then(()=>closeState='done');undefined`)
    expect(await page.evaluate('[recoveryOutcome,closeState,puts,entropy,providers]')).toEqual(['pending','pending',0,copy,0])
    await page.evaluate('releaseCrypto();undefined');await page.evaluate('closing')
    expect(await page.evaluate('[recoveryOutcome,closeState,puts,entropy,providers]')).toEqual(['OrdinaryStateHold','done',0,copy,0])
    expect(await recoveryDigests(page)).toEqual(prior)
  })
}
for(const fault of ['corrupt','unavailable']){
  test(`startup settlement close joins unknown ${fault} custody until exact S repair`,async({page})=>{
    await restartCommitted(page)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put,open=IDBFactory.prototype.open;window.frozenCohort=[];let calls=0;
      IDBObjectStore.prototype.put=function(value,key){frozenCohort.push([key,structuredClone(value)]);if(++calls===3){
        if('${fault}'==='corrupt'){const bad=structuredClone(value);new Uint8Array(bad.tab.ciphertext)[0]^=1;return put.call(this,bad,key)}
        const result=put.call(this,value,key);IDBFactory.prototype.open=()=>{throw Error('read unavailable')};return result
      }return put.call(this,value,key)};
      window.restoreCohort=()=>{IDBObjectStore.prototype.put=put;IDBFactory.prototype.open=open};beginRecovery()})()`)
    await page.waitForFunction('fresh.holdingRetention')
    await page.evaluate(`window.closeState='pending';window.closing=fresh.close().then(()=>closeState='done');undefined`)
    expect(await page.evaluate('[recoveryOutcome,closeState,entropy,providers]')).toEqual(['pending','pending',4,0])
    await page.evaluate(`(async()=>{restoreCohort();const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');
      for(const[key,value]of frozenCohort)tx.objectStore('owners').put(value,key);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();fresh.retryRetention()})()`)
    await page.evaluate('closing')
    expect(await page.evaluate('[recoveryOutcome,closeState,entropy,providers]')).toEqual(['settled','done',4,0])
  })
}
for(const phase of ['prepared','provider-started','provider-returned','candidate-prepared']){
  test(`startup C settlement refuses ${phase} before entropy or writes`,async({page})=>{
    await stage(page,phase);const purpose=await page.evaluate<string>('tabPurpose');await reloadInspector(page,true)
    expect(await page.evaluate(`fresh.recoverCommittedRenewalAtStartup('${purpose}',guard).then(()=>['bad',puts,entropy,providers],e=>[e.name,puts,entropy,providers])`))
      .toEqual(['OrdinaryStateHold',0,0,0]);await page.evaluate('fresh.close()')
  })
}
test('startup settlement rechecks native C after preparing S and refuses changed custody',async({page})=>{
  await restartCommitted(page)
  await page.evaluate(`(()=>{const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let first=true;
    crypto.subtle.encrypt=async(...args)=>{const value=await encrypt(...args);if(first){first=false;window.cryptoWaiting=true;await new Promise(resolve=>window.releaseCrypto=resolve)}return value};beginRecovery()})()`)
  await page.waitForFunction('window.cryptoWaiting===true')
  await page.evaluate(`(async()=>{const rows=new Map(await readRecoveryRows()),br=structuredClone(rows.get('browser'));new Uint8Array(br.frame.ciphertext)[0]^=1;
    const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');tx.objectStore('owners').put(br,'browser');
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close()})()`)
  const changed=await recoveryDigests(page)
  await page.evaluate('releaseCrypto();undefined');await page.evaluate('recovering')
  expect(await page.evaluate('[recoveryOutcome,puts,entropy,providers]')).toEqual(['OrdinaryStateHold',1,4,0])
  expect(await recoveryDigests(page)).toEqual(changed);await page.evaluate('fresh.close()')
})
test('startup settlement close joins native C authentication before any entropy',async({page})=>{
  await restartCommitted(page);const prior=await recoveryDigests(page)
  await page.evaluate(`(()=>{const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let first=true;
    crypto.subtle.decrypt=async(...args)=>{if(first){first=false;window.decryptWaiting=true;await new Promise(resolve=>window.releaseDecrypt=resolve)}return decrypt(...args)};beginRecovery()})()`)
  await page.waitForFunction('window.decryptWaiting===true')
  await page.evaluate(`window.closeState='pending';window.closing=fresh.close().then(()=>closeState='done');undefined`)
  expect(await page.evaluate('[recoveryOutcome,closeState,puts,entropy,providers]')).toEqual(['pending','pending',0,0,0])
  await page.evaluate('releaseDecrypt();undefined');await page.evaluate('closing')
  expect(await page.evaluate('[recoveryOutcome,closeState,puts,entropy,providers]')).toEqual(['OrdinaryStateHold','done',0,0,0])
  expect(await recoveryDigests(page)).toEqual(prior)
})
for(const visitor of [false,true])for(const keep of [false,true])for(const priorLease of [false,true]){
  test(`historical retained-result lease equals actual live lineage, visitor=${visitor}, keep=${keep}, priorLease=${priorLease}`,async({page})=>{
    await page.evaluate(`window.compareHistoricalLease=(request,proofRaw,liveLease,enrolled)=>{
      const images=enrolled.map(image=>({...image,records:new Map(image.records),fences:new Map(image.fences)})),savedNow=Date.now,random=crypto.getRandomValues.bind(crypto),
        deadline=Ordinary.OrdinaryForegroundSigner.nativeDeadline;let entropy=0,foreground=0;
      const raw=Ordinary.readOrdinaryRenewalRequest(request),names=Ordinary.ordinaryOperationNames(images[1].purpose),marker=Ordinary.validateOrdinaryOperationMarker(images[1].records.get(names.marker));
      Ordinary.restoreOrdinaryRenewalPredecessor(images[0],images[1],request,{id:marker.id,sequence:marker.sequence});
      try{crypto.getRandomValues=()=>{entropy++;throw Error('pure lineage must not allocate')};
        Ordinary.OrdinaryForegroundSigner.nativeDeadline=()=>{foreground++;throw Error('historical lineage must not acquire Fore')};
        const first=Ordinary.makeOrdinaryRetainedRenewalLease(images,proofRaw,request);Date.now=()=>raw.intent.authority.tabExpiresAt+43_200_000;
        const expired=Ordinary.makeOrdinaryRetainedRenewalLease(images,proofRaw,request);
        window.lineageComparison=[first===liveLease,expired===liveLease,entropy,foreground]
      }finally{Date.now=savedNow;crypto.getRandomValues=random;Ordinary.OrdinaryForegroundSigner.nativeDeadline=deadline;images.forEach(image=>{image.records.clear();image.fences.clear()})}
    };window.compareHistoricalCandidate=(request,result,seal,enrolled,liveCandidate)=>{
      const images=enrolled.map(image=>({...image,records:new Map(image.records),fences:new Map(image.fences)})),names=Ordinary.ordinaryOperationNames(images[1].purpose),
        marker=Ordinary.validateOrdinaryOperationMarker(images[1].records.get(names.marker)),leaseObserver=compareHistoricalLease;
      Ordinary.restoreOrdinaryRenewalPredecessor(images[0],images[1],request,{id:marker.id,sequence:marker.sequence});
      let candidate;const random=crypto.getRandomValues.bind(crypto),deadline=Ordinary.OrdinaryForegroundSigner.nativeDeadline,savedNow=Date.now;let entropy=0,foreground=0;
      try{window.compareHistoricalLease=undefined;crypto.getRandomValues=()=>{entropy++;throw Error('pure C must not allocate')};
        Ordinary.OrdinaryForegroundSigner.nativeDeadline=()=>{foreground++;throw Error('pure C must not acquire Fore')};Date.now=()=>images[1].expiresAt+43_200_000;
        candidate=Ordinary.prepareOrdinaryRetainedRenewalCandidate(images,request,result,seal,enrolled);
        const canonical=image=>JSON.stringify({...image,records:[...image.records].sort(([a],[b])=>a<b?-1:a>b?1:0),fences:[...image.fences].sort(([a],[b])=>a<b?-1:a>b?1:0),
          migration:image.migration?{...image.migration,sources:[...image.migration.sources],names:[...image.migration.names]}:undefined});
        window.candidateComparison=[candidate.every((image,i)=>canonical(image)===canonical(liveCandidate[i])),entropy,foreground]
      }finally{Date.now=savedNow;crypto.getRandomValues=random;Ordinary.OrdinaryForegroundSigner.nativeDeadline=deadline;window.compareHistoricalLease=leaseObserver;
        [...images,...candidate??[]].forEach(image=>{image.records.clear();image.fences.clear();image.migration?.sources.clear()})}
    }`)
    if(priorLease){
      await page.evaluate(`(${setup})(${JSON.stringify({visitor,keep,noRelays:true})})`);await page.evaluate(`(${controls})()`);await page.evaluate('join()')
      await page.evaluate("window.skipStartupCuts=1;window.requestedStage='candidate-prepared'")
      await page.clock.fastForward(901000)
      await expect.poll(()=>page.evaluate('(async()=>{try{const value=await bootstrap.load();try{return value.sealKeys.length}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(value)}}catch{return 0}})()')).toBe(2)
      await page.evaluate("member.send('before retained-result restart')")
      await page.clock.fastForward(901000);await page.waitForFunction("window.actualStage==='candidate-prepared'")
    }else await stage(page,'candidate-prepared',visitor,keep)
    expect(await page.evaluate('lineageComparison')).toEqual([true,true,0,0])
    expect(await page.evaluate('candidateComparison')).toEqual([true,0,0])
  })
}
for(const phase of ['provider-returned','candidate-prepared'])for(const visitor of [false,true])for(const keep of [false,true])for(const expired of [false,true]){
  test(`restart retained ${phase} commits exact C without signing, visitor=${visitor}, keep=${keep}, expired=${expired}`,async({page})=>{
    await restartRetained(page,phase,visitor,keep,expired)
    const before=await page.evaluate<{history:unknown[];request:string;result:string;target:string[]|null;targetRevisions:number[]|null;revisions:number[]}>('retainedState()')
    expect(await page.evaluate('fresh.recoverRetainedRenewalAtStartup(purpose,guard)')).toEqual({status:'candidate-committed'})
    const after=await page.evaluate<{history:unknown[];request:string;result:string;target:string[];targetRevisions:number[];revisions:number[];digests:string[];secrets:number;nonces:unknown;markers:string[]}>('retainedState()')
    expect(after.history).toEqual(before.history);expect(after.request).toBe(before.request);expect(after.result).toBe(before.result)
    expect(after.revisions).toEqual(before.revisions.map(value=>value+1));expect(after.target).toEqual(after.digests);expect(after.targetRevisions).toEqual(after.revisions)
    if(phase==='candidate-prepared'){expect(after.target).toEqual(before.target);expect(after.targetRevisions).toEqual(before.targetRevisions)}
    expect([after.secrets,after.nonces,after.markers[0]===after.markers[1]]).toEqual([0,null,true])
    const counts=phase==='provider-returned'?[4,4,0] as const:[3,2,0] as const
    expect(await page.evaluate('[puts,entropy,providers]')).toEqual(counts)
    expect(await page.evaluate('fresh.recoverRetainedRenewalAtStartup(purpose,guard)')).toEqual({status:'already-committed'})
    expect(await page.evaluate('[puts,entropy,providers]')).toEqual(counts)
    expect(await page.evaluate('fresh.recoverCommittedRenewalAtStartup(purpose,guard)')).toEqual({status:'settled'})
    expect(await page.evaluate('fresh.inspectRenewalStartup(guard).then(value=>value.status)')).toBe('ordinary')
    expect(await page.evaluate('fresh.recoverRetainedRenewalAtStartup(purpose,guard)')).toEqual({status:'already-settled'})
    expect(await page.evaluate('[puts,entropy,providers]')).toEqual([counts[0]+3,counts[1]+4,0]);await page.evaluate('fresh.close()')
  })
}
for(const phase of ['provider-returned','candidate-prepared'])for(const cut of [1,2,3])for(const queued of [false,true]){
  test(`retained startup ${phase} C put ${cut} throws ${queued?'after':'before'} queue and retries identical bytes`,async({page})=>{
    await restartRetained(page,phase)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let calls=0;window.firstC=[];window.retryC=[];window.retrying=false;
      IDBObjectStore.prototype.put=function(value,key){if('${phase}'==='provider-returned'&&calls===0){calls++;return put.call(this,value,key)}
        const captured=structuredClone(value);(retrying?retryC:firstC).push([key,captured]);
        if(++calls===${cut+(phase==='provider-returned'?1:0)}&&!${queued})throw Error('before C queue');const result=put.call(this,value,key);
        if(calls===${cut+(phase==='provider-returned'?1:0)})throw Error('after C queue');return result};
      window.allowRetry=()=>{retrying=true;calls=100};window.restorePut=()=>IDBObjectStore.prototype.put=put;beginRetained()})()`)
    await page.waitForFunction('fresh.holdingRetention')
    expect(await page.evaluate('retainedOutcome')).toBe('pending')
    expect(await page.evaluate('retainedState().then(value=>value.phase)')).toBe('candidate-prepared')
    const counts=await page.evaluate('[entropy,providers]')
    await page.evaluate('allowRetry();fresh.retryRetention();undefined');await page.evaluate('retaining')
    expect(await page.evaluate('retainedOutcome')).toBe('candidate-committed');expect(await page.evaluate('[entropy,providers]')).toEqual(counts)
    expect(await page.evaluate(`(()=>{const same=(a,b)=>a.byteLength===b.byteLength&&new Uint8Array(a).every((v,i)=>v===new Uint8Array(b)[i]);return firstC.every(([key,value])=>{
      const next=retryC.find(([name])=>name===key)?.[1];return key===Ordinary.ordinaryOperationNames(purpose).control?['browser','tab'].every(k=>same(value[k].nonce,next[k].nonce)&&same(value[k].ciphertext,next[k].ciphertext)):Ordinary.sameOrdinaryFrame(value.frame,next.frame)
    })})()`)).toBe(true)
    await page.evaluate('restorePut();fresh.close()')
  })
}
for(const queued of [false,true]){
  test(`retained startup prepared control throws ${queued?'after':'before'} queue and retains one cohort`,async({page})=>{
    await restartRetained(page,'provider-returned');const prior=await recoveryDigests(page)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;window.firstControl=undefined;window.secondControl=undefined;let once=true;
      IDBObjectStore.prototype.put=function(value,key){if(once){firstControl=structuredClone(value);if(!${queued})throw Error('before control queue');const result=put.call(this,value,key);throw Error('after control queue')}
        if(!secondControl)secondControl=structuredClone(value);return put.call(this,value,key)};
      window.allowRetry=()=>once=false;window.restorePut=()=>IDBObjectStore.prototype.put=put;beginRetained()})()`)
    await page.waitForFunction('fresh.holdingRetention');expect(await recoveryDigests(page)).toEqual(prior)
    expect(await page.evaluate('[retainedOutcome,entropy,providers]')).toEqual(['pending',2,0])
    await page.evaluate('allowRetry();fresh.retryRetention();undefined');await page.evaluate('retaining')
    expect(await page.evaluate(`[retainedOutcome,entropy,providers,(()=>{const same=(a,b)=>a.byteLength===b.byteLength&&new Uint8Array(a).every((v,i)=>v===new Uint8Array(b)[i]);return ['browser','tab'].every(k=>same(firstControl[k].nonce,secondControl[k].nonce)&&same(firstControl[k].ciphertext,secondControl[k].ciphertext))})()]`))
      .toEqual(['candidate-committed',4,0,true]);await page.evaluate('restorePut();fresh.close()')
  })
}
for(const phase of ['provider-returned','candidate-prepared'])for(const cut of [1,2,3]){
  test(`retained startup ${phase} close after C put ${cut} drains exact prepared prior`,async({page})=>{
    await restartRetained(page,phase)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let calls=0;
      IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);if(++calls===${cut+(phase==='provider-returned'?1:0)})window.closing=fresh.close();return result};
      window.restorePut=()=>IDBObjectStore.prototype.put=put;beginRetained()})()`)
    await page.evaluate('retaining');await page.evaluate('closing')
    expect(await page.evaluate('[retainedOutcome,puts,entropy,providers]')).toEqual(['OrdinaryStateHold',cut+(phase==='provider-returned'?1:0),phase==='provider-returned'?4:2,0])
    expect(await page.evaluate('retainedState().then(value=>[value.phase,value.secrets,value.nonces.length])')).toEqual(['candidate-prepared',1,2])
    await page.evaluate('restorePut()')
  })
}
test('retained startup close after prepared control put drains without C allocation',async({page})=>{
  await restartRetained(page,'provider-returned')
  await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let first=true;
    IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);if(first){first=false;window.closing=fresh.close()}return result};
    window.restorePut=()=>IDBObjectStore.prototype.put=put;beginRetained()})()`)
  await page.evaluate('retaining');await page.evaluate('closing')
  expect(await page.evaluate('[retainedOutcome,puts,entropy,providers]')).toEqual(['OrdinaryStateHold',1,2,0])
  expect(await page.evaluate('retainedState().then(value=>value.phase)')).toBe('provider-returned');await page.evaluate('restorePut()')
})
for(const phase of ['provider-returned','candidate-prepared'])for(const copy of phase==='provider-returned'?[1,2,3,4,5,6]:[1,2,3,4]){
  test(`retained startup ${phase} close joins crypto copy ${copy} without subsequent allocation`,async({page})=>{
    await restartRetained(page,phase)
    await page.evaluate(`(()=>{const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let calls=0;
      crypto.subtle.encrypt=async(...args)=>{const value=await encrypt(...args);if(++calls===${copy}){window.cryptoWaiting=true;await new Promise(resolve=>window.releaseCrypto=resolve)}return value};beginRetained()})()`)
    await page.waitForFunction('window.cryptoWaiting===true');const counts=await page.evaluate('[puts,entropy,providers]')
    await page.evaluate(`window.closeState='pending';window.closing=fresh.close().then(()=>closeState='done');undefined`)
    expect(await page.evaluate('[retainedOutcome,closeState]')).toEqual(['pending','pending'])
    await page.evaluate('releaseCrypto();undefined');await page.evaluate('closing')
    expect(await page.evaluate('[retainedOutcome,closeState]')).toEqual(['OrdinaryStateHold','done'])
    expect(await page.evaluate('[puts,entropy,providers]')).toEqual(counts)
    expect(await page.evaluate('retainedState().then(value=>value.phase)')).toBe(phase==='provider-returned'&&copy>=5?'candidate-prepared':phase)
  })
}
for(const phase of ['provider-returned','candidate-prepared'])for(const fault of ['corrupt','unavailable']){
  test(`retained startup ${phase} close joins unknown C ${fault} until exact repair`,async({page})=>{
    await restartRetained(page,phase)
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put,open=IDBFactory.prototype.open;let calls=0;window.frozenC=[];
      IDBObjectStore.prototype.put=function(value,key){calls++;if('${phase}'==='provider-returned'&&calls===1)return put.call(this,value,key);
        frozenC.push([key,structuredClone(value)]);if(calls===${phase==='provider-returned'?4:3}){
          if('${fault}'==='corrupt'){const bad=structuredClone(value);new Uint8Array(bad.tab.ciphertext)[0]^=1;return put.call(this,bad,key)}
          const result=put.call(this,value,key);IDBFactory.prototype.open=()=>{throw Error('C read unavailable')};return result
        }return put.call(this,value,key)};
      window.restoreC=()=>{IDBObjectStore.prototype.put=put;IDBFactory.prototype.open=open};beginRetained()})()`)
    await page.waitForFunction('fresh.holdingRetention');const counts=await page.evaluate('[entropy,providers]')
    await page.evaluate(`window.closeState='pending';window.closing=fresh.close().then(()=>closeState='done');undefined`)
    expect(await page.evaluate('[retainedOutcome,closeState]')).toEqual(['pending','pending'])
    await page.evaluate(`(async()=>{restoreC();const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');
      for(const[key,value]of frozenC)tx.objectStore('owners').put(value,key);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();fresh.retryRetention()})()`)
    await page.evaluate('closing');expect(await page.evaluate('[retainedOutcome,closeState]')).toEqual(['candidate-committed','done'])
    expect(await page.evaluate('[entropy,providers]')).toEqual(counts);expect(await page.evaluate('retainedState().then(value=>[value.phase,value.secrets,value.nonces])')).toEqual(['candidate-committed',0,null])
  })
}
for(const fault of ['corrupt','unavailable']){
  test(`retained startup close joins unknown prepared ${fault} without advancing C`,async({page})=>{
    await restartRetained(page,'provider-returned')
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put,open=IDBFactory.prototype.open;let first=true;window.frozenControl=undefined;
      IDBObjectStore.prototype.put=function(value,key){if(first){first=false;frozenControl=[key,structuredClone(value)];
        if('${fault}'==='corrupt'){const bad=structuredClone(value);new Uint8Array(bad.tab.ciphertext)[0]^=1;return put.call(this,bad,key)}
        const result=put.call(this,value,key);IDBFactory.prototype.open=()=>{throw Error('prepared read unavailable')};return result}return put.call(this,value,key)};
      window.restoreControl=()=>{IDBObjectStore.prototype.put=put;IDBFactory.prototype.open=open};beginRetained()})()`)
    await page.waitForFunction('fresh.holdingRetention')
    await page.evaluate(`window.closeState='pending';window.closing=fresh.close().then(()=>closeState='done');undefined`)
    expect(await page.evaluate('[retainedOutcome,closeState,entropy,providers]')).toEqual(['pending','pending',2,0])
    await page.evaluate(`(async()=>{restoreControl();const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');
      tx.objectStore('owners').put(frozenControl[1],frozenControl[0]);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();fresh.retryRetention()})()`)
    await page.evaluate('closing');expect(await page.evaluate('[retainedOutcome,closeState,entropy,providers]')).toEqual(['OrdinaryStateHold','done',2,0])
    expect(await page.evaluate('retainedState().then(value=>value.phase)')).toBe('candidate-prepared')
  })
}
for(const phase of ['prepared','provider-started']){
  test(`retained startup refuses ${phase} without provider retry or entropy`,async({page})=>{
    await restartRetained(page,phase)
    expect(await page.evaluate('fresh.recoverRetainedRenewalAtStartup(purpose,guard).then(()=>["bad",puts,entropy,providers],e=>[e.name,puts,entropy,providers])'))
      .toEqual(['OrdinaryStateHold',0,0,0]);await page.evaluate('fresh.close()')
  })
}
for(const phase of ['provider-returned','candidate-prepared'])for(const fault of ['signature','extra-result','secret','device','link','keep','ceilings','pending','alias','unexpected-key']){
  test(`retained startup ${phase} refuses authenticated ${fault} before wrapping or writing`,async({page})=>{
    await stage(page,phase);const purpose=await page.evaluate<string>('tabPurpose')
    await page.evaluate(`(async()=>{const rows=new Map(await readStartupRaw()),br=rows.get('browser'),tr=rows.get(tabPurpose),names=Ordinary.ordinaryOperationNames(tabPurpose),
      b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt}),
      input={browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}},j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),input),
      digest=async raw=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),value=>value.toString(16).padStart(2,'0')).join('');
      if('${fault}'==='signature'||'${fault}'==='extra-result'){const result=JSON.parse(j.result);if('${fault}'==='signature')result.sig='0'.repeat(128);else result.extra=true;j.result=JSON.stringify(result);j.resultDigest=await digest(j.result)}
      if('${fault}'==='secret')j.secrets[0].fill(7);
      if(['device','link','keep'].includes('${fault}')){const request=JSON.parse(j.request);if('${fault}'==='device')request.intent.device='b'.repeat(64);
        if('${fault}'==='link')request.intent.linkDigest='b'.repeat(64);if('${fault}'==='keep')request.intent.keep=!request.intent.keep;j.request=Ordinary.encodeOrdinaryRenewalRequest(request);j.requestDigest=await digest(j.request)}
      if('${fault}'==='ceilings')j.ceilings[1]--;
      const control=await Ordinary.sealOrdinaryOperationControl(j,input),r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite'),store=tx.objectStore('owners');
      store.put(control,names.control);if('${fault}'==='pending')store.put({...br,pending:br.frame},'browser');if('${fault}'==='alias')store.put(control,names.control+':alias');if('${fault}'==='unexpected-key')store.put({},'unexpected-key');
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();j.secrets.forEach(value=>value.fill(0))})()`)
    await reloadInspector(page,true)
    expect(await page.evaluate(`fresh.recoverRetainedRenewalAtStartup('${purpose}',guard).then(()=>['bad',puts,entropy,providers],e=>[e.name,puts,entropy,providers])`))
      .toEqual(['OrdinaryStateHold',0,0,0]);await page.evaluate('fresh.close()')
  })
}
for(const fault of ['target','nonce']){
  test(`retained startup refuses candidate-prepared ${fault} mismatch before fresh control entropy`,async({page})=>{
    await stage(page,'candidate-prepared');const purpose=await page.evaluate<string>('tabPurpose')
    await page.evaluate(`(async()=>{const rows=new Map(await readStartupRaw()),br=rows.get('browser'),tr=rows.get(tabPurpose),names=Ordinary.ordinaryOperationNames(tabPurpose),
      b=await Ordinary.openOrdinaryFrame(br.frame,br.key),t=await Ordinary.openOrdinaryFrame(tr.frame,tr.key),binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt}),
      input={browser:{binding:binding(b),key:br.key},tab:{binding:binding(t),key:tr.key}},j=await Ordinary.openOrdinaryOperationControl(rows.get(names.control),input);
      if('${fault}'==='target')j.target=['b'.repeat(64),j.target[1]];else j.nonces=['b'.repeat(24),j.nonces[1]];
      const control=await Ordinary.sealOrdinaryOperationControl(j,input),r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');
      tx.objectStore('owners').put(control,names.control);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();j.secrets.forEach(value=>value.fill(0))})()`)
    await reloadInspector(page,true)
    expect(await page.evaluate(`fresh.recoverRetainedRenewalAtStartup('${purpose}',guard).then(()=>['bad',puts,entropy,providers],e=>[e.name,puts,entropy,providers])`))
      .toEqual(['OrdinaryStateHold',0,0,0]);await page.evaluate('fresh.close()')
  })
}
for(const phase of ['provider-returned','candidate-prepared']){
  test(`retained startup ${phase} verifies actual encrypted C plaintext before controls`,async({page})=>{
    await restartRetained(page,phase);const prior=await recoveryDigests(page)
    await page.evaluate(`(()=>{const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let first=true;
      crypto.subtle.encrypt=async(...args)=>{if(first){first=false;const tuple=JSON.parse(new TextDecoder().decode(args[2]));tuple[6].push(['inert-poison','changed']);tuple[6].sort(([a],[b])=>a<b?-1:a>b?1:0);args[2]=new TextEncoder().encode(JSON.stringify(tuple))}return encrypt(...args)};beginRetained()})()`)
    await page.evaluate('retaining');expect(await page.evaluate('[retainedOutcome,puts,entropy,providers]')).toEqual(['OrdinaryStateHold',0,0,0])
    expect(await recoveryDigests(page)).toEqual(prior);await page.evaluate('fresh.close()')
  })
}
for(const phase of ['provider-returned','candidate-prepared']){
  test(`retained startup ${phase} reauthenticates changed E before fresh wrapping`,async({page})=>{
    await restartRetained(page,phase)
    await page.evaluate(`(()=>{const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let first=true;
      crypto.subtle.encrypt=async(...args)=>{const result=await encrypt(...args);if(first){first=false;window.cryptoWaiting=true;await new Promise(resolve=>window.releaseCrypto=resolve)}return result};beginRetained()})()`)
    await page.waitForFunction('window.cryptoWaiting===true')
    await page.evaluate(`(async()=>{const rows=new Map(await readRecoveryRows()),br=structuredClone(rows.get('browser'));new Uint8Array(br.frame.ciphertext)[0]^=1;
      const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1),db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result)),tx=db.transaction('owners','readwrite');tx.objectStore('owners').put(br,'browser');
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close()})()`)
    const changed=await recoveryDigests(page)
    await page.evaluate('releaseCrypto();undefined');await page.evaluate('retaining')
    expect(await page.evaluate('[retainedOutcome,puts,entropy,providers]')).toEqual(['OrdinaryStateHold',1,0,0])
    expect(await recoveryDigests(page)).toEqual(changed);await page.evaluate('fresh.close()')
  })
}
for(const phase of ['prepare','commit']){
  test(`retained startup close on native ${phase} completion recognises exact target without new effects`,async({page})=>{
    await restartRetained(page,'provider-returned')
    await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;let calls=0;
      IDBObjectStore.prototype.put=function(...args){const value=put.apply(this,args);if(++calls===${phase==='prepare'?1:4})this.transaction.addEventListener('complete',()=>{window.closing=fresh.close()},{once:true});return value};
      window.restorePut=()=>IDBObjectStore.prototype.put=put;beginRetained()})()`)
    await page.evaluate('retaining');await page.evaluate('closing')
    expect(await page.evaluate('[retainedOutcome,puts,entropy,providers]')).toEqual([phase==='prepare'?'OrdinaryStateHold':'candidate-committed',phase==='prepare'?1:4,phase==='prepare'?2:4,0])
    expect(await page.evaluate('retainedState().then(value=>value.phase)')).toBe(phase==='prepare'?'candidate-prepared':'candidate-committed');await page.evaluate('restorePut()')
  })
}
test('retained startup absent storage leaves no database or wrapping entropy',async({page})=>{
  await reloadInspector(page,true)
  expect(await page.evaluate(`fresh.recoverRetainedRenewalAtStartup('tab:'+'a'.repeat(64),guard).then(()=>['bad',puts,entropy,providers],e=>[e.name,puts,entropy,providers])`))
    .toEqual(['OrdinaryStateHold',0,0,0])
  expect(await page.evaluate('(async()=> (await indexedDB.databases()).some(value=>value.name===Ordinary.ORDINARY_DATABASE))()')).toBe(false);await page.evaluate('fresh.close()')
})
for(const phase of ['provider-returned','candidate-prepared']){
  test(`clean process restart completes retained ${phase} from original keys and nonces`,async({browserName},info)=>{
    test.setTimeout(60_000)
    const prefix=info.outputPath('native-retained-profile-');await mkdir(dirname(prefix),{recursive:true});const profile=await mkdtemp(prefix),engine={chromium,firefox,webkit}[browserName]
    let context:Awaited<ReturnType<typeof engine.launchPersistentContext>>|undefined
    try{
      context=await engine.launchPersistentContext(profile,{headless:true})
      await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
      const page=context.pages()[0]??await context.newPage();await page.goto(ORIGIN);await page.clock.install();await page.evaluate('window.memberEpochTimeoutMs=10000')
      await stage(page,phase);const purpose=await page.evaluate<string>('tabPurpose'),firstBrowser=context.browser();await context.close();context=undefined
      expect(firstBrowser!.isConnected()).toBe(false)
      context=await engine.launchPersistentContext(profile,{headless:true})
      await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
      const next=context.pages()[0]??await context.newPage();await next.goto(ORIGIN);await reloadInspector(next,true);await next.clock.install();await next.clock.fastForward(43_200_000)
      expect(await next.evaluate(`fresh.recoverRetainedRenewalAtStartup('${purpose}',guard)`)).toEqual({status:'candidate-committed'})
      expect(await next.evaluate('[puts,entropy,providers]')).toEqual(phase==='provider-returned'?[4,4,0]:[3,2,0])
      expect(await next.evaluate(`fresh.recoverCommittedRenewalAtStartup('${purpose}',guard)`)).toEqual({status:'settled'})
      expect(await next.evaluate('fresh.inspectRenewalStartup(guard).then(value=>value.status)')).toBe('ordinary');await next.evaluate('fresh.close()')
    }finally{await context?.close();await rm(profile,{recursive:true,force:true})}
  })
}
