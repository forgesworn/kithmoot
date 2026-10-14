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
`+marker)}
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
async function reloadInspector(page:Page){
  await page.reload()
  await page.evaluate(`(()=>{window.puts=0;window.entropy=0;window.providers=0;window.live=true;window.guard=()=>live;
    crypto.getRandomValues=()=>{entropy++;throw Error('startup must not allocate')};
    for(const name of ['put','delete','clear'])IDBObjectStore.prototype[name]=()=>{puts++;throw Error('startup must not write')};
    window.nostr={getPublicKey:()=>{providers++;throw Error('startup must not ask a provider')},signEvent:()=>{providers++;throw Error('startup must not sign')}};
    window.fresh=new Ordinary.OrdinaryStateOwner()
  })()`)
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
  ['prepared','missing-tab'],['prepared','unexpected-key'],['prepared','pending']]){
  test(`startup refuses authenticated ${phase} ${fault} mismatch before any effect`,async({page})=>{
    await stage(page,phase)
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
      await stage(page,phase);const firstBrowser=context.browser();await context.close();context=undefined
      expect(firstBrowser!.isConnected()).toBe(false)
      // Reopen the exact native profile in a fresh browser process. No exported
      // storage state, plaintext snapshot, replacement key or fixture import.
      context=await engine.launchPersistentContext(profile,{headless:true})
      await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
      const next=context.pages()[0]??await context.newPage();await next.goto(ORIGIN);await reloadInspector(next)
      expect(await next.evaluate(`(async()=>{const disposition=await fresh.inspectRenewalStartup(guard);let held;
        try{await fresh.prepare(guard,new Map());held='bad'}catch(e){held=e.name};return[disposition.status,disposition.operations[0].phase,held,puts,entropy,providers]})()`))
        .toEqual(['recovery-required',phase,'OrdinaryStateHold',0,0,0]);await next.evaluate('fresh.close()')
    }finally{await context?.close();await rm(profile,{recursive:true,force:true})}
  })
}
