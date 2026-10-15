import { measureStartupStage, startupTimingEnabled } from './ordinary-startup-timing.js'
import {build} from 'esbuild'
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {test,expect,chromium,firefox,webkit,type Page} from '@playwright/test'
import {setup} from './ordinary-bootstrap.setup.js'
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure'
import {controls} from './ordinary-member-session.setup.js'
const ORIGIN='https://ordinary-renewal-startup.invalid'
let bundle=''
test.beforeAll(async()=>{
  bundle=(await build({entryPoints:['test/ordinary-prepared-extension.browser-entry.ts'],bundle:true,write:false,format:'iife',globalName:'Ordinary',platform:'browser',target:'es2022',
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
export async function preparedRestart(page:Page,visitor:boolean,keep:boolean,priorLease=false,sdkExpirySeconds?:number,nativePhase:'prepared'|'ordinary'|'provider-started'|'provider-returned'|'candidate-prepared'|'candidate-committed'|'settled'='prepared'){
  if (startupTimingEnabled(priorLease)) return preparedRestartMeasured(page,visitor,keep,priorLease,sdkExpirySeconds,nativePhase)
  const key=generateSecretKey()
  await page.exposeFunction('freshProviderPubkey',()=>getPublicKey(key))
  await page.exposeFunction('freshProviderSign',(event:Parameters<typeof finalizeEvent>[0])=>finalizeEvent(event,key))
  const fixtureSetup=setup.replace('    identity=await Ordinary.OrdinaryForegroundSigner.open',`    if(options.sdkExpirySeconds){
      const expiresAt=(now+options.sdkExpirySeconds)*1000
      const b=await browserOwner.capture('@ordinary-signet',guard),t=await tabOwner.capture('@ordinary-signet',guard)
      await Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:b},tab:{owner:tabOwner,scope:t},live:guard,
        work:browser=>browser.set(k.expiresAt,String(expiresAt))})
      sourceSession={...sourceSession,expiresAt}
    }
    identity=await Ordinary.OrdinaryForegroundSigner.open`)
  await page.evaluate(`(${fixtureSetup})(${JSON.stringify({visitor,keep,noRelays:true,participantSk:Array.from(key),sdkExpirySeconds})})`)
  await page.evaluate(`(${controls})()`);await page.evaluate('join()')
  if(priorLease){
    await page.evaluate("window.skipStartupCuts=1;window.requestedStage='prepared'")
    await page.clock.fastForward(901000)
    await expect.poll(()=>page.evaluate('(async()=>{try{const result=await bootstrap.load();try{return result.sealKeys.length}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(result)}}catch{return 0}})()')).toBe(2)
    await page.evaluate("member.send('first generation')")
  }
  if(nativePhase!=='ordinary'){
    await page.evaluate(stage=>{
      const w=window as any;w.requestedStage=stage
      w.beforeActualSigning=()=>{
        if(stage==='provider-started')w.gateSigner()
        if(stage==='provider-returned'){
          const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let blocked=false
          crypto.subtle.encrypt=async(...args)=>{
            if(!blocked&&typeof args[0]!=='string'&&'additionalData' in args[0]&&new TextDecoder().decode(args[0].additionalData).includes('kithmoot.ordinary-state')){
              blocked=true;w.actualStage='provider-returned';await new Promise(()=>{})
            }
            return encrypt(...args)
          }
        }
      }
    },nativePhase);await page.clock.fastForward(901000)
    if(nativePhase==='provider-started')await page.waitForFunction('window.signing===true')
    else await page.waitForFunction(stage=>(window as any).actualStage===stage,nativePhase)
  }
  const captured=await page.evaluate<any>(`({account,participant,keep,link:url,inviter:invitation.inviter,bearer:Array.from(invitation.bearer),credentialExpiresAt,tabPurpose,tabExpiry,
    authoritySecret:Array.from(secret),authoritySigner:Array.from(inviterSk),
    time:Date.now(),sdkExpiresAt:sourceSession?.expiresAt,auth:account===null?null:JSON.stringify(sourceSession.authEvent),method:account===null?null:sourceSession.method})`)
  await page.reload();await page.clock.install({time:new Date(captured.time)})
  await page.evaluate(async value=>{
    const o=(window as any).Ordinary,w=window as any
    w.live=true;w.guard=()=>w.live;w.signCalls=0;w.providerPhases=[];w.entropy=0;w.puts=0
    w.preparedAuthoritySecret=Uint8Array.from(value.authoritySecret);w.preparedAuthoritySigner=Uint8Array.from(value.authoritySigner)
    const random=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=(...args)=>{w.entropy++;return random(...args)}
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args:any[]){w.puts++;return put.apply(this,args as any)}
    w.readPreparedRows=()=>new Promise((resolve,reject)=>{const request=indexedDB.open(o.ORDINARY_DATABASE,1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();resolve(keys.result.map((name,i)=>[name,values.result[i]]))};tx.onabort=()=>reject(tx.error)}})
    w.preparedPhase=async()=>{const rows=new Map(await w.readPreparedRows()),b:any=rows.get('browser'),t:any=rows.get(value.tabPurpose),names=o.ordinaryOperationNames(value.tabPurpose),
      binding=(frame:any)=>({purpose:frame.purpose,keyId:frame.keyId,generation:frame.generation,expiresAt:frame.expiresAt})
      if(!rows.has(names.control))return'ordinary'
      const phase=(await o.openOrdinaryOperationClassification(rows.get(names.control),{browser:{key:b.key,binding:binding(b.frame)},tab:{key:t.key,binding:binding(t.frame)}})).phase
      return value.nativePhase==='ordinary'&&phase==='settled'?'ordinary':phase}
    w.nostr={getPublicKey:async()=>{w.providerPhases.push(await w.preparedPhase());return w.freshProviderPubkey()},signEvent:async(event:any)=>{
      w.signCalls++;w.providerPhases.push(await w.preparedPhase());return w.freshProviderSign(event)}}
    const identity=value.account===null?{pubkey:value.participant,signEvent:()=>{throw Error('visitor recovery must use native participant custody')}}:new o.Nip07Signer(value.participant,w.nostr)
    w.sourceSession=value.account===null?undefined:{pubkey:value.participant,method:value.method,signer:identity,authEvent:JSON.parse(value.auth),...(value.sdkExpiresAt===undefined?{}:{expiresAt:value.sdkExpiresAt})}
    w.browserOwner=new o.OrdinaryStateOwner();w.tabOwner=new o.OrdinaryStateOwner(value.tabPurpose,value.tabExpiry)
    const invitation=o.roomInvitation(Uint8Array.from(value.bearer),value.inviter,true),invitationId=o.deriveInvitationId(invitation)
    w.current={account:value.account,participant:value.participant,invitationId,identity,link:value.link,keep:value.keep,credentialExpiresAt:value.credentialExpiresAt}
    w.recoveryOptions={browser:w.browserOwner,tab:w.tabOwner,invitation,account:value.account,identity,link:value.link,keep:value.keep,credentialExpiresAt:value.credentialExpiresAt,current:()=>w.current,live:w.guard,
      ...(value.account===null?{}:{foreground:{session:w.sourceSession,currentSession:()=>w.sourceSession,generation:0,currentGeneration:()=>0,checkClients:async()=>{},stop:()=>{}}})}
    w.recoveryStatus='pending';w.recoveryStack=null;w.beginPrepared=()=>{w.recovering=o.OrdinaryPersistentBootstrap.recoverPreparedAtStartup(w.recoveryOptions).then((result:any)=>{w.recoveryStatus=result.status},(error:any)=>{w.recoveryStatus=error.name;w.recoveryStack=error.stack})}
  },{...captured,nativePhase})
}

async function preparedRestartMeasured(page:Page,visitor:boolean,keep:boolean,priorLease=false,sdkExpirySeconds?:number,nativePhase:'prepared'|'ordinary'|'provider-started'|'provider-returned'|'candidate-prepared'|'candidate-committed'|'settled'='prepared'){
  const key=generateSecretKey()
  await page.exposeFunction('freshProviderPubkey',()=>getPublicKey(key))
  await page.exposeFunction('freshProviderSign',(event:Parameters<typeof finalizeEvent>[0])=>finalizeEvent(event,key))
  const fixtureSetup=setup.replace('    identity=await Ordinary.OrdinaryForegroundSigner.open',`    if(options.sdkExpirySeconds){
      const expiresAt=(now+options.sdkExpirySeconds)*1000
      const b=await browserOwner.capture('@ordinary-signet',guard),t=await tabOwner.capture('@ordinary-signet',guard)
      await Ordinary.OrdinaryStateOwner.mutatePairMigrated({browser:{owner:browserOwner,scope:b},tab:{owner:tabOwner,scope:t},live:guard,
        work:browser=>browser.set(k.expiresAt,String(expiresAt))})
      sourceSession={...sourceSession,expiresAt}
    }
    identity=await Ordinary.OrdinaryForegroundSigner.open`)
  await measureStartupStage(page, 'initial bootstrap', () => page.evaluate(`(${fixtureSetup})(${JSON.stringify({visitor,keep,noRelays:true,participantSk:Array.from(key),sdkExpirySeconds})})`), priorLease)
  await page.evaluate(`(${controls})()`);await measureStartupStage(page, 'initial member join', () => page.evaluate('join()'), priorLease)
  if(priorLease){
    await page.evaluate("window.skipStartupCuts=1;window.requestedStage='prepared'")
    await measureStartupStage(page, 'first renewal clock advance', () => page.clock.fastForward(901000), priorLease)
    await measureStartupStage(page, 'first renewal observed', async () => {
    await expect.poll(()=>page.evaluate('(async()=>{try{const result=await bootstrap.load();try{return result.sealKeys.length}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(result)}}catch{return 0}})()')).toBe(2)
    }, priorLease)
    await measureStartupStage(page, 'first generation send', () => page.evaluate("member.send('first generation')"), priorLease)
  }
  if(nativePhase!=='ordinary'){
    await page.evaluate(stage=>{
      const w=window as any;w.requestedStage=stage
      w.beforeActualSigning=()=>{
        if(stage==='provider-started')w.gateSigner()
        if(stage==='provider-returned'){
          const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);let blocked=false
          crypto.subtle.encrypt=async(...args)=>{
            if(!blocked&&typeof args[0]!=='string'&&'additionalData' in args[0]&&new TextDecoder().decode(args[0].additionalData).includes('kithmoot.ordinary-state')){
              blocked=true;w.actualStage='provider-returned';await new Promise(()=>{})
            }
            return encrypt(...args)
          }
        }
      }
    },nativePhase);await measureStartupStage(page, 'second renewal clock advance', () => page.clock.fastForward(901000), priorLease)
    if(nativePhase==='provider-started')await page.waitForFunction('window.signing===true')
    else await measureStartupStage(page, 'second renewal enrolled', () => page.waitForFunction(stage=>(window as any).actualStage===stage,nativePhase), priorLease)
  }
  const captured=await page.evaluate<any>(`({account,participant,keep,link:url,inviter:invitation.inviter,bearer:Array.from(invitation.bearer),credentialExpiresAt,tabPurpose,tabExpiry,
    authoritySecret:Array.from(secret),authoritySigner:Array.from(inviterSk),
    time:Date.now(),sdkExpiresAt:sourceSession?.expiresAt,auth:account===null?null:JSON.stringify(sourceSession.authEvent),method:account===null?null:sourceSession.method})`)
  await measureStartupStage(page, 'reload', () => page.reload(), priorLease);await page.clock.install({time:new Date(captured.time)})
  await measureStartupStage(page, 'reconstruction', () => page.evaluate(async value=>{
    const o=(window as any).Ordinary,w=window as any
    w.live=true;w.guard=()=>w.live;w.signCalls=0;w.providerPhases=[];w.entropy=0;w.puts=0
    w.preparedAuthoritySecret=Uint8Array.from(value.authoritySecret);w.preparedAuthoritySigner=Uint8Array.from(value.authoritySigner)
    const random=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=(...args)=>{w.entropy++;return random(...args)}
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args:any[]){w.puts++;return put.apply(this,args as any)}
    w.readPreparedRows=()=>new Promise((resolve,reject)=>{const request=indexedDB.open(o.ORDINARY_DATABASE,1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('owners'),store=tx.objectStore('owners'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();resolve(keys.result.map((name,i)=>[name,values.result[i]]))};tx.onabort=()=>reject(tx.error)}})
    w.preparedPhase=async()=>{const rows=new Map(await w.readPreparedRows()),b:any=rows.get('browser'),t:any=rows.get(value.tabPurpose),names=o.ordinaryOperationNames(value.tabPurpose),
      binding=(frame:any)=>({purpose:frame.purpose,keyId:frame.keyId,generation:frame.generation,expiresAt:frame.expiresAt})
      if(!rows.has(names.control))return'ordinary'
      const phase=(await o.openOrdinaryOperationClassification(rows.get(names.control),{browser:{key:b.key,binding:binding(b.frame)},tab:{key:t.key,binding:binding(t.frame)}})).phase
      return value.nativePhase==='ordinary'&&phase==='settled'?'ordinary':phase}
    w.nostr={getPublicKey:async()=>{w.providerPhases.push(await w.preparedPhase());return w.freshProviderPubkey()},signEvent:async(event:any)=>{
      w.signCalls++;w.providerPhases.push(await w.preparedPhase());return w.freshProviderSign(event)}}
    const identity=value.account===null?{pubkey:value.participant,signEvent:()=>{throw Error('visitor recovery must use native participant custody')}}:new o.Nip07Signer(value.participant,w.nostr)
    w.sourceSession=value.account===null?undefined:{pubkey:value.participant,method:value.method,signer:identity,authEvent:JSON.parse(value.auth),...(value.sdkExpiresAt===undefined?{}:{expiresAt:value.sdkExpiresAt})}
    w.browserOwner=new o.OrdinaryStateOwner();w.tabOwner=new o.OrdinaryStateOwner(value.tabPurpose,value.tabExpiry)
    const invitation=o.roomInvitation(Uint8Array.from(value.bearer),value.inviter,true),invitationId=o.deriveInvitationId(invitation)
    w.current={account:value.account,participant:value.participant,invitationId,identity,link:value.link,keep:value.keep,credentialExpiresAt:value.credentialExpiresAt}
    w.recoveryOptions={browser:w.browserOwner,tab:w.tabOwner,invitation,account:value.account,identity,link:value.link,keep:value.keep,credentialExpiresAt:value.credentialExpiresAt,current:()=>w.current,live:w.guard,
      ...(value.account===null?{}:{foreground:{session:w.sourceSession,currentSession:()=>w.sourceSession,generation:0,currentGeneration:()=>0,checkClients:async()=>{},stop:()=>{}}})}
    w.recoveryStatus='pending';w.recoveryStack=null;w.beginPrepared=()=>{w.recovering=o.OrdinaryPersistentBootstrap.recoverPreparedAtStartup(w.recoveryOptions).then((result:any)=>{w.recoveryStatus=result.status},(error:any)=>{w.recoveryStatus=error.name;w.recoveryStack=error.stack})}
  },{...captured,nativePhase}), priorLease)
}
