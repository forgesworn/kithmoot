import {build} from 'esbuild'
import {instrumentPreparedStartup,instrumentPreparedStartupOwner,installPreparedStartupDiagnostic,snapshotPreparedStartupDiagnostic} from './ordinary-prepared-startup-diagnostic.js'
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {test,expect,chromium,firefox,webkit,type Page} from '@playwright/test'
import {setup} from './ordinary-bootstrap.setup.js'
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure'
import {controls} from './ordinary-member-session.setup.js'
const ORIGIN='https://ordinary-renewal-startup.invalid'
let bundle=''
const beforeReload=new WeakMap<Page,unknown>()
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:['test/ordinary-renewal-enrollment.browser-entry.ts'],bundle:true,write:false,format:'iife',globalName:'Ordinary',platform:'browser',target:'es2022',
    plugins:[{name:'actual-private-renewal-startup-cut',setup(builder){builder.onLoad({filter:/ordinary-persistent-bootstrap\.ts$/},async input=>{
      const source=await readFile(input.path,'utf8'),marker='            const selected = source\n'
      if(source.split(marker).length!==2)throw Error('startup private factory fixture drift')
      return {loader:'ts',contents:instrumentPreparedStartup(source.replace(marker,`            const observer=globalThis as any
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
`+marker))}
    });builder.onLoad({filter:/ordinary-state-owner\.ts$/},async input=>({loader:'ts',contents:instrumentPreparedStartupOwner(await readFile(input.path,'utf8'))}));builder.onLoad({filter:/ordinary-renewal-candidate\.ts$/},async input=>{
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

async function preparedRestart(page:Page,visitor:boolean,keep:boolean,priorLease=false){
  const key=generateSecretKey()
  await page.exposeFunction('freshProviderPubkey',()=>getPublicKey(key))
  await page.exposeFunction('freshProviderSign',(event:Parameters<typeof finalizeEvent>[0])=>finalizeEvent(event,key))
  await page.evaluate(`(${setup})(${JSON.stringify({visitor,keep,noRelays:true,participantSk:Array.from(key)})})`)
  await page.evaluate(`(${controls})()`);await page.evaluate('join()')
  if(priorLease){
    await page.evaluate("window.skipStartupCuts=1;window.requestedStage='prepared'")
    await page.evaluate(installPreparedStartupDiagnostic)
    await page.clock.fastForward(901000)
    await expect.poll(()=>page.evaluate('(async()=>{try{const result=await bootstrap.load();try{return result.sealKeys.length}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(result)}}catch{return 0}})()')).toBe(2)
    await page.evaluate("member.send('first generation')")
  }
  await page.evaluate("window.requestedStage='prepared'");await page.clock.fastForward(901000);await page.waitForFunction("window.actualStage==='prepared'")
  const captured=await page.evaluate<any>(`({account,participant,keep,link:url,inviter:invitation.inviter,bearer:Array.from(invitation.bearer),credentialExpiresAt,tabPurpose,tabExpiry,
    time:Date.now(),auth:account===null?null:JSON.stringify(sourceSession.authEvent),method:account===null?null:sourceSession.method})`)
  beforeReload.set(page,await page.evaluate(snapshotPreparedStartupDiagnostic))
  await page.reload();await page.clock.install({time:new Date(captured.time)})
  await page.evaluate(async value=>{
    const o=(window as any).Ordinary,w=window as any
    w.live=true;w.guard=()=>w.live;w.signCalls=0;w.providerPhases=[];w.entropy=0;w.puts=0
    const random=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=(...args)=>{w.entropy++;return random(...args)}
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args:any[]){w.puts++;return put.apply(this,args as any)}
    w.readPreparedRows=()=>new Promise((resolve,reject)=>{const request=indexedDB.open(o.ORDINARY_DATABASE,1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();resolve(keys.result.map((name,i)=>[name,values.result[i]]))};tx.onabort=()=>reject(tx.error)}})
    w.preparedPhase=async()=>{const rows=new Map(await w.readPreparedRows()),b:any=rows.get('browser'),t:any=rows.get(value.tabPurpose),names=o.ordinaryOperationNames(value.tabPurpose),
      binding=(frame:any)=>({purpose:frame.purpose,keyId:frame.keyId,generation:frame.generation,expiresAt:frame.expiresAt})
      return(await o.openOrdinaryOperationClassification(rows.get(names.control),{browser:{key:b.key,binding:binding(b.frame)},tab:{key:t.key,binding:binding(t.frame)}})).phase}
    w.nostr={getPublicKey:async()=>{w.providerPhases.push(await w.preparedPhase());return w.freshProviderPubkey()},signEvent:async(event:any)=>{
      w.signCalls++;w.providerPhases.push(await w.preparedPhase());return w.freshProviderSign(event)}}
    const identity=value.account===null?{pubkey:value.participant,signEvent:()=>{throw Error('visitor recovery must use native participant custody')}}:new o.Nip07Signer(value.participant,w.nostr)
    w.sourceSession=value.account===null?undefined:{pubkey:value.participant,method:value.method,signer:identity,authEvent:JSON.parse(value.auth)}
    w.browserOwner=new o.OrdinaryStateOwner();w.tabOwner=new o.OrdinaryStateOwner(value.tabPurpose,value.tabExpiry)
    const invitation=o.roomInvitation(Uint8Array.from(value.bearer),value.inviter,true),invitationId=o.deriveInvitationId(invitation)
    w.current={account:value.account,participant:value.participant,invitationId,identity,link:value.link,keep:value.keep,credentialExpiresAt:value.credentialExpiresAt}
    w.recoveryOptions={browser:w.browserOwner,tab:w.tabOwner,invitation,account:value.account,identity,link:value.link,keep:value.keep,credentialExpiresAt:value.credentialExpiresAt,current:()=>w.current,live:w.guard,
      ...(value.account===null?{}:{foreground:{session:w.sourceSession,currentSession:()=>w.sourceSession,generation:0,currentGeneration:()=>0,checkClients:async()=>{},stop:()=>{}}})}
    w.recoveryStatus='pending';w.recoveryStack=null;w.beginPrepared=()=>{w.recovering=o.OrdinaryPersistentBootstrap.recoverPreparedAtStartup(w.recoveryOptions).then((result:any)=>{w.recoveryStatus=result.status},(error:any)=>{w.recoveryStatus=error.name;w.recoveryStack=error.stack})}
  },captured)
}
for(const visitor of [false,true])for(const keep of [false,true])for(const priorLease of [false,true]){
  test(`fresh prepared startup signs once only after started ACK, visitor=${visitor}, keep=${keep}, priorLease=${priorLease}`,async({page})=>{
    await preparedRestart(page,visitor,keep,priorLease)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,recoveryStack??null]')).toEqual(['settled',null])
    expect(await page.evaluate('signCalls')).toBe(visitor?0:1)
    expect(await page.evaluate('providerPhases')).toEqual(visitor?[]:['provider-started'])
    expect(await page.evaluate('preparedPhase()')).toBe('settled')
    expect(await page.evaluate('puts')).toBe(9)
  })
}

for(const visitor of [false,true])for(const fault of ['selection-account','selection-identity','selection-keep','selection-link','selection-invitation','selection-expiry','tab-closed','floor-expired','future-issued','async-live']){
  test(`prepared startup refuses ${fault} before entropy, writes or provider, visitor=${visitor}`,async({page})=>{
    await preparedRestart(page,visitor,true)
    const prior=await page.evaluate('readPreparedRows().then(rows=>rows.map(([name,row])=>[name,name.startsWith(Ordinary.ORDINARY_OPERATION_CONTROL_PREFIX)?Ordinary.ordinaryOperationControlDigest(row):Ordinary.ordinaryFrameDigest(row.frame)]))')
    await page.evaluate(fault=>{
      const w=window as any
      if(fault==='selection-account')w.current={...w.current,account:w.current.account===null?w.current.participant:null}
      if(fault==='selection-identity')w.current={...w.current,identity:{...w.current.identity}}
      if(fault==='selection-keep')w.current={...w.current,keep:!w.current.keep}
      if(fault==='selection-link')w.current={...w.current,link:w.current.link+'x'}
      if(fault==='selection-invitation')w.current={...w.current,invitationId:'b'.repeat(64)}
      if(fault==='selection-expiry')w.current={...w.current,credentialExpiresAt:w.current.credentialExpiresAt+1}
      if(fault==='tab-closed')void w.tabOwner.close()
      if(fault==='future-issued'){const now=Date.now();Date.now=()=>now-901000}
      if(fault==='async-live')w.recoveryOptions.live=()=>Promise.resolve(true)
    },fault)
    if(fault==='floor-expired')await page.clock.fastForward(1_201_000)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,entropy,puts,signCalls]')).toEqual(['OrdinaryStateHold',0,0,0])
    const after=await page.evaluate('readPreparedRows().then(rows=>rows.map(([name,row])=>[name,name.startsWith(Ordinary.ORDINARY_OPERATION_CONTROL_PREFIX)?Ordinary.ordinaryOperationControlDigest(row):Ordinary.ordinaryFrameDigest(row.frame)]))')
    expect(after).toEqual(prior)
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
  })
}
for(const fault of ['session-replaced','generation','deadline','auth-order','sign-method-during-decrypt']){
  test(`prepared account refuses current ${fault} before entropy or provider`,async({page})=>{
    await preparedRestart(page,false,true)
    await page.evaluate(fault=>{
      const w=window as any
      if(fault==='session-replaced')w.sourceSession={...w.sourceSession}
      if(fault==='generation')w.recoveryOptions.foreground.currentGeneration=()=>1
      if(fault==='deadline')w.sourceSession.expiresAt=Date.now()+3_600_000
      if(fault==='auth-order'){const p=w.sourceSession.authEvent;w.sourceSession.authEvent={sig:p.sig,id:p.id,pubkey:p.pubkey,content:p.content,tags:p.tags,created_at:p.created_at,kind:p.kind}}
      if(fault==='sign-method-during-decrypt'){
        const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let changed=false
        crypto.subtle.decrypt=async(...args)=>{const result=await decrypt(...args);if(!changed){changed=true;w.recoveryOptions.identity.signEvent=()=>Promise.reject(Error('must not sign'))}return result}
      }
    },fault)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,entropy,puts,signCalls]')).toEqual(['OrdinaryStateHold',0,0,0])
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
  })
}

for(const visitor of [false,true])for(const queued of [false,true]){
  test(`prepared started write throws ${queued?'after':'before'} queue and retries the same cohort, visitor=${visitor}`,async({page})=>{
    await preparedRestart(page,visitor,true)
    await page.evaluate(queued=>{const w=window as any,o=w.Ordinary,put=IDBObjectStore.prototype.put;let failed=false
      w.startedPackets=[];w.startedEntropy=[]
      IDBObjectStore.prototype.put=function(...args:any[]){
        if(String(args[1]).startsWith(o.ORDINARY_OPERATION_CONTROL_PREFIX)&&w.startedPackets.length<2){w.startedPackets.push(o.ordinaryOperationControlDigest(args[0]));w.startedEntropy.push(w.entropy)
          if(!failed){failed=true;w.writeFailed=true;if(queued)put.apply(this,args as any);throw Error('started queue cut')}}
        return put.apply(this,args as any)}
    },queued)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction('window.writeFailed===true')
    await expect.poll(()=>page.evaluate('preparedPhase()')).toBe('prepared')
    expect(await page.evaluate('[recoveryStatus,signCalls]')).toEqual(['pending',0])
    // A completed failed put and a readable prior phase do not mean that the
    // producer has finished reconciliation and installed its retry waiter.
    await page.waitForFunction('browserOwner.holdingRetention && tabOwner.holdingRetention')
    await page.evaluate('browserOwner.retryRetention();tabOwner.retryRetention();undefined')
    await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,signCalls,startedPackets.length,startedPackets[0]===startedPackets[1],startedEntropy[0]===startedEntropy[1]]')).toEqual(['settled',visitor?0:1,2,true,true])
  })
  test(`prepared close ${queued?'after':'before'} started queue joins exact prior without a provider, visitor=${visitor}`,async({page})=>{
    await preparedRestart(page,visitor,true)
    await page.evaluate(queued=>{const w=window as any,o=w.Ordinary,put=IDBObjectStore.prototype.put;let closed=false
      IDBObjectStore.prototype.put=function(...args:any[]){if(!closed&&String(args[1]).startsWith(o.ORDINARY_OPERATION_CONTROL_PREFIX)){
        closed=true;if(queued)put.apply(this,args as any);w.closing=w.browserOwner.close();throw Error('close started queue')};return put.apply(this,args as any)}
    },queued)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction("recoveryStatus!=='pending'");await page.evaluate('closing')
    expect(await page.evaluate('[recoveryStatus,signCalls]')).toEqual(['OrdinaryStateHold',0])
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
  })
}
for(const visitor of [false,true]){
  test(`prepared exact started completion after close never invokes or retries a provider, visitor=${visitor}`,async({page})=>{
    await preparedRestart(page,visitor,true)
    await page.evaluate(()=>{const w=window as any,o=w.Ordinary,put=IDBObjectStore.prototype.put;let closed=false
      IDBObjectStore.prototype.put=function(...args:any[]){const request=put.apply(this,args as any)
        if(!closed&&String(args[1]).startsWith(o.ORDINARY_OPERATION_CONTROL_PREFIX)){closed=true;this.transaction.addEventListener('complete',()=>{w.closing=w.browserOwner.close()},{once:true})}
        return request}
    })
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction("recoveryStatus!=='pending'");await page.evaluate('closing')
    expect(await page.evaluate('[recoveryStatus,signCalls]')).toEqual(['OrdinaryStateHold',0])
    expect(await page.evaluate('preparedPhase()')).toBe('provider-started')
    await page.evaluate('window.browserOwner=new Ordinary.OrdinaryStateOwner();recoveryOptions.browser=browserOwner;recoveryStatus="pending";beginPrepared();undefined')
    await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,signCalls]')).toEqual(['OrdinaryStateHold',0])
  })
}
for(const cut of [1,2,3,4,5,6,7]){
  test(`prepared signing revocation at entropy ${cut} stops before any provider or write`,async({page})=>{
    await preparedRestart(page,false,true)
    await page.evaluate(cut=>{const w=window as any,random=crypto.getRandomValues.bind(crypto);let count=0;crypto.getRandomValues=(...args)=>{
      const result=random(...args);if(++count===cut)w.live=false;return result}},cut)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,entropy,puts,signCalls]')).toEqual(['OrdinaryStateHold',cut,0,0])
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
  })
}
for(const fault of ['selection','owner-close']){
  test(`prepared late verified account result survives ${fault} without fresh entropy or another signature`,async({page})=>{
    await preparedRestart(page,false,true)
    await page.evaluate(()=>{const w=window as any,sign=w.nostr.signEvent;w.nostr.signEvent=(event:any)=>new Promise(resolve=>{
      w.providerPending=true;w.releasePreparedProvider=()=>resolve(sign(event))})})
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction('window.providerPending===true')
    expect(await page.evaluate('preparedPhase()')).toBe('provider-started')
    const entropy=await page.evaluate<number>('entropy')
    await page.evaluate(fault=>{const w=window as any;if(fault==='selection')w.current={...w.current,keep:!w.current.keep};else w.closing=w.browserOwner.close()
      w.releasePreparedProvider();return undefined},fault)
    await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,signCalls,entropy]')).toEqual(['OrdinaryStateHold',1,entropy])
    if(fault==='owner-close')await page.evaluate('closing')
    expect(await page.evaluate('preparedPhase()')).toBe('provider-returned')
    await page.evaluate(async()=>{const w=window as any,owner=new w.Ordinary.OrdinaryStateOwner();try{
      await owner.recoverRetainedRenewalAtStartup(w.tabOwner.purpose,()=>true);await owner.recoverCommittedRenewalAtStartup(w.tabOwner.purpose,()=>true)
    }finally{await owner.close()}})
    expect(await page.evaluate('preparedPhase()')).toBe('settled')
    expect(await page.evaluate('signCalls')).toBe(1)
  })
}

for(const cut of [1,2])for(const fault of ['corrupt','unavailable']){
  test(`prepared close joins unknown control ${cut} ${fault} until exact repair without another signature`,async({page})=>{
    await preparedRestart(page,false,true)
    await page.evaluate(({cut,fault})=>{const w=window as any,o=w.Ordinary,put=IDBObjectStore.prototype.put,open=IDBFactory.prototype.open;let controls=0
      w.restoreFault=()=>{IDBObjectStore.prototype.put=put;IDBFactory.prototype.open=open}
      IDBObjectStore.prototype.put=function(...args:any[]){
        if(String(args[1]).startsWith(o.ORDINARY_OPERATION_CONTROL_PREFIX)&&++controls===cut){w.frozenControl=[args[1],structuredClone(args[0])]
          if(fault==='corrupt'){const bad=structuredClone(args[0]);new Uint8Array(bad.tab.ciphertext)[0]^=1;return put.call(this,bad,args[1])}
          const result=put.apply(this,args as any);IDBFactory.prototype.open=()=>{throw Error('reconciliation unavailable')};return result}
        return put.apply(this,args as any)}
    },{cut,fault})
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction('browserOwner.holdingRetention')
    const entropy=await page.evaluate<number>('entropy')
    await page.evaluate('window.closeStatus="pending";window.closing=browserOwner.close().then(()=>closeStatus="done");undefined')
    expect(await page.evaluate('[recoveryStatus,closeStatus,signCalls]')).toEqual(['pending','pending',cut===1?0:1])
    await page.evaluate(async()=>{const w=window as any;w.restoreFault();const request=indexedDB.open(w.Ordinary.ORDINARY_DATABASE,1)
      const db=await new Promise<IDBDatabase>(resolve=>request.onsuccess=()=>resolve(request.result)),tx=db.transaction('owners','readwrite')
      tx.objectStore('owners').put(w.frozenControl[1],w.frozenControl[0]);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});db.close()
      w.browserOwner.retryRetention();w.tabOwner.retryRetention()
    })
    await page.waitForFunction("recoveryStatus!=='pending'");await page.evaluate('closing')
    expect(await page.evaluate('[recoveryStatus,closeStatus,signCalls,entropy]')).toEqual(['OrdinaryStateHold','done',cut===1?0:1,entropy])
    expect(await page.evaluate('preparedPhase()')).toBe(cut===1?'provider-started':'provider-returned')
  })
}
for(const fault of ['transient-sdk-retry','bad-signature-cache','wrong-statement']){
  test(`prepared provider ${fault} cannot cause another attempt or a false durable result`,async({page})=>{
    await preparedRestart(page,false,true)
    await page.evaluate(fault=>{const w=window as any,sign=w.nostr.signEvent
      w.nostr.signEvent=async(event:any)=>{
        if(fault==='transient-sdk-retry'){w.signCalls++;throw Error('Request failed')}
        const result=await sign(event)
        if(fault==='bad-signature-cache'){result.sig='0'.repeat(128);result[w.Signet.SIGNET_VERIFIED_EVENT_SYMBOL]=true}
        if(fault==='wrong-statement')result.tags[3][1]='b'.repeat(64)
        return result
      }
    },fault)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction("recoveryStatus!=='pending'")
    expect(await page.evaluate('[recoveryStatus,signCalls,puts]')).toEqual(['OrdinaryStateHold',1,1])
    expect(await page.evaluate('preparedPhase()')).toBe('provider-started')
  })
}
for(const cut of [1,3]){
  test(`prepared close joins gated authentication decrypt ${cut} without entropy or signing`,async({page})=>{
    await preparedRestart(page,false,true)
    await page.evaluate(cut=>{const w=window as any,decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let count=0
      crypto.subtle.decrypt=async(...args)=>{const result=await decrypt(...args);if(++count===cut){w.authenticationBlocked=true;await new Promise<void>(resolve=>w.releaseAuthentication=resolve)}return result}
    },cut)
    await page.evaluate('beginPrepared();undefined');await page.waitForFunction('window.authenticationBlocked===true')
    await page.evaluate('window.closeStatus="pending";window.closing=browserOwner.close().then(()=>closeStatus="done");undefined')
    expect(await page.evaluate('[recoveryStatus,closeStatus,entropy,puts,signCalls]')).toEqual(['pending','pending',0,0,0])
    await page.evaluate('releaseAuthentication();undefined');await page.waitForFunction("recoveryStatus!=='pending'");await page.evaluate('closing')
    expect(await page.evaluate('[recoveryStatus,closeStatus,entropy,puts,signCalls]')).toEqual(['OrdinaryStateHold','done',0,0,0])
    expect(await page.evaluate('preparedPhase()')).toBe('prepared')
  })
}

// The diagnostic observes; it never releases a cut, retries or closes a root.
test.afterEach(async({page},testInfo)=>{
  let terminal:unknown=null
  try{terminal=await page.evaluate(snapshotPreparedStartupDiagnostic)}catch{terminal={unavailable:true}}
  const record={diagnostic:'exact-firefox-prepared-startup-v1',status:testInfo.status,beforeReload:beforeReload.get(page)??null,terminal}
  console.log('PREPARED_STARTUP_DIAGNOSTIC '+JSON.stringify(record))
  await testInfo.attach('prepared-startup-redacted-state',{body:JSON.stringify(record),contentType:'application/json'})
})
