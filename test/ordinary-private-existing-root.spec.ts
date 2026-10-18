import { build, type Plugin } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { test } from './ordinary-native-browser.fixture.js'
import { finalizeEvent } from 'nostr-tools/pure'
import { encodeEpochGrant } from '../src/epoch.js'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

let server: Server, origin = '', fixture = '', worker = '', pureFence = ''
const modules = new Map<string, string>()
const ROOT_ENTRY = '/j/build/ordinary-private-existing-root.browser-entry.js'
const probes = `window.effects={provider:0,socket:0,storageWrite:0,put:0,entropy:0,key:0};window.probeNonces=0;window.curveInitializationProbes=0;window.curveProbeActive=false;window.privateEntropyCalls=[];
const nativeProbeRandom=crypto.getRandomValues.bind(crypto);window.__probeRandom=value=>{probeNonces++;return nativeProbeRandom(value)};
window.__privateProviderSetupProbe=stage=>{const f=window.privateProviderCommandFixture;if(!f)return;(f.stages??=[]).push(stage);if(f.cut===stage&&!f.cutEntered){f.cutEntered=true;if(f.cutMode==='controller')navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));else if(f.cutMode==='close')void window.__privateRootCloseForTest().catch(()=>{});else window.dispatchEvent(new PageTransitionEvent('pagehide'))}if(f.fail===stage)throw Error('Explicit provider setup failure: '+stage)};
window.privateG0JoinCutEntered=null;window.__privateG0JoinCut=stage=>{if(window.privateG0JoinCut!==stage||window.privateG0JoinCutEntered)return;window.privateG0JoinCutEntered=stage;window.dispatchEvent(new PageTransitionEvent('pagehide'))};
window.__curveProbeRandom=(random,length)=>{curveInitializationProbes++;curveProbeActive=true;try{return random(length)}finally{curveProbeActive=false}};
Object.defineProperty(window,'nostr',{configurable:true,get(){effects.provider++;if(window.providerFixture)return window.providerFixture.current;throw Error('provider forbidden')}});
window.WebSocket=class{constructor(url){effects.socket++;if(window.privateJoinNetworkFixture&&window.__controlDecision)return new window.__privateJoinSocket(url);throw Error('socket forbidden')}};
for(const name of ['setItem','removeItem','clear'])Storage.prototype[name]=()=>{effects.storageWrite++;throw Error('Storage write forbidden')};
window.__privateBootstrapPause=async stage=>{const cut=window.privateBootstrapGate;if(!cut||cut.stage!==stage||cut.used)return;cut.used=true;cut.entered=true;await new Promise((yes,no)=>{cut.release=()=>cut.reject?no(Error('Explicit bootstrap fixture failure')):yes()})};\nwindow.privateRenewalEntropy=[];window.privateRenewalWrites=[];window.privateRenewalPackets=[];window.privateRenewalEncryptedRows={};window.privateRenewalEncryptedCohorts={};
window.__enterPrivateRenewalDecision=()=>{const before=[window.__privateRenewalDecision,window.__controlDecision,window.__foregroundDecision];window.__privateRenewalDecision=true;window.__controlDecision=true;window.__foregroundDecision=true;return()=>{[window.__privateRenewalDecision,window.__controlDecision,window.__foregroundDecision]=before}};
for(const name of ['put','add','delete','clear']){const actual=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){effects.put++;if(window.allowPrivateRenewalEffects&&window.__privateRenewalDecision){privateRenewalWrites.push([name,args[1]??null]);privateRenewalPackets.push({phase:window.__privateRenewalWritePhase,key:args[1],packet:JSON.stringify(args[0],(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v)});const result=Reflect.apply(actual,this,args);if(name==='put'&&window.__privateRenewalWritePhase){privateRenewalEncryptedRows[args[1]]=structuredClone(args[0]);if(String(args[1]).startsWith('journal:'))privateRenewalEncryptedCohorts[window.__privateRenewalWritePhase]=structuredClone(privateRenewalEncryptedRows)}const fault=window.privateRenewalAckFault;if(fault&&!fault.used&&fault.phase===window.__privateRenewalWritePhase){fault.used=true;const tx=this.transaction;if(fault.prior){fault.entered=true;tx.abort();if(fault.close)window.dispatchEvent(new PageTransitionEvent('pagehide'))}else{const complete=tx.oncomplete,abort=tx.onabort;tx.oncomplete=event=>{fault.entered=true;fault.release=()=>{fault.delivered=true;if(fault.reject)abort.call(tx,new Event('abort'));else complete.call(tx,event)}}}}return result}throw Error('native write forbidden')}};
crypto.getRandomValues=value=>{if(curveProbeActive)return nativeProbeRandom(value);effects.entropy++;if(window.privateMemberConstruction&&window.__controlDecision){(window.privateMemberEntropy??=[]).push(value.byteLength);return nativeProbeRandom(value)};if(window.allowPrivateRenewalEffects&&window.__privateRenewalDecision){privateRenewalEntropy.push(value.byteLength);if(value.byteLength===12&&window.privateRenewalNonceCollision){const prior=window.privateRenewalNonceCollision==='existing'?window.__privateRenewalPriorNonces[0]:window.__privateRenewalFirstNonce;if(prior){value.set(Uint8Array.from(prior.match(/../g).map(v=>parseInt(v,16))));return value}}const result=nativeProbeRandom(value);if(value.byteLength===12&&!window.__privateRenewalFirstNonce)window.__privateRenewalFirstNonce=Array.from(value,v=>v.toString(16).padStart(2,'0')).join('');return result}const error=Error('entropy forbidden');privateEntropyCalls.push(error.stack);throw error};
crypto.subtle.generateKey=()=>{effects.key++;throw Error('key allocation forbidden')};
window.__dueTransactionModes=[];window.__dueObserveTransactions=false;
const dueNativeTransaction=IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction=function(...args){if(window.__dueObserveTransactions)window.__dueTransactionModes.push(args[1]??'readonly');return Reflect.apply(dueNativeTransaction,this,args)};`
const none = { provider: 0, socket: 0, storageWrite: 0, put: 0, entropy: 0, key: 0 }

test.beforeAll(async () => {
  const sdkPlugins: Plugin[] = process.env.SIGNET_PINNED_SOURCE_ENTRY ? [{ name: 'local-pinned-sdk-source-overlay', setup(builder) {
    builder.onResolve({ filter: /^signet-login$/ }, () => ({ path: resolve(process.env.SIGNET_PINNED_SOURCE_ENTRY!) }))
  } }] : []
  const result = await build({ entryPoints: ['test/ordinary-private-existing-root.browser-entry.ts'],
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    outdir: '.private-root-test-build', chunkNames: 'chunks/[name]-[hash]', write: false, metafile: true,
    plugins: [...sdkPlugins, { name: 'observe-private-root-failure-only', setup(builder) {
      builder.onLoad({ filter: /ordinary-private-existing-root\.ts$/ }, async input => {
        let source = await readFile(input.path, 'utf8')
        const once = (marker: string, replacement: string) => {
          if (source.split(marker).length !== 2) throw Error('Provider command root observer drift: ' + marker)
          source = source.replace(marker, replacement)
        }
        once('\n    this.#providerWork = command', `\n    this.#providerWork = command
          const commandFixture = (globalThis as any).privateProviderCommandFixture
          if (commandFixture) {
            commandFixture.command = command
            void command.then(() => {commandFixture.commandState='fulfilled'}, error => {commandFixture.commandState='rejected';commandFixture.commandError=error?.message})
          }`)
        once('\n      this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot, command)',
          `\n      (globalThis as any).__privateProviderSetupProbe('root-before-native')
           if ((globalThis as any).privateProviderCommandFixture?.wrongRoot) {
             try { claimOrdinaryPrivateExistingProviderCommand(Object.freeze({}) as OrdinaryPrivateExistingRoot, command) }
             catch { (globalThis as any).privateProviderCommandFixture.wrongRootRefused=true }
           }
      this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot, command)
           ;(globalThis as any).__privateProviderSetupProbe('root-after-assignment')`)
        once('await this.#capture.completed\n    this.#check()\n    this.#captureReady = true', `await this.#capture.completed
          const captureFixture=(globalThis as any).privateProviderCommandFixture
          if(captureFixture?.early) {captureFixture.captureEntered=true;await new Promise<void>(yes=>{captureFixture.captureRelease=yes})}
          this.#check()
          this.#captureReady = true`)
        for (const kind of ['provider','capture']) once(`this.#stopOne(() => this.#${kind}?.stop())`,
          `this.#stopOne(() => {const f=(globalThis as any).privateProviderCommandFixture;if(f){(f.rootStops??=[]).push('${kind}');if(f.throwRootStops?.includes('${kind}'))throw Error('Explicit root ${kind} stop failure')}this.#${kind}?.stop()})`)
        const marker = '}, async () => {\n      this.#stop()'
        if (source.split(marker).length !== 2) throw Error('Private root observation fixture drift')
        const closeMarker='this.#closing = new Promise<void>((yes, no) => { resolve = yes; reject = no })'
        if(source.split(closeMarker).length!==2)throw Error('Private root terminal observer drift')
        const observed=source.replace(closeMarker,closeMarker+`; (globalThis as any).__rootCloseDoneForTest=false;
          void this.#closing.then(()=>{(globalThis as any).__rootCloseDoneForTest=true},(error)=>{(globalThis as any).__rootCloseFailure=error?.message;(globalThis as any).__rootCloseDoneForTest=true})`)
        source = observed.replace(marker,
          '}, async (error) => { (globalThis as any).__rootFailure=error?.stack; this.#stop()').replace(
            '}, async () => { this.#stop(); await this.close() })',
            '}, async (error) => { (globalThis as any).__providerFailure=error?.stack; this.#stop(); await this.close() })').replace(
            '\n      this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot, command)',
            `\n      const provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot, command)
             if ((globalThis as any).providerFixture?.cutAssignment === 'before') window.dispatchEvent(new PageTransitionEvent('pagehide'))
             this.#provider = provider
             if ((globalThis as any).providerFixture?.cutAssignment === 'after') window.dispatchEvent(new PageTransitionEvent('pagehide'))`).replace(
            '#pagehide = () => { void this.close().catch(() => {}) }',
            '#pagehide = () => { (globalThis as any).__rootCloseDoneForTest=false; void this.close().catch(error => { (globalThis as any).__rootCloseFailure=error?.message }).finally(()=>{(globalThis as any).__rootCloseDoneForTest=true}) }').replace(
            'assertClientsCurrent: async () => { this.#check(); await this.#worker!.assertCurrent(); this.#check() }',
            `assertClientsCurrent: async () => {
              this.#check()
              const cut = (globalThis as any).privateRenewalClientCut, selected = cut && ++cut.calls === cut.at
              const pause = async () => {
                cut.entered = true
                await new Promise<void>((yes, no) => { cut.release = () => cut.reject ? no(Error('Explicit delayed client probe rejection')) : yes() })
              }
              if (selected && cut.before) await pause()
              await this.#worker!.assertCurrent()
              if (selected && !cut.before) await pause()
              this.#check()
            }`).replace(
            'roots.set(this, { root: this, claimed: false })',
            `roots.set(this, { root: this, claimed: false })
             // Instrument this private stage only; no production action or public API is added.
             ;(globalThis as any).__invokePrivateControlForTest = () => (globalThis as any).__privateControlForTest(this)
             ;(globalThis as any).__invokePrivateForegroundForTest = () => (globalThis as any).__privateForegroundForTest(this)
             ;(globalThis as any).__privateRootCloseForTest=()=>this.close()
             // Privileged preview mechanics only; no production bridge exists.
             ;(globalThis as any).__draftPreviewForTest=(kind:any)=>(globalThis as any).__draftOwnerPreviewForTest(this,kind)
             ;(globalThis as any).__draftPreviewTakeForTest=(receipt:any,kind:any)=>(globalThis as any).__draftOwnerPreviewTakeForTest(this,receipt,kind)
             ;(globalThis as any).__draftPreviewAdvanceForTest=()=>(globalThis as any).__draftOwnerPreviewAdvanceForTest(this)
             ;(globalThis as any).__draftPreviewRevokeForTest=()=>(globalThis as any).__draftOwnerPreviewRevokeForTest(this)
             ;(globalThis as any).__privateRestoreProviderNowForTest=()=>this.restoreProvider()
             ;(globalThis as any).__privateClaimProviderCommandForTest=(command:Promise<void>)=>claimOrdinaryPrivateExistingProviderCommand(this as unknown as OrdinaryPrivateExistingRoot,command)`)
        {
        const marker='    this.#trackMember(command)'
        if(source.split(marker).length!==2)throw Error('Trusted command observation drift')
        source=source.replace(marker,marker+`; (globalThis as any).__trustedCommandDone=false;
          void command.then(()=>{(globalThis as any).__trustedCommandOutcome='fulfilled'},error=>{
            (globalThis as any).__trustedCommandOutcome='rejected';
            if(error instanceof Error)(globalThis as any).__trustedCommandError=error.stack
          }).finally(()=>{(globalThis as any).__trustedCommandDone=true})`)
        const registration='memberIntents.set(intent, action); memberCommands.set(command, action)'
        if(source.split(registration).length!==2)throw Error('Trusted wallet retry observer drift')
        source=source.replace(registration,registration+`; (globalThis as any).__trustedWalletRetryForTest=()=>{
          try{beginOrdinaryPrivateWalletEffect(this as unknown as OrdinaryPrivateExistingRoot,command,view.kind as 'unlock-private-member'|'verify-private-member');return 'unexpected'}catch{return 'held'}
        }`)
        const revoke='this.#stopOne(() => this.#nativeMember?.revokeOrdinaryPrivateSelectionPreview(this as unknown as OrdinaryPrivateExistingRoot))'
        if(source.split(revoke).length!==2)throw Error('Preview revocation cleanup fault hook drift')
        // Labelled lexical fault after the real fixed revoker; no receipt escapes.
        source=source.replace(revoke,`this.#stopOne(() => {
          this.#nativeMember?.revokeOrdinaryPrivateSelectionPreview(this as unknown as OrdinaryPrivateExistingRoot)
          const f=(globalThis as any).memberCleanupFault
          if(f?.armed&&f.mode==='preview'&&!f.used){f.used=true;f.removed.push('preview');throw Error('Explicit member cleanup fault: preview')}
        })`)
        source+=`\n;(globalThis as any).__trustedRootCloseForTest=()=>actualRoot?.close()`
        }
        return {loader:'ts',contents:source}
      })
      builder.onLoad({filter:/ordinary-private-existing-root\.browser-entry\.ts$/},async input=>{
        const source=await readFile(input.path,'utf8')
        return {loader:'ts',contents:source.replace('void prepareOrdinaryPrivateExistingRoot()',
          "void ((globalThis as any).privateTrustedMemberFixture ? prepareOrdinaryPrivateMemberRoot() : prepareOrdinaryPrivateExistingRoot())")}
      })
      builder.onLoad({filter: /ordinary-state-codec\.ts$/}, async input => {
        const source = await readFile(input.path, 'utf8'), marker = "this.name = 'OrdinaryStateHold'"
        if (source.split(marker).length !== 2) throw Error('Private pipeline owned refusal observer drift')
        return {loader: 'ts', contents: source.replace(marker, marker + "; if ((globalThis as any).allowPrivateRenewalEffects) ((globalThis as any).__privateRenewalHolds ??= []).push(this.stack)").replace(
          '    crypto.getRandomValues(new Uint8Array(frame.nonce))',
          `    const f=(globalThis as any), fault=f.allowPrivateRenewalEffects&&!f.privateRenewalSealFaultUsed?f.privateRenewalSealFault:undefined
               if(fault)f.privateRenewalSealFaultUsed=true
               if(fault!=='missing')crypto.getRandomValues(new Uint8Array(frame.nonce))
               if(fault==='extra')crypto.getRandomValues(new Uint8Array(frame.nonce))
               if(fault==='changed-iv')new Uint8Array(frame.nonce)[0]^=1`)}
      })
      builder.onLoad({filter:/persistent-admission-proof\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8')
        const continuity='if (current.epochs.find(value => value.epoch === bound.device.epoch)?.id !== priorId) hold()'
        if(source.split(continuity).length!==2)throw Error('Historical epoch continuity observer drift')
        source=source.replace(continuity,`if (current.epochs.find(value => value.epoch === bound.device.epoch)?.id !== priorId) {
          if((globalThis as any).privateHistorySemanticFixture)(globalThis as any).privateHistorySemanticRefusal={
            stage:'historical-epoch-continuity',currentEpoch:current.epoch,proofEpoch:bound.device.epoch,missingHistoricalId:true}
          hold()
        }`)
        return {loader:'ts',contents:source}
      })
      builder.onLoad({filter:/ordinary-renewal-obligation\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8'),at=source.indexOf('export function registerOrdinaryRenewalFactory(')
        const body=source.indexOf('  if(!factory',at)
        if(at<0||body<0)throw Error('Legacy factory observer drift')
        source=source.slice(0,body)+`  if((globalThis as any).privateBootstrapTesting)(globalThis as any).privateBootstrapLegacyFactoryCalls++\n`+source.slice(body)
        return {loader:'ts',contents:source}
      })
      builder.onLoad({filter:/ordinary-persistent-bootstrap\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8')
        const claimGet='const value = privateControllerRenewalClaims.get(claim)'
        if(source.split(claimGet).length!==2)throw Error('Root reservation claim counter drift')
        source=source.replace(claimGet,`;(globalThis as any).__privateRootIndexTakes=((globalThis as any).__privateRootIndexTakes??0)+1; `+claimGet)
        source+=`
;(globalThis as any).__privateRootIndexClaimPresent=(claim:any)=>privateControllerRenewalClaims.has(claim)
`

        const currentEpoch='const epoch = device.epochs.find(value => value.epoch === device.epoch)'
        if(source.split(currentEpoch).length!==2)throw Error('Join durable current epoch observer drift')
        source=source.replace(currentEpoch,currentEpoch+`; if((globalThis as any).privateJoinNetworkFixture)(globalThis as any).privateJoinDurableCurrent={epoch:device.epoch,id:epoch?.id}`)
        const sealCheck='const seals = retained.sealStrings.map(value => {\n        const key = hexToBytes(value)\n        try {return getPublicKey(key)} finally {key.fill(0)}\n      })'
        if(source.split(sealCheck).length!==2)throw Error('Private join seal erasure observer drift')
        source=source.replace(sealCheck,`const seals = retained.sealStrings.map(value => {
          const key=hexToBytes(value),fixture=globalThis as any
          if(fixture.privateJoinNetworkFixture)(fixture.privateJoinDecodedSealKeys??=[]).push(key)
          try {if(fixture.privateJoinSealConversionFailure)throw Error('Explicit seal conversion failure');return getPublicKey(key)} finally {key.fill(0)}
        })`)
        const ownerCheck='const data = module.takeOrdinaryPrivateMemberJoinedDecision(decision)'
        if(source.split(ownerCheck).length!==2)throw Error('Private join owner cut fixture drift')
        source=source.replace(ownerCheck,ownerCheck+`; (globalThis as any).__privateG0JoinCut('owner-authentication')`)
        const bootstrapJoined='if (!joining) hold()\n        await joining\n        await this.#checkPrivateMaterial(material)'
        if(source.split(bootstrapJoined).length!==2)throw Error('Private join bootstrap handoff fixture drift')
        source=source.replace(bootstrapJoined,`if (!joining) hold()
          await joining
          ;(globalThis as any).__privateG0JoinCut('bootstrap-handoff')
          await this.#checkPrivateMaterial(material)`)
        const marker='privateBootstrapResources.set(resource, Object.freeze({state, completed}))'
        if(source.split(marker).length!==2)throw Error('Private bootstrap resource observer drift')
        source=source.replace(marker,marker+`
          ;(globalThis as any).__privateBootstrapResourceForTest=()=>({closed:state.#closed,opening:!!state.#privateOpening,work:state.#work.size,
            material:!!state.#privateMaterial,legacy:!!state.#legacy,operation:!!state.#ownedOperation,
            retained:state.#privateMaterial?[state.#privateMaterial.admission.secret,state.#privateMaterial.deviceKey,state.#privateMaterial.sealKey,...state.#privateMaterial.sealKeys??[]].map(v=>v.length):[]})
          ;(globalThis as any).__seenPrivateBootstrapResource=resource
        `)
        const take='const binding = takeOrdinaryPrivateBootstrapClaim(claim)'
        if(source.split(take).length!==2)throw Error('Private bootstrap claim observer drift')
        source=source.replace(take,`const original = takeOrdinaryPrivateBootstrapClaim(claim)
          ;(globalThis as any).__seenPrivateBootstrapClaim=claim
          const fixture=(globalThis as any), fault=fixture.privateBootstrapSelectionFault
          let selected=original.selection, scopes=original.scopes
          if(fault){
            const wrong='f'.repeat(64)
            selected=Object.freeze({...selected,...fault==='account'?{account:wrong}:fault==='participant'?{participant:wrong}:
              fault==='invitation'?{invitationId:wrong}:fault==='room'?{roomId:wrong}:fault==='operation'?{proofOperation:wrong}:
              fault==='keep'?{keep:!selected.keep}:fault==='link'?{link:selected.link+'#changed'}:
              fault==='credential'?{credentialExpiresAt:selected.credentialExpiresAt+1}:fault==='bootstrap-expiry'?{bootstrapCredentialExpiresAt:selected.bootstrapCredentialExpiresAt+1}:{}})
            if(fault==='browser-scope'||fault==='tab-scope')scopes=original.scopes.map((v,i)=>i===(fault==='browser-scope'?0:1)?Object.freeze({...v,fence:v.fence+1}):v) as unknown as typeof scopes
          }
          const binding=fault?Object.freeze({...original,selection:selected,scopes}):original
          if(fixture.privateBootstrapCut==='claim-consumed')window.dispatchEvent(new PageTransitionEvent('pagehide'))
        `)
        const memberFailure='      } catch {\n        this.#revoke(); await this.#drainAndWipe(); throw new OrdinaryStateHold()'
        if(source.split(memberFailure).length!==2)throw Error('Private member failure observer drift')
        source=source.replace(memberFailure,'      } catch (error) {\n        ;(globalThis as any).__privateMemberFailureForTest=(error as Error)?.stack\n        this.#revoke(); await this.#drainAndWipe(); throw new OrdinaryStateHold()')
        const memberMarker='this.#privateSessionModule = module; this.#privateSession = resource'
        if(source.split(memberMarker).length!==2)throw Error('Private member assignment observer drift')
        source=source.replace(memberMarker,memberMarker+`; (globalThis as any).__privateMemberConstructedForTest=true; if((globalThis as any).privateMemberCut==='after-session')window.dispatchEvent(new PageTransitionEvent('pagehide'))`)
        const loaded='state.#privateMaterial = material'
        if(source.split(loaded).length!==2)throw Error('Private bootstrap material observer drift')
        source=source.replace(loaded,loaded+`
          const held=[material.admission.secret,material.deviceKey,material.sealKey,...material.sealKeys??[]]
          ;(globalThis as any).__privateBootstrapWipedForTest=()=>held.every(v=>v.every(b=>b===0))
          const fault=(globalThis as any).privateBootstrapMaterialFault
          if(fault){
            if(fault==='device')material.deviceKey[0]^=1
            else if(fault==='seal')material.sealKey[0]^=1
            else if(fault==='root')material.admission.secret[0]^=1
            else if(fault==='credential')(material.credential as any).content='changed'
            else if(fault==='admission')(material.admission as any).unexpected=true
            else if(fault==='seal-history'&&material.sealKeys?.length===2)(material.sealKeys as Uint8Array[]).reverse()
            else throw Error('Unknown private material fixture fault')
            ;(globalThis as any).privateBootstrapMaterialFaultUsed=true
          }
          await (globalThis as any).__privateBootstrapPause('after-load')
          if((globalThis as any).privateBootstrapCut==='after-load')window.dispatchEvent(new PageTransitionEvent('pagehide'))
        `)
        const initial='await state.#initialiseExisting(true)'
        source=source.replace(initial,`await (globalThis as any).__privateBootstrapPause('before-load'); `+initial)
        const closed='      this.#openedImage = undefined; this.#options.invitation.bearer.fill(0)\n      erased = true\n      if (failures.length) throw failures[0]'
        if(source.split(closed).length!==2)throw Error('Private bootstrap close observer drift')
        source=source.replace(closed,`      this.#openedImage = undefined; this.#options.invitation.bearer.fill(0)\n      erased = true\n      if(this.#private)await (globalThis as any).__privateBootstrapPause('close')\n      if (failures.length) throw failures[0]`)
        return {loader:'ts',contents:`;(globalThis as any).__privateBootstrapModuleEvaluated=((globalThis as any).__privateBootstrapModuleEvaluated??0)+1\n`+source+`
          ;(globalThis as any).__privateBootstrapClassForTest=OrdinaryPersistentBootstrap
          if((globalThis as any).privateBootstrapReplacePublic){
            const fail=()=>{(globalThis as any).privateBootstrapPublicDispatches++;throw Error('Private bootstrap public dispatch')}
            for(const name of ['open','recoverPreparedAtStartup'])Object.defineProperty(OrdinaryPersistentBootstrap,name,{configurable:true,value:fail})
            for(const name of ['load','revoke','close','bootstrap','openMemberSession'])Object.defineProperty(OrdinaryPersistentBootstrap.prototype,name,{configurable:true,value:fail})
          }
          ;(globalThis as any).__privateBootstrapFunctionsForTest=Object.freeze({open:openOrdinaryPrivateBootstrapFromOwnerClaim,completed:ordinaryPrivateBootstrapCompleted,stop:stopOrdinaryPrivateBootstrap,close:closeOrdinaryPrivateBootstrap,constructMember:constructOrdinaryPrivateBootstrapMember,joinMember:joinOrdinaryPrivateBootstrapMember,
            takeJoin:takeOrdinaryPrivateMemberSessionJoinClaim,hasJoin:(token:object)=>privateSessionJoinClaims.has(token)})
        `}
      })
      builder.onLoad({filter:/ordinary-private-member-session\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8')
        const marker='const binding = takeOrdinaryPrivateSessionClaim(claim)'
        if(source.split(marker).length!==2)throw Error('Private Session claim observer drift')
        source=source.replace(marker,marker+`; (globalThis as any).__privateMemberClaimForTest=claim;
          ;((globalThis as any).__privateControllerOrder??=[]).push('session')
          ;(globalThis as any).__privateControllerScheduleForTest=binding.schedule`)
        const retained='sessions.set(resource, Object.assign(Object.create(null), {view, secret, device, seals, protocol, graph: binding.graph,\n      generation: binding.generation, joinState: \'unjoined\', joining: undefined, nativeJoining: undefined, joinedReceipt: undefined, joinedSnapshot: undefined,\n      disposed: false, controllerClaimed: false, closeResult: undefined, closing: undefined, draining: undefined}))'
        if(source.split(retained).length!==2)throw Error('Private Session retained input observer drift')
        source=source.replace(retained,retained+`;
          ;(globalThis as any).__privateSessionSeenResource=resource
          ;(globalThis as any).__privateJoinTupleForTest=()=>{const v=sessions.get(resource)!;return{session:resource,graph:v.graph,generation:v.generation,receipt:v.joinedReceipt}}
          ;(globalThis as any).__privateJoinedSessionForTest=()=>{const v=sessions.get(resource)!;return{state:v.joinState,outer:!!v.joining,native:!!v.nativeJoining,
            receipt:!!v.joinedReceipt,closed:!!v.closeResult,snapshot:v.joinedSnapshot?{credential:v.joinedSnapshot.credential.id,epoch:v.joinedSnapshot.epoch,epochId:v.joinedSnapshot.epochId,seals:v.joinedSnapshot.seals,channels:v.joinedSnapshot.channels}:null}}
          ;(globalThis as any).__privateSessionInputsWipedForTest=()=>[secret!,device!,...seals].every(key=>key.every(value=>value===0))
          if((globalThis as any).privateMemberCloseFailure||(globalThis as any).privateMemberDisposeFailure||(globalThis as any).privateMemberDisposePaused||(globalThis as any).privateMemberReentrantClose){
            const actual=view, fixture=globalThis as any, closeError=Error('Explicit private Session close failure')
            fixture.__privateSessionSeenResource=resource;fixture.privateMemberCloseCalls=0;fixture.privateMemberDisposeCalls=0
            sessions.set(resource,Object.assign(Object.create(null),{view:Object.freeze({...actual,close:()=>{fixture.privateMemberCloseCalls++;
              if(fixture.privateMemberReentrantClose){fixture.privateMemberReentrantClose=undefined;fixture.privateMemberReentrantClosePromise=closeOrdinaryPrivateMemberSession(resource);void fixture.privateMemberReentrantClosePromise.catch(()=>{})}
              if(fixture.privateMemberReentrantDrain){fixture.privateMemberReentrantDrain=undefined;fixture.privateMemberReentrantDrainPromise=drainOrdinaryPrivateMemberSession(resource);void fixture.privateMemberReentrantDrainPromise.catch(()=>{})}
              return fixture.privateMemberCloseFailure?Promise.reject(closeError):actual.close()},
              dispose:()=>{fixture.privateMemberDisposeCalls++;if(fixture.privateMemberDisposePaused||fixture.privateMemberDisposeFailure&&fixture.privateMemberDisposeCalls===1)throw Error('Explicit private Session disposal failure');
                actual.dispose();fixture.__privateSessionDisposedForTest=true}}),secret,device,seals,protocol,graph:binding.graph,generation:binding.generation,
                joinState:'unjoined',joining:undefined,nativeJoining:undefined,joinedReceipt:undefined,joinedSnapshot:undefined,
                disposed:false,controllerClaimed:false,closeResult:undefined,closing:undefined,draining:undefined}))
          }
        `)
        const joinTake='const binding = takeOrdinaryPrivateMemberSessionJoinClaim(claim), value = owned(binding.session)'
        if(source.split(joinTake).length!==2)throw Error('Private join claim observer drift')
        source=source.replace(joinTake,`(globalThis as any).__privateG0JoinCut('before-claim'); (globalThis as any).privateJoinForeignClaimProbe?.(claim); `+joinTake+`; (globalThis as any).__privateJoinClaimForTest=claim`)
        for(const [marker,replacement]of [
          ['try {binding.track(outer); check()}',"try {binding.track(outer); (globalThis as any).__privateG0JoinCut('outer-retained'); check()}"],
          ['await joining; check()',"await joining; (globalThis as any).__privateG0JoinCut('native-joined'); check()"],
          ['binding.publish(token, dueAt)',";(globalThis as any).__privateG0JoinCut('before-publication'); binding.publish(token, dueAt); (globalThis as any).__privateG0JoinCut('after-publication')"],
          ["if (value.joinState !== 'joined' || value.joinedReceipt !== receipt)",";(globalThis as any).__privateG0JoinCut('session-handoff'); check(); if (value.joinState !== 'joined' || value.joinedReceipt !== receipt)"],
        ]){if(source.split(marker).length!==2)throw Error('Private join cut fixture drift: '+marker);source=source.replace(marker,replacement)}
        const decision="const decision = Object.freeze(Object.create(null)) as OrdinaryPrivateMemberJoinedDecision"
        if(source.split(decision).length!==2)throw Error('Private join decision observer drift')
        source=source.replace(decision,decision+`; ((globalThis as any).privateJoinDecisions??=[]).push(decision)`)
        const authenticate='  try {\n    const dueAt = authentication.authenticate(decision)'
        if(source.split(authenticate).length!==2)throw Error('Private foreign decision probe drift')
        source=source.replace(authenticate,"  ;(globalThis as any).privateJoinForeignDecisionProbe?.(decision)\n"+authenticate)
        const preannouncement="beforeAnnounce: snapshot => {authenticateSnapshot(owned(resource), snapshot, 'private-session-preannouncement')}"
        if(source.split(preannouncement).length!==2)throw Error('Private preannouncement fault fixture drift')
        source=source.replace(preannouncement,`beforeAnnounce: snapshot => {
          const fixture=globalThis as any,fault=fixture.privateJoinSnapshotFault
          fixture.privateJoinPreannouncementObserved={native:!!fixture.__controlDecision,snapshot:structuredClone(snapshot)}
          fixture.__privateG0JoinCut('preannouncement')
          fixture.privateJoinBeforePreannouncement?.()
          if(fault)snapshot=Object.freeze({...snapshot,...fault==='credential'?{credential:{...snapshot.credential,content:'explicit fixture mismatch'}}:
            fault==='epoch'?{epoch:snapshot.epoch+1}:fault==='epoch-id'?{epochId:'f'.repeat(64)}:
            fault==='seals'?{seals:Object.freeze([])}:fault==='channels'?{channels:Object.freeze(['unpermitted'])}:{}})
          authenticateSnapshot(owned(resource), snapshot, 'private-session-preannouncement')
        }`)
        source=source.replace('}).catch(fail)', `}).catch(error=>{(globalThis as any).__privateJoinFailureForTest=error?.stack;fail()})`)
        return {loader:'ts',contents:source+`
          ;(globalThis as any).__privateMemberClassForTest=RoomSession
          ;(globalThis as any).__privateMemberFunctionsForTest={open:openOrdinaryPrivateMemberSessionFromBootstrapClaim,stop:stopOrdinaryPrivateMemberSession,close:closeOrdinaryPrivateMemberSession,drain:drainOrdinaryPrivateMemberSession,
            join:joinOrdinaryPrivateMemberSessionFromBootstrapClaim,takeJoined:takeOrdinaryPrivateMemberJoinedDecision,checkReceipt:checkOrdinaryPrivateMemberJoinedReceipt,
            hasDecision:(token:object)=>joinedDecisions.has(token)}
        `}
      })
      builder.onLoad({filter:/ordinary-private-member-controller\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8')
        const take='const binding = takeOrdinaryPrivateMemberControllerClaim(claim)'
        if(source.split(take).length!==2)throw Error('Private controller construction observer drift')
        source=source.replace(take,take+`;
          ;(globalThis as any).__privateControllerClaimForTest=claim
          ;((globalThis as any).__privateControllerOrder??=[]).push('controller')
          if((globalThis as any).privateControllerCut==='claim-consumed')window.dispatchEvent(new PageTransitionEvent('pagehide'))
        `)
        const put='controllers.set(resource, Object.assign(Object.create(null), {binding, session: undefined, renewal: undefined, preparing: undefined,\n    joining: undefined, joined: undefined, scheduleHint: undefined, dueAt: undefined, closed: false, closing: undefined}))'
        if(source.split(put).length!==2)throw Error('Private controller resource observer drift')
        source=source.replace(put,put+`;
          ;(globalThis as any).__privateControllerResourceForTest=resource
          ;(globalThis as any).__privateJoinControllerForTest=()=>{const v=controllers.get(resource)!;return{closed:v.closed,joining:!!v.joining,joined:!!v.joined,hint:v.scheduleHint??null,dueAt:v.dueAt??null}}
          ;(globalThis as any).__privateControllerPreparationForTest=()=>prepareOrdinaryPrivateMemberControllerRenewal(resource)
          ;(globalThis as any).__privateControllerBindingKeysForTest=()=>Reflect.ownKeys(binding)
          ;(globalThis as any).__privateControllerForTest=()=>{const value=controllers.get(resource)!;return{closed:value.closed,attached:!!value.session,
            frozen:Object.isFrozen(resource),keys:Reflect.ownKeys(resource).length,generationFrozen:Object.isFrozen(value.binding.generation),generationKeys:Reflect.ownKeys(value.binding.generation).length}}
          if((globalThis as any).privateControllerCut==='after-resource')window.dispatchEvent(new PageTransitionEvent('pagehide'))
        `)
        const attachment='const binding = takeOrdinaryPrivateMemberControllerSessionClaim(claim), value = owned(binding.controller)'
        if(source.split(attachment).length!==2)throw Error('Private controller attachment observer drift')
        source=source.replace(attachment,`const original=takeOrdinaryPrivateMemberControllerSessionClaim(claim)
          ;(globalThis as any).__privateControllerSessionClaimForTest=claim
          const fault=(globalThis as any).privateControllerAttachmentFault
          const binding=fault?Object.freeze({...original,[fault]:Object.freeze({})}):original,value=owned(binding.controller)
          if((globalThis as any).privateControllerCut==='attachment-consumed')window.dispatchEvent(new PageTransitionEvent('pagehide'))
        `)
        const attached='value.session = binding.session'
        if(source.split(attached).length!==2)throw Error('Private controller attached observer drift')
        source=source.replace(attached,attached+`;
          ;((globalThis as any).__privateControllerOrder??=[]).push('attached')
          if((globalThis as any).privateControllerCut==='after-attachment')window.dispatchEvent(new PageTransitionEvent('pagehide'))
        `)
        return{loader:'ts',contents:source+`
          ;(globalThis as any).__privateControllerFunctionsForTest={open:openOrdinaryPrivateMemberControllerFromBootstrapClaim,
            attach:attachOrdinaryPrivateMemberControllerSessionFromBootstrapClaim,schedule:scheduleOrdinaryPrivateMemberController,
            stop:stopOrdinaryPrivateMemberController,close:closeOrdinaryPrivateMemberController,
            captureJoined:captureOrdinaryPrivateMemberControllerRenewalJoined}
        `}
      })
      builder.onLoad({filter:/ordinary-relay-carrier\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8')
        source=source.replace('const binding = takeOrdinaryPrivateCarrierClaim(claim)', 'const binding = takeOrdinaryPrivateCarrierClaim(claim);(globalThis as any).__privateCarrierBindingKeysForTest=()=>Reflect.ownKeys(binding)')
        const marker='privateCarrierResources.set(resource, Object.freeze({state, completed, transport}))'
        if(source.split(marker).length!==2)throw Error('Private carrier resource observer drift')
        source=source.replace(marker,marker+`;
          ;(globalThis as any).__privateCarrierForTest=()=>({closed:state.#closed,private:!!state.#private,work:state.#work.size,pool:!!state.#pool,
            profile:state.#options.profile,authentication:state.#options.authentication??[],relays:state.#relays,facade:Reflect.ownKeys(transport),frozen:Object.isFrozen(transport),nullPrototype:Object.getPrototypeOf(transport)===null})
          ;(globalThis as any).__privateCarrierSeenResource=resource
        `)
        return {loader:'ts',contents:source+`
          ;(globalThis as any).__privateCarrierClassForTest=OrdinaryRelayCarrier
          ;(globalThis as any).__privateCarrierFunctionsForTest={open:openOrdinaryPrivateCarrierFromBootstrapClaim,completed:ordinaryPrivateCarrierCompleted,transport:ordinaryPrivateCarrierTransport,stop:stopOrdinaryPrivateCarrier,close:closeOrdinaryPrivateCarrier}
        `}
      })
      builder.onLoad({filter:/ordinary-prepared-renewal-capacity\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8')
        for(const [marker,stage] of [['    const sizes: [number, number] = [ordinaryImageByteLength','C'],['    if (settlement) {','S']] as const){
          if(source.split(marker).length!==2)throw Error('Native capacity stage observer drift')
          source=source.replace(marker,`    if((globalThis as any).privateCapacityExpected)(globalThis as any).privateCapacityStage='${stage}'\n`+marker)
        }
        return {loader:'ts',contents:source}
      })
      builder.onLoad({ filter: /ordinary-state-owner\.ts$/ }, async input => {
        let source = await readFile(input.path, 'utf8')
        const previewStart=source.indexOf('  static #preparePrivateSelectionPreview('),previewEnd=source.indexOf('  static #preparePrivateRenewalDue(',previewStart)
        if(previewStart<0||previewEnd<0)throw Error('Draft preview native region drift')
        let preview=source.slice(previewStart,previewEnd)
        const oncePreview=(a:string,b:string)=>{if(preview.split(a).length!==2)throw Error('Draft preview observer drift '+a);preview=preview.replace(a,b)}
        oncePreview('t = await openOrdinaryFrame(tr.frame, tr.key); check()',"t = await openOrdinaryFrame(tr.frame, tr.key); check();await (globalThis as any).__privateBootstrapPause('preview-tab');check()")
        oncePreview('cleanup(() => clearImage(b))','cleanup(() => {clearImage(b);(globalThis as any).__draftPreviewBrowserWiped=!!b&&b.records.size===0&&b.fences.size===0&&(!b.migration||(b.migration.sources.size===0&&b.migration.names.length===0));if((globalThis as any).__draftPreviewCleanupFault){(globalThis as any).__draftPreviewCleanupFault=false;throw Error("Explicit preview browser cleanup fault")}})')
        oncePreview('cleanup(() => clearImage(t))','cleanup(() => {clearImage(t);(globalThis as any).__draftPreviewTabWiped=!!t&&t.records.size===0&&t.fences.size===0&&(!t.migration||(t.migration.sources.size===0&&t.migration.names.length===0))})')
        source=source.slice(0,previewStart)+preview+source.slice(previewEnd)
        const previewWire='preparePrivateSelectionPreview = (root, kind) => this.#preparePrivateSelectionPreview(root, kind)'
        if(source.split(previewWire).length!==2)throw Error('Draft preview bridge drift')
        source=source.replace(previewWire,previewWire+`; (globalThis as any).__draftOwnerPreviewForTest=(root:OrdinaryPrivateExistingRoot,kind:OrdinaryPrivateMemberActionKind)=>this.#preparePrivateSelectionPreview(root,kind)
          ;(globalThis as any).__draftOwnerPreviewTakeForTest=(root:OrdinaryPrivateExistingRoot,receipt:OrdinaryPrivateSelectionPreviewReceipt,kind:OrdinaryPrivateMemberActionKind)=>{this.#takePrivateSelectionPreview(root,receipt,kind)}
          ;(globalThis as any).__draftPreviewTakeRootForTest=(globalThis as any).__draftOwnerPreviewTakeForTest
          ;(globalThis as any).__draftPreviewHasForTest=(receipt:OrdinaryPrivateSelectionPreviewReceipt)=>privateSelectionPreviews.has(receipt)
          ;(globalThis as any).__draftOwnDataForTest=privateSelectionOwnData
          ;(globalThis as any).__draftRelayDataForTest=(value:unknown)=>privateSelectionRelayData(value,16)
          ;(globalThis as any).__draftSameRelaysForTest=privateSelectionSameRelays
          ;(globalThis as any).__draftOwnerPreviewRevokeForTest=revokeOrdinaryPrivateSelectionPreview
          ;(globalThis as any).__draftPreviewRecordsForTest=(receipt:OrdinaryPrivateSelectionPreviewReceipt)=>{const work=privateSelectionPreviews.get(receipt)!;const slot=privateSelectionPreviewSlots.get(work.root)!;return{workNull:Object.getPrototypeOf(work)===null,slotNull:Object.getPrototypeOf(slot)===null,ownReceipt:Object.prototype.hasOwnProperty.call(work,'receipt'),ownWork:Object.prototype.hasOwnProperty.call(slot,'work')}}
          ;(globalThis as any).__draftOwnerPreviewAdvanceForTest=(root:OrdinaryPrivateExistingRoot)=>{const c=privateExistingCaptures.get(root)!;const g=c.credentialGeneration.current;c.credentialGeneration.current=Object.freeze({...g,serial:g.serial+1,identity:Object.freeze({}) as OrdinaryPrivateCredentialGeneration})}`)

        const readStart=source.indexOf('  static #readPrivateSettled('),readEnd=source.indexOf('  static #runPrivateRenewal(',readStart)
        if(readStart<0||readEnd<0)throw Error('Private S reader observer drift')
        let reader=source.slice(readStart,readEnd)
        reader=reader.replace('catch {setup = false; stopPrivateSettledRead(read)}','catch(error) {(globalThis as any).__liveReadSetupFailure=(error as Error)?.stack;setup = false; stopPrivateSettledRead(read)}').replace(
          '}, () => {read.finished = true; stopPrivateSettledRead(read); reject(new OrdinaryStateHold())}',
          '}, (error) => {(globalThis as any).__liveReadBodyFailure=(error as Error)?.stack;read.finished = true; stopPrivateSettledRead(read); reject(new OrdinaryStateHold())}')
        for(const[marker,stage]of [
          ["import('./ordinary-renewal-credential.js')]); check()",'modules'],
          ['await clients(); check()','clients'],
          ['check(); if (!db) hold()','database'],
          ['b = await openOrdinaryFrame(br.frame, br.key); check()','browser'],
          ['t = await openOrdinaryFrame(tr.frame, tr.key); check()','tab'],
          ['tab: {binding: binding(t), key: tr.key}}); check()','control'],
          ['ordinaryRenewalResultForIntent(intent, publicSeal, successor); check()','credential'],
          ['context.stop(); await context.ended; check()','terminal'],
        ] as const){
          if(!reader.includes(marker))throw Error('Private S reader cut drift '+stage)
          reader=reader.replace(marker,marker+`; await (globalThis as any).__privateBootstrapPause('settled-${stage}'); check()`)
        }
        const foreground='validateOrdinaryPrivateSettledReadForegroundDecision(value.foreground, value.native, decision); nativeCheck()'
        if(!reader.includes(foreground))throw Error('Private S foreground decision observer drift')
        reader=reader.replace(foreground,`;(globalThis as any).__liveReadDecisionForTest=decision
          const restore=(globalThis as any).__enterPrivateRenewalDecision()
          try{${foreground}}finally{restore()}`)
        const publication='const token = Object.freeze(Object.create(null)) as OrdinaryPrivateRenewalAdoptionPreparation'
        if(!reader.includes(publication))throw Error('Private S token publication observer drift')
        reader=reader.replace(publication,`;(globalThis as any).liveReadBeforeToken?.(); `+publication)
        source=source.slice(0,readStart)+reader+source.slice(readEnd)
        source = `import * as ControllerGraphForTest from './ordinary-protocol-work.js'\nimport * as ControllerRenewalForTest from './ordinary-private-renewal.js'\n` + source
        source=source.replace('const claim = await value.prepare()', `await (globalThis as any).__privateBootstrapPause('controller-before-factory')
          const claim = await value.prepare()
          await (globalThis as any).__privateBootstrapPause('controller-before-factory-open')`).replace('value.factory = factory', `value.factory = factory
          await (globalThis as any).__privateBootstrapPause('controller-after-factory')`)
        source=source.replace('}).catch(() => {\n      if (createdWitness)', '}).catch((error) => { (globalThis as any).__privateIntentFailureForTest=error?.stack;\n      if (createdWitness)')
        const reservation='privateControllerRenewalsByRoot.set(member.capture.root, resource)\n    try {'
        if(source.split(reservation).length!==2)throw Error('Root reservation observer drift')
        source=source.replace(reservation,`privateControllerRenewalsByRoot.set(member.capture.root, resource)
          ;(globalThis as any).__privateRootIndexProbe=()=>({indexed:privateControllerRenewalsByRoot.get(member.capture.root)===resource,
            any:privateControllerRenewalsByRoot.has(member.capture.root),replacement:!!(globalThis as any).__privateRootIndexReplacement&&privateControllerRenewalsByRoot.get(member.capture.root)===(globalThis as any).__privateRootIndexReplacement,
            controllerClaimed:member.controller.claimed,generationClaimed:generation.renewal.claimed,
            takes:(globalThis as any).__privateRootIndexTakes??0,claimPresent:(globalThis as any).__privateRootIndexClaimPresent(claim),
            retained:!!privateControllerRenewals.get(resource)?.release,closed:privateControllerRenewals.get(resource)?.closed??null,
            ownerResources:[member.capture.browser.#resources.size,member.capture.tab.#resources.size]})
          ;(globalThis as any).__privateRootIndexDuplicate=()=>{const fixture=globalThis as any,before=fixture.__privateRootIndexProbe();let refused=false;
            try{OrdinaryStateOwner.#bindPrivateControllerRenewal(native,foreground,generation,claim,read,scopes)}catch{refused=true}
            return{refused,before,after:fixture.__privateRootIndexProbe()}}
          ;(globalThis as any).__privateRootIndexOldStop=()=>stopOrdinaryPrivateControllerRenewal(resource)
    try {`)
        const take='const binding = graphModule.takeOrdinaryPrivateMemberControllerRenewalClaim(claim)'
        if(source.split(take).length!==2)throw Error('Root reservation tuple fault drift')
        source=source.replace(take,`const originalBinding=graphModule.takeOrdinaryPrivateMemberControllerRenewalClaim(claim)
          const binding=(globalThis as any).__privateRootIndexFault==='tuple'
            ?Object.freeze({...originalBinding,generation:Object.freeze({})}):originalBinding`)
        const call='return OrdinaryStateOwner.#bindPrivateControllerRenewal(native, foreground, generation, claim, activeRead, scopes)'
        if(source.split(call).length!==2)throw Error('Root reservation rejection retry drift')
        source=source.replace(call,`if((globalThis as any).__privateRootIndexFault==='take-rejection-retry'){
            const fixture=globalThis as any;let refused=false;
            try{OrdinaryStateOwner.#bindPrivateControllerRenewal(native,foreground,generation,Object.freeze({}) as OrdinaryPrivateMemberControllerRenewalClaim,activeRead,scopes)}catch{refused=true}
            fixture.__privateRootIndexRejectedTake={refused,state:fixture.__privateRootIndexProbe()}
          }
          `+call)
        const producerEnd='graphModule.checkOrdinaryPrivateMemberGraphReceipt(binding.receipt)\n      if (privateControllerRenewalsByRoot.get(member.capture.root) !== resource) hold()\n      return resource'
        if(source.split(producerEnd).length!==2)throw Error('Private producer graph observation drift')
        source=source.replace(producerEnd,`if((globalThis as any).__privateRootIndexFault==='after-retention'||(globalThis as any).__privateRootIndexFault==='replacement'){
            if((globalThis as any).__privateRootIndexFault==='replacement'){
              const sentinel=Object.freeze({});(globalThis as any).__privateRootIndexReplacement=sentinel;
              privateControllerRenewalsByRoot.set(member.capture.root,sentinel as OrdinaryPrivateControllerRenewal)
            }
            throw Error('Explicit post-retention reservation fault')
          }
          graphModule.checkOrdinaryPrivateMemberGraphReceipt(binding.receipt)
      if (privateControllerRenewalsByRoot.get(member.capture.root) !== resource) hold()
          ;(globalThis as any).__privateControllerRenewalForTest={
            factory:()=>value.factory,resource:()=>resource,
            state:()=>({closed:value.closed,prepared:!!value.factory,claimed:generation.renewal.claimed,bootstrap:member.bootstrap.claimed,standalone:member.renewal.claimed}),
            indexed:()=>privateControllerRenewalsByRoot.get(member.capture.root)===resource,
            due:()=>prepareOrdinaryPrivateRenewalDue(member.capture.root),
            foreignDue:(root:any)=>prepareOrdinaryPrivateRenewalDue(root),
            drift:(kind:string)=>{
              const capture=member.capture,oldGeneration=capture.credentialGeneration.current,oldIndex=privateControllerRenewalsByRoot.get(capture.root),factory=value.factory!,f=privateRenewalFactories.get(factory)!,oldStarted=f.operationStarted;
              if(kind==='generation')capture.credentialGeneration.current=Object.freeze({...oldGeneration,serial:oldGeneration.serial+1})
              else if(kind==='index')privateControllerRenewalsByRoot.delete(capture.root)
              else if(kind==='factory-started')f.operationStarted=true
              else throw Error('Unknown privileged due drift')
              return()=>{capture.credentialGeneration.current=oldGeneration;if(oldIndex)privateControllerRenewalsByRoot.set(capture.root,oldIndex);f.operationStarted=oldStarted}
            },
            stopProducer:()=>stopOrdinaryPrivateControllerRenewal(resource),
            dueCleanupErrors:()=>[member.capture.browser.#cleanupFailure,member.capture.tab.#cleanupFailure].map(v=>v?.error instanceof Error?v.error.message:null),
            dueState:(receipt?:any)=>{const slot=privateRenewalDueSlots.get(member.capture.root),work=slot?.work;
              return{revision:slot?.revision??null,work:!!work,pending:work?.pending??null,receipt:!!receipt&&privateRenewalDueReceipts.has(receipt),
                resources:[member.capture.browser.#resources.size,member.capture.tab.#resources.size],
                factoryStarted:value.factory?privateRenewalFactories.get(value.factory)?.operationStarted??null:null}},
            joined:(selected:any=resource,bootstrap:any=binding.bootstrap)=>graphModule.captureOrdinaryPrivateBootstrapRenewalJoined(bootstrap,selected),
            prepare:()=>prepareOrdinaryPrivateControllerRenewal(resource),
            read:(settled:any,selected:any=resource)=>readOrdinaryPrivateControllerRenewalSettled(selected,settled),
            discard:discardOrdinaryPrivateRenewalAdoptionPreparation,
            foregroundRead:(token:any)=>validateOrdinaryPrivateSettledReadForegroundDecision(foreground,native,token),
            readState:()=>({closed:value.settledRead?.closed??null,finished:value.settledRead?.finished??null,
              material:!!value.settledRead?.images,token:!!value.settledRead?.token,
              initialGenerationUnchanged:member.credentialGeneration.current===generation}),
            start:(body:any)=>ControllerGraphForTest.startOrdinaryProtocolLifecycle(binding.control,body),
            suspend:(root:any)=>ControllerGraphForTest.suspendOrdinaryProtocolLifecycle(binding.control,root),
            resume:(root:any)=>ControllerGraphForTest.resumeOrdinaryProtocolLifecycle(binding.control,root),
            verify:(root:any)=>ControllerGraphForTest.verifyOrdinaryProtocolLifecycle(binding.control,root),
            obligation:(root:any,desired:any)=>ControllerRenewalForTest.prepareOrdinaryPrivateRenewalObligation(value.factory!,root,desired),
            check:()=>graphModule.checkOrdinaryPrivateMemberGraphReceipt(binding.receipt),
            release:()=>value.release,
          }
          return resource`)

        const dueStart=source.indexOf('  static #preparePrivateRenewalDue('),dueEnd=source.indexOf('  /** Owner-only action consumer.',dueStart)
        if(dueStart<0||dueEnd<dueStart)throw Error('Due notice reader observer scope drift')
        let due=source.slice(dueStart,dueEnd)
        const beforeLock='await navigator.locks.request(WRITE_LOCK, async () => {'
        if(due.split(beforeLock).length!==2)throw Error('Due notice pause drift')
        due=due.replace(beforeLock,`await (globalThis as any).__privateBootstrapPause('due-before-db');check(); `+beforeLock)
        const foregroundTry='try {\n                    OrdinaryStateOwner.#validatePrivateRenewalRead(producer.member, scopes, bv.store, tv.store, custody)'
        if(due.split(foregroundTry).length!==2)throw Error('Due notice foreground D observer drift')
        due=due.replace(foregroundTry,'const restoreDue=(globalThis as any).__enterPrivateRenewalDecision(); '+foregroundTry)
        const foregroundEnd='} finally {pairCustody.delete(custody)}'
        if(due.split(foregroundEnd).length!==2)throw Error('Due notice foreground cleanup drift')
        due=due.replace(foregroundEnd,'} finally {try{restoreDue()}finally{pairCustody.delete(custody)}}')

        for(const[marker,stage]of[
          ['check(); const br = row(raw[0]), tr = row(raw[1])','rows'],
          ['b = await openOrdinaryFrame(br.frame, br.key); check()','browser'],
          ['t = await openOrdinaryFrame(tr.frame, tr.key); check()','tab'],
          ['check(); await clients(); check()','after-transaction'],
        ]as const){if(due.split(marker).length!==2)throw Error('Due native cut observer drift '+stage);due=due.replace(marker,marker+`;await (globalThis as any).__privateBootstrapPause('due-${stage}');check()`)}

        const errorMarker='    let cleanupError: {readonly error: unknown} | undefined'
        if(due.split(errorMarker).length!==2)throw Error('Due cleanup observation drift')
        due=due.replace(errorMarker,`    const dueCleanupFault=(name:string)=>{const f=(globalThis as any).__dueCleanupFault;if(!f?.armed)return;f.visited.push(name);if(f.faults.includes(name))throw Error('Explicit due cleanup fault:'+name)}
`+errorMarker)
        for(const[from,to]of[
          ['cleanup(() => context?.abort())',"cleanup(() => {context?.abort();dueCleanupFault('abort')})"],
          ['cleanup(() => { if (work.receipt) privateRenewalDueReceipts.delete(work.receipt) })',"cleanup(() => {if(work.receipt)privateRenewalDueReceipts.delete(work.receipt);dueCleanupFault('receipt')})"],
          ['cleanup(() => { if (slot.work === work) slot.work = undefined })',"cleanup(() => {if(slot.work===work)slot.work=undefined;dueCleanupFault('slot')})"],
          ['cleanup(() => browser.#resources.delete(work.cancel))',"cleanup(() => {browser.#resources.delete(work.cancel);dueCleanupFault('browser')})"],
          ['cleanup(() => tab.#resources.delete(work.cancel))',"cleanup(() => {tab.#resources.delete(work.cancel);dueCleanupFault('tab')})"],
        ]){if(due.split(from).length!==2)throw Error('Due cleanup edge drift '+from);due=due.replace(from,to)}

        const dueReturn='return privateSelectionFreeze(privateSelectionAssign(privateSelectionCreate(null), {display, dueAt: work.dueAt, receipt})) as OrdinaryPrivateRenewalDuePreview'
        if(due.split(dueReturn).length!==2)throw Error('Due publication tail observer drift')
        due=due.replace(dueReturn,";(globalThis as any).__dueLateThen?.();\n          "+dueReturn)

        const dueTransaction="context = operationTransaction(db, 'readonly')"
        if(due.split(dueTransaction).length!==2)throw Error('Due native abort transaction observer drift')
        due=due.replace(dueTransaction,dueTransaction+`; {
          const probe={tx:context.tx,complete:false,aborted:false,calls:0}
          ;(globalThis as any).__dueNativeAbortProbe=probe
          context.tx.addEventListener('complete',()=>{probe.complete=true})
          context.tx.addEventListener('abort',()=>{probe.aborted=true})
        }`)
        source=source.slice(0,dueStart)+due+source.slice(dueEnd)

        for(const args of ['facts,selected','inverse,facts,selected']){
          const begin='await context.step(()=>{check();const value=work(j!,[br,tr],[b!,t!],'+args+')'
          const at=source.indexOf(begin)
          if(at<0)throw Error('Cold recovery native decision fixture drift')
          const end=source.indexOf('result=value})',at)
          if(end<0)throw Error('Cold recovery native postcheck fixture drift')
          source=source.slice(0,at)+source.slice(at,end).replace(begin,'await context.step(()=>{const restore=(globalThis as any).__enterPrivateRenewalDecision();try{if(mode===\'readwrite\'&&\''+args+'\'===\'facts,selected\')(globalThis as any).__privateRenewalWritePhase=\'settled\';check();const value=work(j!,[br,tr],[b!,t!],'+args+')')+'result=value}finally{restore()}})'+source.slice(end+'result=value})'.length)
        }
        source=source.replace("if(stage==='prepare'){check();attempted=true;","if(stage==='prepare'){(globalThis as any).__privateRenewalWritePhase='candidate-prepared';check();attempted=true;").replace("else{const br={key:rows[0].key,frame:validateOrdinaryFrame(frames[0])},tr={key:rows[1].key,frame:validateOrdinaryFrame(frames[1])}","else{(globalThis as any).__privateRenewalWritePhase='candidate-committed';const br={key:rows[0].key,frame:validateOrdinaryFrame(frames[0])},tr={key:rows[1].key,frame:validateOrdinaryFrame(frames[1])}")
        for (const marker of [
          'this.#db = undefined\n    if (this.#cleanupFailure) throw this.#cleanupFailure.error',
          'beginPrivateExistingProvider = (root, command) => this.#beginPrivateExistingProvider(root, command)',
          'await context.step(() => {\n                check(); if (controlMode',
          'start?.(); check(); if (controlMode && (!sdkCurrent || !sdkCurrent())) hold()\n              })',
        ]) if (source.split(marker).length !== 2) throw Error('Provider command parent observer drift: ' + marker)
        for(const [marker,stage] of [["const module = await import('./ordinary-persistent-bootstrap.js'); check()",'after-import'],['await clients()\n        await read(live, () => {','before-claim']] as const){
          if(source.split(marker).length!==2)throw Error('Private bootstrap owner pause drift '+stage)
          source=source.replace(marker,marker+`\n${stage==='before-claim'?'':`await (globalThis as any).__privateBootstrapPause('${stage}');check()`}`)
        }
        const before="check()\n        const module = await import('./ordinary-persistent-bootstrap.js')"
        if(source.split(before).length!==2)throw Error('Private bootstrap preimport observer drift')
        source=source.replace(before,"check();await (globalThis as any).__privateBootstrapPause('before-import');check()\n        const module = await import('./ordinary-persistent-bootstrap.js')")
        const bootstrapLatch='member.bootstrap.claimed = true'
        if(source.split(bootstrapLatch).length!==2)throw Error('Private bootstrap latch observer drift')
        source=source.replace(bootstrapLatch,bootstrapLatch+`; (globalThis as any).__privateBootstrapLatchForTest=()=>Object.freeze({bootstrap:member.bootstrap.claimed,renewal:member.renewal.claimed}); (globalThis as any).__privateMemberCloseOwnerForTest=(which:string)=>{const owner=which==='browser'?member.capture.browser:member.capture.tab;return owner.#close()}`)
        const beforeClaim='await clients()\n        await read(live, () => {'
        source=source.replace(beforeClaim,"await clients();await (globalThis as any).__privateBootstrapPause('before-claim');check()\n        await read(live, () => {")
        const resource='const resource = module.openOrdinaryPrivateBootstrapFromOwnerClaim(claim)'
        if(source.split(resource).length!==2)throw Error('Private bootstrap assignment observer drift')
        source=source.replace(resource,resource+`; if((globalThis as any).privateBootstrapCut==='after-resource')window.dispatchEvent(new PageTransitionEvent('pagehide'))`)
        const decision='try {const answer = work(b, t, c); validate(b, t, c); return answer} finally {activeRead = undefined}'
        if(source.split(decision).length!==2)throw Error('Private bootstrap read observer drift')
        source=source.replace(decision,`try {const f=(globalThis as any),n=(f.privateBootstrapReadCount=(f.privateBootstrapReadCount??0)+1);const answer=work(b,t,c);if(f.privateBootstrapReadCut===n)window.dispatchEvent(new PageTransitionEvent('pagehide'));validate(b,t,c);return answer} finally {activeRead = undefined}`)
        const floor='expire(); nativeCheck()'
        if(source.split(floor).length!==2)throw Error('Private credential-generation floor observer drift')
        source=source.replace(floor,floor+`;
          // Identity invalidation only: this fixture does not implement or
          // prove authorised adoption or extension of a credential deadline.
          ;(globalThis as any).__privateAdvanceCredentialGenerationForTest=()=>{
            const current=captured.credentialGeneration.current
            captured.credentialGeneration.current=Object.freeze({...current,serial:current.serial+1,renewal:{claimed:false}})
          }
          ;(globalThis as any).__privateGenerationFloorForTest=()=>{
            const current=captured.credentialGeneration.current
            return {serial:current.serial,stopped,deadline:current.selection.credentialExpiresAt,
              frozen:Object.isFrozen(current)&&Object.isFrozen(current.selection)&&Object.isFrozen(current.rows)&&Object.isFrozen(current.revisions)&&Object.isFrozen(current.ownerGenerations),
              source:current.classification===captured.classification,rows:current.rows.every((v,i)=>v===captured.rows[i]),
              predecessor:current.predecessor,operation:current.operation===captured.selection.memberLeaseOperation||current.operation===captured.selection.proofOperation,
              reserved:current.renewal.claimed}
          }
          ;(globalThis as any).__privateInitialFloorTimerForTest=expire
        `)
        {
          const begin=source.indexOf('  static #beginPrivateExistingProvider('), end=source.indexOf('  static #authenticatePrivateExistingProvider(',begin)
          if(begin<0||end<0)throw Error('Provider command constructor scope drift')
          let part=source.slice(begin,end)
          const once=(marker:string,replacement:string)=>{if(part.split(marker).length!==2)throw Error('Provider command native observer drift: '+marker);part=part.replace(marker,replacement)}
          once('claimOrdinaryPrivateExistingProviderCommand(root, command)', `claimOrdinaryPrivateExistingProviderCommand(root, command)
            const commandFixture=(globalThis as any).privateProviderCommandFixture
            if(commandFixture?.replay) {try{claimOrdinaryPrivateExistingProviderCommand(root,command)}catch{commandFixture.replayRefused=true}}`)
          once('queued = Promise.resolve().then(async () => {', `queued = Promise.resolve().then(async () => {
            ;(globalThis as any).__privateProviderSetupProbe('operation-entered')`)
          once('controlWork.add(pending); browser.#track(pending); tab.#track(pending)', `controlWork.add(pending)
            if(pending===command)(globalThis as any).__privateProviderSetupProbe('command-set')
            browser.#track(pending)
            if(pending===command)(globalThis as any).__privateProviderSetupProbe('command-browser')
            tab.#track(pending)
            if(pending===command)(globalThis as any).__privateProviderSetupProbe('command-tab')`)
          for(const [marker,stage] of [
            ['trackControl(command)','command-retained'],['browser.#track(operation)','operation-browser'],['tab.#track(operation)','operation-tab'],
            ['captured.consumed = true','capture-consumed'],['browser.#resources.add(cancel)','cancel-browser'],['tab.#resources.add(cancel)','cancel-tab'],
            ['void queued.catch(() => {})','queue-published'],['browser.#track(queued)','queue-browser'],['tab.#track(queued)','queue-tab'],
            ['void queued.then(resolveOperation, rejectOperation).catch(() => {})','completion-linked'],
          ])once(marker,marker+`; (globalThis as any).__privateProviderSetupProbe('${stage}')`)
          once('    // Construct the complete stop/close resource before consuming capture or', `
            ;(globalThis as any).__privateProviderCloseForTest=()=>resource.close()
            ;(globalThis as any).__privateInstallNativeStopFaultForTest=()=>{
              const f=(globalThis as any).privateProviderCommandFixture
              if(!f||f.nativeProbeInstalled)return;f.nativeProbeInstalled=true
              for(const [name,owner]of [['browser',browser],['tab',tab]]as const){
                owner.#resources.add({stop:()=>{(f.nativeStops??=[]).push(name+'-throw');throw Error('Explicit '+name+' native resource stop failure')}})
                owner.#resources.add({stop:()=>{(f.nativeStops??=[]).push(name+'-later')}})
              }
            }
            // Construct the complete stop/close resource before consuming capture or`)
          once('const resource = Object.freeze({ completed: operation, stop, close: () => {', `
            const fixtureForCompleted=(globalThis as any).privateProviderCommandFixture
            if(fixtureForCompleted)void operation.then(()=>{fixtureForCompleted.completedState='fulfilled'},error=>{fixtureForCompleted.completedState='rejected';fixtureForCompleted.completedError=error?.message})
            const resource = Object.freeze({ completed: operation, stop, close: () => {`)
          once('if (closing) return closing', `if (closing) return closing
            const f=(globalThis as any).privateProviderCommandFixture;if(f)f.providerCloseStarts=(f.providerCloseStarts??0)+1`)
          // Name each actual cleanup role so adding a new lifetime cannot
          // silently move an old fault to a different cleanup operation.
          once('const stopOne = (work: () => void) => {','const stopOne = (work: () => void, stage: string) => {')
          for(const [marker,stage]of [
            ['stopOne(() => revokePrivateTrustedMember(root))','trusted-member'],
            ['stopOne(() => { if (expiryTimer !== undefined) clearTimeout(expiryTimer) })','expiry'],
            ['stopOne(() => context?.abort())','native-context'],
            ['stopOne(() => {\n        if (retainedProvider?.bootstrap) retainedProvider.bootstrapModule!.stopOrdinaryPrivateBootstrap(retainedProvider.bootstrap)\n      })','bootstrap'],
            ['stopOne(() => retainedProvider?.foreground?.stop())','foreground'],
            ['stopOne(() => binding.revoke())','root'],
            ['stopOne(() => browser.#revoke())','browser-owner'],['stopOne(() => tab.#revoke())','tab-owner'],
          ])once(marker,marker.slice(0,-1)+`, '${stage}')`)
          once('try { work() } catch (error) { stopFailure ??= { error } }', `try {
            const f=(globalThis as any).privateProviderCommandFixture
            if(f){f.providerStopAttempts=(f.providerStopAttempts??0)+1;(f.providerStopActions??=[]).push(stage);if(f.throwProviderStopAction===stage)throw Error('Explicit provider stop action failure')}
            work()
          } catch (error) { stopFailure ??= { error } }`)
          once("tab.#resources.add(cancel); (globalThis as any).__privateProviderSetupProbe('cancel-tab')", `tab.#resources.add(cancel); (globalThis as any).__privateProviderSetupProbe('cancel-tab')
            const nativeFixture=(globalThis as any).privateProviderCommandFixture
            if(nativeFixture?.throwNativeStops)(globalThis as any).__privateInstallNativeStopFaultForTest()`)
          source=source.slice(0,begin)+part+source.slice(end)
          const captureBegin=source.indexOf('  static #beginPrivateExistingCapture('),captureEnd=source.indexOf('  static #beginPrivateExistingProvider(',captureBegin)
          if(captureBegin<0||captureEnd<0)throw Error('Provider command capture scope drift')
          let capture=source.slice(captureBegin,captureEnd)
          const closing='if (closing) return closing'
          if(capture.split(closing).length!==2)throw Error('Provider command capture close counter drift')
          capture=capture.replace(closing,closing+`; const f=(globalThis as any).privateProviderCommandFixture;if(f)f.captureCloseStarts=(f.captureCloseStarts??0)+1`)
          const captureDelivery='joinOrdinaryClose(() => tab ? tab.#close() : undefined)]).then(results => {'
          if(capture.split(captureDelivery).length!==2)throw Error('Provider command capture close delivery drift')
          capture=capture.replace(captureDelivery,`joinOrdinaryClose(() => tab ? tab.#close() : undefined)]).then(async results => {
            const f=(globalThis as any).privateProviderCommandFixture
            if(f?.captureCloseGate){f.captureCloseEntered=true;await new Promise<void>(yes=>{f.captureCloseRelease=yes});f.captureCloseTerminal=true;if(f.captureCloseReject){reject(Error('Explicit capture close delivery failure'));return}}
          `)
          source=source.slice(0,captureBegin)+capture+source.slice(captureEnd)
        }
        const revoker='  privateTrustedMembers.delete(root)\n  privateTrustedProviders.delete(root)\n  privateTrustedUnlocks.get(root)?.cancel.stop()'
        if(source.split(revoker).length!==2)throw Error('Trusted member revoker cancellation observer drift')
        // Labelled lexical fault after real mandatory map deletion AND the
        // actual pending command cancellation; never a pre-work stop bypass.
        source=source.replace(revoker,`  const f=(globalThis as any).privateProviderCommandFixture
          const selected=f?.throwTrustedMemberRevocation&&!f.trustedMemberRevokerFaultUsed
          if(selected)f.trustedRevocationBefore={member:privateTrustedMembers.has(root),provider:privateTrustedProviders.has(root),pending:privateTrustedUnlocks.has(root)}
          privateTrustedMembers.delete(root)
          privateTrustedProviders.delete(root)
          const pending=privateTrustedUnlocks.get(root)
          pending?.cancel.stop()
          if(selected){f.trustedMemberRevokerFaultUsed=true;f.trustedRevocationAfter={member:privateTrustedMembers.has(root),provider:privateTrustedProviders.has(root),pendingStopped:pending?.stopped===true};throw Error('Explicit trusted member revoker cancellation failure')}
        `)
        const earlyCapacity='  const size = (delta: 1|2|3): readonly [number,number] => {'
        if(source.split(earlyCapacity).length!==2)throw Error('Native intent capacity observer drift')
        source=source.replace(earlyCapacity,earlyCapacity+`
    if((globalThis as any).privateCapacityExpected)(globalThis as any).privateCapacityStage=delta===1?'E':delta===2?'C':'S'`)
        const lateSeal='const seal = fixedCrypto(slots, [rows[0].key, rows[1].key], custodyOnly)'
        if(source.split(lateSeal).length!==2)throw Error('Private late sealer fault fixture drift')
        source=source.replace(lateSeal,lateSeal+`
          // Deliberate misuse of the actual closed fixed sealer. No key or
          // nonce escapes this fixture-instrumented owner function.
          const observation=(globalThis as any), fault=journal.phase==='candidate-committed'?observation.privateLateSealFault:undefined
          if(fault&&!observation.privateLateSealFaultUsed){
            const encrypt=seal.provider.subtle.encrypt.bind(seal.provider.subtle)
            if(fault==='reordered'){
              observation.privateLateSealFaultUsed=true
              await encrypt({name:'AES-GCM',iv:new Uint8Array(12),tagLength:128},rows[0].key,new Uint8Array())
            }else seal.provider.subtle.encrypt=((algorithm,key,bytes)=>{
              if(!observation.privateLateSealFaultUsed){
                observation.privateLateSealFaultUsed=true
                if(fault==='wrong-key')key=rows[1].key
                if(fault==='wrong-algorithm')algorithm={...(algorithm as AesGcmParams),name:'AES-CTR'}
                if(fault==='wrong-tag')algorithm={...(algorithm as AesGcmParams),tagLength:96}
              }
              return encrypt(algorithm,key,bytes)
            }) as SubtleCrypto['encrypt']
          }
        `)
        const sdkStart='sdk = createPinnedNip07SignerWithDiscoveryBoundary(boundary)'
        if(source.split(sdkStart).length!==2)throw Error('Trusted SDK outcome observation drift')
        source=source.replace(sdkStart,sdkStart+`; void sdk.then(()=>{(globalThis as any).__trustedSdkOutcomeForTest='fulfilled'},()=>{(globalThis as any).__trustedSdkOutcomeForTest='rejected'})`)
        const marker = 'raw = await sdk; check()'
        if (source.split(marker).length !== 2) throw Error('Private provider SDK close fixture drift')
        // Wrap only this checkpoint's already-created actual SDK signer. Its
        // real close still runs; explicit fault fixtures delay/reject its join.
        return { loader: 'ts', contents: source.replace(marker, `raw = await sdk;
          const fixture = (globalThis as any).providerFixture
          if (fixture?.closeMode) {
            const actual = raw
            // A mutable owned observation shell avoids violating Proxy
            // invariants of the actual SDK's newly frozen own methods.
            const descriptors = Object.getOwnPropertyDescriptors(actual)
            for (const descriptor of Object.values(descriptors)) { descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true }
            raw = Object.create(Object.getPrototypeOf(actual), descriptors)
            Object.defineProperty(raw, 'close', { configurable: true, writable: true, value: async () => {
              fixture.closeCalls = (fixture.closeCalls ?? 0) + 1
              await actual.close()
              if (fixture.closeMode === 'pending') await new Promise<void>(yes => { fixture.closeRelease = yes })
              fixture.closeTerminal = true
              if (fixture.closeMode === 'reject' || fixture.closeReject) throw Error('Explicit SDK close fixture rejection')
            } })
            if (fixture.sdkDoubleStart?.family === 'sign') {
              const sign = actual.signEvent
              raw.signEvent = async (template, boundary) => {
                const result = await Reflect.apply(sign, actual, [template, boundary])
                if (template.kind !== 21236) {
                  if (fixture.sdkDoubleStart.timing === 'microtask') await Promise.resolve()
                  await boundary!.start(() => { fixture.duplicateCallbacks = (fixture.duplicateCallbacks ?? 0) + 1; return actual.signEvent(template) })
                }
                return result
              }
            }
            if (fixture.sdkDoubleStart?.family === 'crypto') {
              const family = actual.nip44!
              raw.nip44 = Object.freeze({ ...family, encrypt: async (peer, text, boundary) => {
                const result = await family.encrypt(peer, text, boundary)
                if (fixture.sdkDoubleStart.timing === 'microtask') await Promise.resolve()
                await boundary!.start(() => { fixture.duplicateCallbacks = (fixture.duplicateCallbacks ?? 0) + 1; return family.encrypt(peer, text) })
                return result
              } })
            }
          }
          if (fixture) fixture.sdk = raw
          check()`).replace(
          'const result = work(browserView.store, tabView.store,\n              Object.freeze([...first.migration.names]), Object.freeze([...second.migration.names]), custody)',
          `const result = (() => {
            const previous=(globalThis as any).__controlDecision, foreground=(globalThis as any).__foregroundDecision
            ;(globalThis as any).__controlDecision=true;(globalThis as any).__foregroundDecision=true
            try {return work(browserView.store,tabView.store,Object.freeze([...first.migration.names]),Object.freeze([...second.migration.names]),custody)}
            finally {(globalThis as any).__controlDecision=previous;(globalThis as any).__foregroundDecision=foreground}
          })()`).replace(
          'check(); OrdinaryStateOwner.#validatePrivateRenewalRead(value.member, value.scopes, bv!.store, tv!.store, custody!)',
          'const restore = (globalThis as any).__enterPrivateRenewalDecision(); try { check(); OrdinaryStateOwner.#validatePrivateRenewalRead(value.member, value.scopes, bv!.store, tv!.store, custody!)').replace(
          'OrdinaryStateOwner.#validatePrivateRenewalRead(value.member, value.scopes, bv!.store, tv!.store, custody!); check()\n          })',
          'OrdinaryStateOwner.#validatePrivateRenewalRead(value.member, value.scopes, bv!.store, tv!.store, custody!); check() } finally { restore() }\n          })').replace(
          'inDecision = true\n            try {',
          'inDecision = true\n            const restore = (globalThis as any).__enterPrivateRenewalDecision()\n            try {').replace(
          'finally { inDecision = false; if (decision) privateRenewalDecisions.delete(decision) }',
          'finally { inDecision = false; if (decision) privateRenewalDecisions.delete(decision); restore() }').replace(
          'phaseCheck(custodyOnly); attempted = true',
          'phaseCheck(custodyOnly); (globalThis as any).__privateRenewalWritePhase=journal.phase; attempted = true').replace(
          "check(); attempted = true\n              op.context!.store.put",
          "check(); (globalThis as any).__privateRenewalWritePhase='prepared'; attempted = true\n              op.context!.store.put").replace(
          'cell.canonical = credential.ordinaryRenewalResultForStatement',
          '(globalThis as any).__privateRenewalCaptures=((globalThis as any).__privateRenewalCaptures??0)+1; cell.canonical = credential.ordinaryRenewalResultForStatement').replace(
          'browser.#operationControlDigests = new Map(facts.controls)\n          bv = view',
          '(globalThis as any).__privateRenewalPriorNonces=[...priorNonces]; browser.#operationControlDigests = new Map(facts.controls)\n          bv = view').replace(
          'result = work(j!, [br, tr], [b!, t!]); nativeCheck()',
          `result = work(j!, [br, tr], [b!, t!]); nativeCheck()
           const fault=(globalThis as any).privateRenewalCompletionAckFault
           if(custodyOnly&&op.completion?.state==='captured'&&fault&&!fault.used){
             fault.used=true;const tx=context!.tx,abort=tx.onabort!
             tx.oncomplete=()=>{fault.entered=true;fault.release=()=>abort.call(tx,new Event('abort'))}
           }`).replace(
          'retainOrdinaryPrivateRenewalForeground(attempt); check()',
          `if((globalThis as any).privateRenewalRetainFailure==='before')throw new OrdinaryStateHold()
           retainOrdinaryPrivateRenewalForeground(attempt)
           if((globalThis as any).privateRenewalRetainFailure==='after')throw new OrdinaryStateHold()
           check()`).replace(
          'cell.raw = undefined; cell.captured = undefined; cell.binding = undefined; cell.provider = undefined',
          `cell.raw = undefined; cell.captured = undefined; cell.binding = undefined; cell.provider = undefined
           ;(globalThis as any).__privateRenewalAfterSdkFinish={provider:!!cell.provider,raw:cell.raw!==undefined,captured:!!cell.captured,binding:!!cell.binding,canonical:!!cell.canonical,digest:!!cell.digest}`).replace(
          'const resource = {stop: () => { op.revoked = true; if (!op.custodyOnly) { op.context?.abort(); op.revokeWait?.() } }}',
          `;(globalThis as any).__privateRenewalResourceForTest = () => ({disposed:op.disposed, revoked:op.revoked, tails:op.tails.size, tokens:op.tokens.size, state:op.completion?.state??op.terminal,holding:!!browser.#retry,resources:privateRenewalOwnerResources.get(browser)?.size??0,material:{provider:!!op.completion?.provider,raw:op.completion?.raw!==undefined,captured:!!op.completion?.captured,request:!!op.request,statement:!!op.statement,canonical:!!op.completion?.canonical,digest:!!op.completion?.digest,secret:!!op.secret,nonces:!!op.nonces}})
           ;(globalThis as any).__privateRenewalRetryForTest = () => {browser.#retry?.();tab.#retry?.()}
           ;(globalThis as any).__privateRenewalCorruptCapturedForTest = (field:string) => {
             const cell=op.completion!
             if(field==='canonical')cell.canonical=cell.canonical!+' '
             else if(field==='digest')cell.digest='0'.repeat(64)
             else if(field==='binding')cell.binding=Object.freeze({...cell.binding!,request:cell.binding!.request+' '})
           }
           ;(globalThis as any).__privateRenewalDiskForTest = async () => {
             const db = await browser.#existingStartupDatabase(()=>true,true)
             if (!db) throw Error('No actual private renewal database')
             const context=operationTransaction(db,'readonly'),purpose=tab.purpose,names=ordinaryOperationNames(purpose)
             let b:OrdinaryImage|undefined,t:OrdinaryImage|undefined,j:OrdinaryOperationJournal|undefined
             try {
               const raw=await Promise.all([context.read(()=>context.store.get('browser')),context.read(()=>context.store.get(purpose)),context.read(()=>context.store.get(names.control))])
               const br=row(raw[0])!,tr=row(raw[1])!
               if(raw[2]===undefined){context.stop();await context.ended;return {phase:'absent',result:false,secretCount:0,sequence:0,initialGenerationUnchanged:true,changedRows:[rowDigest(br)!==value.member.credentialGeneration.current.rows[0],rowDigest(tr)!==value.member.credentialGeneration.current.rows[1]]}}
               b=await openOrdinaryFrame(br.frame!,br.key);t=await openOrdinaryFrame(tr.frame!,tr.key)
               j=await openOrdinaryOperationControl(raw[2],{browser:{binding:{purpose:b.purpose,keyId:b.keyId,generation:b.generation,expiresAt:b.expiresAt},key:br.key},tab:{binding:{purpose:t.purpose,keyId:t.keyId,generation:t.generation,expiresAt:t.expiresAt},key:tr.key}})
               context.stop();await context.ended
               return {phase:j.phase,result:!!j.result,secretCount:j.secrets.length,sequence:j.sequence,initialGenerationUnchanged:value.member.credentialGeneration.current.rows.every((r,i)=>r===value.member.capture.rows[i]),changedRows:[rowDigest(br)!==value.member.credentialGeneration.current.rows[0],rowDigest(tr)!==value.member.credentialGeneration.current.rows[1]]}
             } finally {context.stop();db.close();clearImage(b);clearImage(t);wipeOrdinaryOperationJournal(j)}
           }
           const resource = {stop: () => { op.revoked = true; if (!op.custodyOnly) { op.context?.abort(); op.revokeWait?.() } }}`).replace(
          'privateRenewalFactories.set(factory, Object.assign(Object.create(null), {native, foreground, member, generation, scopes, foregroundExpiresAt,',
          `privateRenewalFactories.set(factory, Object.assign(Object.create(null), {native, foreground, member, generation,
            scopes: (globalThis as any).providerFixture?.renewalScopeFamily === 'signet' ? member.foregroundScopes()! : scopes,
            foregroundExpiresAt,`).replace(
          'createdWitness = witness',
          'createdWitness = witness; (globalThis as any).__seenPrivateRenewalWitness = witness').replace(
          'createdFactory = factory; createdClaim = claim',
          `createdFactory = factory; createdClaim = claim; (globalThis as any).__seenPrivateRenewalClaim = claim
           ;(globalThis as any).__privateRenewalFactoryCurrentForTest=()=>ordinaryPrivateRenewalFactoryCurrent(factory)
           if((globalThis as any).privateRenewalGenerationCut==='construction')(globalThis as any).__privateAdvanceCredentialGenerationForTest()` ).replace(
          'beginPrivateExistingProvider = (root, command) => this.#beginPrivateExistingProvider(root, command)',
          `beginPrivateExistingProvider = (root, command) => this.#beginPrivateExistingProvider(root, command)
           ;(globalThis as any).__privateOwnerPrototypeForTest = this.prototype
           ;(globalThis as any).__privateColdResourceForTest = (owner:OrdinaryStateOwner) => ({closed:owner.#closed,work:owner.#work.size,waiting:!!owner.#retry})
           ;(globalThis as any).__takePrivateRenewalIntentForTest = takeOrdinaryPrivateRenewalIntent
           ;(globalThis as any).__takePrivateRenewalClaimForTest = takeOrdinaryPrivateRenewalFactoryClaim
           ;(globalThis as any).__privateRenewForTest = renewOrdinaryPrivateMember
           ;(globalThis as any).__privateControlForTest = (root: OrdinaryPrivateExistingRoot) => this.#authenticatePrivateExistingProvider(root)
           ;(globalThis as any).__privateForegroundForTest = (root: OrdinaryPrivateExistingRoot) => this.#beginPrivateExistingForeground(root)`).replace(
          'challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))',
          'challenge = bytesToHex((globalThis as any).__controlRandom(new Uint8Array(32)))').replace(
          'await context.step(() => {\n                check(); if (controlMode',
          'await context.step(() => { const previous = (globalThis as any).__controlDecision; if (controlMode) (globalThis as any).__controlDecision = true; try {\n              check(); if (controlMode').replace(
          'start?.(); check(); if (controlMode && (!sdkCurrent || !sdkCurrent())) hold()\n              })',
          'start?.(); check(); if (controlMode && (!sdkCurrent || !sdkCurrent())) hold()\n            } finally { (globalThis as any).__controlDecision = previous } })').replace(
          'this.#db = undefined\n    if (this.#cleanupFailure) throw this.#cleanupFailure.error',
          `this.#db = undefined
           const fixture = (globalThis as any).__privateOwnerCloseFixture
           if (fixture) {
             const name = this.purpose === 'browser' ? 'browser' : 'tab'
             fixture.entered.push(name)
             if (fixture.pending === name) await new Promise<void>(yes => { fixture.release = yes })
             fixture.terminal.push(name)
             if (fixture.reject === name) throw Error('Explicit ' + name + ' native owner close failure')
           }
           if (this.#cleanupFailure) throw this.#cleanupFailure.error`).replace('return work(browser, tab, custody)',
          `const previous = (globalThis as any).__controlDecision
           const previousForeground = (globalThis as any).__foregroundDecision
           ;(globalThis as any).__controlDecision = true
           ;(globalThis as any).__foregroundDecision = true
           try { return work(browser, tab, custody) }
           finally { (globalThis as any).__controlDecision = previous; (globalThis as any).__foregroundDecision = previousForeground }`) }
      })
      builder.onLoad({ filter: /ordinary-foreground-signer\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8')
        const imports = `import * as PrivateRenewalForTest from './ordinary-private-renewal.js'
          import { OrdinaryProtocolWork as PrivateRenewalWorkForTest } from './ordinary-protocol-work.js'
          import { takeOrdinaryRenewalObligation as legacyRenewalTakeForTest } from './ordinary-renewal-obligation.js'
          import { inspectPersistentAdmissionProofs as inspectRenewalForTest } from './persistent-admission-proof.js'
          import { ordinaryPairPredecessorSemanticDigestFor as renewalDigestForTest } from './ordinary-state-owner.js'
        `
        return { loader: 'ts', contents: (imports + source).replace(
          'const binding = takeOrdinaryPrivateForegroundClaim(claim)',
          'const binding = takeOrdinaryPrivateForegroundClaim(claim); (globalThis as any).__seenPrivateForegroundClaim = claim').replace(
          'static { openPrivateForeground = binding => OrdinaryForegroundSigner.#openPrivateForeground(binding) }',
          `static { openPrivateForeground = binding => OrdinaryForegroundSigner.#openPrivateForeground(binding)
           ;(globalThis as any).__privateForegroundClassForTest = this
           ;(globalThis as any).__privateRenewalRegistryForTest = PrivateRenewalForTest
           ;(globalThis as any).__privateRenewalWorkForTest = PrivateRenewalWorkForTest
           ;(globalThis as any).__legacyRenewalTakeForTest = legacyRenewalTakeForTest
           ;(globalThis as any).__openPrivateForegroundClaimForTest = openOrdinaryPrivateForegroundFromOwnerClaim
           ;(globalThis as any).__privateAuthorityFunctions = Object.freeze({ current: ordinaryPrivateForegroundCurrent,
             deadline: ordinaryPrivateForegroundDeadline, borrow: borrowOrdinaryPrivateForegroundCredentialSigner,
             nativeCurrent: ordinaryPrivateMemberNativeCurrent, validate: validateOrdinaryPrivateForegroundCustody }) }`).replace(
          'Object.freeze(actual)\n      })',
          `Object.freeze(actual)
           ;(globalThis as any).__privateForegroundProbe = Object.freeze({
             busy:()=>actual.#busy,
             revokeForJoinTest:()=>actual.#revoke(),
             loadMember: () => actual.#loadPrivateMember(),
             native: () => actual.#privateForeground!.native, authority: () => actual.#privateAuthority,
             prepareRenewalFactory: () => actual.#privateForeground!.prepareRenewalFactory(actual.#privateAuthority!),
             renewalDesired: () => actual.#privateForeground!.readForeground(actual.#live, (browser, tab, custody) => {
               const b = new Map(browser.keys().map(name => [name, browser.get(name)!])), t = new Map(tab.keys().map(name => [name, tab.get(name)!]))
               const inspected = inspectRenewalForTest(browser, tab)
               try {
                 const found = [...inspected.selected.values()].find(value => value.proof.binding.participant === actual.#participant)!
                 const credential = JSON.parse(found.proof.binding.device.credentials[0]!), now = Math.floor(Date.now() / 1000)
                 const headers = ordinaryPairReadCustodyFor(custody, b, t)
                 const foreground = ordinaryPrivateForegroundDeadline(actual.#privateAuthority!, actual.#privateForeground!.native, browser, tab, custody, actual.#participant)
                 return Object.freeze({ issuedAt: now, expiresAt: Math.min(now + Number(credential.tags[2][1]) - credential.created_at,
                   Math.floor(headers.tab.expiresAt / 1000), found.admission.endsAt ?? Infinity, foreground === null ? Infinity : Math.floor(foreground / 1000)),
                   semanticDigest: renewalDigestForTest(custody, b, t) })
               } finally { inspected.close(); b.clear(); t.clear() }
             }),
             tokens: () => Object.freeze({ authority: actual.#privateAuthority!, native: actual.#privateForeground!.native }),
             current: () => ordinaryPrivateForegroundCurrent(actual.#privateAuthority!, actual.#privateForeground!.native, actual.#participant),
             deadline: () => actual.#privateForeground!.readForeground(actual.#live, (browser, tab, custody) =>
               ordinaryPrivateForegroundDeadline(actual.#privateAuthority!, actual.#privateForeground!.native, browser, tab, custody, actual.#participant)),
             borrowCredential: (consumer: OrdinaryForegroundConsumer) => actual.#privateForeground!.readForeground(actual.#live, (browser, tab, custody) =>
               borrowOrdinaryPrivateForegroundCredentialSigner(actual.#privateAuthority!, actual.#privateForeground!.native, browser, tab, custody, consumer)),
             refuseWrongViews: () => actual.#privateForeground!.readForeground(actual.#live, (browser, tab, custody) => {
               let getters = 0, refused = 0
               const fake = new Proxy({}, { get() { getters++; throw Error('Forged native view getter') },
                 getPrototypeOf() { getters++; throw Error('Forged consumer prototype') } }) as DeviceStore
               const authority = actual.#privateAuthority!, native = actual.#privateForeground!.native
               for (const [b, t, c] of [[fake, tab, custody], [browser, fake, custody], [browser, tab, Object.freeze({})]] as const) {
                 try { borrowOrdinaryPrivateForegroundCredentialSigner(authority, native, b, t, c as OrdinaryPairCustody, fake as unknown as OrdinaryForegroundConsumer) }
                 catch { refused++ }
               }
               ;(globalThis as any).__stalePrivateAuthorityRead = { browser, tab, custody }
               return [refused, getters]
             }),
             sign: (event: EventTemplate) => actual.#signEvent(event),
             encrypt: (peer: string, text: string) => actual.nip44!.encrypt(peer, text),
             signWithConsumer: (event: EventTemplate, validate: () => unknown) => actual.#signEvent(event, undefined, { live: () => true, validate }),
             custody: () => actual.#read(() => true, { live: () => true, validate: (browser, tab, custody) => {
               const b = new Map(browser.keys().map(name => [name, browser.get(name)!])), t = new Map(tab.keys().map(name => [name, tab.get(name)!]))
               try { ordinaryPairReadCustodyFor(custody, b, t) } finally { b.clear(); t.clear() }
             } }),
             metadata: () => [Object.isFrozen(actual), Object.hasOwn(actual, 'signEvent'), actual.session.authEvent.kind],
           })
      })`).replace('state = new OrdinaryForegroundSigner(options, captured, scopes[0], scopes[1])',
          `if ((globalThis as any).providerFixture?.constructorFailure) throw (globalThis as any).providerFixture.constructorFailure
           state = new OrdinaryForegroundSigner(options, captured, scopes[0], scopes[1])`) }
      })
      builder.onLoad({ filter: /ordinary-state-clients\.ts$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = 'crypto.getRandomValues(new Uint8Array(32))'
        if (source.split(marker).length !== 2) throw Error('Public probe nonce fixture drift')
        // Count the exact public fence nonce call separately while keeping its
        // real native entropy. All private ID/key entropy remains forbidden.
        return { loader: 'ts', contents: source.replace(marker, '(globalThis as any).__probeRandom(new Uint8Array(32))') }
      })
      builder.onLoad({ filter: /(?:@noble[/\\]curves|noble-curves-2\.4\.0[/\\]package)[/\\]abstract[/\\]curve\.js$/ }, async input => {
        const source = await readFile(input.path, 'utf8'), marker = 'const probe = randomBytes(length);'
        // Other installed Noble versions lack this optional capability probe.
        // Observe only its exact implementation, regardless of npm hoisting.
        if (!source.includes('function probeRandomBytes(')) return undefined
        if (source.split(marker).length !== 2) throw Error('Noble initialization probe fixture drift')
        // Preserve the cryptographic library's actual RNG-capability probe.
        // This call allocates no tab marker, identity, native key or owner row.
        return { loader: 'js', contents: source.replace(marker, 'const probe = globalThis.__curveProbeRandom(randomBytes, length);') }
      })
    } }] })
  for (const file of result.outputFiles) modules.set('/j/build/' + relative(resolve('.private-root-test-build'), file.path), file.text)
  // Follow static imports only: owner/SDK code must stay behind the actual
  // presence decision and worker fence, including after bundler splitting.
  const meta = result.metafile!, entry = Object.keys(meta.outputs).find(name => meta.outputs[name]!.entryPoint === 'test/ordinary-private-existing-root.browser-entry.ts')!
  const staticInputs = new Set<string>(), visited = new Set<string>()
  const visit = (name: string) => {
    if (visited.has(name)) return
    visited.add(name)
    for (const input of Object.keys(meta.outputs[name]!.inputs)) staticInputs.add(input)
    for (const dependency of meta.outputs[name]!.imports) if (dependency.kind !== 'dynamic-import' && !dependency.external) visit(dependency.path)
  }
  visit(entry)
  expect([...staticInputs].some(name => /ordinary-state-owner|signet-login|nostr-tools|ordinary-foreground-signer/.test(name))).toBe(false)
  modules.set('/j/mutate-native.js', (await build({
    entryPoints: ['test/ordinary-private-provider-mutation.browser-entry.ts'], bundle: true, plugins: sdkPlugins,
    format: 'esm', platform: 'browser', target: 'es2022', write: false,
  })).outputFiles[0]!.text)
  fixture = (await build({ entryPoints: ['test/ordinary-bootstrap.browser-entry.ts'], bundle: true, plugins: sdkPlugins,
    format: 'iife', globalName: 'Ordinary', platform: 'browser', target: 'es2022', write: false })).outputFiles[0]!.text
  pureFence = (await build({ entryPoints: ['test/ordinary-protected-worker.browser-entry.ts'], bundle: true, plugins: sdkPlugins,
    format: 'iife', globalName: 'FenceOnly', platform: 'browser', target: 'es2022', write: false })).outputFiles[0]!.text
  worker = await readFile('app/public/ordinary-state-sw.js', 'utf8')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/j/sw.js') {
      res.setHeader('content-type', 'text/javascript')
      res.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));" +
        (url.search ? "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));" : '') + worker)
    } else if (modules.has(url.pathname)) {
      res.setHeader('content-type', 'text/javascript'); res.end(modules.get(url.pathname))
    } else {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/outside/legacy') res.end('<!doctype html><title>Unresponsive other window</title>')
      else if (url.pathname === '/outside/modern') res.end(`<!doctype html><script>${pureFence.replace(/<\/script/gi, '<\\/script')}</script>`)
      else if (url.pathname === '/j/setup') res.end(`<!doctype html><script>${fixture.replace(/<\/script/gi, '<\\/script')}</script>`)
      else res.end(`<!doctype html><script>${probes}</script><script type="module" src="${ROOT_ENTRY}"></script>`)
    }
  })
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing native root server')
  origin = `http://127.0.0.1:${address.port}`
})
test.afterAll(() => !server ? undefined : new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())))
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => console.error('Private root fixture page error:', error.message))
  page.on('console', message => { if (message.type() === 'error') console.error('Private root fixture console:', message.text()) })
})

async function seed(page: Page, keep = true, visitor = false, signedDestinations = false): Promise<string> {
  await page.goto(origin + '/j/setup')
  await page.evaluate(`(${setup})(${JSON.stringify({ keep, visitor, noRelays: !signedDestinations })})`)
  return page.evaluate(async () => {
    const w = window as any, o = w.Ordinary
    const result = await w.bootstrap.bootstrap(w.evidence)
    o.wipeOrdinaryPersistentBootstrapResult(result)
    sessionStorage.setItem('kithmoot.ordinary-tab.v1', w.tabPurpose.slice(4))
    return w.url
  })
}
async function install(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/j/sw.js', { scope: '/j/', updateViaCache: 'none' })
    if (!registration.active) await new Promise<void>((yes, no) => {
      const worker = registration.installing ?? registration.waiting
      if (!worker) { no(Error('Missing native worker')); return }
      const changed = () => {
        if (worker.state === 'activated') { worker.removeEventListener('statechange', changed); yes() }
        else if (worker.state === 'redundant') { worker.removeEventListener('statechange', changed); no(Error('Worker failed')) }
      }
      worker.addEventListener('statechange', changed); changed()
    })
  })
}
async function releaseFixture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as any
    await w.bootstrap.close(); await w.browserOwner.close(); await w.tabOwner.close()
  })
}
async function enter(page: Page, href: string, expected: 'held' | 'captured-held'): Promise<void> {
  await releaseFixture(page)
  await page.goto(href)
  await page.waitForFunction(() => ['held', 'captured-held'].includes(document.documentElement.dataset.ordinaryProtectedStartup ?? ''))
  const state = await page.evaluate('({state:document.documentElement.dataset.ordinaryProtectedStartup,error:window.__rootFailure,effects,privateEntropyCalls})')
  expect(state, JSON.stringify(state)).toMatchObject({ state: expected, effects: none })
  expect(await page.evaluate('effects')).toEqual(none)
}
async function lockAvailable(page: Page, suffix: string): Promise<boolean> {
  return page.evaluate(suffix => navigator.locks.request('kithmoot-ordinary-state-v1:' + suffix,
    { ifAvailable: true }, lock => !!lock), suffix)
}

for (const keep of [false, true]) {
  test(`fixed private capture authenticates existing NIP07 custody without effects, keep=${keep}`, async ({ page }) => {
    const href = await seed(page, keep)
    await install(page)
    const before = await page.evaluate('rawBoth().then(rows=>rows.map(row=>JSON.stringify(row.frame)))')
    await enter(page, href, 'captured-held')
    expect(await page.evaluate('probeNonces')).toBe(3)
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    expect(await lockAvailable(page, 'write')).toBe(true)
    // A completed capture still owns its tab and MIGRATION until actual close.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
    expect(await page.evaluate('effects')).toEqual(none)
    const after = await page.evaluate(() => new Promise<string[]>((yes, no) => {
      const request = indexedDB.open('kithmoot-ordinary-state-v1')
      request.onerror = () => no(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('owners'), store = tx.objectStore('owners')
        const browser = store.get('browser'), tab = store.get('tab:' + 'a'.repeat(64))
        tx.oncomplete = () => { db.close(); yes([browser.result, tab.result].map(row => JSON.stringify(row.frame))) }
        tx.onabort = () => { db.close(); no(tx.error) }
      }
    }))
    expect(after).toEqual(before)
  })
}

for (const keep of [false, true]) {
  test(`capture accepts a current native lease after its bootstrap credential expires, keep=${keep}`, async ({ page }) => {
    await page.clock.install()
    await page.goto(origin + '/j/setup')
    await page.evaluate(`(${setup})(${JSON.stringify({ keep, noRelays: true })})`)
    // Match the existing member-restoration fixture's synthetic epoch budget.
    // This test asserts authenticated renewal/capture, not a one-second relay deadline.
    await page.evaluate('window.memberEpochTimeoutMs=10000')
    await page.evaluate(`(${controls})()`)
    await page.evaluate('member.join()')
    await page.clock.fastForward(901_000)
    await expect.poll(() => page.evaluate(`(async()=>{try{const result=await bootstrap.load();
      try{return result.sealKeys.length}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(result)}}catch{return 0}})()`)).toBe(2)
    const href = await page.evaluate(async () => {
      const w = window as any, result = await w.bootstrap.load()
      try {
        if (Number(result.credential.tags[2][1]) <= w.credentialExpiresAt) throw Error('Native lease did not renew')
        w.currentCredentialExpiry = Number(result.credential.tags[2][1])
      } finally { w.Ordinary.wipeOrdinaryPersistentBootstrapResult(result) }
      // Stop renewal before moving past the historical bootstrap expiry.
      await w.member.close(); await w.bootstrap.close()
      sessionStorage.setItem('kithmoot.ordinary-tab.v1', w.tabPurpose.slice(4))
      return w.url
    })
    await page.clock.fastForward(900_001)
    expect(await page.evaluate('Math.floor(Date.now()/1000)>credentialExpiresAt&&currentCredentialExpiry-Math.floor(Date.now()/1000)>=600')).toBe(true)
    await install(page)
    await enter(page, href, 'captured-held')
    expect(await lockAvailable(page, 'migration')).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await page.evaluate('effects')).toEqual(none)
  })
}

for (const fault of ['missing-marker', 'invalid-marker', 'missing-tab', 'missing-browser', 'wrong-url',
  'account', 'method', 'pending-login', 'expired-tab', 'expired-credential', 'metadata'] as const) {
  test(`actual private root holds ${fault} without native or provider effects`, async ({ page }) => {
    let href = await seed(page)
    await install(page)
    if (fault === 'missing-marker') await page.evaluate(() => sessionStorage.removeItem('kithmoot.ordinary-tab.v1'))
    else if (fault === 'invalid-marker') await page.evaluate(() => sessionStorage.setItem('kithmoot.ordinary-tab.v1', 'invalid'))
    else if (fault === 'wrong-url') href = origin + '/j/#wrong'
    else if (fault === 'expired-tab' || fault === 'expired-credential') {
      await page.clock.install()
      await page.clock.fastForward(fault === 'expired-tab' ? 3_600_001 : 1_800_001)
    } else if (fault === 'missing-tab' || fault === 'missing-browser') await page.evaluate(async fault => {
      const request = indexedDB.open('kithmoot-ordinary-state-v1')
      const db = await new Promise<IDBDatabase>((yes, no) => { request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error) })
      const tx = db.transaction('owners', 'readwrite')
      tx.objectStore('owners').delete(fault === 'missing-tab' ? 'tab:' + 'a'.repeat(64) : 'browser')
      await new Promise<void>((yes, no) => { tx.oncomplete = () => yes(); tx.onabort = () => no(tx.error) }); db.close()
    }, fault)
    else await page.evaluate(async fault => {
      const w = window as any
      await w.pair((browser: any) => {
        const k = w.Ordinary.ORDINARY_SIGNET_KEYS
        if (fault === 'account') browser.set(k.pubkey, 'f'.repeat(64))
        else if (fault === 'method') browser.set(k.method, 'bunker')
        else if (fault === 'pending-login') browser.set(k.pendingRedirect, '{}')
        else {
          const name = w.prefix + 'kithmoot.room.' + w.roomId, value = JSON.parse(browser.get(name))
          browser.set(name, JSON.stringify({ ...value, link: location.origin + '/j/#wrong' }))
        }
      })
    }, fault)
    await enter(page, href, 'held')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  })
}

test('first uncontrolled document cannot substitute later worker activation for entry control', async ({ page }) => {
  const href = await seed(page)
  await enter(page, href, 'held')
  expect(await lockAvailable(page, 'migration')).toBe(true)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.ordinaryProtectedStartup === 'captured-held')
  expect(await page.evaluate('effects')).toEqual(none)
})

test('a visitor proof cannot select the account-bound NIP07 checkpoint', async ({ page }) => {
  const href = await seed(page, false, true)
  await install(page)
  await enter(page, href, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('actual worker-controller replacement closes the captured root and releases MIGRATION last', async ({ page }) => {
  const href = await seed(page)
  await install(page)
  await enter(page, href, 'captured-held')
  await page.evaluate(() => navigator.serviceWorker.register('/j/sw.js?replacement', { scope: '/j/', updateViaCache: 'none' }))
  await page.waitForFunction(() => document.documentElement.dataset.ordinaryProtectedStartup === 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('effects')).toEqual(none)
})

test('repeated entry cannot replay capture or revive a closed document root', async ({ page }) => {
  const href = await seed(page)
  await install(page)
  await enter(page, href, 'captured-held')
  const capturedProbes = await page.evaluate<[number, number]>('[probeNonces,curveInitializationProbes]')
  expect(capturedProbes[0]).toBe(3)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.prepareOrdinaryPrivateExistingRoot())`)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual(capturedProbes)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.prepareOrdinaryPrivateExistingRoot())`)
  expect(await page.evaluate('document.documentElement.dataset.ordinaryProtectedStartup')).toBe('held')
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual(capturedProbes)
  expect(await page.evaluate('effects')).toEqual(none)
})

test('the lexical native bridge refuses forged and proxy roots without invoking getters', async ({ page }) => {
  await page.goto(origin + '/j/setup')
  expect(await page.evaluate(() => {
    const w = window as any
    let getters = 0, refused = 0
    for (const name of ['beginOrdinaryPrivateExistingCapture', 'beginOrdinaryPrivateExistingProvider']) {
      if (typeof w.Ordinary[name] !== 'function') throw Error('Missing fixed native bridge: ' + name)
      for (const root of [{}, Object.freeze({}), new Proxy({}, { get() { getters++; throw Error('caller getter') } })]) {
        try { w.Ordinary[name](root) } catch { refused++ }
      }
    }
    return { getters, refused }
  })).toEqual({ getters: 0, refused: 6 })
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([])
})

test('a retained marker cannot create an absent database or a replacement tab identity', async ({ page }) => {
  await page.goto(origin + '/j/setup')
  await page.evaluate(() => sessionStorage.setItem('kithmoot.ordinary-tab.v1', 'a'.repeat(64)))
  await install(page)
  await page.goto(origin + '/j/')
  await page.waitForFunction(() => document.documentElement.dataset.ordinaryProtectedStartup === 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([])
  expect(await page.evaluate('effects')).toEqual(none)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual([0, 0])
})

test('an unresponsive outside-scope window holds before owner/SDK import', async ({ page, context }) => {
  const href = await seed(page)
  await install(page)
  const other = await context.newPage()
  await other.goto(origin + '/outside/legacy')
  await enter(page, href, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual([1, 0])
  await other.close()
})

test('an acknowledged outside-scope window owning the exact tab marker prevents restoration', async ({ page, context }) => {
  const href = await seed(page)
  await install(page)
  const other = await context.newPage()
  await other.goto(origin + '/outside/modern')
  await other.evaluate(() => new Promise<void>(yes => {
    const w = window as any
    w.modernFence = new w.FenceOnly.OrdinaryClientFence()
    w.tabLockWork = navigator.locks.request('kithmoot-ordinary-state-v1:lifetime:' + 'a'.repeat(64), async () => {
      await new Promise<void>(release => { w.releaseTabLock = release; yes() })
    })
  }))
  await enter(page, href, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  expect(await page.evaluate('[probeNonces,curveInitializationProbes]')).toEqual([1, 0])
  await other.evaluate(async () => { const w = window as any; w.releaseTabLock(); await w.tabLockWork; w.modernFence.close() })
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  await other.close()
})

for (const [target, outcome] of [['presence', 'success'], ['capture', 'success'], ['capture', 'version-error']] as const) {
  test(`pagehide joins delayed native ${target} ${outcome} terminal delivery before releasing MIGRATION`, async ({ page }) => {
    const href = await seed(page)
    await install(page)
    if (outcome === 'version-error') {
      await releaseFixture(page)
      await page.evaluate(() => new Promise<void>((yes, no) => {
        const request = indexedDB.open('kithmoot-ordinary-state-v1', 2)
        request.onsuccess = () => { request.result.close(); yes() }
        request.onerror = () => no(request.error)
        request.onblocked = () => no(Error('Fixture owner was not closed before upgrade'))
      }))
    }
    await page.addInitScript(target => {
      const w = window as any, native = indexedDB.open.bind(indexedDB), close = IDBDatabase.prototype.close
      let opened = 0
      w.nativeTail = { ready: false, closed: 0, delivered: false, kind: null, error: null }
      IDBDatabase.prototype.close = function () { w.nativeTail.closed++; return close.call(this) }
      indexedDB.open = ((...args: Parameters<IDBFactory['open']>) => {
        const request = native(...args)
        if (++opened !== (target === 'presence' ? 1 : 2)) return request
        const proxy = new Proxy(request, {
          get(object, name) { const value = Reflect.get(object, name, object); return typeof value === 'function' ? value.bind(object) : value },
          set(object, name, value) {
            if (name === 'onsuccess' || name === 'onerror') {
              Reflect.set(object, name, (event: Event) => {
                event.preventDefault(); w.nativeTail.ready = true
                w.nativeTail.kind = event.type; w.nativeTail.error = object.error?.name ?? null
                w.deliverNativeTail = () => { w.nativeTail.delivered = true; value.call(object, event) }
              }, object)
              return true
            }
            return Reflect.set(object, name, value, object)
          },
        })
        // Honest injection: the later success/error and database are native;
        // a version-one read did not naturally request an upgrade block.
        if (target === 'capture') queueMicrotask(() => request.dispatchEvent(new Event('blocked')))
        return proxy
      }) as IDBFactory['open']
    }, target)
    await releaseFixture(page)
    await page.goto(href)
    await page.waitForFunction('nativeTail.ready')
    expect(await page.evaluate('[nativeTail.kind,nativeTail.error]')).toEqual(outcome === 'success' ? ['success', null] : ['error', 'VersionError'])
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    expect(await page.evaluate('document.documentElement.dataset.ordinaryProtectedStartup')).toBe('held')
    expect(await lockAvailable(page, 'migration')).toBe(false)
    if (target === 'capture') expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    const before = await page.evaluate<number>('nativeTail.closed')
    await page.evaluate('deliverNativeTail()')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    if (outcome === 'success') expect(await page.evaluate('nativeTail.closed')).toBeGreaterThan(before)
    expect(await page.evaluate('effects')).toEqual(none)
  })
}

async function providerFixture(page: Page, account: string, gated = false, withCrypto = false): Promise<void> {
  await page.addInitScript(({ account, gated, withCrypto }) => {
    const w = window as any
    const fixture: any = { account, gated, started: false, calls: 0, signs: 0, mutations: 0, release: undefined, controlNonces: 0,
      nativeRandom: crypto.getRandomValues.bind(crypto), nativePut: IDBObjectStore.prototype.put }
    w.__controlRandom = (value: Uint8Array) => { fixture.controlNonces++; fixture.controlNonceBytes = value.byteLength; return fixture.nativeRandom(value) }
    const provider = {
      getPublicKey: () => {
        fixture.calls++; fixture.started = true
        if(fixture.discoveryOutcome==='throw')throw Error('Explicit synchronous discovery failure')
        return (async()=>{
        if(fixture.openPopup)w.privateSignerPopup=window.open('about:blank','signer-test-popup','popup,width=360,height=360')
        if (fixture.gated) await new Promise<void>(yes => { fixture.release = yes })
        if(fixture.discoveryOutcome==='reject')throw Error('Explicit rejected discovery')
        return fixture.account
        })()
      },
      signEvent: (event: any) => {
        if(fixture.controlOutcome==='throw'){fixture.signs++;fixture.signingStarted=true;throw Error('Explicit synchronous proof failure')}
        if (fixture.foregroundExpected && fixture.synchronousFailure) { fixture.signs++; fixture.foregroundStarts=(fixture.foregroundStarts??0)+1; throw fixture.synchronousFailure }
        return (async () => {
        fixture.signs++
        if (fixture.foregroundExpected) {
          fixture.foregroundStarts = (fixture.foregroundStarts ?? 0) + 1
          fixture.foregroundGuarded = !!w.__foregroundDecision
          if (fixture.renewalCut === 'start') window.dispatchEvent(new PageTransitionEvent('pagehide'))
          if (fixture.foregroundGated) await new Promise<void>(yes => { fixture.releaseForeground = yes })
          if (fixture.foregroundFailure) throw fixture.foregroundFailure
        }
        if (!fixture.controlMode) throw Error('Signing is outside provider discovery')
        fixture.signingStarted = true; fixture.statement = structuredClone(event);if(fixture.controlOutcome==='reject')throw Error('Explicit rejected proof')
        if (fixture.controlFailure) throw fixture.controlFailure
        if (fixture.controlGated) await new Promise<void>(yes => { fixture.releaseControl = yes })
        if (fixture.controlMode === 'transient') throw Error('Request failed: explicit transient provider fixture')
        const captured = structuredClone(event)
        if (fixture.controlMode === 'challenge') captured.tags[0][1] = 'ef'.repeat(32)
        if (fixture.controlMode === 'origin') captured.tags[1][1] = 'https://wrong.example'
        if (fixture.controlMode === 'app') captured.tags[2][1] = 'Another app'
        if (fixture.controlMode === 'content') captured.content = 'wrong'
        if (fixture.controlMode === 'time') captured.created_at--
        if (fixture.controlMode === 'signature') return { ...await w.__controlSign(captured), sig: '0'.repeat(128) }
        const result = await w.__controlSign(captured)
        if (!fixture.proofProxy) return result
        const inspect = () => {
          fixture.proofInspections = (fixture.proofInspections ?? 0) + 1
          if (!w.__controlDecision || fixture.renewalProofExpected && !w.__privateRenewalDecision) { fixture.proofOutside = (fixture.proofOutside ?? 0) + 1; throw Error('Proof inspection outside native decision') }
          if (fixture.proofCutsRoot) window.dispatchEvent(new PageTransitionEvent('pagehide'))
        }
        return new Proxy(result, {
          // Native Promise resolution necessarily reads `then` before the SDK
          // receives the result. Observe component proof inspection separately.
          get(target, key, receiver) { if (key !== 'then') inspect(); return Reflect.get(target, key, receiver) },
          getPrototypeOf(target) { inspect(); return Reflect.getPrototypeOf(target) },
          ownKeys(target) { inspect(); return Reflect.ownKeys(target) },
          getOwnPropertyDescriptor(target, key) { inspect(); return Reflect.getOwnPropertyDescriptor(target, key) },
        })
        })()
      },
    }
    if (withCrypto) (provider as any).nip44 = {
      encrypt: async (_peer: string, text: string) => { fixture.crypts = (fixture.crypts ?? 0) + 1; return 'encrypted:' + text },
      decrypt: async (_peer: string, text: string) => { fixture.crypts = (fixture.crypts ?? 0) + 1; return text.slice('encrypted:'.length) },
    }
    fixture.current = provider; fixture.provider = provider; w.providerFixture = fixture
  }, { account, gated, withCrypto })
}
async function startProvider(page: Page): Promise<void> {
  await page.evaluate(`window.providerDone=false;window.providerOpening=import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot()).then(()=>{window.providerDone=true});undefined`)
}
async function providerState(page: Page, state: 'held' | 'provider-held'): Promise<void> {
  await page.waitForFunction(state => document.documentElement.dataset.ordinaryProtectedStartup === state, state)
  const result = await page.evaluate('({state:document.documentElement.dataset.ordinaryProtectedStartup,error:window.__providerFailure,effects})')
  expect(result, JSON.stringify(result)).toMatchObject({ state, effects: { ...none, provider: expect.any(Number) } })
}
for (const keep of [false, true]) test(`private root restores only its actual NIP07 provider account, keep=${keep}`, async ({ page }) => {
  const href = await seed(page, keep), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await startProvider(page); await providerState(page, 'provider-held')
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  expect(await lockAvailable(page, 'write')).toBe(true)
  const nonces = await page.evaluate('probeNonces')
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,probeNonces]')).toEqual([1, nonces])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
})
for (const fault of ['account', 'missing-provider'] as const) test(`provider restoration refuses ${fault} without signing or writes`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, fault === 'account' ? 'f'.repeat(64) : account)
  await enter(page, href, 'captured-held')
  if (fault === 'missing-provider') await page.evaluate('providerFixture.current=undefined')
  await startProvider(page); await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([fault === 'account' ? 1 : 0, 0])
})
for (const field of ['getPublicKey', 'signEvent'] as const) test(`provider ${field} metadata revocation holds before actual discovery`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await page.evaluate(field => {
    const f = (window as any).providerFixture, original = f.provider[field]
    Object.defineProperty(f.provider, field, { get() {
      if (!f.cut) { f.cut = true; window.dispatchEvent(new PageTransitionEvent('pagehide')) }
      return original
    } })
  }, field)
  await startProvider(page); await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
})
test('pagehide joins an actual pending SDK account discovery before releasing MIGRATION', async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, true)
  await enter(page, href, 'captured-held'); await startProvider(page)
  await page.waitForFunction('providerFixture.started')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await providerState(page, 'held')
  expect(await page.evaluate('providerDone')).toBe(false)
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  await page.evaluate('providerFixture.release();undefined'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerDone,providerFixture.calls,providerFixture.signs]')).toEqual([true, 1, 0])
})

for (const timing of ['before-discovery', 'pending-discovery'] as const) test(`authenticated native revision change ${timing} refuses stale provider handoff`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, timing === 'pending-discovery')
  await enter(page, href, 'captured-held')
  if (timing === 'pending-discovery') { await startProvider(page); await page.waitForFunction('providerFixture.started') }
  // The explicit fixture seals a valid new frame through the actual codec;
  // application write/entropy probes stay installed throughout.
  await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  expect(await page.evaluate('providerFixture.mutations')).toBe(1)
  if (timing === 'before-discovery') await startProvider(page)
  else await page.evaluate('providerFixture.release();undefined')
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([timing === 'before-discovery' ? 0 : 1, 0])
})
test('provider replacement during pending discovery cannot adopt the old result', async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, true)
  await enter(page, href, 'captured-held'); await startProvider(page)
  await page.waitForFunction('providerFixture.started')
  await page.evaluate('providerFixture.current={...providerFixture.provider};providerFixture.release();undefined')
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
})
test('a failed provider witness cannot be reused after the account is corrected', async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, 'f'.repeat(64))
  await enter(page, href, 'captured-held'); await startProvider(page)
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  const probes = await page.evaluate('probeNonces')
  await page.evaluate(account => { (window as any).providerFixture.account = account }, account)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,probeNonces]')).toEqual([1, 0, probes])
  expect(await lockAvailable(page, 'migration')).toBe(true)
})
test('expiry during actual pending discovery discards the late account and releases after it joins', async ({ page }) => {
  await page.clock.install()
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, true)
  await enter(page, href, 'captured-held'); await startProvider(page)
  await page.waitForFunction('providerFixture.started')
  await page.clock.fastForward(1_201_000)
  await providerState(page, 'held')
  expect(await lockAvailable(page, 'migration')).toBe(false)
  await page.evaluate('providerFixture.release();undefined')
  await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
})

for (const mode of ['success', 'pending', 'reject'] as const) test(`actual SDK ${mode} close joins owners before MIGRATION release`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await page.evaluate(mode => { (window as any).providerFixture.closeMode = mode }, mode)
  await startProvider(page); await providerState(page, 'provider-held')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await providerState(page, 'held'); await page.waitForFunction('providerFixture.closeCalls===1')
  if (mode === 'pending') {
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    expect(await page.evaluate('providerFixture.closeTerminal')).toBeUndefined()
    await page.evaluate('providerFixture.closeRelease();undefined')
  }
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  expect(await page.evaluate('[providerFixture.closeCalls,providerFixture.closeTerminal,providerFixture.calls,providerFixture.signs]')).toEqual([1, true, 1, 0])
  if (mode === 'reject') await expect.poll(() => page.evaluate('window.__rootCloseFailure')).toBe('Explicit SDK close fixture rejection')
})
for (const timing of ['before', 'after'] as const) test(`pagehide ${timing} the provider resource assignment boundary joins late ownership`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held')
  await page.evaluate(timing => { (window as any).providerFixture.cutAssignment = timing }, timing)
  await startProvider(page); await providerState(page, 'held'); await page.evaluate('providerOpening')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
})
test('held provider expires without a new discovery or signing effect', async ({ page }) => {
  await page.clock.install()
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held'); await startProvider(page); await providerState(page, 'provider-held')
  await page.clock.fastForward(1_201_000); await providerState(page, 'held')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
})
for (const mutation of ['provider', 'native'] as const) test(`held ${mutation} mutation cannot turn cached discovery into a fresh handoff`, async ({ page }) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await enter(page, href, 'captured-held'); await startProvider(page); await providerState(page, 'provider-held')
  if (mutation === 'provider') await page.evaluate('providerFixture.current={...providerFixture.provider}')
  else await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  const probes = await page.evaluate('probeNonces')
  // Discovery is a cached historical checkpoint, not a current-state consumer.
  // Repeating it performs no handoff; future private consumption must re-read.
  await page.evaluate(`import('${ROOT_ENTRY}').then(module=>module.restoreOrdinaryPrivateExistingProviderRoot())`)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,probeNonces]')).toEqual([1, 0, probes])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})


// Explicit native-stage instrumentation, not a production authentication UI or
// member-authority test. The real private driver/action and subsequent member
// construction remain part of the unpublished vertical under construction.
const privateControlFixtureSecrets = new WeakMap<Page, Uint8Array>()
async function prepareControlStage(page: Page, keep = true, proxyProvider = false,
  duplicated?: { family: 'sign' | 'crypto'; timing: 'sequential' | 'microtask' }, seedFixture?:()=>Promise<void>, signedDestinations = false): Promise<void> {
  const href = await seed(page, keep, false, signedDestinations)
  await seedFixture?.()
  const account = await page.evaluate<string>('account'),
    secret = Uint8Array.from(await page.evaluate<number[]>('Array.from(participantSk)'))
  const registered = privateControlFixtureSecrets.has(page)
  privateControlFixtureSecrets.set(page, secret)
  if (!registered) await page.exposeFunction('__controlSign', (event: Parameters<typeof finalizeEvent>[0]) =>
    JSON.parse(JSON.stringify(finalizeEvent(event, privateControlFixtureSecrets.get(page)!))))
  await install(page); await providerFixture(page, account, false, duplicated?.family === 'crypto')
  await enter(page, href, 'captured-held')
  await page.evaluate(({ proxyProvider, duplicated }) => {
    const w = window as any, fixture = w.providerFixture
    fixture.closeMode = 'success'
    fixture.sdkDoubleStart = duplicated
    if (proxyProvider) {
      const inspect = () => {
        if (!fixture.controlMode) return
        fixture.providerInspections = (fixture.providerInspections ?? 0) + 1
        if (!w.__controlDecision) { fixture.providerOutside = (fixture.providerOutside ?? 0) + 1; throw Error('Provider inspection outside native decision') }
      }
      fixture.current = new Proxy(fixture.current, {
        get(target, key, receiver) { inspect(); return Reflect.get(target, key, receiver) },
        getPrototypeOf(target) { inspect(); return Reflect.getPrototypeOf(target) },
        ownKeys(target) { inspect(); return Reflect.ownKeys(target) },
        getOwnPropertyDescriptor(target, key) { inspect(); return Reflect.getOwnPropertyDescriptor(target, key) },
      })
      fixture.provider = fixture.current
    }
  }, { proxyProvider, duplicated })
  await startProvider(page); await providerState(page, 'provider-held')
  await page.evaluate(() => {
    const w = window as any
    Object.defineProperty(window, 'nostr', { configurable: true, writable: true, value: w.providerFixture.current })
    w.providerFixture.controlMode = 'success'
  })
}
async function startControlStage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.controlDone = false
    w.controlWork = w.__invokePrivateControlForTest().then((proof: any) => {
      w.controlDone = true; w.controlOutcome = 'verified'
      w.controlProofShape = [Object.isFrozen(proof), Object.isFrozen(proof.tags), proof.tags.every(Object.isFrozen), Reflect.ownKeys(proof).length]
    }, (error: Error) => { w.controlDone = true; w.controlOutcome = error.name; w.controlError = error.message })
  })
}
for (const keep of [false, true]) test(`private control stage verifies actual guarded SDK proof once, keep=${keep}`, async ({ page }) => {
  await prepareControlStage(page, keep)
  await startControlStage(page); await page.waitForFunction('controlDone')
  expect(await page.evaluate('({outcome:controlOutcome,error:window.controlError,shape:window.controlProofShape})')).toEqual({
    outcome: 'verified', error: undefined, shape: [true, true, true, 7],
  })
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,providerFixture.controlNonces,providerFixture.controlNonceBytes]')).toEqual([1, 1, 1, 32])
  expect(await page.evaluate('[effects.socket,effects.storageWrite,effects.put,effects.entropy,effects.key]')).toEqual([0, 0, 0, 0, 0])
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'write')).toBe(true)
  expect(await page.evaluate('__invokePrivateControlForTest().then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces]')).toEqual([1, 1])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})
for (const mode of ['challenge', 'origin', 'app', 'content', 'time', 'signature', 'transient'] as const) {
  test(`private control stage refuses ${mode} and cannot retry another wallet start`, async ({ page }) => {
    await prepareControlStage(page)
    await page.evaluate(mode => { (window as any).providerFixture.controlMode = mode }, mode)
    await startControlStage(page); await page.waitForFunction('controlDone')
    expect(await page.evaluate('controlOutcome')).not.toBe('verified')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces]')).toEqual([1, 1])
    expect(await page.evaluate('__invokePrivateControlForTest().then(()=>"escaped",error=>error.name)')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces,effects.put,effects.storageWrite]')).toEqual([1, 1, 0, 0])
  })
}
for (const mutation of ['provider', 'native'] as const) test(`private control stage refuses ${mutation} mutation before nonce or signing`, async ({ page }) => {
  await prepareControlStage(page)
  if (mutation === 'provider') await page.evaluate('window.nostr=providerFixture.current={...providerFixture.provider}')
  else await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  await startControlStage(page); await page.waitForFunction('controlDone')
  expect(await page.evaluate('controlOutcome')).not.toBe('verified')
  expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces]')).toEqual([0, 0])
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})
for (const field of ['signEvent', 'capabilities', 'pubkey', 'prototype'] as const) test(`private control stage refuses captured SDK ${field} replacement before nonce`, async ({ page }) => {
  await prepareControlStage(page)
  await page.evaluate(field => {
    const sdk = (window as any).providerFixture.sdk
    if (field === 'signEvent') sdk.signEvent = async () => { throw Error('Replacement signer must never run') }
    else if (field === 'capabilities') sdk.capabilities = { ...sdk.capabilities }
    else if (field === 'pubkey') sdk.pubkey = 'f'.repeat(64)
    else Object.setPrototypeOf(sdk, { signEvent: async () => { throw Error('Replacement prototype signer must never run') } })
  }, field)
  await startControlStage(page); await page.waitForFunction('controlDone')
  expect(await page.evaluate('controlOutcome')).not.toBe('verified')
  expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces]')).toEqual([0, 0])
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})
for (const cut of ['pagehide', 'provider', 'native', 'expiry'] as const) test(`private control stage joins pending wallet after ${cut} before SDK and MIGRATION close`, async ({ page }) => {
  if (cut === 'expiry') await page.clock.install()
  await prepareControlStage(page)
  await page.evaluate('providerFixture.controlGated=true')
  await startControlStage(page); await page.waitForFunction('providerFixture.signingStarted')
  // Start inside the native decision, then release WRITE while retaining the
  // actual wallet operation, tab and MIGRATION until its terminal result.
  await expect.poll(() => lockAvailable(page, 'write')).toBe(true)
  expect(await lockAvailable(page, 'migration')).toBe(false)
  if (cut === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  else if (cut === 'provider') await page.evaluate('window.nostr=providerFixture.current={...providerFixture.provider}')
  else if (cut === 'native') await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  else await page.clock.fastForward(1_201_000)
  expect(await page.evaluate('controlDone')).toBe(false)
  expect(await page.evaluate('providerFixture.closeCalls')).toBeUndefined()
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  await page.evaluate('providerFixture.releaseControl();undefined'); await page.evaluate('controlWork')
  expect(await page.evaluate('controlOutcome')).not.toBe('verified')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces,providerFixture.closeCalls,providerFixture.closeTerminal]')).toEqual([1, 1, 1, true])
})

for (const field of ['window-provider', 'provider-signEvent', 'sdk-pubkey'] as const) test(`private control stage refuses ${field} accessor without invoking it`, async ({ page }) => {
  await prepareControlStage(page)
  await page.evaluate(field => {
    const w = window as any, fixture = w.providerFixture
    fixture.accessorCalls = 0
    const target = field === 'window-provider' ? window : field === 'provider-signEvent' ? fixture.provider : fixture.sdk
    const key = field === 'window-provider' ? 'nostr' : field === 'provider-signEvent' ? 'signEvent' : 'pubkey'
    Object.defineProperty(target, key, { configurable: true, get() { fixture.accessorCalls++; throw Error('Accessor must not run') } })
  }, field)
  await startControlStage(page); await page.waitForFunction('controlDone')
  expect(await page.evaluate('controlOutcome')).not.toBe('verified')
  expect(await page.evaluate('[providerFixture.accessorCalls,providerFixture.signs,providerFixture.controlNonces]')).toEqual([0, 0, 0])
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('private control stage confines provider Proxy reflection to authenticated native decisions', async ({ page }) => {
  await prepareControlStage(page, true, true)
  await startControlStage(page); await page.waitForFunction('controlDone')
  expect(await page.evaluate('({outcome:controlOutcome,error:window.controlError})')).toEqual({ outcome: 'verified', error: undefined })
  expect(await page.evaluate('providerFixture.providerInspections')).toBeGreaterThan(0)
  expect(await page.evaluate('providerFixture.providerOutside ?? 0')).toBe(0)
  expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces]')).toEqual([1, 1])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const cut of [false, true]) test(`private control stage confines raw proof Proxy capture and honours native cut=${cut}`, async ({ page }) => {
  await prepareControlStage(page)
  await page.evaluate(cut => { const fixture = (window as any).providerFixture; fixture.proofProxy = true; fixture.proofCutsRoot = cut }, cut)
  await startControlStage(page); await page.waitForFunction('controlDone')
  expect(await page.evaluate('controlOutcome') === 'verified').toBe(!cut)
  expect(await page.evaluate('providerFixture.proofInspections')).toBeGreaterThan(0)
  expect(await page.evaluate('providerFixture.proofOutside ?? 0')).toBe(0)
  expect(await page.evaluate('[providerFixture.signs,providerFixture.controlNonces]')).toEqual([1, 1])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.closeCalls,providerFixture.closeTerminal]')).toEqual([1, true])
})

for (const stage of ['captured', 'provider-held', 'pending-control'] as const) {
  test(`private owner cleanup bypasses a replaced public close at ${stage}`, async ({ page }) => {
    if (stage === 'captured') {
      const href = await seed(page)
      await install(page); await enter(page, href, 'captured-held')
    } else {
      await prepareControlStage(page)
      if (stage === 'pending-control') {
        await page.evaluate('providerFixture.controlGated=true')
        await startControlStage(page)
        await page.waitForFunction('providerFixture.signs===1')
      }
    }
    const effectsBeforeClose = await page.evaluate<Record<string, number>>('effects')
    expect({ ...effectsBeforeClose, provider: 0 }).toEqual(none)
    // Observe the actual owner class in the same split module graph. A public
    // method replacement must receive neither private owner, even at close.
    await page.evaluate(() => {
      const w = window as any
      w.ownerCloseDispatches = 0
      const prototype = w.__privateOwnerPrototypeForTest
      if (!prototype || typeof prototype.close !== 'function') throw Error('Missing native owner prototype observation')
      Object.defineProperty(prototype, 'close', { configurable: true, value() {
        w.ownerCloseDispatches++
        throw Error('Public close intercepted a private owner')
      } })
    })
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await providerState(page, 'held')
    expect(await page.evaluate('ownerCloseDispatches')).toBe(0)
    if (stage === 'pending-control') {
      expect(await lockAvailable(page, 'migration')).toBe(false)
      expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
      expect(await page.evaluate('controlDone')).toBe(false)
      await page.evaluate('providerFixture.releaseControl();undefined')
      await page.evaluate('controlWork')
      expect(await page.evaluate('controlOutcome')).not.toBe('verified')
    }
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
    expect(await page.evaluate('ownerCloseDispatches')).toBe(0)
    expect(await page.evaluate('effects')).toEqual(effectsBeforeClose)
  })
}

for (const rejected of ['browser', 'tab'] as const) {
  test(`private capture joins the pending owner after ${rejected} close rejects`, async ({ page }) => {
    const href = await seed(page)
    await install(page); await enter(page, href, 'captured-held')
    await page.evaluate(reject => {
      ;(window as any).__privateOwnerCloseFixture = {
        reject, pending: reject === 'browser' ? 'tab' : 'browser', entered: [], terminal: [],
      }
    }, rejected)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await providerState(page, 'held')
    await page.waitForFunction('__privateOwnerCloseFixture.entered.length===2')
    expect(await page.evaluate('__privateOwnerCloseFixture.terminal')).toEqual([rejected])
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    await page.evaluate('__privateOwnerCloseFixture.release();undefined')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
    await expect.poll(() => page.evaluate('window.__rootCloseFailure')).toBe('Explicit ' + rejected + ' native owner close failure')
    expect(await page.evaluate('effects')).toEqual(none)
  })
}

// Construction-stage observation only. The production trusted button and the
// bootstrap/carrier/member/epoch graph remain unmounted and unfinished.
async function startPrivateForeground(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.privateForegroundDone = false
    w.privateForegroundOpening = w.__invokePrivateForegroundForTest().then((result: unknown) => {
      w.privateForegroundDone = true; w.privateForegroundOutcome = 'ready'; w.privateForegroundReturnedVoid = result === undefined
    }, (error: Error) => { w.privateForegroundDone = true; w.privateForegroundOutcome = error.name; w.privateForegroundError = error.message })
  })
  await page.waitForFunction('privateForegroundDone')
}
async function signPrivateForeground(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    w.foregroundSignDone = false; w.providerFixture.foregroundExpected = true
    w.foregroundSigning = w.__privateForegroundProbe.sign({ kind: 1, created_at: Math.floor(Date.now() / 1000),
      content: 'private foreground message', tags: [['t', 'guarded']] }).then((event: any) => {
      w.foregroundSignDone = true; w.foregroundSignOutcome = 'signed'
      w.foregroundSignResult = [event.kind, event.content, Object.isFrozen(event), Object.isFrozen(event.tags[0])]
    }, (error: Error) => { w.foregroundSignDone = true; w.foregroundSignOutcome = error.name })
  })
}
test('private foreground claim rejects forgeries and replay without caller getters', async ({ page }) => {
  await prepareControlStage(page)
  expect(await page.evaluate(() => {
    const w = window as any; let refused = 0, getters = 0
    for (const fake of [{}, Object.freeze({}), new Proxy({}, { get() { getters++; throw Error('Forged claim getter') } })]) {
      try { w.__openPrivateForegroundClaimForTest(fake) } catch { refused++ }
    }
    return { refused, getters }
  })).toEqual({ refused: 3, getters: 0 })
  expect(await page.evaluate('providerFixture.signs')).toBe(0)
  await startPrivateForeground(page)
  expect(await page.evaluate('({outcome:privateForegroundOutcome,error:window.privateForegroundError,returned:privateForegroundReturnedVoid})')).toEqual({ outcome: 'ready', error: undefined, returned: true })
  expect(await page.evaluate(() => {
    const w = window as any
    try { w.__openPrivateForegroundClaimForTest(w.__seenPrivateForegroundClaim); return 'replayed' }
    catch (error) { return (error as Error).name }
  })).toBe('OrdinaryStateHold')
  await page.evaluate('__invokePrivateForegroundForTest().catch(()=>{});undefined')
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,providerFixture.controlNonces]')).toEqual([1, 1, 1])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})
test('private foreground uses the actual pinned SDK and bypasses replaced public methods', async ({ page }) => {
  await prepareControlStage(page)
  await page.evaluate(() => {
    const w = window as any
    w.publicForegroundDispatches = 0
    const intercepted = () => { w.publicForegroundDispatches++; throw Error('Private foreground reached a public method') }
    const owner = w.__privateOwnerPrototypeForTest.constructor, foreground = w.__privateForegroundClassForTest
    for (const name of ['readPairMigrated', 'joinPairLifetime']) owner[name] = intercepted
    for (const name of ['capture', 'close']) owner.prototype[name] = intercepted
    for (const name of ['open', 'isNativeSigner', 'nativeCurrent', 'nativeDeadline', 'borrowNativeSignEvent']) foreground[name] = intercepted
    for (const name of ['signEvent', 'revoke', 'close']) foreground.prototype[name] = intercepted
  })
  await startPrivateForeground(page)
  expect(await page.evaluate('({outcome:privateForegroundOutcome,error:window.privateForegroundError})')).toEqual({ outcome: 'ready', error: undefined })
  expect(await page.evaluate('__privateForegroundProbe.metadata()')).toEqual([true, true, 21236])
  await signPrivateForeground(page); await page.evaluate('foregroundSigning')
  expect(await page.evaluate('[foregroundSignOutcome,foregroundSignResult,providerFixture.foregroundGuarded]')).toEqual(['signed', [1, 'private foreground message', true, true], true])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[publicForegroundDispatches,providerFixture.calls,providerFixture.signs,providerFixture.controlNonces,effects.put,effects.socket]')).toEqual([0, 1, 2, 1, 0, 0])
})
test('private foreground read custody cannot expose owners through replaced public validation', async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  await page.evaluate(() => {
    const w = window as any
    w.publicCustodyDispatches = 0
    w.__privateOwnerPrototypeForTest.constructor.validatePairBinding = () => {
      w.publicCustodyDispatches++; throw Error('Replaced native custody validator')
    }
  })
  expect(await page.evaluate(async () => {
    const w = window as any
    try { return [await w.__privateForegroundProbe.custody(), w.publicCustodyDispatches] }
    catch { return ['refused', w.publicCustodyDispatches] }
  })).toEqual([true, 0])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.signs, effects.put, effects.socket]')).toEqual([1, 0, 0])
})
for (const changed of ['sdk', 'native'] as const) test(`private foreground refuses ${changed} replacement before provider signing`, async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  if (changed === 'sdk') await page.evaluate('providerFixture.sdk.signEvent=async()=>{providerFixture.replacedSigns=(providerFixture.replacedSigns??0)+1;throw Error("Replacement signer")};undefined')
  else await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  await signPrivateForeground(page); await page.evaluate('foregroundSigning')
  expect(await page.evaluate('[foregroundSignOutcome,providerFixture.signs,providerFixture.replacedSigns??0]')).toEqual(['OrdinaryStateHold', 1, 0])
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})
test('private foreground confines provider and raw-proof Proxy reflection to its native callback', async ({ page }) => {
  await prepareControlStage(page, true, true); await startPrivateForeground(page)
  expect(await page.evaluate('({outcome:privateForegroundOutcome,error:window.privateForegroundError})')).toEqual({ outcome: 'ready', error: undefined })
  await page.evaluate('providerFixture.proofProxy=true')
  await signPrivateForeground(page); await page.evaluate('foregroundSigning')
  expect(await page.evaluate('foregroundSignOutcome')).toBe('signed')
  expect(await page.evaluate('[providerFixture.providerOutside??0,providerFixture.proofOutside??0,providerFixture.foregroundGuarded]')).toEqual([0, 0, true])
  expect(await page.evaluate('providerFixture.proofInspections')).toBeGreaterThan(0)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})
for (const phase of ['control', 'foreground'] as const) test(`private ${phase} rejection cannot expose hostile error metadata to SDK retry classification`, async ({ page }) => {
  await prepareControlStage(page)
  if (phase === 'foreground') {
    await startPrivateForeground(page)
    expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  }
  await page.evaluate(phase => {
    const fixture = (window as any).providerFixture
    fixture.errorInspections = 0
    const rejection = new Error()
    Object.defineProperty(rejection, 'message', { get() { fixture.errorInspections++; return 'Request failed: hostile provider error' } })
    if (phase === 'control') fixture.controlFailure = rejection
    else fixture.foregroundFailure = rejection
  }, phase)
  if (phase === 'control') { await startPrivateForeground(page); expect(await page.evaluate('privateForegroundOutcome')).toBe('OrdinaryStateHold') }
  else { await signPrivateForeground(page); await page.evaluate('foregroundSigning'); expect(await page.evaluate('foregroundSignOutcome')).toBe('OrdinaryStateHold') }
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.errorInspections,providerFixture.signs]')).toEqual([0, phase === 'control' ? 1 : 2])
})
test('private foreground joins an unabortable wallet then the SDK close before releasing locks', async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  await page.evaluate('providerFixture.foregroundGated=true;providerFixture.closeMode="pending"')
  await signPrivateForeground(page); await page.waitForFunction('providerFixture.foregroundStarts===1')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await providerState(page, 'held')
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await page.evaluate('[foregroundSignDone,providerFixture.closeCalls??0]')).toEqual([false, 0])
  await page.evaluate('providerFixture.releaseForeground();undefined'); await page.evaluate('foregroundSigning')
  await page.waitForFunction('providerFixture.closeCalls===1')
  expect(await page.evaluate('foregroundSignOutcome')).toBe('OrdinaryStateHold')
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
  await page.evaluate('providerFixture.closeRelease();undefined')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  expect(await page.evaluate('[providerFixture.closeCalls,providerFixture.closeTerminal,providerFixture.signs,effects.put,effects.socket]')).toEqual([1, true, 2, 0, 0])
})

for (const phase of ['control', 'constructor', 'foreground'] as const) test(`private foreground owner replaces a hostile ${phase} rejection with an owned refusal`, async ({ page }) => {
  await prepareControlStage(page)
  if (phase === 'foreground') { await startPrivateForeground(page); expect(await page.evaluate('privateForegroundOutcome')).toBe('ready') }
  await page.evaluate(phase => {
    const fixture = (window as any).providerFixture
    fixture.rejectionTraps = 0
    const trap = () => { fixture.rejectionTraps++; throw Error('Hostile rejection was inspected') }
    const rejection = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
    if (phase === 'control') fixture.controlFailure = rejection
    else if (phase === 'constructor') fixture.constructorFailure = rejection
    else fixture.foregroundFailure = rejection
  }, phase)
  if (phase === 'foreground') { await signPrivateForeground(page); await page.evaluate('foregroundSigning'); expect(await page.evaluate('foregroundSignOutcome')).toBe('OrdinaryStateHold') }
  else { await startPrivateForeground(page); expect(await page.evaluate('privateForegroundOutcome')).toBe('OrdinaryStateHold') }
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.rejectionTraps,providerFixture.signs]')).toEqual([0, phase === 'foreground' ? 2 : 1])
})
for (const family of ['sign', 'crypto'] as const) for (const timing of ['sequential', 'microtask'] as const) {
  test(`private foreground permanently refuses a second ${timing} SDK ${family} effect`, async ({ page }) => {
    await prepareControlStage(page, true, false, { family, timing }); await startPrivateForeground(page)
    expect(await page.evaluate('({outcome:privateForegroundOutcome,error:window.privateForegroundError})')).toEqual({ outcome: 'ready', error: undefined })
    if (family === 'sign') {
      await signPrivateForeground(page); await page.evaluate('foregroundSigning')
      expect(await page.evaluate('foregroundSignOutcome')).toBe('OrdinaryStateHold')
    } else {
      expect(await page.evaluate(async () => {
        const w = window as any
        try { await w.__privateForegroundProbe.encrypt(w.providerFixture.account, 'private'); return 'encrypted' }
        catch (error) { return (error as Error).name }
      })).toBe('OrdinaryStateHold')
    }
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await page.evaluate('[providerFixture.duplicateCallbacks??0,providerFixture.signs,providerFixture.crypts??0]')).toEqual([0, family === 'sign' ? 2 : 1, family === 'crypto' ? 1 : 0])
  })
}
for (const disposition of ['rejected', 'pending'] as const) test(`private foreground sinks and joins an invalid ${disposition} asynchronous consumer`, async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  await page.evaluate(disposition => {
    const w = window as any
    w.validationUnhandled = 0
    window.addEventListener('unhandledrejection', () => { w.validationUnhandled++ })
    w.invalidValidation = disposition === 'rejected' ? undefined : new Promise<void>(yes => { w.releaseInvalidValidation = yes })
    w.invalidConsumerDone = false
    w.invalidConsumerSigning = w.__privateForegroundProbe.signWithConsumer({ kind: 1, created_at: Math.floor(Date.now() / 1000), content: 'refused', tags: [] },
      () => disposition === 'rejected' ? Promise.reject(new Error('Invalid asynchronous native restriction')) : w.invalidValidation)
      .then(() => { w.invalidConsumerDone = true; w.invalidConsumerOutcome = 'signed' },
        (error: Error) => { w.invalidConsumerDone = true; w.invalidConsumerOutcome = error.name })
  }, disposition)
  await page.evaluate('invalidConsumerSigning')
  expect(await page.evaluate('[invalidConsumerOutcome,providerFixture.signs]')).toEqual(['OrdinaryStateHold', 1])
  if (disposition === 'pending') {
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await page.evaluate('providerFixture.closeCalls??0')).toBe(0)
    await page.evaluate('releaseInvalidValidation();undefined')
  }
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  await page.evaluate(() => new Promise<void>(yes => setTimeout(yes, 0)))
  expect(await page.evaluate('validationUnhandled')).toBe(0)
})

async function beginPrivateRenewalPipeline(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as any, api = w.__privateRenewalRegistryForTest
    w.privatePipelineDone = false; w.privatePipelineStage = 'claim'
    let factory: unknown, desired: unknown
    try {
      const claim = await w.__privateForegroundProbe.prepareRenewalFactory()
      w.privatePipelineStage = 'factory'; factory = api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim)
      w.privatePipelineStage = 'desired'; desired = await w.__privateForegroundProbe.renewalDesired()
    } catch (error) { w.privatePipelineOutcome = 'fixture-'+w.privatePipelineStage+':'+(error as Error).name; w.privatePipelineDone = true; return }
    w.allowPrivateRenewalEffects = true; w.providerFixture.foregroundExpected = true; w.providerFixture.renewalProofExpected = true
    w.privatePipelineDone = false
    const work = w.__privateRenewalWorkForTest.registerPreparedStartup({}, async (root: unknown) => {
      const obligation = await api.prepareOrdinaryPrivateRenewalObligation(factory, root, desired)
      w.privatePipelineObligation = obligation
      try { w.privatePipelineReceipt = await w.__privateRenewForTest(obligation); w.privatePipelineOutcome = 'settled' }
      catch (error) { w.privatePipelineOutcome = (error as Error).name }
    })
    w.privatePipelineWork = work
    w.privatePipelinePending = work.start().catch((error: Error) => { w.privatePipelineOutcome = error.name })
      .finally(() => { w.privatePipelineDone = true; work.close() })
  })
}

for (const keep of [false, true]) test(`private renewal pipeline acknowledges actual durable S without adopting initial epoch, keep=${keep}`, async ({page}) => {
  await page.clock.install(); await prepareControlStage(page, keep, true); await startPrivateForeground(page)
  await page.clock.fastForward(2_000)
  await page.evaluate('providerFixture.proofProxy=true;undefined')
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  if (await page.evaluate('privatePipelineOutcome') !== 'settled') console.log('Private pipeline refusal observation:', await page.evaluate('JSON.stringify({stage:privatePipelineStage,holds:window.__privateRenewalHolds,resource:window.__privateRenewalResourceForTest?.()})'))
  expect(await page.evaluate('({outcome:privatePipelineOutcome,stage:privatePipelineStage,resource:window.__privateRenewalResourceForTest?.(),entropy:privateRenewalEntropy,writes:privateRenewalWrites,errors:privateEntropyCalls,outside:providerFixture.providerOutside??0,rootFailure:window.__providerFailure})'))
    .toMatchObject({outcome: 'settled', resource: {disposed: false, tails: 0, tokens: 1, state: 'settled'}, entropy: [32, 32, ...Array(18).fill(12)], errors: [], outside: 0})
  expect(await page.evaluate('__privateRenewalResourceForTest().material')).toEqual({provider:false,raw:false,captured:false,request:false,statement:false,canonical:false,digest:false,secret:false,nonces:false})
  expect(await page.evaluate('__privateRenewalAfterSdkFinish')).toEqual({provider:false,raw:false,captured:false,binding:false,canonical:true,digest:true})
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toEqual({phase: 'settled', result: false, secretCount: 0, sequence: 1,
    initialGenerationUnchanged: true, changedRows: [true, true]})
  expect(await page.evaluate('[providerFixture.signs,effects.put,effects.entropy,effects.key,effects.socket,providerFixture.providerOutside??0,providerFixture.proofOutside??0,providerFixture.foregroundGuarded]'))
    .toEqual([2, 12, 20, 0, 0, 0, 0, true])
  expect(await page.evaluate('__privateRenewForTest(privatePipelineObligation).then(()=>"replayed",error=>error.name)')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('Object.isFrozen(privatePipelineReceipt)&&Reflect.ownKeys(privatePipelineReceipt).length===0')).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('__privateRenewalResourceForTest()')).toMatchObject({disposed: true, tokens: 0, tails: 0})
})

async function preparePrivateRenewalPipeline(page: Page): Promise<void> {
  await page.clock.install(); await prepareControlStage(page, false, true); await startPrivateForeground(page)
  await page.clock.fastForward(2_000)
}

for (const synchronous of [false, true]) test(`private renewal pipeline owns hostile provider rejection without metadata, synchronous=${synchronous}`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(synchronous => {
    const w = window as any; w.hostileRejectionReads = 0
    const trap = () => { w.hostileRejectionReads++; throw Error('Foreign rejection metadata') }
    const hostile = new Proxy({}, {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap})
    w.providerFixture[synchronous ? 'synchronousFailure' : 'foregroundFailure'] = hostile
  }, synchronous)
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('({outcome:privatePipelineOutcome,reads:hostileRejectionReads,signs:providerFixture.signs,resource:__privateRenewalResourceForTest()})'))
    .toMatchObject({outcome: 'OrdinaryStateHold', reads: 0, signs: 2, resource: {tokens: 0, tails: 0, state: 'failed'}})
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'provider-started', result: false, initialGenerationUnchanged: true})
  expect(await page.evaluate('[effects.put,effects.entropy,effects.key,effects.socket]')).toEqual([4, 20, 0, 0])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('private renewal pipeline quarantines invalid signature after one proof capture', async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate('providerFixture.controlMode="signature";undefined')
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('[privatePipelineOutcome,providerFixture.signs,__privateRenewalCaptures,__privateRenewalResourceForTest().tokens,effects.put]'))
    .toEqual(['OrdinaryStateHold', 2, 1, 0, 4])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'provider-started', result: false, initialGenerationUnchanged: true})
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const cut of ['start', 'pending', 'proof']) test(`private renewal pipeline retains late proof custody after ${cut} revocation`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(cut => {
    const f = (window as any).providerFixture
    f.proofProxy = true
    if (cut === 'proof') f.proofCutsRoot = true
    else { f.foregroundGated = true; if (cut === 'start') f.renewalCut = 'start' }
  }, cut)
  await beginPrivateRenewalPipeline(page)
  if (cut !== 'proof') {
    await page.waitForFunction('providerFixture.foregroundStarts===1&&!!providerFixture.releaseForeground')
    if (cut === 'pending') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'write')).toBe(false)
    expect(await page.evaluate('privatePipelineDone')).toBe(false)
    expect(await page.evaluate('providerFixture.closed??0')).toBe(0)
    await page.evaluate('providerFixture.releaseForeground()')
  }
  await page.waitForFunction('privatePipelineDone')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[privatePipelineOutcome,providerFixture.signs,__privateRenewalCaptures,providerFixture.proofOutside??0,effects.put,effects.entropy]'))
    .toEqual(['OrdinaryStateHold', 2, 1, 0, 5, 20])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'provider-returned', result: true, initialGenerationUnchanged: true})
  expect(await page.evaluate('__privateRenewalResourceForTest()')).toMatchObject({disposed: true, tokens: 0, tails: 0})
})

for (const phase of ['prepared', 'provider-started', 'provider-returned', 'candidate-prepared', 'candidate-committed', 'settled']) {
  for (const closing of [false, true]) test(`private renewal pipeline reconciles committed ${phase} after lost acknowledgement, closing=${closing}`, async ({page}) => {
    await preparePrivateRenewalPipeline(page)
    await page.evaluate(phase => { (window as any).privateRenewalAckFault = {phase, reject: true} }, phase)
    await beginPrivateRenewalPipeline(page)
    await page.waitForFunction('privateRenewalAckFault.entered')
    expect(await page.evaluate('privatePipelineDone')).toBe(false)
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'write')).toBe(false)
    if (closing) await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    // The native transaction really committed. Only delivery of its success
    // acknowledgement is replaced by an error; this is not an abort claim.
    await page.evaluate('privateRenewalAckFault.release()')
    await page.waitForFunction('privatePipelineDone')
    expect(await page.evaluate('privatePipelineOutcome')).toBe(closing ? 'OrdinaryStateHold' : 'settled')
    expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: closing ? phase : 'settled', initialGenerationUnchanged: true})
    expect(await page.evaluate('effects.entropy')).toBe(20)
    expect(await page.evaluate('providerFixture.signs')).toBe(closing && ['prepared', 'provider-started'].includes(phase) ? 1 : 2)
    expect(await page.evaluate('__privateRenewalResourceForTest().tokens')).toBe(closing ? 0 : 1)
    if (!closing) await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  })
}

for (const phase of ['prepared', 'provider-returned', 'candidate-committed', 'settled']) test(`private renewal pipeline retries exact prior ${phase} with identical ciphertext`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(phase => { (window as any).privateRenewalAckFault = {phase, prior: true} }, phase)
  await beginPrivateRenewalPipeline(page)
  await page.waitForFunction('privateRenewalAckFault.entered&&__privateRenewalResourceForTest().holding')
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'write')).toBe(false)
  expect(await page.evaluate('effects.entropy')).toBe(20)
  await page.evaluate('__privateRenewalRetryForTest()')
  await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('privatePipelineOutcome')).toBe('settled')
  expect(await page.evaluate(phase => {
    const packets = (window as any).privateRenewalPackets.filter((v: any) => v.phase === phase)
    const byKey = new Map<string, string[]>()
    for (const p of packets) byKey.set(p.key, [...byKey.get(p.key) ?? [], p.packet])
    const values = [...byKey.values()]
    return values.some(v => v.length === 2) && values.every(v => v.length >= 1 && v.length <= 2 && v.every(packet => packet === v[0]))
  }, phase)).toBe(true)
  expect(await page.evaluate('[effects.entropy,providerFixture.signs,__privateRenewalCaptures]')).toEqual([20, 2, 1])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const phase of ['prepared','provider-started','candidate-prepared','candidate-committed','settled']) test(`private renewal pipeline prior wait revocation ${phase} terminates live stage`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(phase => {(window as any).privateRenewalAckFault={phase,prior:true}},phase)
  await beginPrivateRenewalPipeline(page)
  await page.waitForFunction('privateRenewalAckFault.entered&&__privateRenewalResourceForTest().holding')
  expect(await page.evaluate('privatePipelineDone')).toBe(false)
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => page.evaluate('privatePipelineDone'),{timeout:2_000}).toBe(true)
  await expect.poll(() => lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[privatePipelineOutcome,__privateRenewalResourceForTest().tokens]')).toEqual(['OrdinaryStateHold',0])
  expect(await page.evaluate('providerFixture.signs')).toBe(['prepared','provider-started'].includes(phase)?1:2)
})

test('private renewal pipeline retains exact-prior result custody after waiting then revocation', async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate('privateRenewalAckFault={phase:"provider-returned",prior:true};undefined')
  await beginPrivateRenewalPipeline(page)
  await page.waitForFunction('privateRenewalAckFault.entered&&__privateRenewalResourceForTest().holding')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await page.evaluate('privatePipelineDone')).toBe(false)
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await lockAvailable(page,'write')).toBe(false)
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'provider-started',result:false})
  await page.evaluate('__privateRenewalRetryForTest()')
  await page.waitForFunction('privatePipelineDone')
  await expect.poll(() => lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[privatePipelineOutcome,providerFixture.signs,effects.entropy,__privateRenewalCaptures,__privateRenewalResourceForTest().tokens]'))
    .toEqual(['OrdinaryStateHold',2,20,1,0])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'provider-returned',result:true,initialGenerationUnchanged:true})
  expect(await page.evaluate(() => {
    const packets=(window as any).privateRenewalPackets.filter((v:any)=>v.phase==='provider-returned')
    return packets.length===2&&packets[0].packet===packets[1].packet
  })).toBe(true)
})

test('private renewal pipeline terminates revoked exact-prior E without waiting for impossible retry', async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate('privateRenewalAckFault={phase:"prepared",prior:true,close:true};undefined')
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[privatePipelineOutcome,providerFixture.signs,__privateRenewalResourceForTest().tokens]')).toEqual(['OrdinaryStateHold', 1, 0])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'absent', changedRows: [false, false]})
})

for (const corruption of ['none', 'canonical', 'digest', 'binding']) test(`private renewal pipeline reauthenticates detached completion after read acknowledgement loss, corruption=${corruption}`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate('privateRenewalCompletionAckFault={};providerFixture.proofProxy=true;undefined')
  await beginPrivateRenewalPipeline(page)
  await page.waitForFunction('privateRenewalCompletionAckFault.entered')
  const inspections = await page.evaluate<number>('providerFixture.proofInspections')
  expect(await page.evaluate('__privateRenewalCaptures')).toBe(1)
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await lockAvailable(page, 'write')).toBe(false)
  await page.evaluate(corruption => {
    const w=window as any
    if(corruption!=='none')w.__privateRenewalCorruptCapturedForTest(corruption)
    w.privateRenewalCompletionAckFault.release()
  }, corruption)
  await page.waitForFunction('__privateRenewalResourceForTest().holding')
  await page.evaluate('__privateRenewalRetryForTest()')
  await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('privatePipelineOutcome')).toBe(corruption === 'none' ? 'settled' : 'OrdinaryStateHold')
  if (corruption !== 'none') {
    expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'provider-started',result:false})
    expect(await page.evaluate('__privateRenewalResourceForTest()')).toMatchObject({tokens:0,tails:0,state:'failed'})
  }
  expect(await page.evaluate('[__privateRenewalCaptures,providerFixture.proofInspections,providerFixture.proofOutside??0,providerFixture.signs,effects.entropy]'))
    .toEqual([1, inspections, 0, 2, 20])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const timing of ['sequential', 'microtask'] as const) test(`private renewal pipeline spends SDK provider boundary before ${timing} duplicate`, async ({page}) => {
  await page.clock.install(); await prepareControlStage(page, false, true, {family: 'sign', timing}); await startPrivateForeground(page)
  await page.clock.fastForward(2_000)
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('[privatePipelineOutcome,providerFixture.signs,providerFixture.duplicateCallbacks??0,__privateRenewalCaptures,effects.put,effects.entropy,__privateRenewalResourceForTest().tokens]'))
    .toEqual(['OrdinaryStateHold', 2, 0, 1, 5, 20, 0])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'provider-returned',result:true,initialGenerationUnchanged:true})
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('private renewal pipeline uses closed owner and foreground cores despite public method replacement', async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(() => {
    const w=window as any;w.privatePipelineInterceptions=0
    const replaced=()=>{w.privatePipelineInterceptions++;throw Error('Replaced public renewal core')}
    const owner=w.__privateOwnerPrototypeForTest.constructor,fg=w.__privateForegroundClassForTest
    for(const name of ['captureRenewalPredecessor','validatePairBinding','readPairMigrated','joinPairLifetime'])owner[name]=replaced
    for(const name of ['isNativeSigner','nativeCurrent','nativeDeadline','borrowNativeSignEvent'])fg[name]=replaced
    for(const name of ['signEvent','borrowSignEvent'])fg.prototype[name]=replaced
  })
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('[privatePipelineOutcome,privatePipelineInterceptions,providerFixture.signs,effects.entropy]')).toEqual(['settled',0,2,20])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const phase of ['prepared','provider-returned']) for (const closing of [false,true]) test(`private renewal pipeline retains mixed ${phase} cohort until exact repair, closing=${closing}`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(phase => {(window as any).privateRenewalAckFault={phase,reject:true}},phase)
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privateRenewalAckFault.entered')
  await page.evaluate(async () => {
    const w=window as any,key=w.privateRenewalWrites.find((entry:any)=>String(entry[1]).startsWith('journal:'))[1]
    const opened=indexedDB.open('kithmoot-ordinary-state-v1',1)
    const db=await new Promise<IDBDatabase>((yes,no)=>{opened.onsuccess=()=>yes(opened.result);opened.onerror=()=>no(opened.error)})
    const write=(repair:boolean)=>new Promise<void>((yes,no)=>{
      const tx=db.transaction('owners','readwrite'),store=tx.objectStore('owners'),r=store.get(key)
      r.onsuccess=()=>{
        if(!repair){w.privatePipelineOriginalControl=structuredClone(r.result);new Uint8Array(r.result.browser.ciphertext)[0]^=1}
        Reflect.apply(w.providerFixture.nativePut,store,[repair?w.privatePipelineOriginalControl:r.result,key])
      }
      tx.oncomplete=()=>yes();tx.onabort=()=>no(tx.error)
    })
    await write(false)
    w.privatePipelineRepairMixed=async()=>{await write(true);db.close()}
  })
  if (closing) await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await page.evaluate('privateRenewalAckFault.release()')
  await page.waitForFunction('__privateRenewalResourceForTest().holding')
  expect(await page.evaluate('privatePipelineDone')).toBe(false)
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await lockAvailable(page,'write')).toBe(false)
  const before=await page.evaluate('[effects.put,effects.entropy,providerFixture.signs]')
  await page.evaluate('__privateRenewalRetryForTest()')
  await page.waitForFunction('__privateRenewalResourceForTest().holding')
  expect(await page.evaluate('[effects.put,effects.entropy,providerFixture.signs]')).toEqual(before)
  await page.evaluate('privatePipelineRepairMixed()')
  await page.evaluate('__privateRenewalRetryForTest()')
  await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('privatePipelineOutcome')).toBe(closing?'OrdinaryStateHold':'settled')
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:closing?phase:'settled',initialGenerationUnchanged:true})
  expect(await page.evaluate('effects.entropy')).toBe(20)
  if(!closing)await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page,'migration')).toBe(true)
})

for (const collision of ['existing', 'new']) test(`private renewal pipeline refuses ${collision} nonce collision before E`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(collision => { (window as any).privateRenewalNonceCollision = collision }, collision)
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('[privatePipelineOutcome,effects.put,providerFixture.signs,__privateRenewalResourceForTest().tokens,privateRenewalEntropy]'))
    .toEqual(['OrdinaryStateHold', 0, 1, 0, [32, 32, ...Array(collision === 'existing' ? 1 : 2).fill(12)]])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'absent', changedRows: [false, false]})
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const fault of ['missing', 'extra', 'changed-iv']) test(`private renewal pipeline refuses ${fault} sealer nonce use before E`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(fault => { (window as any).privateRenewalSealFault = fault }, fault)
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('[privatePipelineOutcome,effects.put,providerFixture.signs,__privateRenewalResourceForTest().tokens,effects.entropy,privateRenewalSealFaultUsed]'))
    .toEqual(['OrdinaryStateHold', 0, 1, 0, 20, true])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'absent', changedRows: [false, false]})
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

async function preparePrivateColdSnapshot(page:Page,phase:string):Promise<void>{
  await preparePrivateRenewalPipeline(page); await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('privatePipelineOutcome')).toBe('settled')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page,'migration')).toBe(true)
  // Native encrypted snapshots come from one fully acknowledged reference
  // journey. Fixture restoration is explicit; this does not claim a process
  // crash or physical power-cut test. Keys never leave native IndexedDB.
  await page.evaluate(async phase => {
    const w=window as any,selected=w.privateRenewalEncryptedCohorts[phase],reference=w.privateRenewalEncryptedCohorts.settled
    const open=(name:string,backup=false)=>new Promise<IDBDatabase>((yes,no)=>{
      const r=indexedDB.open(name,1);r.onupgradeneeded=()=>{if(backup)r.result.createObjectStore('snapshots')}
      r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)
    })
    const backup=await open('private-renewal-reference-fixture',true),tx=backup.transaction('snapshots','readwrite')
    Reflect.apply(w.providerFixture.nativePut,tx.objectStore('snapshots'),[{reference,packets:w.privateRenewalPackets,phase},'reference'])
    await new Promise<void>((yes,no)=>{tx.oncomplete=()=>yes();tx.onabort=()=>no(tx.error)});backup.close()
    const db=await open('kithmoot-ordinary-state-v1'),restore=db.transaction('owners','readwrite'),store=restore.objectStore('owners')
    for(const [key,value] of Object.entries(selected))Reflect.apply(w.providerFixture.nativePut,store,[value,key])
    await new Promise<void>((yes,no)=>{restore.oncomplete=()=>yes();restore.onabort=()=>no(restore.error)});db.close()
  },phase)
  await page.reload(); await page.waitForFunction('!!window.__privateOwnerPrototypeForTest')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page,'migration')).toBe(true)
}
async function beginPrivateColdRecovery(page:Page,phase:string,fault?:{phase:string;prior?:boolean;reject?:boolean}):Promise<void>{
  await page.evaluate(({phase,fault})=>{
    const w=window as any
    w.privateColdOwner=new w.__privateOwnerPrototypeForTest.constructor();w.privateColdLive=true;w.privateColdDone=false;w.privateColdEndpointOutcomes=[]
    w.privateRenewalAckFault=fault
    w.privateColdPending=(async()=>{
    const owner=w.privateColdOwner
    w.allowPrivateRenewalEffects=true
    try{
      const before=await owner.inspectRenewalStartup(()=>w.privateColdLive)
      let result='held';const refused:string[]=[]
      if(['prepared','provider-started'].includes(phase))for(const recover of ['recoverRetainedRenewalAtStartup','recoverCommittedRenewalAtStartup']){
        try{await owner[recover]('tab:'+'a'.repeat(64),()=>w.privateColdLive);refused.push('unexpected success')}catch(error){refused.push((error as Error).name)}
      }
      const recover=async(method:string)=>{
        try{const value=await owner[method]('tab:'+'a'.repeat(64),()=>w.privateColdLive);w.privateColdEndpointOutcomes.push({method,status:value.status})}
        catch(error){w.privateColdEndpointOutcomes.push({method,error:(error as Error).name});throw error}
      }
      if(['provider-returned','candidate-prepared'].includes(phase))await recover('recoverRetainedRenewalAtStartup')
      if(!['prepared','provider-started'].includes(phase)){await recover('recoverCommittedRenewalAtStartup');result='settled'}
      const after=await owner.inspectRenewalStartup(()=>w.privateColdLive)
      const read=(name:string,storeName:string)=>new Promise<any>((yes,no)=>{
        const r=indexedDB.open(name,1);r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(storeName),store=tx.objectStore(storeName),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();yes(Object.fromEntries(keys.result.map((k,i)=>[k,values.result[i]])))};tx.onabort=()=>{db.close();no(tx.error)}}
      })
      const current=await read('kithmoot-ordinary-state-v1','owners'),reference=(await read('private-renewal-reference-fixture','snapshots')).reference
      const encoded=(value:any)=>JSON.stringify(value,(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v)
      const same=Object.entries(reference.reference).every(([key,value])=>encoded(value)===encoded(current[key]))
      const samePackets=w.privateRenewalPackets.every((value:any)=>reference.packets.some((p:any)=>p.phase===value.phase&&p.key===value.key&&p.packet===value.packet))
      return {result,before,after,same,samePackets,refused,effects:{...w.effects}}
    }catch(error){if(!w.privateColdExpectHold)console.log('Cold recovery refusal',JSON.stringify({error:(error as Error).stack,holds:w.__privateRenewalHolds,effects:w.effects,packets:w.privateRenewalPackets.map((p:any)=>[p.phase,p.key])}));throw error}
    })().then(value=>{w.privateColdObservation=value;w.privateColdOutcome='ok'},error=>{w.privateColdOutcome=error.name})
      .finally(async()=>{await w.privateColdOwner.close();w.privateColdDone=true})
  },{phase,fault})
}
for (const phase of ['prepared','provider-started','provider-returned','candidate-prepared','candidate-committed','settled']) test(`private renewal pipeline cold document restores acknowledged ${phase} snapshot with fixed ciphertext`, async ({page}) => {
  await preparePrivateColdSnapshot(page,phase);await beginPrivateColdRecovery(page,phase)
  await page.waitForFunction('privateColdDone')
  expect(await page.evaluate('privateColdOutcome')).toBe('ok')
  const observation=await page.evaluate<{
    effects:Record<string,number>;before:{operations:{phase:string}[]};after:{operations:{phase:string}[];status:string};
    result:string;same:boolean;samePackets:boolean;refused:string[]
  }>('privateColdObservation')
  expect(observation.effects).toMatchObject({provider:0,entropy:0,key:0,socket:0,storageWrite:0})
  expect(observation.before.operations[0].phase).toBe(phase)
  if(['prepared','provider-started'].includes(phase)){
    expect(observation.result).toBe('held');expect(observation.after.operations[0].phase).toBe(phase);expect(observation.effects.put).toBe(0);expect(observation.refused).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
  }else{
    expect(observation.result).toBe('settled');expect(observation.after.status).toBe('ordinary');expect(observation.same).toBe(true);expect(observation.samePackets).toBe(true)
  }
})

async function alterPrivateColdControl(page:Page,repair:boolean):Promise<void>{
  await page.evaluate(async repair=>{
    const w=window as any,key=w.privateRenewalPackets.find((p:any)=>p.phase===w.privateRenewalAckFault.phase&&String(p.key).startsWith('journal:')).key
    const r=indexedDB.open('kithmoot-ordinary-state-v1',1)
    const db=await new Promise<IDBDatabase>((yes,no)=>{r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)})
    try{
      const tx=db.transaction('owners','readwrite'),store=tx.objectStore('owners'),get=store.get(key)
      get.onsuccess=()=>{
        if(!repair){w.privateColdOriginalControl=structuredClone(get.result);new Uint8Array(get.result.browser.ciphertext)[0]^=1}
        Reflect.apply(w.providerFixture.nativePut,store,[repair?w.privateColdOriginalControl:get.result,key])
      }
      await new Promise<void>((yes,no)=>{tx.oncomplete=()=>yes();tx.onabort=()=>no(tx.error)})
    }finally{db.close()}
  },repair)
}
async function inspectPrivateColdState(page:Page):Promise<any>{
  return page.evaluate(async()=>{
    const w=window as any,owner=new w.__privateOwnerPrototypeForTest.constructor()
    try{return await owner.inspectRenewalStartup(()=>true)}finally{await owner.close()}
  })
}
for(const target of ['candidate-prepared','candidate-committed','settled']) for(const fault of ['prior','lost-ack','mixed','unavailable']) for(const closing of [false,true])
  test(`private renewal pipeline cold owner reconciles ${target} ${fault}, closing=${closing}`,async({page})=>{
    const initial=target==='settled'?'candidate-committed':'provider-returned'
    await preparePrivateColdSnapshot(page,initial)
    await beginPrivateColdRecovery(page,initial,{phase:target,...fault==='prior'?{prior:true}:{reject:true}})
    await page.waitForFunction('privateRenewalAckFault.entered')
    if(fault==='prior')await page.waitForFunction('__privateColdResourceForTest(privateColdOwner).waiting')
    if(fault==='mixed')await alterPrivateColdControl(page,false)
    if(fault==='unavailable')await page.evaluate(()=>{
      const w=window as any,open=indexedDB.open.bind(indexedDB);w.privateColdStorageUnavailable=true;w.privateColdUnavailableCalls=0
      indexedDB.open=((...args:Parameters<IDBFactory['open']>)=>{if(w.privateColdStorageUnavailable){w.privateColdUnavailableCalls++;throw new DOMException('Explicit unavailable-storage fixture','UnknownError')}return open(...args)}) as IDBFactory['open']
      w.privateColdRestoreStorage=()=>{w.privateColdStorageUnavailable=false;indexedDB.open=open}
    })
    expect(await page.evaluate('privateColdDone')).toBe(false)
    expect(await lockAvailable(page,'write')).toBe(false)
    if(closing)await page.evaluate(()=>{
      const w=window as any;w.privateColdExpectHold=true;w.privateColdLive=false
      w.privateColdClosingDone=false;w.privateColdClosing=w.privateColdOwner.close().finally(()=>{w.privateColdClosingDone=true})
    })
    if(fault!=='prior')await page.evaluate('privateRenewalAckFault.release()')
    if(fault==='mixed'||fault==='unavailable'){
      await page.waitForFunction('__privateColdResourceForTest(privateColdOwner).waiting')
      const before=await page.evaluate('[effects.put,effects.entropy,effects.key,effects.provider]')
      await page.evaluate('privateColdOwner.retryRetention()')
      await page.waitForFunction('__privateColdResourceForTest(privateColdOwner).waiting')
      expect(await page.evaluate('privateColdDone')).toBe(false)
      if(closing)expect(await page.evaluate('privateColdClosingDone')).toBe(false)
      expect(await lockAvailable(page,'write')).toBe(false)
      expect(await page.evaluate('[effects.put,effects.entropy,effects.key,effects.provider]')).toEqual(before)
      if(fault==='mixed')await alterPrivateColdControl(page,true)
      else {expect(await page.evaluate('privateColdUnavailableCalls')).toBeGreaterThanOrEqual(2);await page.evaluate('privateColdRestoreStorage()')}
      await page.evaluate('privateColdOwner.retryRetention()')
    }else if(fault==='prior'&&!closing)await page.evaluate('privateColdOwner.retryRetention()')
    await page.waitForFunction('privateColdDone')
    expect(await page.evaluate('privateColdOutcome')).toBe(closing?'OrdinaryStateHold':'ok')
    if(closing)expect(await page.evaluate('privateColdEndpointOutcomes')).toEqual([{method:initial==='candidate-committed'?'recoverCommittedRenewalAtStartup':'recoverRetainedRenewalAtStartup',error:'OrdinaryStateHold'}])
    const disposition=await inspectPrivateColdState(page)
    const expected=closing?(fault==='prior'?(target==='candidate-prepared'?'provider-returned':target==='candidate-committed'?'candidate-prepared':'candidate-committed'):target):'settled'
    expect(disposition.operations[0].phase).toBe(expected)
    expect(await page.evaluate('({entropy:effects.entropy,key:effects.key,provider:effects.provider,socket:effects.socket})')).toEqual({entropy:0,key:0,provider:0,socket:0})
    expect(await lockAvailable(page,'write')).toBe(true)
    expect(await page.evaluate('__privateColdResourceForTest(privateColdOwner)')).toMatchObject({closed:true,work:0,waiting:false})
    if(!closing)expect(await page.evaluate('privateColdObservation')).toMatchObject({same:true,samePackets:true})
  })

for(const fault of ['count','slot-order','duplicate-nonce','truncated','trailing','downgrade']) test(`private renewal pipeline cold rejects authenticated malformed continuation ${fault}`,async({page})=>{
  await preparePrivateColdSnapshot(page,'provider-returned')
  const controlBefore=await page.evaluate(async fault=>{
    const w=window as any,r=indexedDB.open('kithmoot-ordinary-state-v1',1)
    const db=await new Promise<IDBDatabase>((yes,no)=>{r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)})
    try{
      const raw=await new Promise<any>((yes,no)=>{const tx=db.transaction('owners'),s=tx.objectStore('owners'),keys=s.getAllKeys(),values=s.getAll();tx.oncomplete=()=>yes(Object.fromEntries(keys.result.map((k,i)=>[k,values.result[i]])));tx.onabort=()=>no(tx.error)})
      const purpose='tab:'+'a'.repeat(64),name='journal:tab:'+'a'.repeat(64),control=raw[name]
      const aad=(row:any)=>new TextEncoder().encode(JSON.stringify(['kithmoot.ordinary-operation.v1',name,row.frame.purpose,row.frame.keyId,row.frame.generation,row.frame.expiresAt]))
      let bytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:control.browser.nonce,additionalData:aad(raw.browser),tagLength:128},raw.browser.key,control.browser.ciphertext))
      const size=new DataView(bytes.buffer).getUint32(0),header=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+size)))
      const start=4+size+header[15]+header[16]+header[17]*32
      if(fault==='slot-order')bytes[start]++
      if(fault==='duplicate-nonce')bytes.set(bytes.subarray(start+1,start+13),start+14)
      if(fault==='truncated'){const changed=bytes.slice(0,-13);bytes.fill(0);bytes=changed}
      if(fault==='trailing'){const changed=Uint8Array.from([...bytes,0]);bytes.fill(0);bytes=changed}
      if(fault==='count'||fault==='downgrade'){
        if(fault==='count')header[19]--;else header[0]=1
        const encoded=new TextEncoder().encode(JSON.stringify(header)),changed=new Uint8Array(4+encoded.length+bytes.length-4-size)
        new DataView(changed.buffer).setUint32(0,encoded.length);changed.set(encoded,4);changed.set(bytes.subarray(4+size),4+encoded.length);bytes.fill(0);bytes=changed
      }
      // Fixture-only forgery uses new native random nonces, never reuses a
      // production slot for a changed plaintext, and exposes no keys to Node.
      const nonces:string[]=[raw.browser.frame.nonce,raw[purpose].frame.nonce,control.browser.nonce,control.tab.nonce].map(v=>JSON.stringify(Array.from(new Uint8Array(v))))
      for(const [role,row] of [['browser',raw.browser],['tab',raw[purpose]]] as const){
        const nonce=new Uint8Array(12);w.providerFixture.nativeRandom(nonce)
        if(nonces.includes(JSON.stringify(Array.from(nonce))))throw Error('Fixture nonce collision')
        nonces.push(JSON.stringify(Array.from(nonce)))
        control[role]={nonce:nonce.buffer,ciphertext:await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(row),tagLength:128},row.key,bytes)}
      }
      bytes.fill(0)
      const tx=db.transaction('owners','readwrite');Reflect.apply(w.providerFixture.nativePut,tx.objectStore('owners'),[control,name])
      await new Promise<void>((yes,no)=>{tx.oncomplete=()=>yes();tx.onabort=()=>no(tx.error)})
      return JSON.stringify(control,(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v)
    }finally{db.close()}
  },fault)
  await beginPrivateColdRecovery(page,'provider-returned');await page.waitForFunction('privateColdDone')
  expect(await page.evaluate('privateColdOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('({put:effects.put,entropy:effects.entropy,key:effects.key,provider:effects.provider,socket:effects.socket})')).toEqual({put:0,entropy:0,key:0,provider:0,socket:0})
  expect(await page.evaluate(async()=>{
    const r=indexedDB.open('kithmoot-ordinary-state-v1',1),db=await new Promise<IDBDatabase>((yes,no)=>{r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)})
    try{return await new Promise<string>((yes,no)=>{const tx=db.transaction('owners'),get=tx.objectStore('owners').get('journal:tab:'+'a'.repeat(64));tx.oncomplete=()=>yes(JSON.stringify(get.result,(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v));tx.onabort=()=>no(tx.error)})}finally{db.close()}
  })).toBe(controlBefore)
})

for (const at of ['before','after']) test(`private renewal pipeline disposes setup when foreground retention fails ${at} reservation`, async ({page}) => {
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(at => {(window as any).privateRenewalRetainFailure=at},at)
  await beginPrivateRenewalPipeline(page); await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('[privatePipelineOutcome,providerFixture.signs,effects.put,effects.entropy]')).toEqual(['OrdinaryStateHold',1,0,0])
  expect(await page.evaluate('__privateRenewalResourceForTest()')).toMatchObject({disposed:true,revoked:true,tokens:0,tails:0,resources:0,state:'failed',
    material:{provider:false,raw:false,captured:false,request:false,statement:false,canonical:false,digest:false,secret:false,nonces:false}})
  await page.evaluate(() => {window.dispatchEvent(new PageTransitionEvent('pagehide'));window.dispatchEvent(new PageTransitionEvent('pagehide'))})
  await expect.poll(() => lockAvailable(page,'migration')).toBe(true)
})

test('private renewal pipeline rejects forged obligations without metadata or effects', async ({page}) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate(async () => {
    const w = window as any; let traps = 0, refused = 0
    const trap = () => { traps++; throw Error('forged private obligation metadata') }
    for (const fake of [{}, Object.freeze({}), new Proxy({}, {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap})]) {
      try { await w.__privateRenewForTest(fake) } catch { refused++ }
    }
    return [refused, traps, w.effects.put, w.effects.entropy, w.providerFixture.signs]
  })).toEqual([3, 0, 0, 0, 1])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const keep of [false, true]) test(`private renewal factory derives owned native intent without legacy binding, keep=${keep}`, async ({page}) => {
  await page.clock.install()
  await prepareControlStage(page, keep)
  await startPrivateForeground(page); await page.clock.fastForward(2_000)
  expect(await page.evaluate(async () => {
    const w = window as any, api = w.__privateRenewalRegistryForTest
    const claim = await w.__privateForegroundProbe.prepareRenewalFactory(), factory = api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim)
    let replay = false, interceptions = 0
    try { api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim) } catch { replay = true }
    const replaced = () => { interceptions++; throw Error('Replaced public private-renewal path') }
    for (const name of ['captureRenewalPredecessor', 'validatePairBinding', 'readPairMigrated', 'joinPairLifetime']) w.__privateOwnerPrototypeForTest.constructor[name] = replaced
    for (const name of ['isNativeSigner', 'nativeCurrent', 'nativeDeadline']) w.__privateForegroundClassForTest[name] = replaced
    const desired = await w.__privateForegroundProbe.renewalDesired()
    let result: unknown
    const work = w.__privateRenewalWorkForTest.registerPreparedStartup({}, async (root: unknown) => {
      const obligation = await api.prepareOrdinaryPrivateRenewalObligation(factory, root, desired)
      const held = api.takeOrdinaryPrivateRenewalObligation(obligation)
      let legacyRefused = false, duplicateRefused = false
      try { w.__legacyRenewalTakeForTest(obligation) } catch { legacyRefused = true }
      try { api.takeOrdinaryPrivateRenewalObligation(obligation) } catch { duplicateRefused = true }
      api.checkOrdinaryPrivateRenewalObligation(obligation)
      result = [held.factory === factory, held.root === root, held.intent.issuedAt === desired.issuedAt,
        held.intent.expiresAt === desired.expiresAt, held.intent.semanticDigest === desired.semanticDigest,
        Object.isFrozen(held), Object.isFrozen(held.intent), Object.keys(held).sort(), legacyRefused, duplicateRefused]
      api.releaseOrdinaryPrivateRenewalObligation(obligation)
    })
    try { await work.start() } finally { work.close(); await work.join(); api.closeOrdinaryPrivateRenewalFactory(factory) }
    return [replay, Object.isFrozen(factory), Reflect.ownKeys(factory).length, interceptions, result,
      w.providerFixture.signs, w.effects.put, w.effects.entropy, w.effects.socket]
  })).toEqual([true, true, 0, 0, [true, true, true, true, true, true, true, ['factory', 'intent', 'root'], true, true], 1, 0, 0, 0])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const keep of [false, true]) test(`private credential generation shares the native provider floor and retires its old timer, keep=${keep}`, async ({page}) => {
  await prepareControlStage(page,keep);await startPrivateForeground(page)
  expect(await page.evaluate('__privateGenerationFloorForTest()')).toMatchObject({serial:0,stopped:false,frozen:true,source:true,rows:true,predecessor:null,operation:true,reserved:false})
  expect(await page.evaluate(()=>{
    const w=window as any, timer=window.setTimeout;let armed=0
    window.setTimeout=((...args:Parameters<typeof setTimeout>)=>{armed++;return Reflect.apply(timer,window,args)}) as typeof setTimeout
    try{
      w.__privateInitialFloorTimerForTest();const initialArms=armed
      w.__privateAdvanceCredentialGenerationForTest();w.__privateAdvanceCredentialGenerationForTest()
      w.__privateInitialFloorTimerForTest()
      return {initialArms,staleArms:armed-initialArms,state:w.__privateGenerationFloorForTest()}
    }finally{window.setTimeout=timer}
  })).toMatchObject({initialArms:1,staleArms:0,state:{serial:2,stopped:false,frozen:true,source:true,rows:true,reserved:false}})
  // This exercises invalidation of an old callback, not live adoption or a
  // new generation's timer arm. The original signed expiry is unchanged.
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

for(const stage of ['construction','claim','opened'] as const)test(`private renewal factory remains bound to its exact credential generation at ${stage}`,async({page})=>{
  await page.clock.install();await prepareControlStage(page);await startPrivateForeground(page);await page.clock.fastForward(2_000)
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  expect(await page.evaluate(async stage=>{
    const w=window as any,api=w.__privateRenewalRegistryForTest;let refused=0,traps=0,initialCurrent=true
    if(stage==='construction')w.privateRenewalGenerationCut=stage
    let claim:any,factory:any,desired:any
    try{claim=await w.__privateForegroundProbe.prepareRenewalFactory()}catch{refused++}
    if(stage!=='construction'){
      if(stage==='opened'){
        factory=api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim)
        desired=await w.__privateForegroundProbe.renewalDesired()
      }
      initialCurrent=w.__privateRenewalFactoryCurrentForTest()
      w.__privateAdvanceCredentialGenerationForTest();w.__privateAdvanceCredentialGenerationForTest()
      if(stage==='claim'){
        for(let i=0;i<2;i++)try{api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim)}catch{refused++}
      }else{
        const hostile=new Proxy(desired,{get(){traps++;throw Error('Stale desired getter')},getPrototypeOf(){traps++;throw Error('Stale desired prototype')}})
        const work=w.__privateRenewalWorkForTest.registerPreparedStartup({},async(root:unknown)=>{
          try{await api.prepareOrdinaryPrivateRenewalObligation(factory,root,hostile)}catch{refused++}
        })
        try{await work.start()}finally{work.close();await work.join();api.closeOrdinaryPrivateRenewalFactory(factory)}
      }
    }
    // A new identity does not reset the permanently spent standalone path.
    try{await w.__privateForegroundProbe.prepareRenewalFactory()}catch{refused++}
    return {refused,traps,initialCurrent,current:w.__privateRenewalFactoryCurrentForTest()}
  },stage)).toEqual({refused:stage==='claim'?3:2,traps:0,initialCurrent:true,current:false})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

test('private renewal factory refuses forged claims and handles before caller reflection', async ({page}) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate(async () => {
    const w = window as any, api = w.__privateRenewalRegistryForTest
    let traps = 0, refused = 0
    const proxy = new Proxy({}, {get() { traps++; throw Error('foreign factory getter') }, ownKeys() { traps++; return [] },
      getPrototypeOf() { traps++; return Object.prototype }})
    for (const fake of [{}, Object.freeze({}), proxy]) {
      try { api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(fake) } catch { refused++ }
      try { await api.prepareOrdinaryPrivateRenewalObligation(fake, proxy, proxy) } catch { refused++ }
      try { api.takeOrdinaryPrivateRenewalObligation(fake) } catch { refused++ }
    }
    return [refused, traps, w.providerFixture.signs, w.effects.put, w.effects.entropy]
  })).toEqual([9, 0, 1, 0, 0])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('private renewal factory refuses swapped scope families without effects', async ({page}) => {
  await page.clock.install(); await prepareControlStage(page); await startPrivateForeground(page)
  await page.clock.fastForward(2_000)
  expect(await page.evaluate(async () => {
    const w = window as any, api = w.__privateRenewalRegistryForTest
    w.providerFixture.renewalScopeFamily = 'signet'
    const claim = await w.__privateForegroundProbe.prepareRenewalFactory(), factory = api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim)
    const desired = await w.__privateForegroundProbe.renewalDesired()
    let refused = false
    const work = w.__privateRenewalWorkForTest.registerPreparedStartup({}, async (root: unknown) => {
      try { await api.prepareOrdinaryPrivateRenewalObligation(factory, root, desired) } catch { refused = true }
    })
    try { await work.start() } finally { work.close(); await work.join(); api.closeOrdinaryPrivateRenewalFactory(factory) }
    return [refused, w.providerFixture.signs, w.effects.put, w.effects.entropy, w.effects.socket]
  })).toEqual([true, 1, 0, 0, 0])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('private renewal intent refuses accessor data and root replay without reading getters', async ({page}) => {
  await page.clock.install(); await prepareControlStage(page); await startPrivateForeground(page)
  await page.clock.fastForward(2_000)
  expect(await page.evaluate(async () => {
    const w = window as any, api = w.__privateRenewalRegistryForTest
    const claim = await w.__privateForegroundProbe.prepareRenewalFactory(), factory = api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim)
    const desired = await w.__privateForegroundProbe.renewalDesired()
    let refused = 0, getters = 0
    const hostile = {...desired}
    Object.defineProperty(hostile, 'issuedAt', {enumerable: true, get() { getters++; return desired.issuedAt }})
    const work = w.__privateRenewalWorkForTest.registerPreparedStartup({}, async (root: unknown) => {
      try { await api.prepareOrdinaryPrivateRenewalObligation(factory, root, hostile) } catch { refused++ }
      try { await api.prepareOrdinaryPrivateRenewalObligation(factory, root, desired) } catch { refused++ }
    })
    try { await work.start() } finally { work.close(); await work.join(); api.closeOrdinaryPrivateRenewalFactory(factory) }
    return [refused, getters, w.providerFixture.signs, w.effects.put, w.effects.entropy]
  })).toEqual([2, 0, 1, 0, 0])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('private renewal claim stays spent after native revocation', async ({page}) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  await page.evaluate(async () => { const w = window as any; w.renewalClaim = await w.__privateForegroundProbe.prepareRenewalFactory() })
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate(() => {
    const w = window as any; let refused = 0
    for (let i = 0; i < 2; i++) try { w.__privateRenewalRegistryForTest.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(w.renewalClaim) } catch { refused++ }
    return [refused, w.providerFixture.signs, w.effects.put, w.effects.entropy]
  })).toEqual([2, 1, 0, 0])
})

test('private authority tokens refuse forged handles before caller reflection', async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  expect(await page.evaluate(() => {
    const w = window as any, api = w.__privateAuthorityFunctions, pair = w.__privateForegroundProbe.tokens()
    let getters = 0, refused = 0
    const hostile = new Proxy({}, { get() { getters++; throw Error('forged handle getter') },
      getPrototypeOf() { getters++; throw Error('forged handle prototype') },
      ownKeys() { getters++; throw Error('forged handle keys') } })
    for (const fake of [{}, Object.freeze({}), hostile]) {
      if (api.current(fake, pair.native, w.providerFixture.account) === false) refused++
      if (api.current(pair.authority, fake, w.providerFixture.account) === false) refused++
      if (api.nativeCurrent(fake) === false) refused++
      try { api.deadline(fake, pair.native, hostile, hostile, hostile, w.providerFixture.account) } catch { refused++ }
      try { api.borrow(pair.authority, fake, hostile, hostile, hostile, hostile) } catch { refused++ }
      try { api.validate(fake, hostile, hostile, hostile) } catch { refused++ }
    }
    return [refused, getters, Object.isFrozen(pair.authority), Object.isFrozen(pair.native),
      Reflect.ownKeys(pair.authority).length, Reflect.ownKeys(pair.native).length, w.__privateForegroundProbe.current()]
  })).toEqual([18, 0, true, true, 0, 0, true])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

for (const hostile of [false, true]) test(`private authority credential borrow uses fixed native deadline and guarded SDK, hostile=${hostile}`, async ({ page }) => {
  await prepareControlStage(page, hostile, hostile); await startPrivateForeground(page)
  expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  if (hostile) await page.evaluate('providerFixture.proofProxy=true;undefined')
  await page.evaluate(() => {
    const w = window as any
    w.authorityDispatches = 0
    const replaced = () => { w.authorityDispatches++; throw Error('Replaced public authority method') }
    const owner = w.__privateOwnerPrototypeForTest.constructor, foreground = w.__privateForegroundClassForTest
    for (const name of ['validatePairBinding', 'readPairMigrated', 'joinPairLifetime']) owner[name] = replaced
    for (const name of ['isNativeSigner', 'nativeCurrent', 'nativeDeadline', 'borrowNativeSignEvent']) foreground[name] = replaced
    for (const name of ['signEvent', 'borrowSignEvent', 'revoke', 'close']) foreground.prototype[name] = replaced
    Object.defineProperty(owner, Symbol.hasInstance, { value: replaced })
    Object.defineProperty(foreground, Symbol.hasInstance, { value: replaced })
  })
  expect(await page.evaluate('__privateForegroundProbe.current()')).toBe(true)
  expect(await page.evaluate('__privateForegroundProbe.deadline()')).toBe(null)
  expect(await page.evaluate(async () => {
    const w = window as any
    w.credentialConsumerChecks = 0; w.credentialConsumerGuarded = true
    const input = { live: () => true, validate: () => {
      w.credentialConsumerChecks++; w.credentialConsumerGuarded &&= !!w.__foregroundDecision
    } }
    const sign = await w.__privateForegroundProbe.borrowCredential(input)
    input.validate = () => { throw Error('Changed consumer alias') }
    w.providerFixture.foregroundExpected = true
    const event = await sign({ kind: 20460, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['d', 'ab'.repeat(32)]] })
    return [event.kind, event.pubkey === w.providerFixture.account, Object.isFrozen(event), Object.isFrozen(sign),
      w.authorityDispatches, w.credentialConsumerChecks > 1, w.credentialConsumerGuarded, w.providerFixture.foregroundGuarded,
      w.providerFixture.providerOutside ?? 0, w.providerFixture.proofOutside ?? 0]
  })).toEqual([20460, true, true, true, 0, true, true, true, 0, 0])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.signs,effects.put,effects.socket]')).toEqual([2, 0, 0])
})

test('private authority refuses foreign views and expired read custody before consumer callbacks', async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate('__privateForegroundProbe.refuseWrongViews()')).toEqual([3, 0])
  expect(await page.evaluate(() => {
    const w = window as any, pair = w.__privateForegroundProbe.tokens(), stale = w.__stalePrivateAuthorityRead
    let getters = 0
    const consumer = new Proxy({}, { get() { getters++; throw Error('stale consumer getter') },
      getPrototypeOf() { getters++; throw Error('stale consumer prototype') } })
    try { w.__privateAuthorityFunctions.borrow(pair.authority, pair.native, stale.browser, stale.tab, stale.custody, consumer); return ['accepted', getters] }
    catch { return ['refused', getters] }
  })).toEqual(['refused', 0])
  expect(await page.evaluate('providerFixture.signs')).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
})

test('private authority credential borrow refuses another event kind before provider start', async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate(async () => {
    const w = window as any, sign = await w.__privateForegroundProbe.borrowCredential({ live: () => true, validate: () => {} })
    try { await sign({ kind: 1, created_at: Math.floor(Date.now() / 1000), content: 'not a credential', tags: [] }); return 'signed' }
    catch (error) { return (error as Error).name }
  })).toBe('OrdinaryStateHold')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.signs,effects.put,effects.socket]')).toEqual([1, 0, 0])
})

test('private authority tokens stay revoked after root close without inspecting stale inputs', async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate(() => {
    const w = window as any, pair = w.__privateForegroundProbe.tokens(), api = w.__privateAuthorityFunctions
    let getters = 0, refused = 0
    const hostile = new Proxy({}, { get() { getters++; throw Error('closed token input') },
      getPrototypeOf() { getters++; throw Error('closed token prototype') } })
    try { api.deadline(pair.authority, pair.native, hostile, hostile, hostile, w.providerFixture.account) } catch { refused++ }
    try { api.borrow(pair.authority, pair.native, hostile, hostile, hostile, hostile) } catch { refused++ }
    return [api.current(pair.authority, pair.native, w.providerFixture.account), api.nativeCurrent(pair.native), refused, getters]
  })).toEqual([false, false, 2, 0])
})

test('private authority handles cannot cross document roots or revive after native replacement', async ({ page }) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  expect(await page.evaluate('__privateForegroundProbe.current()')).toBe(true)
  const opening = page.waitForEvent('popup')
  await page.evaluate(url => { (window as any).authorityObserver = window.open(url, 'private-authority-observer') }, origin + '/outside/modern')
  const observer = await opening
  try {
    await observer.waitForLoadState('load')
    await observer.evaluate(() => {
      sessionStorage.removeItem('kithmoot.ordinary-tab.v1')
      const w = window as any
      w.authorityObserverFence = new w.FenceOnly.OrdinaryClientFence()
    })
    await page.evaluate(() => {
      const w = window as any, other = w.authorityObserver
      other.retainedAuthorityTokens = w.__privateForegroundProbe.tokens()
      other.retainedAuthorityCurrent = w.__privateAuthorityFunctions.current
    })
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    // Replace this test origin's native fixture only after its actual root has
    // joined and closed. The observer retains the genuine old opaque objects.
    await page.goto(origin + '/j/setup')
    await page.evaluate(() => new Promise<void>((yes, no) => {
      const request = indexedDB.deleteDatabase((window as any).Ordinary.ORDINARY_DATABASE)
      request.onsuccess = () => yes(); request.onerror = () => no(request.error)
      request.onblocked = () => no(Error('Old native root did not release its database'))
    }))
    await prepareControlStage(page); await startPrivateForeground(page)
    expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
    expect(await page.evaluate(() => {
      const w = window as any, other = window.open('', 'private-authority-observer') as any
      const old = other.retainedAuthorityTokens, current = w.__privateForegroundProbe.tokens(), api = w.__privateAuthorityFunctions
      let getters = 0, refused = 0
      const hostile = new Proxy({}, { get() { getters++; throw Error('Cross-root input') } })
      for (const [authority, native] of [[current.authority, old.native], [old.authority, current.native]]) {
        try { api.borrow(authority, native, hostile, hostile, hostile, hostile) } catch { refused++ }
      }
      return [other.retainedAuthorityCurrent(old.authority, old.native, w.providerFixture.account),
        api.current(current.authority, old.native, w.providerFixture.account), api.current(old.authority, current.native, w.providerFixture.account),
        api.current(current.authority, current.native, w.providerFixture.account), refused, getters]
    })).toEqual([false, false, false, true, 2, 0])
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  } finally { await observer.close() }
})

test('private renewal factory rechecks a newly arrived unresponsive outside client', async ({page, context}) => {
  await prepareControlStage(page); await startPrivateForeground(page)
  const other = await context.newPage(); await other.goto(origin + '/outside/legacy')
  try {
    const outcome = await page.evaluate(async () => {
      const w = window as any
      try { await w.__privateForegroundProbe.prepareRenewalFactory(); return 'minted' }
      catch (error) { return (error as Error).name }
    })
    expect(outcome).toBe('OrdinaryStateHold')
  } finally {
    await other.close(); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  }
})

for (const stage of ['claim', 'intent'] as const) for (const reject of [false, true])
  test(`private renewal ${stage} retains native locks through a revoked delayed client probe, reject=${reject}`, async ({page}) => {
    await page.clock.install(); await prepareControlStage(page); await startPrivateForeground(page)
    await page.clock.fastForward(2_000)
    await page.evaluate(async ({stage, reject}) => {
      const w = window as any, api = w.__privateRenewalRegistryForTest
      if (stage === 'intent') {
        const claim = await w.__privateForegroundProbe.prepareRenewalFactory()
        w.delayedRenewalFactory = api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim)
        w.delayedRenewalDesired = await w.__privateForegroundProbe.renewalDesired()
      }
      // Claim probe 3 and intent probe 2 follow the actual native read.
      w.privateRenewalClientCut = {calls: 0, at: stage === 'claim' ? 3 : 2, reject}
      w.delayedRenewalDone = false; w.delayedRenewalPublished = false
      const run = async (root?: unknown) => {
        try {
          if (stage === 'claim') await w.__privateForegroundProbe.prepareRenewalFactory()
          else await api.prepareOrdinaryPrivateRenewalObligation(w.delayedRenewalFactory, root, w.delayedRenewalDesired)
          w.delayedRenewalPublished = true; w.delayedRenewalOutcome = 'published'
        } catch (error) { w.delayedRenewalOutcome = (error as Error).name }
        finally { w.delayedRenewalDone = true }
      }
      if (stage === 'intent') {
        w.delayedRenewalWork = w.__privateRenewalWorkForTest.registerPreparedStartup({}, run)
        w.delayedRenewalPending = w.delayedRenewalWork.start()
      } else w.delayedRenewalPending = run()
    }, {stage, reject})
    await page.waitForFunction('privateRenewalClientCut.entered')
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    expect(await page.evaluate('({done:delayedRenewalDone,published:delayedRenewalPublished})')).toEqual({done: false, published: false})
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    await page.evaluate(async () => {
      const w = window as any
      w.privateRenewalClientCut.release(); await w.delayedRenewalPending
      if (w.delayedRenewalWork) { w.delayedRenewalWork.close(); await w.delayedRenewalWork.join() }
      if (w.delayedRenewalFactory) w.__privateRenewalRegistryForTest.closeOrdinaryPrivateRenewalFactory(w.delayedRenewalFactory)
    })
    expect(await page.evaluate('({done:delayedRenewalDone,published:delayedRenewalPublished,outcome:delayedRenewalOutcome,signs:providerFixture.signs,put:effects.put,entropy:effects.entropy,socket:effects.socket})'))
      .toEqual({done: true, published: false, outcome: 'OrdinaryStateHold', signs: 1, put: 0, entropy: 0, socket: 0})
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  })


test('private renewal intent fences an outside client arriving after factory creation', async ({page, context}) => {
  await page.clock.install(); await prepareControlStage(page); await startPrivateForeground(page)
  await page.clock.fastForward(2_000)
  await page.evaluate(async () => {
    const w = window as any, api = w.__privateRenewalRegistryForTest
    w.outsideIntentFactory = api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(await w.__privateForegroundProbe.prepareRenewalFactory())
    w.outsideIntentDesired = await w.__privateForegroundProbe.renewalDesired()
  })
  const other = await context.newPage(); await other.goto(origin + '/outside/legacy')
  try {
    expect(await page.evaluate(async () => {
      const w = window as any, api = w.__privateRenewalRegistryForTest
      let outcome: string | undefined, published = false
      const work = w.__privateRenewalWorkForTest.registerPreparedStartup({}, async (root: unknown) => {
        try { await api.prepareOrdinaryPrivateRenewalObligation(w.outsideIntentFactory, root, w.outsideIntentDesired); published = true }
        catch (error) { outcome = (error as Error).name }
      })
      try { await work.start() } finally { work.close(); await work.join(); api.closeOrdinaryPrivateRenewalFactory(w.outsideIntentFactory) }
      return [outcome, published, w.__seenPrivateRenewalWitness === undefined, w.providerFixture.signs, w.effects.put, w.effects.entropy, w.effects.socket]
    })).toEqual(['OrdinaryStateHold', false, true, 1, 0, 0, 0])
  } finally {
    await other.close(); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  }
})

for (const stage of ['claim', 'intent'] as const)
  test(`private renewal ${stage} post-read client fence refuses a newly arrived outside client`, async ({page, context}) => {
    await page.clock.install(); await prepareControlStage(page); await startPrivateForeground(page)
    await page.clock.fastForward(2_000)
    await page.evaluate(async stage => {
      const w = window as any, api = w.__privateRenewalRegistryForTest
      if (stage === 'intent') {
        w.lateOutsideFactory = api.openOrdinaryPrivateRenewalFactoryFromOwnerClaim(await w.__privateForegroundProbe.prepareRenewalFactory())
        w.lateOutsideDesired = await w.__privateForegroundProbe.renewalDesired()
      }
      // Pause before the real post-read worker enumeration, never after it.
      w.privateRenewalClientCut = {calls: 0, at: stage === 'claim' ? 3 : 2, before: true}
      w.lateOutsideDone = false; w.lateOutsidePublished = false
      const run = async (root?: unknown) => {
        try {
          if (stage === 'claim') await w.__privateForegroundProbe.prepareRenewalFactory()
          else await api.prepareOrdinaryPrivateRenewalObligation(w.lateOutsideFactory, root, w.lateOutsideDesired)
          w.lateOutsidePublished = true; w.lateOutsideOutcome = 'published'
        } catch (error) {
          w.lateOutsideOutcome = (error as Error).name
          try {
            if (stage === 'claim') w.__takePrivateRenewalClaimForTest(w.__seenPrivateRenewalClaim)
            else w.__takePrivateRenewalIntentForTest(w.lateOutsideFactory, root, w.__seenPrivateRenewalWitness)
            w.lateOutsideTokenOutcome = 'consumed'
          } catch (error) { w.lateOutsideTokenOutcome = (error as Error).name }
        } finally { w.lateOutsideDone = true }
      }
      if (stage === 'intent') {
        w.lateOutsideWork = w.__privateRenewalWorkForTest.registerPreparedStartup({}, run)
        w.lateOutsidePending = w.lateOutsideWork.start()
      } else w.lateOutsidePending = run()
    }, stage)
    await page.waitForFunction('privateRenewalClientCut.entered')
    expect(await page.evaluate(stage => {
      const w = window as any
      return [w.lateOutsideDone, w.lateOutsidePublished, !!(stage === 'claim' ? w.__seenPrivateRenewalClaim : w.__seenPrivateRenewalWitness)]
    }, stage)).toEqual([false, false, true])
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    const other = await context.newPage(); await other.goto(origin + '/outside/legacy')
    try {
      await page.evaluate(async () => { const w = window as any; w.privateRenewalClientCut.release(); await w.lateOutsidePending })
      expect(await page.evaluate('({done:lateOutsideDone,published:lateOutsidePublished,outcome:lateOutsideOutcome,token:lateOutsideTokenOutcome,signs:providerFixture.signs,put:effects.put,entropy:effects.entropy,socket:effects.socket})'))
        .toEqual({done: true, published: false, outcome: 'OrdinaryStateHold', token: 'OrdinaryStateHold', signs: 1, put: 0, entropy: 0, socket: 0})
      // A failed child probe cannot release the still-live parent lifetime.
      expect(await lockAvailable(page, 'migration')).toBe(false)
      expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(false)
    } finally {
      await other.close()
      await page.evaluate(async () => {
        const w = window as any
        if (w.lateOutsideWork) { w.lateOutsideWork.close(); await w.lateOutsideWork.join() }
        if (w.lateOutsideFactory) w.__privateRenewalRegistryForTest.closeOrdinaryPrivateRenewalFactory(w.lateOutsideFactory)
        window.dispatchEvent(new PageTransitionEvent('pagehide'))
      })
      await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
      expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
    }
  })

for(const fault of ['wrong-key','wrong-algorithm','wrong-tag','reordered'])test(`private renewal bounded adversarial refuses late candidate-committed sealer ${fault}`,async({page})=>{
  await preparePrivateRenewalPipeline(page)
  await page.evaluate(fault=>{
    const w=window as any;w.privateLateSealFault=fault;w.privateLateSealNativeCalls=0
    const encrypt=crypto.subtle.encrypt.bind(crypto.subtle)
    crypto.subtle.encrypt=((...args:Parameters<SubtleCrypto['encrypt']>)=>{
      if(w.privateLateSealFaultUsed)w.privateLateSealNativeCalls++
      return encrypt(...args)
    }) as SubtleCrypto['encrypt']
  },fault)
  await beginPrivateRenewalPipeline(page);await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('[privatePipelineOutcome,privateLateSealFaultUsed,privateLateSealNativeCalls,effects.entropy,providerFixture.signs]'))
    .toEqual(['OrdinaryStateHold',true,0,20,2])
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'candidate-prepared',initialGenerationUnchanged:true})
  expect(await page.evaluate('privateRenewalPackets.some(p=>p.phase===\'candidate-committed\'||p.phase===\'settled\')')).toBe(false)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

for(const boundary of ['C','S'] as const)test(`private renewal bounded adversarial native ${boundary} overflow refuses before effects`,async({page})=>{
  test.setTimeout(120_000)
  // First measure an acknowledged reference operation. Then seed a separate
  // native origin image with ordinary padding before any private root capture.
  // The actual 32 MiB limit is unchanged; this is no post-authentication patch.
  await preparePrivateRenewalPipeline(page);await beginPrivateRenewalPipeline(page);await page.waitForFunction('privatePipelineDone')
  expect(await page.evaluate('privatePipelineOutcome')).toBe('settled')
  const baseline=await page.evaluate<{C:number;S:number}>(()=>{
    const w=window as any,c=w.privateRenewalEncryptedCohorts
    return {C:c['candidate-committed']['tab:'+'a'.repeat(64)].frame.ciphertext.byteLength-16,S:c.settled['tab:'+'a'.repeat(64)].frame.ciphertext.byteLength-16}
  })
  expect(baseline.S-baseline.C).toBeGreaterThan(32)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  await page.evaluate(()=>new Promise<void>((yes,no)=>{
    const r=indexedDB.deleteDatabase('kithmoot-ordinary-state-v1');r.onsuccess=()=>yes();r.onerror=()=>no(r.error);r.onblocked=()=>no(Error('Fixture reset blocked'))
  }))
  await prepareControlStage(page,false,true,undefined,async()=>{
    await page.evaluate(async({baseline,boundary})=>{
      const w=window as any,o=w.Ordinary,images=await w.images(),image=images[1],before=o.ordinaryImageByteLength(image)
      const records=new Map<string,string>(image.records),chunk=o.ORDINARY_VALUE_BYTES-1
      for(let i=0;i<4;i++)records.set('native-capacity-fixture.'+i,i<3?'x'.repeat(chunk):'')
      const delta=o.ordinaryImageByteLength({...image,records})-before
      // C overflow is unambiguous; S-only overflow leaves32 bytes of C
      // headroom. Fixed-width random fields cannot alter this projection.
      const needed=o.ORDINARY_IMAGE_BYTES+(boundary==='C'?128:-32)-baseline.C-delta
      if(needed<0||needed>=o.ORDINARY_VALUE_BYTES)throw Error('Native padding fixture outside per-record bound')
      records.set('native-capacity-fixture.3','x'.repeat(needed))
      const scope=await w.tabOwner.capture(w.invScopeName,w.guard)
      await w.tabOwner.mutateMigrated(scope,w.guard,(store:any)=>{for(const [name,value] of records)if(name.startsWith('native-capacity-fixture.'))store.set(name,value)})
      images.forEach((v:any)=>{v.records.clear();v.fences.clear()});records.clear()
    },{baseline,boundary})
  })
  await startPrivateForeground(page);await page.clock.fastForward(2_000)
  await page.evaluate(boundary=>{(window as any).privateCapacityExpected=boundary},boundary)
  await beginPrivateRenewalPipeline(page);await page.waitForFunction('privatePipelineDone')
  const observed=await page.evaluate('({outcome:privatePipelineOutcome,stage:window.privateCapacityStage??null,entropy:effects.entropy,put:effects.put,signs:providerFixture.signs})')
  if((observed as any).stage!==boundary)console.log('Native capacity refusal',JSON.stringify({observed,holds:await page.evaluate('window.__privateRenewalHolds??[]')}))
  expect(observed).toMatchObject({outcome:'OrdinaryStateHold',stage:boundary,entropy:0,put:0,signs:1})
  expect((await inspectPrivateColdState(page)).operations).toEqual([])
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

async function beginPrivateBootstrapLoad(page:Page):Promise<void>{
  await page.evaluate(()=>{
    const w=window as any;w.privateBootstrapDone=false;w.privateBootstrapTesting=true;w.privateBootstrapLegacyFactoryCalls=0
    try{w.privateBootstrapPending=w.__privateForegroundProbe.loadMember().then((value:unknown)=>{
      w.privateBootstrapOutcome='loaded';w.privateBootstrapVoid=value===undefined
    },(error:Error)=>{w.privateBootstrapOutcome=error.name}).finally(()=>{w.privateBootstrapDone=true})}
    catch(error){w.privateBootstrapOutcome=(error as Error).name;w.privateBootstrapDone=true}
  })
}
for(const keep of [false,true])test(`private bootstrap owned load retains material without effects, keep=${keep}`,async({page})=>{
  await prepareControlStage(page,keep,true);await startPrivateForeground(page)
  expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
  expect(await page.evaluate('window.__privateBootstrapModuleEvaluated??0')).toBe(0)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  if(await page.evaluate('privateBootstrapOutcome')!=='loaded')console.log('Private bootstrap hold',await page.evaluate('JSON.stringify({outcome:privateBootstrapOutcome,providerFailure:window.__providerFailure,holds:window.__privateRenewalHolds,entropy:privateEntropyCalls})'))
  expect(await page.evaluate('[privateBootstrapOutcome,privateBootstrapVoid,__privateBootstrapModuleEvaluated]')).toEqual(['loaded',true,1])
  expect(await page.evaluate('__privateBootstrapResourceForTest()')).toMatchObject({closed:false,material:true,legacy:false,operation:true,retained:[32,32,32]})
  expect(await page.evaluate('privateBootstrapLegacyFactoryCalls')).toBe(0)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateBootstrapResourceForTest()')).toMatchObject({closed:true,material:false,work:0,retained:[]})
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})

for(const fault of ['account','participant','invitation','room','operation','keep','link','credential','bootstrap-expiry','browser-scope','tab-scope'])test(`private bootstrap refuses selected binding ${fault} without effects`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  await page.evaluate(fault=>{(window as any).privateBootstrapSelectionFault=fault},fault)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  expect(await page.evaluate('privateBootstrapLegacyFactoryCalls')).toBe(0)
})
for(const stage of ['before-import','after-import','before-claim','before-load','after-load','close'])for(const reject of [false,true])test(`private bootstrap joins revoked ${stage} tail, reject=${reject}`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(({stage,reject})=>{(window as any).privateBootstrapGate={stage,reject}}, {stage,reject})
  await beginPrivateBootstrapLoad(page)
  if(stage==='close'){await page.waitForFunction('privateBootstrapDone');expect(await page.evaluate('privateBootstrapOutcome')).toBe('loaded')}
  else await page.waitForFunction('privateBootstrapGate.entered')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await page.waitForFunction('privateBootstrapGate.entered')
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await lockAvailable(page,'lifetime:'+'a'.repeat(64))).toBe(false)
  expect(await page.evaluate('providerFixture.closeCalls??0')).toBe(0)
  if(stage!=='close')expect(await page.evaluate('privateBootstrapDone')).toBe(false)
  await page.evaluate('privateBootstrapGate.release();undefined')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe(stage==='close'?'loaded':'OrdinaryStateHold')
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  if(stage==='after-load'||stage==='close')expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})
for(const stage of ['claim-consumed','after-resource','after-load'])test(`private bootstrap closes after synchronous ${stage} revocation`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(stage=>{(window as any).privateBootstrapCut=stage},stage)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  if(stage==='after-load')expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})
for(const read of [1,2,3,4])test(`private bootstrap refuses revoked native decision ${read}`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(read=>{(window as any).privateBootstrapReadCut=read},read)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})
test('private bootstrap refuses forged and replayed claims and resources without reflection',async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('loaded')
  const result=await page.evaluate(async()=>{
    const w=window as any,f=w.__privateBootstrapFunctionsForTest;let reflections=0
    const fake=new Proxy({},{get(){reflections++;throw Error('Untrusted bootstrap reflection')},getPrototypeOf(){reflections++;throw Error('Untrusted bootstrap prototype')}})
    const result=[]
    for(const action of [()=>f.open(fake),()=>f.open(w.__seenPrivateBootstrapClaim),()=>f.completed(fake),()=>f.stop(fake),()=>f.close(fake),()=>new w.__privateBootstrapClassForTest({kind:'private',permit:fake})]){
      try{await action();result.push('unexpected success')}catch(error){result.push((error as Error).name)}
    }
    return {result,reflections}
  })
  expect(result).toEqual({result:Array(6).fill('OrdinaryStateHold'),reflections:0})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('private bootstrap bypasses replaced public bootstrap owner and foreground methods',async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  await page.evaluate(()=>{
    const w=window as any;w.privateBootstrapReplacePublic=true;w.privateBootstrapPublicDispatches=0
    const fail=()=>{w.privateBootstrapPublicDispatches++;throw Error('Public native dispatch')}
    const owner=w.__privateOwnerPrototypeForTest.constructor,fg=w.__privateForegroundClassForTest
    for(const name of ['readPairMigrated','joinPairLifetime','validatePairBinding'])owner[name]=fail
    w.__privateOwnerPrototypeForTest.capture=fail
    for(const name of ['nativeDeadline','nativeCurrent','open'])fg[name]=fail
    fg.prototype.close=fail
  })
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('[privateBootstrapOutcome,privateBootstrapPublicDispatches]')).toEqual(['loaded',0])
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('privateBootstrapPublicDispatches')).toBe(0)
})
test('private bootstrap second child start cannot replace an owned pending first load',async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  await page.evaluate(()=>{(window as any).privateBootstrapGate={stage:'before-load'}})
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapGate.entered')
  expect(await page.evaluate(async()=>{try{await(window as any).__privateForegroundProbe.loadMember();return 'unexpected'}catch(error){return(error as Error).name}})).toBe('OrdinaryStateHold')
  expect(await page.evaluate('privateBootstrapDone')).toBe(false)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate('privateBootstrapGate.release();undefined')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('OrdinaryStateHold')
})

for(const first of ['bootstrap','renewal'] as const)test(`private bootstrap and renewal exclude a ${first} start before awaiting`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  if(first==='bootstrap'){
    await page.evaluate(()=>{(window as any).privateBootstrapGate={stage:'before-import'}})
    await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapGate.entered')
    expect(await page.evaluate(async()=>{try{await(window as any).__privateForegroundProbe.prepareRenewalFactory();return 'unexpected'}catch(error){return(error as Error).name}})).toBe('OrdinaryStateHold')
    expect(await page.evaluate('privateBootstrapDone')).toBe(false)
    await page.evaluate('privateBootstrapGate.release();undefined');await page.waitForFunction('privateBootstrapDone')
    expect(await page.evaluate('privateBootstrapOutcome')).toBe('loaded')
  }else{
    await page.evaluate(async()=>{(window as any).privateBootstrapExcludedRenewalClaim=await(window as any).__privateForegroundProbe.prepareRenewalFactory()})
    await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
    expect(await page.evaluate('[privateBootstrapOutcome,window.__privateBootstrapModuleEvaluated??0]')).toEqual(['OrdinaryStateHold',0])
  }
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
for(const fault of ['device','seal','root','credential','admission'])test(`private bootstrap final native decision refuses changed retained ${fault}`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(fault=>{(window as any).privateBootstrapMaterialFault=fault},fault)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('[privateBootstrapOutcome,privateBootstrapMaterialFaultUsed,__privateBootstrapWipedForTest()]')).toEqual(['OrdinaryStateHold',true,true])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})
for(const fault of ['provider','sdk','native','controller','expiry','credential-floor'] as const)test(`private bootstrap refuses ${fault} change after material assignment`,async({page})=>{
  if(fault==='expiry'||fault==='credential-floor')await page.clock.install()
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(()=>{(window as any).privateBootstrapGate={stage:'after-load'}})
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapGate.entered')
  if(fault==='provider')await page.evaluate('window.nostr=providerFixture.current={}')
  else if(fault==='sdk')await page.evaluate("providerFixture.sdk.capabilities={...providerFixture.sdk.capabilities}")
  else if(fault==='native')await page.evaluate("import('/j/mutate-native.js').then(module=>module.advanceBrowserRevision())")
  else if(fault==='controller'){
    await page.evaluate(()=>navigator.serviceWorker.register('/j/sw.js?replacement',{scope:'/j/',updateViaCache:'none'}))
    await page.waitForFunction(()=>document.documentElement.dataset.ordinaryProtectedStartup==='held')
  }else await page.clock.fastForward(fault==='expiry'?3_601_000:1_201_000)
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.evaluate('privateBootstrapDone')).toBe(false)
  await page.evaluate('privateBootstrapGate.release();undefined');await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('[privateBootstrapOutcome,__privateBootstrapWipedForTest()]')).toEqual(['OrdinaryStateHold',true])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})
for(const at of [4,6,8,9,10])for(const reject of [false,true])test(`private bootstrap joins revoked current-client probe ${at}, reject=${reject}`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(({at,reject})=>{(window as any).privateRenewalClientCut={calls:0,at,reject}},{at,reject})
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateRenewalClientCut.entered')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await page.evaluate('privateBootstrapDone')).toBe(false)
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await lockAvailable(page,'lifetime:'+'a'.repeat(64))).toBe(false)
  expect(await page.evaluate('providerFixture.closeCalls??0')).toBe(0)
  await page.evaluate('privateRenewalClientCut.release();undefined');await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})
test('private bootstrap final native read refuses a newly arrived outside client',async({page,context})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(()=>{(window as any).privateBootstrapGate={stage:'after-load'}})
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapGate.entered')
  const other=await context.newPage();await other.goto(origin+'/outside/legacy')
  try{
    await page.evaluate('privateBootstrapGate.release();undefined');await page.waitForFunction('privateBootstrapDone')
    expect(await page.evaluate('[privateBootstrapOutcome,__privateBootstrapWipedForTest()]')).toEqual(['OrdinaryStateHold',true])
    await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
    expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  }finally{await other.close()}
})
async function preparePrivateBootstrapSuccessor(page:Page,keep:boolean):Promise<void>{
  await page.clock.install()
  await prepareControlStage(page,keep,true,undefined,async()=>{
    await page.evaluate('window.memberEpochTimeoutMs=10000')
    const existingControls=controls.replace('await bootstrap.bootstrap(evidence)','await bootstrap.load()')
    if(existingControls===controls)throw Error('Successor fixture setup drift')
    await page.evaluate(`(${existingControls})()`);await page.evaluate('member.join()')
    await page.clock.fastForward(901_000)
    await expect.poll(()=>page.evaluate(`(async()=>{try{const result=await bootstrap.load();try{return result.sealKeys.length}finally{Ordinary.wipeOrdinaryPersistentBootstrapResult(result)}}catch{return 0}})()`)).toBe(2)
    await page.evaluate('member.close()')
  })
  await startPrivateForeground(page);expect(await page.evaluate('privateForegroundOutcome')).toBe('ready')
}
for(const keep of [false,true])test(`private bootstrap loads an acknowledged successor with owned seal history, keep=${keep}`,async({page})=>{
  await preparePrivateBootstrapSuccessor(page,keep)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('loaded')
  expect(await page.evaluate('__privateBootstrapResourceForTest()')).toMatchObject({material:true,legacy:false,retained:[32,32,32,32,32]})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})
test('private bootstrap final decision refuses reordered successor seal history',async({page})=>{
  await preparePrivateBootstrapSuccessor(page,false)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(()=>{(window as any).privateBootstrapMaterialFault='seal-history'})
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('[privateBootstrapOutcome,privateBootstrapMaterialFaultUsed,__privateBootstrapWipedForTest()]')).toEqual(['OrdinaryStateHold',true,true])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})
test('private bootstrap failed first start keeps its latch spent and excludes renewal',async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await page.evaluate(()=>{(window as any).privateBootstrapGate={stage:'before-import',reject:true}})
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapGate.entered')
  await page.evaluate('privateBootstrapGate.release();undefined');await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('[privateBootstrapOutcome,__privateBootstrapLatchForTest(),window.__privateBootstrapModuleEvaluated??0]'))
    .toEqual(['OrdinaryStateHold',{bootstrap:true,renewal:false},0])
  expect(await page.evaluate(async()=>{
    const probe=(window as any).__privateForegroundProbe,result=[]
    for(const action of [()=>probe.loadMember(),()=>probe.prepareRenewalFactory()]){
      try{await action();result.push('unexpected')}catch(error){result.push((error as Error).name)}
    }
    return result
  })).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
  expect(await page.evaluate('__privateBootstrapLatchForTest()')).toEqual({bootstrap:true,renewal:false})
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})


async function beginPrivateMemberConstruction(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w=window as any;w.privateMemberDone=false;w.privateMemberConstruction=true
    w.privateMemberPending=w.__privateBootstrapFunctionsForTest.constructMember(w.__seenPrivateBootstrapResource).then(
      (value:unknown)=>{w.privateMemberOutcome='constructed';w.privateMemberVoid=value===undefined},
      (error:Error)=>{w.privateMemberOutcome=error.name}).finally(()=>{w.privateMemberDone=true})
  })
}
async function preparePrivateControllerConstruction(page: Page): Promise<void> {
  await prepareControlStage(page,false,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('loaded')
}
for(const keep of [false,true])test(`private member controller precedes actual Session and holds pre-armed scheduling, keep=${keep}`,async({page})=>{
  await prepareControlStage(page,keep,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('[privateMemberOutcome,__privateControllerOrder]')).toEqual(['constructed',['controller','session','attached']])
  expect(await page.evaluate('__privateControllerForTest()')).toEqual({closed:false,attached:true,frozen:true,keys:0,generationFrozen:true,generationKeys:0})
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  expect(await page.evaluate(()=>{
    const w=window as any,schedule=w.__privateControllerScheduleForTest,timer=window.setTimeout;let timers=0,refused=0,reflections=0
    const hostile=new Proxy({},{get(){reflections++;throw Error('Foreign delay')},getPrototypeOf(){reflections++;throw Error('Foreign delay prototype')}})
    window.setTimeout=((...args:Parameters<typeof setTimeout>)=>{timers++;return Reflect.apply(timer,window,args)}) as typeof setTimeout
    try{for(const value of [0,NaN,hostile])try{schedule(value)}catch{refused++}}
    finally{window.setTimeout=timer}
    return {same:schedule===w.__privateControllerScheduleForTest,timers,refused,reflections}
  })).toEqual({same:true,timers:0,refused:3,reflections:0})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateControllerForTest()')).toMatchObject({closed:true,attached:false})
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})
test('private member controller refuses forged and spent claims without caller reflection',async({page})=>{
  await preparePrivateControllerConstruction(page);await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  expect(await page.evaluate(async()=>{
    const w=window as any,api=w.__privateControllerFunctionsForTest;let refused=0,reflections=0
    const fake=new Proxy({},{get(){reflections++;throw Error('Foreign controller property')},getPrototypeOf(){reflections++;throw Error('Foreign controller prototype')},ownKeys(){reflections++;throw Error('Foreign controller keys')}})
    for(const action of [()=>api.open(fake),()=>api.open(w.__privateControllerClaimForTest),()=>api.attach(fake),()=>api.attach(w.__privateControllerSessionClaimForTest),()=>api.schedule(fake,fake),()=>api.stop(fake),()=>api.close(fake)]){
      try{await action()}catch{refused++}
    }
    return {refused,reflections}
  })).toEqual({refused:7,reflections:0})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
for(const field of ['controller','bootstrap','carrier','generation','graph','session','renewal'])test(`private member controller refuses a mismatched ${field} attachment and joins parent erasure`,async({page})=>{
  await preparePrivateControllerConstruction(page)
  await page.evaluate(field=>{(window as any).privateControllerAttachmentFault=field},field)
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateControllerForTest()')).toMatchObject({closed:true,attached:false})
  expect(await page.evaluate('[__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest(),providerFixture.closeCalls]')).toEqual([true,true,1])
})
for(const stage of ['claim-consumed','after-resource','attachment-consumed','after-attachment'])test(`private member controller joins pagehide at ${stage}`,async({page})=>{
  await preparePrivateControllerConstruction(page)
  await page.evaluate(stage=>{(window as any).privateControllerCut=stage},stage)
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateControllerForTest()')).toMatchObject({closed:true,attached:false})
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
  expect(await page.evaluate('providerFixture.closeCalls')).toBe(1)
})
test('private member controller close is shared and revokes the actual parent graph',async({page})=>{
  await preparePrivateControllerConstruction(page);await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  expect(await page.evaluate(async()=>{
    const w=window as any,api=w.__privateControllerFunctionsForTest,resource=w.__privateControllerResourceForTest
    const first=api.close(resource),second=api.close(resource);await first
    return first===second
  })).toBe(true)
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateControllerForTest()')).toMatchObject({closed:true,attached:false})
  expect(await page.evaluate('[__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest(),providerFixture.closeCalls]')).toEqual([true,true,1])
})
for(const field of ['draining','closing','closeResult','session'])test(`private member controller and Session cleanup ignore inherited terminal promises in ${field}`,async({page})=>{
  await preparePrivateControllerConstruction(page);await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  await page.evaluate(field=>{
    const w=window as any;w.privateCleanupInheritedReads=0;w.privateCleanupInheritedWrites=0
    Object.defineProperty(Object.prototype,field,{configurable:true,
      get(){w.privateCleanupInheritedReads++;return Promise.resolve()},set(){w.privateCleanupInheritedWrites++;throw Error('Inherited private cleanup write')}})
    window.dispatchEvent(new PageTransitionEvent('pagehide'))
  },field)
  try{
    await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
    expect(await page.evaluate('[privateCleanupInheritedReads,privateCleanupInheritedWrites,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([0,0,true,true])
    expect(await page.evaluate('__privateControllerForTest()')).toMatchObject({closed:true,attached:false})
  }finally{await page.evaluate(()=>{for(const field of ['draining','closing','closeResult','session'])Reflect.deleteProperty(Object.prototype,field)})}
})
for(const keep of [false,true])test(`private member construction uses genuine claims without a participant signer, keep=${keep}`,async({page})=>{
  await prepareControlStage(page,keep,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('loaded')
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  if(await page.evaluate('privateMemberOutcome')!=='constructed')console.log('Private construction refusal',await page.evaluate('JSON.stringify({holds:window.__privateRenewalHolds,entropy:privateEntropyCalls,outcome:privateMemberOutcome,error:window.__privateMemberFailureForTest})'))
  expect(await page.evaluate('[privateMemberOutcome,privateMemberVoid,__privateMemberConstructedForTest]')).toEqual(['constructed',true,true])
  expect(await page.evaluate('__privateCarrierForTest()')).toMatchObject({closed:false,private:true,pool:true,profile:'direct',authentication:[],relays:[{url:'wss://signed.example/',read:true,write:true}],facade:['publish','subscribe','close'],frozen:true,nullPrototype:true})
  const after=await page.evaluate('({...effects,signs:providerFixture.signs})')
  expect(after).toEqual({...before,entropy:before.entropy+1})
  expect(await page.evaluate('privateMemberEntropy')).toEqual([4])
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.evaluate(async()=>{try{await(window as any).__privateBootstrapFunctionsForTest.constructMember((window as any).__seenPrivateBootstrapResource);return'unexpected'}catch(error){return(error as Error).name}})).toBe('OrdinaryStateHold')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateCarrierForTest()')).toMatchObject({closed:true,work:0})
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})
test('private member construction holds missing signed destinations before SID or sockets',async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  expect(await page.evaluate('window.__privateCarrierForTest===undefined')).toBe(true)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('private member claim wrappers refuse copied, proxy and spent claims before reflection or effects',async({page})=>{
  await prepareControlStage(page,false,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  expect(await page.evaluate(async()=>{
    const w=window as any;let reflections=0,refused=0
    const fake=new Proxy({}, {get(){reflections++;throw Error('Foreign getter')},ownKeys(){reflections++;throw Error('Foreign keys')},getPrototypeOf(){reflections++;throw Error('Foreign prototype')}})
    for(const action of [()=>w.__privateMemberFunctionsForTest.open(fake),()=>w.__privateMemberFunctionsForTest.open(w.__privateMemberClaimForTest),()=>w.__privateCarrierFunctionsForTest.open(fake),()=>w.__privateCarrierFunctionsForTest.transport(fake),()=>w.__privateMemberFunctionsForTest.close(fake)]){
      try{await action()}catch{refused++}
    }
    return[reflections,refused]
  })).toEqual([0,5])
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('private member construction cleans up pagehide after Session resource assignment',async({page})=>{
  await prepareControlStage(page,false,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await page.evaluate(()=>{(window as any).privateMemberCut='after-session'})
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('[privateMemberOutcome,__privateMemberConstructedForTest]')).toEqual(['OrdinaryStateHold',true])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateCarrierForTest()')).toMatchObject({closed:true,work:0})
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})


test('private member construction ignores inherited epoch-key consumers and optional settings',async({page})=>{
  await prepareControlStage(page,false,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await page.evaluate(()=>{
    const w=window as any;w.privateMemberInheritedReads=0;w.privateMemberEpochKeyLeaks=0
    for(const field of ['forwarderMediaPipeline','rekey','setRelays','epoch','now','sid','assist','owner'])
      Object.defineProperty(Object.prototype,field,{configurable:true,get(){w.privateMemberInheritedReads++;return{rekey(){w.privateMemberEpochKeyLeaks++;return true}}},
        set(value){Object.defineProperty(this,field,{value,configurable:true,writable:true,enumerable:true})}})
  })
  try{
    await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
    expect(await page.evaluate('[privateMemberOutcome,privateMemberInheritedReads,privateMemberEpochKeyLeaks]')).toEqual(['constructed',0,0])
  }finally{
    await page.evaluate(()=>{for(const field of ['forwarderMediaPipeline','rekey','setRelays','epoch','now','sid','assist','owner'])Reflect.deleteProperty(Object.prototype,field)})
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  }
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('private member cleanup erases retained material after Session close rejects',async({page})=>{
  await prepareControlStage(page,false,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await page.evaluate(()=>{(window as any).privateMemberCloseFailure=true})
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateSessionDisposedForTest,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([true,true,true])
  expect(await page.evaluate('__privateCarrierForTest()')).toMatchObject({closed:true,work:0})
})
for(const first of ['stop','close'])test(`private member ${first} starts one lexical close before reentrant cleanup`,async({page})=>{
  await preparePrivateControllerConstruction(page)
  await page.evaluate(()=>{(window as any).privateMemberReentrantClose=true})
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  expect(await page.evaluate(first=>{
    const w=window as any,api=w.__privateMemberFunctionsForTest,r=w.__privateSessionSeenResource
    const started=first==='stop'?api.stop(r):api.close(r)
    const closing=api.close(r)
    void closing.catch(()=>{})
    return{calls:w.privateMemberCloseCalls,shared:closing===api.close(r)&&closing===w.privateMemberReentrantClosePromise,
      first:first==='stop'?started===undefined:started===closing,notDisposedYet:!w.__privateSessionDisposedForTest}
  },first)).toEqual({calls:1,shared:true,first:true,notDisposedYet:true})
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[privateMemberCloseCalls,__privateSessionDisposedForTest,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([1,true,true,true])
})
test('private member construction and close bypass public owner carrier and Session methods',async({page})=>{
  await prepareControlStage(page,false,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await page.evaluate(()=>{
    const w=window as any;w.privateMemberPublicDispatches=0
    const fail=()=>{w.privateMemberPublicDispatches++;throw Error('Public private-member dispatch')}
    const owner=w.__privateOwnerPrototypeForTest.constructor,carrier=w.__privateCarrierClassForTest
    for(const name of ['readPairMigrated','joinPairLifetime','validatePairBinding','retainPairResource'])owner[name]=fail
    w.__privateOwnerPrototypeForTest.capture=fail
    for(const name of ['open','prepareSuccessor','checkSuccessor','applySuccessor','resumeSuccessor'])carrier[name]=fail
    for(const name of ['publish','subscribe','close','joinLifetime','describe','resumeResources'])carrier.prototype[name]=fail
  })
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('[privateMemberOutcome,privateMemberPublicDispatches]')).toEqual(['constructed',0])
  await page.evaluate(()=>{
    const w=window as any,fail=()=>{w.privateMemberPublicDispatches++;throw Error('Public Session cleanup')}
    for(const name of ['join','leave','disposeProtocolSecrets'])w.__privateMemberClassForTest.prototype[name]=fail
    window.dispatchEvent(new PageTransitionEvent('pagehide'))
  })
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[privateMemberPublicDispatches,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([0,true,true])
})


for(const cause of ['pagehide','browser','tab'])for(const closeFails of [false,true])test(`private member parent drain retains native custody through ${cause} erasure retries, closeFails=${closeFails}`,async({page})=>{
  await prepareControlStage(page,false,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await page.evaluate(closeFails=>{const w=window as any;w.privateMemberCloseFailure=closeFails;w.privateMemberDisposePaused=true;w.privateMemberReentrantDrain=true},closeFails)
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  const before=await page.evaluate<Record<string,number>>('({...effects,signs:providerFixture.signs})')
  try{
  await page.evaluate(cause=>{
    const w=window as any;w.__privateOwnerCloseFixture={entered:[],terminal:[]};w.privateDrainNativeOpens=0;w.privateDrainNativeTransactions=0
    w.privateCleanupInheritedReads=0;w.privateCleanupInheritedWrites=0
    for(const field of ['draining','closing','closeResult','session'])Object.defineProperty(Object.prototype,field,{configurable:true,
      get(){w.privateCleanupInheritedReads++;return Promise.resolve()},set(){w.privateCleanupInheritedWrites++;throw Error('Inherited retry cleanup write')}})
    const open=indexedDB.open.bind(indexedDB),transaction=IDBDatabase.prototype.transaction
    indexedDB.open=((...args:Parameters<IDBFactory['open']>)=>{w.privateDrainNativeOpens++;return open(...args)}) as IDBFactory['open']
    IDBDatabase.prototype.transaction=function(...args:Parameters<IDBDatabase['transaction']>){w.privateDrainNativeTransactions++;return Reflect.apply(transaction,this,args)}
    if(cause==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide'))
    else {
      w.privateDirectOwnerCloseDone=false
      void w.__privateMemberCloseOwnerForTest(cause).finally(()=>{w.privateDirectOwnerCloseDone=true}).catch(()=>{})
    }
  },cause)
  await expect.poll(()=>page.evaluate<number>('privateMemberDisposeCalls')).toBeGreaterThanOrEqual(3)
  expect(await page.evaluate('[privateMemberCloseCalls,__rootCloseDoneForTest,providerFixture.closeCalls??0,__privateOwnerCloseFixture.entered.length,privateDrainNativeOpens,privateDrainNativeTransactions]')).toEqual([1,false,0,0,0,0])
  if(cause!=='pagehide')expect(await page.evaluate('privateDirectOwnerCloseDone')).toBe(false)
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await lockAvailable(page,'lifetime:'+'a'.repeat(64))).toBe(false)
  expect(await page.evaluate('__privateBootstrapResourceForTest()')).toMatchObject({closed:true,material:true})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  expect(await page.evaluate(()=>{
    const w=window as any,f=w.__privateMemberFunctionsForTest,r=w.__privateSessionSeenResource
    const a=f.drain(r),b=f.drain(r);void a.catch(()=>{});void b.catch(()=>{});return a===b&&a===w.privateMemberReentrantDrainPromise
  })).toBe(true)
  // A persistent failure observation is not success. Release the explicit
  // fixture fault so the real root/provider/native chain can reach terminal.
  await page.evaluate(()=>{(window as any).privateMemberDisposePaused=false})
  await page.waitForFunction('__rootCloseDoneForTest')
  if(cause!=='pagehide')await page.waitForFunction('privateDirectOwnerCloseDone')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await lockAvailable(page,'lifetime:'+'a'.repeat(64))).toBe(true)
  expect(await page.evaluate('window.__rootCloseFailure')).toBe(closeFails?'Explicit private Session close failure':'Explicit private Session disposal failure')
  expect(await page.evaluate('[privateMemberCloseCalls,__privateSessionDisposedForTest,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest(),providerFixture.closeCalls]')).toEqual([1,true,true,true,1])
  expect(await page.evaluate('__privateOwnerCloseFixture.terminal')).toEqual(expect.arrayContaining(['browser','tab']))
  expect(await page.evaluate('__privateBootstrapResourceForTest()')).toMatchObject({closed:true,material:false,work:0})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  expect(await page.evaluate('[privateCleanupInheritedReads,privateCleanupInheritedWrites]')).toEqual([0,0])
  }finally{await page.evaluate(()=>{for(const field of ['draining','closing','closeResult','session'])Reflect.deleteProperty(Object.prototype,field)})}
})


test('private member renewal producer reserves the exact generation once without signing or scheduling',async({page})=>{
  await preparePrivateControllerConstruction(page);await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  expect(await page.evaluate('__privateControllerRenewalForTest.state()')).toEqual({closed:false,prepared:true,claimed:true,bootstrap:true,standalone:false})
  expect(await page.evaluate('__privateCarrierBindingKeysForTest()')).not.toEqual(expect.arrayContaining(['work']))
  expect(await page.evaluate('__privateCarrierBindingKeysForTest()')).not.toEqual(expect.arrayContaining(['protocol']))
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  expect(await page.evaluate(async()=>{
    const w=window as any,a=w.__privateControllerPreparationForTest(),b=w.__privateControllerPreparationForTest()
    let refused=false;try{await w.__privateForegroundProbe.prepareRenewalFactory()}catch{refused=true}
    await a;await b
    const resource=w.__privateControllerRenewalForTest.resource()
    return {same:a===b,refused,frozen:Object.isFrozen(resource),keys:Reflect.ownKeys(resource).length,bindingKeys:w.__privateControllerBindingKeysForTest()}
  })).toEqual({same:true,refused:true,frozen:true,keys:0,bindingKeys:['bootstrap','carrier','generation','graph','live','revoke']})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateControllerRenewalForTest.state()')).toMatchObject({closed:true,prepared:false})
})

test('private member renewal producer refuses a genuine foreign root before reflecting intent then accepts its actual graph root',async({page})=>{
  await page.clock.install();await preparePrivateControllerConstruction(page);await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  // Renewal must advance issuedAt and expiry beyond the initial credential.
  await page.clock.fastForward(2_000)
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  expect(await page.evaluate(async()=>{
    const w=window as any,api=w.__privateControllerRenewalForTest;let reflections=0,refused=0,accepted=false,opaque=false
    const desired=await w.__privateForegroundProbe.renewalDesired()
    const hostile=new Proxy({},{get(){reflections++;throw Error('Foreign intent property')},getPrototypeOf(){reflections++;throw Error('Foreign intent prototype')}})
    const foreign=w.__privateRenewalWorkForTest.registerPreparedStartup({},async(root:any)=>{try{await api.obligation(root,hostile)}catch{refused++}})
    await foreign.start();await foreign.join()
    try {await api.start(async(root:any)=>{
      await api.suspend(root);api.verify(root)
      const obligation=await api.obligation(root,desired)
      accepted=true;opaque=Object.isFrozen(obligation)&&Reflect.ownKeys(obligation).length===0
      api.resume(root)
    })} catch(error) {return {error:String(error),inner:w.__privateIntentFailureForTest}}
    return {reflections,refused,accepted,opaque}
  })).toEqual({reflections:0,refused:1,accepted:true,opaque:true})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

for(const stage of ['controller-before-factory','controller-before-factory-open','controller-after-factory'])test(`private member renewal producer retains MIGRATION through pagehide at ${stage}`,async({page})=>{
  await preparePrivateControllerConstruction(page)
  await page.evaluate(stage=>{(window as any).privateBootstrapGate={stage,used:false,entered:false}},stage)
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateBootstrapGate.entered')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate('privateBootstrapGate.release()');await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateControllerForTest()')).toMatchObject({closed:true,attached:false})
  expect(await page.evaluate('__privateControllerRenewalForTest.state()')).toMatchObject({closed:true,prepared:false})
  expect(await page.evaluate('__privateSessionInputsWipedForTest()')).toBe(true)
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})

test('private member renewal producer refuses a stale credential generation before publishing its factory',async({page})=>{
  await preparePrivateControllerConstruction(page)
  await page.evaluate(()=>{(window as any).privateRenewalGenerationCut='construction'})
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('__privateControllerRenewalForTest.state()')).toMatchObject({closed:true,prepared:false})
  expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})

async function preparePrivateLiveSettledRead(page:Page,keep=false):Promise<void>{
  await page.clock.install()
  await prepareControlStage(page,keep,true,undefined,undefined,true);await startPrivateForeground(page)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
  await page.clock.fastForward(2_000)
}
async function beginPrivateLiveSettledRead(page:Page,mode='read'):Promise<void>{
  await page.evaluate(async mode=>{
    const w=window as any,api=w.__privateControllerRenewalForTest,desired=await w.__privateForegroundProbe.renewalDesired()
    w.liveReadSnapshot=async()=>{
      const r=indexedDB.open('kithmoot-ordinary-state-v1',1),db=await new Promise<IDBDatabase>((yes,no)=>{r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)})
      try{return await new Promise<string>((yes,no)=>{const tx=db.transaction('owners'),s=tx.objectStore('owners'),keys=s.getAllKeys(),rows=s.getAll();tx.oncomplete=()=>yes(JSON.stringify(keys.result.map((k,i)=>[k,rows.result[i]]),(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v));tx.onabort=()=>no(tx.error)})}finally{db.close()}
    }
    w.allowPrivateRenewalEffects=true;w.providerFixture.foregroundExpected=true;w.providerFixture.renewalProofExpected=true
    w.liveReadDone=false;w.liveReadRootDone=false
    w.liveReadPending=api.start(async(root:any)=>{
      await api.suspend(root);api.verify(root)
      const obligation=await api.obligation(root,desired)
      w.liveReadS=await w.__privateRenewForTest(obligation)
      w.liveReadDiskBefore=await w.liveReadSnapshot()
      if(w.liveReadBeforeRead)await w.liveReadBeforeRead()
      w.liveReadBefore={...w.effects,signs:w.providerFixture.signs}
      w.liveReadBusyBefore=w.__privateForegroundProbe.busy()
      if(mode==='late'){w.liveReadDone=true;return}
      try{
        const selected=mode==='foreign'?new Proxy({},{get(){w.liveReadReflections++;throw Error('Forged producer')},getPrototypeOf(){w.liveReadReflections++;throw Error('Forged producer')}}):undefined
        w.liveReadReflections=0
        w.liveReadPreparation=await api.read(w.liveReadS,selected)
        w.liveReadOutcome='prepared'
        w.liveReadOpaque=Object.isFrozen(w.liveReadPreparation)&&Object.getPrototypeOf(w.liveReadPreparation)===null&&Reflect.ownKeys(w.liveReadPreparation).length===0
      }catch(error){w.liveReadOutcome=(error as Error).name}
      w.liveReadAfterRead?.()
      if(mode==='transition'){
        // Test-only graph-mechanics transition, deliberately with no adopt or
        // application effect. The old native guards still refuse the S rows.
        // This isolates exact-root disposal from a whole-provider revocation.
        api.resume(root)
      }
      w.liveReadAfter={...w.effects,signs:w.providerFixture.signs}
      w.liveReadBusyAfter=w.__privateForegroundProbe.busy()
      w.liveReadDone=true
      if(mode==='transition'||mode==='return-root')return
      // S is intentionally unapplied: keep the genuine root open while the
      // test inspects/discards preparation. Returning suspended would revoke
      // the graph. This fixture never resumes an unadopted successor.
      await new Promise<void>(yes=>{w.liveReadReleaseRoot=yes})
    }).catch((error:Error)=>{w.liveReadOutcome??=error.name;w.liveReadFailure=error.stack}).finally(()=>{w.liveReadDone=true;w.liveReadRootDone=true})
  },mode)
}
for(const keep of [false,true])test(`private live settled reader authenticates the exact successor without adopting G0, keep=${keep}`,async({page})=>{
  await preparePrivateLiveSettledRead(page,keep);await beginPrivateLiveSettledRead(page);await page.waitForFunction('liveReadDone')
  if(await page.evaluate('liveReadOutcome')!=='prepared')console.log('Live S reader refusal',await page.evaluate('JSON.stringify({outcome:liveReadOutcome,holds:window.__privateRenewalHolds,failure:window.liveReadFailure,setup:window.__liveReadSetupFailure,body:window.__liveReadBodyFailure})'))
  expect(await page.evaluate('[liveReadOutcome,liveReadOpaque]')).toEqual(['prepared',true])
  expect(await page.evaluate('liveReadAfter')).toEqual(await page.evaluate('liveReadBefore'))
  expect(await page.evaluate('[liveReadBusyBefore,liveReadBusyAfter]')).toEqual([false,false])
  expect(await page.evaluate('__privateControllerRenewalForTest.readState()')).toEqual({closed:false,finished:true,material:true,token:true,initialGenerationUnchanged:true})
  expect(await page.evaluate(async()=>{
    const w=window as any,a=w.__privateControllerRenewalForTest
    try{await a.read(w.liveReadS);return'unexpected'}catch(error){return(error as Error).name}
  })).toBe('OrdinaryStateHold')
  await page.evaluate('__privateControllerRenewalForTest.discard(liveReadPreparation)')
  expect(await page.evaluate('liveReadSnapshot()')).toBe(await page.evaluate('liveReadDiskBefore'))
  expect(await page.evaluate(()=>{
    const w=window as any
    try{w.__privateControllerRenewalForTest.foregroundRead(w.__liveReadDecisionForTest);return'unexpected'}catch(error){return(error as Error).name}
  })).toBe('OrdinaryStateHold')
  expect(await page.evaluate('__privateControllerRenewalForTest.readState()')).toEqual({closed:true,finished:true,material:false,token:false,initialGenerationUnchanged:true})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await page.evaluate('liveReadReleaseRoot()')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
for(const mode of ['late','foreign'])test(`private live settled reader spends S when ${mode} authority is refused`,async({page})=>{
  await preparePrivateLiveSettledRead(page);await beginPrivateLiveSettledRead(page,mode);await page.waitForFunction(mode==='late'?'liveReadRootDone':'liveReadDone')
  expect(await page.evaluate(async()=>{
    const w=window as any,a=w.__privateControllerRenewalForTest,outcomes=[]
    for(let i=0;i<2;i++){try{await a.read(w.liveReadS);outcomes.push('unexpected')}catch(error){outcomes.push((error as Error).name)}}
    return outcomes
  })).toEqual(['OrdinaryStateHold','OrdinaryStateHold'])
  if(mode==='foreign')expect(await page.evaluate('[liveReadOutcome,liveReadReflections]')).toEqual(['OrdinaryStateHold',0])
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(await page.evaluate('liveReadBefore'))
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'settled',initialGenerationUnchanged:true})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  if(mode!=='late')await page.evaluate('liveReadReleaseRoot()')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
for(const stage of ['modules','clients','database','browser','tab','control','credential','terminal'])test(`private live settled reader joins pagehide at ${stage} before releasing MIGRATION`,async({page})=>{
  await preparePrivateLiveSettledRead(page)
  await page.evaluate(stage=>{(window as any).privateBootstrapGate={stage:'settled-'+stage}},stage)
  await beginPrivateLiveSettledRead(page);await page.waitForFunction('privateBootstrapGate.entered')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.evaluate('liveReadDone')).toBe(false)
  await page.evaluate('privateBootstrapGate.release()');await page.waitForFunction('liveReadDone')
  await page.evaluate('liveReadReleaseRoot()')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('liveReadOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('__privateControllerRenewalForTest.readState()')).toMatchObject({closed:true,finished:true,material:false,token:false,initialGenerationUnchanged:true})
  expect(await page.evaluate('[__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([true,true])
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(await page.evaluate('liveReadBefore'))
})

for(const fault of ['browser','tab','control','pending','missing-control','extra-owner'])test(`private live settled reader refuses native ${fault} drift without rewriting S`,async({page})=>{
  await preparePrivateLiveSettledRead(page)
  await page.evaluate(fault=>{
    const w=window as any
    w.liveReadSnapshot=async()=>{
      const r=indexedDB.open('kithmoot-ordinary-state-v1',1),db=await new Promise<IDBDatabase>((yes,no)=>{r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)})
      try{return await new Promise<string>((yes,no)=>{const tx=db.transaction('owners'),s=tx.objectStore('owners'),keys=s.getAllKeys(),rows=s.getAll();tx.oncomplete=()=>yes(JSON.stringify(keys.result.map((k,i)=>[k,rows.result[i]]),(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v));tx.onabort=()=>no(tx.error)})}finally{db.close()}
    }
    w.liveReadBeforeRead=async()=>{
      const r=indexedDB.open('kithmoot-ordinary-state-v1',1),db=await new Promise<IDBDatabase>((yes,no)=>{r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)})
      try{await new Promise<void>((yes,no)=>{
        const tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners'),purpose='tab:'+'a'.repeat(64),control='journal:tab:'+'a'.repeat(64)
        const key=fault==='control'||fault==='missing-control'?control:fault==='tab'||fault==='pending'?purpose:'browser',read=s.get(key)
        read.onsuccess=()=>{
          const raw=read.result,restore=w.__enterPrivateRenewalDecision()
          try{
            if(fault==='missing-control')s.delete(key)
            else if(fault==='extra-owner')s.put(raw,'unexpected-native-owner')
            else{if(fault==='pending')raw.pending=structuredClone(raw.frame);else new Uint8Array(fault==='control'?raw.browser.ciphertext:raw.frame.ciphertext)[0]^=1;s.put(raw,key)}
          }finally{restore()}
        }
        tx.oncomplete=()=>yes();tx.onabort=()=>no(tx.error)
      })}finally{db.close()}
      w.liveReadDiskBefore=await w.liveReadSnapshot()
    }
  },fault)
  await beginPrivateLiveSettledRead(page);await page.waitForFunction('liveReadDone')
  expect(await page.evaluate('liveReadOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(await page.evaluate('liveReadBefore'))
  expect(await page.evaluate('liveReadSnapshot()')).toBe(await page.evaluate('liveReadDiskBefore'))
  expect(await page.evaluate('__privateControllerRenewalForTest.readState()')).toMatchObject({closed:true,finished:true,material:false,token:false,initialGenerationUnchanged:true})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await page.evaluate('liveReadReleaseRoot()')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

test('private live settled reader refuses forged S and foreground decisions without reflection or effects',async({page})=>{
  await preparePrivateLiveSettledRead(page)
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  expect(await page.evaluate(async()=>{
    const w=window as any,api=w.__privateControllerRenewalForTest;let reflections=0,refused=0
    const fake=new Proxy({},{get(){reflections++;throw Error('Forged handle')},getPrototypeOf(){reflections++;throw Error('Forged handle')}})
    for(const token of [fake,Object.freeze({}),undefined,null]){
      try{await api.read(token)}catch{refused++}
      try{api.discard(token)}catch{refused++}
      try{api.foregroundRead(token)}catch{refused++}
    }
    return{reflections,refused}
  })).toEqual({reflections:0,refused:12})
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

for(const fault of ['provider','sdk-sign','sdk-capability','sdk-account','credential-floor'])test(`private live settled reader refuses ${fault} drift before preparation`,async({page})=>{
  await preparePrivateLiveSettledRead(page)
  await page.evaluate(fault=>{
    const w=window as any
    w.liveReadBeforeRead=()=>{
      const restore=w.__enterPrivateRenewalDecision()
      try{
        if(fault==='provider')(window as any).nostr=w.providerFixture.current={}
        else if(fault==='sdk-sign')w.providerFixture.sdk.signEvent=async()=>{w.liveReadUnexpectedSigns=(w.liveReadUnexpectedSigns??0)+1;throw Error('Replacement signer')}
        else if(fault==='sdk-capability')w.providerFixture.sdk.capabilities={...w.providerFixture.sdk.capabilities,canSignEvents:false}
        else if(fault==='sdk-account')w.providerFixture.sdk.pubkey='f'.repeat(64)
        else{const now=Date.now;Date.now=()=>now()+1_201_000;w.liveReadRestoreClock=()=>{Date.now=now}}
      }finally{restore()}
    }
  },fault)
  await beginPrivateLiveSettledRead(page);await page.waitForFunction('liveReadDone')
  expect(await page.evaluate('liveReadOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('window.liveReadUnexpectedSigns??0')).toBe(0)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(await page.evaluate('liveReadBefore'))
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'settled',initialGenerationUnchanged:true})
  await page.evaluate('window.liveReadRestoreClock?.()')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await page.evaluate('liveReadReleaseRoot()')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

test('private live settled reader owns every optional terminal field despite inherited properties',async({page})=>{
  await preparePrivateLiveSettledRead(page)
  await page.evaluate(()=>{
    const w=window as any;w.liveReadInheritedReads=0;w.liveReadInheritedWrites=0
    w.liveReadBeforeRead=()=>{
      for(const field of ['settledRead','sourceLease','requestDigest','images','journal','token'])Object.defineProperty(Object.prototype,field,{configurable:true,
        get(){w.liveReadInheritedReads++;(w.liveReadInheritedTrace??=[]).push([field,new Error().stack]);return true},set(){w.liveReadInheritedWrites++;(w.liveReadInheritedTrace??=[]).push([field,new Error().stack])}})
    }
    // Noble uses a normal mutable 'finished' instance field. Poison that
    // name only after cryptographic verification, at preparation publication,
    // to test the new owner's terminal cell independently of library denial.
    w.liveReadBeforeToken=()=>Object.defineProperty(Object.prototype,'finished',{configurable:true,get(){w.liveReadInheritedReads++;return true},set(){w.liveReadInheritedWrites++}})
  })
  try{
    await beginPrivateLiveSettledRead(page);await page.waitForFunction('liveReadDone')
    if(await page.evaluate('liveReadOutcome')!=='prepared')console.log('Inherited S refusal',await page.evaluate('JSON.stringify({holds:window.__privateRenewalHolds,trace:window.liveReadInheritedTrace})'))
    expect(await page.evaluate('[liveReadOutcome,liveReadInheritedReads,liveReadInheritedWrites]')).toEqual(['prepared',0,0])
    await page.evaluate('__privateControllerRenewalForTest.discard(liveReadPreparation)')
    expect(await page.evaluate('__privateControllerRenewalForTest.readState()')).toMatchObject({closed:true,material:false,token:false})
  }finally{
    await page.evaluate(()=>{for(const field of ['settledRead','sourceLease','requestDigest','finished','images','journal','token'])Reflect.deleteProperty(Object.prototype,field)})
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await page.evaluate('liveReadReleaseRoot()')
    await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  }
})

for(const mode of ['getter','function'])test(`private live settled reader delivers its exact null-prototype token under inherited then ${mode}`,async({page})=>{
  await preparePrivateLiveSettledRead(page)
  await page.evaluate(mode=>{
    const w=window as any;w.liveReadThenReads=0;w.liveReadThenCalls=0
    w.liveReadBeforeToken=()=>Object.defineProperty(Object.prototype,'then',{configurable:true,get(){
      w.liveReadThenReads++
      return mode==='getter'?undefined:(resolve:(value:object)=>void)=>{w.liveReadThenCalls++;resolve(Object.create(null))}
    }})
    w.liveReadAfterRead=()=>Reflect.deleteProperty(Object.prototype,'then')
  },mode)
  try{
    await beginPrivateLiveSettledRead(page);await page.waitForFunction('liveReadDone')
    expect(await page.evaluate('[liveReadOutcome,liveReadOpaque,liveReadThenReads,liveReadThenCalls]')).toEqual(['prepared',true,0,0])
    await page.evaluate('__privateControllerRenewalForTest.discard(liveReadPreparation)')
    expect(await page.evaluate('liveReadSnapshot()')).toBe(await page.evaluate('liveReadDiskBefore'))
  }finally{
    await page.evaluate(()=>Reflect.deleteProperty(Object.prototype,'then'))
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await page.evaluate('liveReadReleaseRoot()')
    await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  }
})

test('private live settled reader refuses inherited toJSON poisoning without changing durable S',async({page})=>{
  await preparePrivateLiveSettledRead(page)
  await page.evaluate(()=>{
    const w=window as any
    w.liveReadBeforeRead=()=>Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value:()=> 'same-for-unequal-data'})
    w.liveReadAfterRead=()=>Reflect.deleteProperty(Object.prototype,'toJSON')
  })
  try{
    await beginPrivateLiveSettledRead(page);await page.waitForFunction('liveReadDone')
    expect(await page.evaluate('liveReadOutcome')).toBe('OrdinaryStateHold')
    expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(await page.evaluate('liveReadBefore'))
    expect(await page.evaluate('liveReadSnapshot()')).toBe(await page.evaluate('liveReadDiskBefore'))
    expect(await page.evaluate('__privateControllerRenewalForTest.readState()')).toMatchObject({closed:true,material:false,token:false})
  }finally{
    await page.evaluate(()=>Reflect.deleteProperty(Object.prototype,'toJSON'))
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await page.evaluate('liveReadReleaseRoot()')
    await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  }
})

for(const mode of ['transition','return-root'])test(`private live settled reader erases unconsumed preparation on exact root ${mode}`,async({page})=>{
  await preparePrivateLiveSettledRead(page);await beginPrivateLiveSettledRead(page,mode);await page.waitForFunction('liveReadRootDone')
  expect(await page.evaluate('[liveReadOutcome,liveReadOpaque]')).toEqual(['prepared',true])
  expect(await page.evaluate('__privateControllerRenewalForTest.readState()')).toEqual({closed:true,finished:true,material:false,token:false,initialGenerationUnchanged:true})
  expect(await page.evaluate('liveReadSnapshot()')).toBe(await page.evaluate('liveReadDiskBefore'))
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(await page.evaluate('liveReadBefore'))
  if(mode==='transition'){
    expect(await page.evaluate('__privateControllerForTest().closed')).toBe(false)
    expect(await page.evaluate('__privateBootstrapResourceForTest().material')).toBe(true)
    expect(await lockAvailable(page,'migration')).toBe(false)
  }
  expect(await page.evaluate(()=>{
    const w=window as any
    try{w.__privateControllerRenewalForTest.discard(w.liveReadPreparation);return'unexpected'}catch(error){return(error as Error).name}
  })).toBe('OrdinaryStateHold')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})

/** Native-stage composition with a synthetic authority/relay. The actual
 * Session, pool/carrier, native stores and crypto run; this is not production
 * consent UI, independent peer delivery or physical network acceptance. */
interface PrivateG0JoinPeer {roomId: string; credential: Parameters<typeof encodeEpochGrant>[0]['credential']; secret: number[]; authority: number[]}
const privateG0JoinPeers = new WeakMap<Page, {peer: PrivateG0JoinPeer; mode: string}>()
async function preparePrivateG0Join(page: Page, keep: boolean, mode = 'grant', pauseDisposal = false): Promise<void> {
  let peer!: PrivateG0JoinPeer
  await prepareControlStage(page,keep,true,undefined,async()=>{
    if(mode.startsWith('durable'))await page.evaluate(async()=>{
      const w=window as any,o=w.Ordinary,scope=await w.browserOwner.capture('room:'+w.roomId,w.guard)
      await w.browserOwner.mutateMigrated(scope,w.guard,(store:any)=>o.storeKeptRoomEpoch({
        get:(name:string)=>store.get(w.prefix+name),set:(name:string,value:string)=>store.set(w.prefix+name,value),
        remove:(name:string)=>store.remove(w.prefix+name),keys:()=>[]},w.roomId,
        {epoch:{epoch:1,secret:new Uint8Array(32).fill(61)},past:[{epoch:0,secret:w.secret,leftAt:w.now}],removed:[],members:[w.participant]},w.now))
    })
    peer=await page.evaluate(async()=>{
      const w=window as any,material=await w.bootstrap.load()
      if(!material)throw Error('Missing join peer seed')
      try{return{roomId:w.roomId,credential:material.credential,secret:Array.from(material.admission.secret) as number[],authority:Array.from(w.inviterSk) as number[]}}
      finally{w.Ordinary.wipeOrdinaryPersistentBootstrapResult(material)}
    })
  },true)
  const registered=privateG0JoinPeers.has(page)
  privateG0JoinPeers.set(page,{peer,mode})
  if(!registered)await page.exposeFunction('__privateJoinPeerGrant',(request:{id:string;pubkey:string})=>{
    const {peer,mode}=privateG0JoinPeers.get(page)!
    if(mode==='pending')return null
    return encodeEpochGrant({roomId:peer.roomId,authoritySk:Uint8Array.from(peer.authority),device:request.pubkey,request:request.id,
      epoch:mode==='durable-future'?{epoch:2,secret:new Uint8Array(32).fill(62)}:
        mode==='durable-wrong-id'?{epoch:1,secret:new Uint8Array(32).fill(62)}:
        mode==='nonzero'||mode==='durable'?{epoch:1,secret:new Uint8Array(32).fill(61)}:{epoch:0,secret:Uint8Array.from(peer.secret)},
      credential:peer.credential!,removed:[],now:Math.floor(Date.now()/1000)})
  })
  await page.evaluate(({roomId,participant})=>{
    const w=window as any;w.privateJoinFixtureRoom=roomId;w.privateJoinFixturePrefix='kithmoot.account.'+participant+'.';w.privateJoinNetworkFixture=true;w.privateJoinGrantReady=false;w.privateJoinEpochRequested=false;w.privateJoinFrames=[];w.privateJoinSockets=[]
    w.__privateJoinSocket=class {
      readyState=0;onopen:any=null;onmessage:any=null;onclose:any=null;onerror:any=null;requests=new Map<string,any[]>()
      constructor(readonly url:string){w.privateJoinSockets.push(this);queueMicrotask(()=>{if(this.readyState===3)return;this.readyState=1;this.onopen?.({type:'open'})})}
      message(frame:unknown[]){if(this.readyState!==3)this.onmessage?.({data:JSON.stringify(frame)})}
      send(raw:string){
        if(!w.__controlDecision)throw Error('Join socket send outside native decision')
        const frame=JSON.parse(raw);w.privateJoinFrames.push({frame,native:!!w.__controlDecision,url:this.url})
        if(frame[0]==='REQ')this.requests.set(frame[1],frame.slice(2))
        if(frame[0]==='CLOSE')this.requests.delete(frame[1])
        queueMicrotask(async()=>{
          if(frame[0]==='REQ')this.message(['EOSE',frame[1]])
          if(frame[0]==='EVENT'){
            this.message(['OK',frame[1].id,true,'accepted'])
            if(frame[1].kind===20468){
              w.privateJoinEpochRequested=true
              const grant=await w.__privateJoinPeerGrant(frame[1]);if(!grant)return
              if(w.privateJoinPauseGrant){w.privateJoinGrantReady=true;await new Promise<void>(yes=>{w.privateJoinReleaseGrant=yes})}
              for(const socket of w.privateJoinSockets)for(const[id,filters]of socket.requests)
                if(filters.some((f:any)=>f.kinds?.includes(grant.kind)))socket.message(['EVENT',id,grant])
            }
          }
        })
      }
      close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({type:'close'})}
    }
  },{roomId:peer.roomId,participant:peer.credential!.pubkey})
  await startPrivateForeground(page);await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('loaded')
  await page.evaluate(pause=>{(window as any).privateMemberDisposePaused=pause},pauseDisposal)
  await beginPrivateMemberConstruction(page);await page.waitForFunction('privateMemberDone')
  expect(await page.evaluate('privateMemberOutcome')).toBe('constructed')
}
async function beginPrivateG0Join(page: Page): Promise<void> {
  await page.evaluate(()=>{
    const w=window as any;w.privateJoinDone=false
    w.privateJoinPending=w.__privateBootstrapFunctionsForTest.joinMember(w.__seenPrivateBootstrapResource).then(
      (value:unknown)=>{w.privateJoinOutcome='joined';w.privateJoinVoid=value===undefined},(error:Error)=>{w.privateJoinOutcome=error.name})
      .finally(()=>{w.privateJoinDone=true})
  })
}
for(const keep of [false,true])test(`private G0 join uses the actual retained Session and records due state without wallet signing, keep=${keep}`,async({page})=>{
  await preparePrivateG0Join(page,keep)
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  if(await page.evaluate('privateJoinOutcome')!=='joined')console.log('Private join diagnostic',await page.evaluate('({outcome:privateJoinOutcome,error:window.__privateJoinFailureForTest,holds:window.__privateRenewalHolds,entropy:privateEntropyCalls})'))
  expect(await page.evaluate('[privateJoinOutcome,privateJoinVoid]')).toEqual(['joined',true])
  expect(await page.evaluate('__privateJoinedSessionForTest()')).toMatchObject({state:'joined',outer:true,native:true,receipt:true,closed:false,snapshot:{epoch:0,channels:[]}})
  expect(await page.evaluate('__privateJoinControllerForTest()')).toMatchObject({closed:false,joining:true,joined:true})
  expect(await page.evaluate('Number.isFinite(__privateJoinControllerForTest().hint)&&Number.isSafeInteger(__privateJoinControllerForTest().dueAt)')).toBe(true)
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
  expect(await page.evaluate('privateJoinFrames.every(v=>v.native&&v.url==="wss://signed.example/")&&privateJoinFrames.every(v=>v.frame[0]!=="AUTH")')).toBe(true)
  expect(await page.evaluate('privateJoinPreannouncementObserved')).toMatchObject({native:true,snapshot:{epoch:0,channels:[]}})
  expect(await page.evaluate('privateJoinDecodedSealKeys.length>0&&privateJoinDecodedSealKeys.every(key=>key.every(value=>value===0))')).toBe(true)
  expect(await page.evaluate(()=>{
    const w=window as any;let reflected=0
    const hostile=new Proxy(Object.create({then(){reflected++}}),{get(){reflected++;throw Error('Foreign getter')},ownKeys(){reflected++;throw Error('Foreign keys')}})
    const outcomes=[]
    for(const token of [Object.freeze(Object.create(null)),hostile,w.__privateJoinClaimForTest]){
      try{w.__privateMemberFunctionsForTest.join(token);outcomes.push('unexpected')}catch(error){outcomes.push((error as Error).name)}
    }
    for(const token of [hostile,...w.privateJoinDecisions]){
      try{w.__privateMemberFunctionsForTest.takeJoined(token);outcomes.push('unexpected')}catch(error){outcomes.push((error as Error).name)}
    }
    return {reflected,outcomes}
  })).toEqual({reflected:0,outcomes:Array(6).fill('OrdinaryStateHold')})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateJoinedSessionForTest().state,__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual(['closed',false,true,true])
})
for(const fault of ['credential','epoch','epoch-id','seals','channels','seal-conversion'])test(`private G0 join refuses ${fault} mismatch before roster subscriptions or presence`,async({page})=>{
  await preparePrivateG0Join(page,false)
  await page.evaluate(fault=>{const w=window as any;w.privateJoinSnapshotFault=fault;w.privateJoinSealConversionFailure=fault==='seal-conversion'},fault)
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('privateJoinPreannouncementObserved.native')).toBe(true)
  expect(await page.evaluate('privateJoinDecodedSealKeys.length>0&&privateJoinDecodedSealKeys.every(key=>key.every(value=>value===0))')).toBe(true)
  // The only network work before the check is authority epoch settlement.
  // No roster/descriptor subscription, presence or chat frame may escape.
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual([20468])
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="REQ").flatMap(v=>v.frame.slice(2).flatMap(f=>f.kinds??[])).every(kind=>kind===1462||kind===20469)')).toBe(true)
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([false,true,true])
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
  const frames=await page.evaluate('privateJoinFrames.length')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('privateJoinFrames.length')).toBe(frames)
})
test('private G0 join refuses an actual authority epoch ahead of durable history before presence',async({page})=>{
  await preparePrivateG0Join(page,false,'nonzero')
  const before=await page.evaluate('effects.put')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('privateJoinPreannouncementObserved')).toMatchObject({native:true,snapshot:{epoch:1,channels:[]}})
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual([20468])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[effects.put,__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([before,false,true,true])
})
for(const mode of ['durable','durable-stale','durable-future'])test(`private G0 join reconciles actual ${mode} authority with already-durable nonzero history`,async({page})=>{
  await preparePrivateG0Join(page,true,mode)
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe(mode==='durable'?'joined':'OrdinaryStateHold')
  expect(await page.evaluate('privateJoinPreannouncementObserved.snapshot.epoch')).toBe(mode==='durable'?1:mode==='durable-stale'?0:2)
  if(mode==='durable'){
    expect(await page.evaluate('__privateJoinedSessionForTest()')).toMatchObject({state:'joined',receipt:true,snapshot:{epoch:1,channels:[]}})
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  }else expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual([20468])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([false,true,true])
})
test('private G0 join cancellation settles its actual pending epoch task before native custody is released',async({page})=>{
  await preparePrivateG0Join(page,false,'pending');await beginPrivateG0Join(page);await page.waitForFunction('privateJoinEpochRequested')
  expect(await page.evaluate('__privateJoinedSessionForTest()')).toMatchObject({state:'joining',receipt:false})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([false,true,true])
})
for(const stage of ['before-claim','outer-retained','preannouncement','owner-authentication','native-joined','before-publication','after-publication','session-handoff','bootstrap-handoff'])test(`private G0 join cut at ${stage} drains before releasing native custody`,async({page})=>{
  await preparePrivateG0Join(page,false,'grant',true)
  await page.evaluate(stage=>{(window as any).privateG0JoinCut=stage},stage)
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('[privateJoinOutcome,privateG0JoinCutEntered]')).toEqual(['OrdinaryStateHold',stage])
  await page.waitForFunction('privateMemberDisposeCalls>0')
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateJoinControllerForTest().joined,__privateJoinControllerForTest().dueAt]')).toEqual([false,false,null])
  expect(await page.evaluate('privateJoinFrames.every(v=>v.native&&v.frame[0]!=="AUTH")')).toBe(true)
  if(['before-claim','outer-retained','preannouncement','owner-authentication'].includes(stage))
    expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").every(v=>v.frame[1].kind===20468)')).toBe(true)
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
  await page.evaluate(()=>{(window as any).privateMemberDisposePaused=false})
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([true,true])
})

for(const fault of ['provider','provider-sign','sdk-sign','sdk-capability','sdk-account','sdk-prototype','credential-expiry','foreground','generation-floor'])test(`private G0 join refuses ${fault} change inside preannouncement before member effects`,async({page})=>{
  await preparePrivateG0Join(page,false)
  await page.evaluate(fault=>{
    const w=window as any
    w.privateJoinBeforePreannouncement=()=>{
      const unexpected=()=>{w.privateJoinUnexpectedCalls=(w.privateJoinUnexpectedCalls??0)+1;throw Error('Replacement provider/SDK must not run')}
      if(fault==='provider')Object.defineProperty(window,'nostr',{configurable:true,writable:true,value:{}})
      else if(fault==='provider-sign')w.providerFixture.current.signEvent=unexpected
      else if(fault==='sdk-sign')w.providerFixture.sdk.signEvent=unexpected
      else if(fault==='sdk-capability')w.providerFixture.sdk.capabilities={...w.providerFixture.sdk.capabilities,canSignEvents:false}
      else if(fault==='sdk-account')w.providerFixture.sdk.pubkey='f'.repeat(64)
      else if(fault==='sdk-prototype')Object.setPrototypeOf(w.providerFixture.sdk,{signEvent:unexpected})
      else if(fault==='credential-expiry'){const now=Date.now;Date.now=()=>now()+1_201_000;w.privateJoinRestoreClock=()=>{Date.now=now}}
      else if(fault==='foreground')w.__privateForegroundProbe.revokeForJoinTest()
      else w.__privateAdvanceCredentialGenerationForTest()
      const observed=fault==='provider'?Object.getOwnPropertyDescriptor(window,'nostr')!.value!==w.providerFixture.current:
        fault==='provider-sign'?w.providerFixture.current.signEvent===unexpected:
        fault==='sdk-sign'?w.providerFixture.sdk.signEvent===unexpected:
        fault==='sdk-capability'?w.providerFixture.sdk.capabilities.canSignEvents===false:
        fault==='sdk-account'?w.providerFixture.sdk.pubkey==='f'.repeat(64):
        fault==='sdk-prototype'?Object.getPrototypeOf(w.providerFixture.sdk).signEvent===unexpected:
        fault==='credential-expiry'?!!w.privateJoinRestoreClock:
        fault==='foreground'?!w.__privateForegroundProbe.current():w.__privateGenerationFloorForTest().serial===1
      if(!observed)throw Error('Drift fixture did not apply its mutation')
      w.privateJoinDriftApplied={fault,native:!!w.__controlDecision,observed}
    }
  },fault)
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  try {
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('privateJoinDriftApplied')).toEqual({fault,native:true,observed:true})
  expect(await page.evaluate('window.privateJoinUnexpectedCalls??0')).toBe(0)
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual([20468])
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="REQ").flatMap(v=>v.frame.slice(2).flatMap(f=>f.kinds??[])).every(kind=>kind===1462||kind===20469)')).toBe(true)
  } finally {await page.evaluate('window.privateJoinRestoreClock?.()')}
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([false,true,true])
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
})

test('private G0 join refuses a valid authority epoch with the wrong current ID before presence',async({page})=>{
  await preparePrivateG0Join(page,true,'durable-wrong-id')
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('privateJoinPreannouncementObserved')).toMatchObject({native:true,snapshot:{epoch:1}})
  expect(await page.evaluate('privateJoinDurableCurrent.epoch')).toBe(1)
  expect(await page.evaluate('privateJoinDurableCurrent.id!==privateJoinPreannouncementObserved.snapshot.epochId')).toBe(true)
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual([20468])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([false,true,true])
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
})

for(const mode of ['missing-current','pruned-proof'] as const)test(`private G0 join refuses authenticated ${mode} disk history mutation during authority wait`,async({page})=>{
  await preparePrivateG0Join(page,true,'durable')
  await page.evaluate(()=>{(window as any).privateJoinPauseGrant=true})
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinGrantReady')
  await page.evaluate(async mode=>{
    const w=window as any,path='/j/mutate-native.js',module=await import(path)
    await module.changeBrowserEpochHistory(w.privateJoinFixtureRoom,w.privateJoinFixturePrefix,mode)
    w.privateJoinAfterAdversarialWrite={signs:w.providerFixture.signs,put:w.effects.put,storage:w.effects.storageWrite}
    w.privateJoinReleaseGrant()
  },mode)
  await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('providerFixture.historyMutation')).toMatchObject({mode,authenticated:true})
  expect(await page.evaluate('providerFixture.historyMutationWrites')).toBe(1)
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual([20468])
  // This exercises exact native-row drift refusal. It does not claim the
  // changed frame was accepted by the owner or authorised an epoch rollback.
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([false,true,true])
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(await page.evaluate('privateJoinAfterAdversarialWrite'))
})

test('private G0 join refuses an absent nonzero durable epoch after fresh native capture',async({page})=>{
  await preparePrivateG0Join(page,true,'nonzero')
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('privateJoinPreannouncementObserved')).toMatchObject({native:true,snapshot:{epoch:1}})
  expect(await page.evaluate('privateJoinDurableCurrent.epoch')).toBe(0)
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual([20468])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([true,true])
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
})

test('private G0 join entry refuses authenticated pruned proof history at fresh capture',async({page})=>{
  const href=await seed(page,true,false,true)
  await page.evaluate(async()=>{
    const w=window as any,o=w.Ordinary,scope=await w.browserOwner.capture('room:'+w.roomId,w.guard)
    await w.browserOwner.mutateMigrated(scope,w.guard,(store:any)=>o.storeKeptRoomEpoch({
      get:(name:string)=>store.get(w.prefix+name),set:(name:string,value:string)=>store.set(w.prefix+name,value),
      remove:(name:string)=>store.remove(w.prefix+name),keys:()=>[]},w.roomId,
      {epoch:{epoch:1,secret:new Uint8Array(32).fill(61)},past:[{epoch:0,secret:w.secret,leftAt:w.now}],removed:[],members:[w.participant]},w.now))
  })
  await releaseFixture(page)
  const account=await page.evaluate<string>('account')
  expect(await page.evaluate(async()=>{
    const w=window as any,path='/j/mutate-native.js',module=await import(path)
    w.providerFixture={nativeRandom:crypto.getRandomValues.bind(crypto),nativePut:IDBObjectStore.prototype.put}
    await module.changeBrowserEpochHistory(w.roomId,w.prefix,'pruned-proof')
    return w.providerFixture.historyMutationWrites
  })).toBe(1)
  await install(page);await providerFixture(page,account)
  await page.addInitScript(()=>{(window as any).privateHistorySemanticFixture=true})
  // No active captured fingerprint exists yet: the fresh native capture
  // rejects the actual decrypted image's missing historical proof epoch.
  await enter(page,href,'held')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0,0])
  expect(await page.evaluate('effects')).toEqual(none)
  expect(await page.evaluate('window.__privateSessionSeenResource===undefined')).toBe(true)
  expect(await page.evaluate('privateHistorySemanticRefusal')).toEqual({stage:'historical-epoch-continuity',currentEpoch:1,proofEpoch:0,missingHistoricalId:true})
})

// The genuine predecessor and current-root journey have separate bounded
// lifetimes. Each keeps its 30s budget; this is not a combined two-root 30s SLO.
// The observer retains actual old-realm functions/maps/objects, never clones.
const privateG0CrossDocumentTest=test.extend<{privateJoinPriorRoot:Page}>({
  privateJoinPriorRoot:[async({page},use)=>{
    await preparePrivateG0Join(page,false);await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
    expect(await page.evaluate('privateJoinOutcome')).toBe('joined')
    const opening=page.waitForEvent('popup')
    await page.evaluate(url=>{(window as any).privateJoinObserver=window.open(url,'private-join-observer')},origin+'/outside/modern')
    const observer=await opening
    try{
      await observer.waitForLoadState('load')
      await observer.evaluate(()=>{
        sessionStorage.removeItem('kithmoot.ordinary-tab.v1')
        const w=window as any;w.privateJoinObserverFence=new w.FenceOnly.OrdinaryClientFence()
      })
      await page.evaluate(()=>{
        const w=window as any
        w.privateJoinObserver.retainedJoin={functions:w.__privateMemberFunctionsForTest,tuple:w.__privateJoinTupleForTest(),
          claim:w.__privateJoinClaimForTest,decisions:w.privateJoinDecisions}
      })
      await use(observer)
    }finally{await observer.close()}
  },{timeout:30_000}],
})

privateG0CrossDocumentTest('private G0 join genuine claims decisions and receipts cannot cross document session graph or generation',async({page,privateJoinPriorRoot})=>{
  void privateJoinPriorRoot // Keep the exact observer alive through all assertions.
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  await page.goto(origin+'/j/setup')
  await page.evaluate(()=>new Promise<void>((yes,no)=>{
    const request=indexedDB.deleteDatabase((window as any).Ordinary.ORDINARY_DATABASE)
    request.onsuccess=()=>yes();request.onerror=()=>no(request.error);request.onblocked=()=>no(Error('Old actual join still owns its database'))
  }))
  await preparePrivateG0Join(page,true,'durable')
  await page.evaluate(()=>{
    const w=window as any,other=window.open('','private-join-observer') as any
    w.privateJoinOld=other.retainedJoin;w.privateJoinForeignProbes=[];w.privateJoinForeignProbeBusy=false
    const probe=(kind:string,token:unknown)=>{
      // Old realm functions retain their real maps, while their WindowProxy
      // can resolve this test hook in the new document. Do not re-enter it.
      if(w.privateJoinForeignProbeBusy)return
      w.privateJoinForeignProbeBusy=true
      const before=JSON.stringify({...w.effects,signs:w.providerFixture.signs,frames:w.privateJoinFrames.length})
      let outcome='unexpected'
      try{if(kind==='claim')w.privateJoinOld.functions.join(token);else w.privateJoinOld.functions.takeJoined(token)}catch(error){outcome=(error as Error).name}
      finally{w.privateJoinForeignProbeBusy=false}
      w.privateJoinForeignProbes.push({kind,outcome,native:!!w.__controlDecision,
        unchanged:before===JSON.stringify({...w.effects,signs:w.providerFixture.signs,frames:w.privateJoinFrames.length})})
    }
    w.privateJoinForeignClaimProbe=(token:unknown)=>probe('claim',token)
    w.privateJoinForeignDecisionProbe=(token:unknown)=>probe('decision',token)
  })
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('joined')
  expect(await page.evaluate('privateJoinForeignProbes')).toEqual([
    {kind:'claim',outcome:'OrdinaryStateHold',native:true,unchanged:true},
    {kind:'decision',outcome:'OrdinaryStateHold',native:true,unchanged:true},
    {kind:'decision',outcome:'OrdinaryStateHold',native:true,unchanged:true},
  ])
  expect(await page.evaluate(()=>{
    const w=window as any,api=w.__privateMemberFunctionsForTest,old=w.privateJoinOld,t=w.__privateJoinTupleForTest(),a=old.tuple
    w.privateJoinCurrentTupleForTest=t
    delete w.privateJoinForeignClaimProbe;delete w.privateJoinForeignDecisionProbe
    const before=JSON.stringify({...w.effects,signs:w.providerFixture.signs,frames:w.privateJoinFrames.length})
    let reflected=0,refused=0
    const hostile=new Proxy(Object.create({get then(){reflected++;throw Error('Foreign then getter')}}),{
      get(){reflected++;throw Error('Foreign getter')},getPrototypeOf(){reflected++;throw Error('Foreign prototype')},ownKeys(){reflected++;throw Error('Foreign keys')}})
    api.checkReceipt(t.receipt,t.session,t.graph,t.generation)
    for(const [receipt,session,graph,generation]of [
      [t.receipt,a.session,t.graph,t.generation],[t.receipt,t.session,a.graph,t.generation],[t.receipt,t.session,t.graph,a.generation],
      [a.receipt,t.session,t.graph,t.generation],[t.receipt,a.session,a.graph,a.generation],[a.receipt,a.session,a.graph,a.generation],
      [hostile,t.session,t.graph,t.generation],[t.receipt,hostile,hostile,hostile],
    ]){try{api.checkReceipt(receipt,session,graph,generation)}catch{refused++}}
    try{old.functions.checkReceipt(a.receipt,a.session,a.graph,a.generation)}catch{refused++}
    try{old.functions.checkReceipt(t.receipt,t.session,t.graph,t.generation)}catch{refused++}
    for(const token of [hostile,old.claim,w.__privateJoinClaimForTest]){try{api.join(token)}catch{refused++}}
    for(const token of [hostile,...old.decisions,...w.privateJoinDecisions]){try{api.takeJoined(token)}catch{refused++}}
    api.checkReceipt(t.receipt,t.session,t.graph,t.generation)
    return{refused,reflected,distinct:[t.session!==a.session,t.graph!==a.graph,t.generation!==a.generation],
      unchanged:before===JSON.stringify({...w.effects,signs:w.providerFixture.signs,frames:w.privateJoinFrames.length})}
  })).toEqual({refused:18,reflected:0,distinct:[true,true,true],unchanged:true})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate(()=>{
    const w=window as any,t=w.privateJoinCurrentTupleForTest;try{w.__privateMemberFunctionsForTest.checkReceipt(t.receipt,t.session,t.graph,t.generation);return'unexpected'}catch(error){return(error as Error).name}
  })).toBe('OrdinaryStateHold')
})

for(const kind of ['claim','decision'])for(const cut of ['pagehide','generation-floor'])test(`private G0 join spends an actual unconsumed ${kind} after ${cut} before replay`,async({page})=>{
  await preparePrivateG0Join(page,false)
  await page.evaluate(({kind,cut})=>{
    const w=window as any
    const probe=(token:object)=>{
      w.privateJoinUnconsumedToken=token
      if(cut==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide'));else w.__privateAdvanceCredentialGenerationForTest()
      const api=kind==='claim'?w.__privateBootstrapFunctionsForTest:w.__privateMemberFunctionsForTest
      let outcome='unexpected'
      try{if(kind==='claim')api.takeJoin(token);else api.takeJoined(token)}catch(error){outcome=(error as Error).name}
      w.privateJoinPreconsumption={outcome,native:!!w.__controlDecision,spent:kind==='claim'?!api.hasJoin(token):!api.hasDecision(token)}
    }
    if(kind==='claim')w.privateJoinForeignClaimProbe=probe;else w.privateJoinForeignDecisionProbe=probe
  },{kind,cut})
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('OrdinaryStateHold')
  // A genuine decision checks its closed protocol after spending its cell.
  // The fixed outer still normalises this refusal to OrdinaryStateHold.
  expect(await page.evaluate('privateJoinPreconsumption')).toEqual({
    outcome:kind==='decision'&&cut==='pagehide'?'OrdinaryProtocolSuspended':'OrdinaryStateHold',native:true,spent:true})
  expect(await page.evaluate('privateJoinFrames.filter(v=>v.frame[0]==="EVENT").map(v=>v.frame[1].kind)')).toEqual(kind==='claim'?[]:[20468])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[__privateJoinedSessionForTest().receipt,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest()]')).toEqual([false,true,true])
  expect(await page.evaluate(kind=>{
    const w=window as any,api=kind==='claim'?w.__privateBootstrapFunctionsForTest:w.__privateMemberFunctionsForTest
    delete w.privateJoinForeignClaimProbe;delete w.privateJoinForeignDecisionProbe
    try{if(kind==='claim')api.takeJoin(w.privateJoinUnconsumedToken);else api.takeJoined(w.privateJoinUnconsumedToken);return'unexpected'}catch(error){return(error as Error).name}
  },kind)).toBe('OrdinaryStateHold')
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
})

// Preparatory command/lifetime evidence only. These explicit checkpoint calls
// do not exercise trusted consent or mount the production private member UI.
async function prepareProviderCommand(page: Page, fixture: Record<string, unknown> = {}, gated = false): Promise<void> {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account, gated)
  await enter(page, href, 'captured-held')
  await page.evaluate(fixture => { (window as any).privateProviderCommandFixture = fixture }, fixture)
}
async function beginProviderCommand(page: Page): Promise<void> {
  await page.evaluate(url => {
    const w = window as any, fixture = w.privateProviderCommandFixture
    fixture.openingDone = false
    w.providerOpening = import(url).then(module => module.restoreOrdinaryPrivateExistingProviderRoot()).then(
      () => { fixture.openingState = 'fulfilled' }, error => { fixture.openingState = 'rejected'; fixture.openingError = error?.message },
    ).finally(() => { fixture.openingDone = true })
  }, ROOT_ENTRY)
}
async function closeProviderCommand(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any, fixture = w.privateProviderCommandFixture
    try {
      const first = w.__privateRootCloseForTest(), second = w.__privateRootCloseForTest()
      fixture.closeSamePromise = first === second
      void first.then(() => {fixture.closeDone = true; fixture.closeState = 'fulfilled'}, (error: Error) => {
        fixture.closeDone = true; fixture.closeState = 'rejected'; fixture.closeError = error.message
      })
    } catch (error) { fixture.closeThrewSynchronously = (error as Error).message }
  })
}
const providerSetupFailures = ['root-before-native', 'command-set', 'command-browser', 'command-tab', 'command-retained',
  'operation-browser', 'operation-tab', 'capture-consumed', 'cancel-browser', 'cancel-tab',
  'queue-published', 'queue-browser', 'queue-tab', 'completion-linked', 'root-after-assignment'] as const
for (const stage of providerSetupFailures) test(`private provider command drains synchronous setup failure at ${stage}`, async ({page}) => {
  await prepareProviderCommand(page, {fail: stage})
  await beginProviderCommand(page)
  await page.waitForFunction('privateProviderCommandFixture.openingDone')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await lockAvailable(page, 'lifetime:' + 'a'.repeat(64))).toBe(true)
  const fixture = await page.evaluate<any>('privateProviderCommandFixture')
  expect(fixture.commandState).toBe('rejected')
  expect(fixture.commandError).toBe('Explicit provider setup failure: ' + stage)
  if (!['root-before-native'].includes(stage)) {
    expect(fixture.completedState).toBe('rejected')
    expect(fixture.completedError).toBe(stage === 'root-after-assignment' ? 'Protected browser storage could not be verified.' : fixture.commandError)
    expect(fixture.providerCloseStarts).toBe(1)
  }
  expect(fixture.captureCloseStarts).toBe(1)
  expect(await page.evaluate('effects')).toEqual(none)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
})
for (const mode of ['pagehide','controller','close'] as const) for (const stage of ['command-set','cancel-tab','queue-published','root-after-assignment'] as const) {
  test(`private provider command ${mode} at ${stage} joins before releasing custody`, async ({page}) => {
    await prepareProviderCommand(page, {cut: stage, cutMode: mode})
    await beginProviderCommand(page)
    await page.waitForFunction('privateProviderCommandFixture.openingDone')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await page.evaluate('privateProviderCommandFixture.cutEntered')).toBe(true)
    expect(await page.evaluate('privateProviderCommandFixture.commandState')).toBe('rejected')
    expect(await page.evaluate('privateProviderCommandFixture.providerCloseStarts')).toBe(1)
    expect(await page.evaluate('effects')).toEqual(none)
    expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
  })
}
test('private provider command refuses foreign and replayed promises without consuming native capture', async ({page}) => {
  await prepareProviderCommand(page, {replay: true})
  expect(await page.evaluate(() => {
    const w = window as any; let refused = 0, getters = 0
    const hostile = new Proxy({}, {get(){getters++;throw Error('Foreign command getter')}})
    for (const value of [undefined, {}, Promise.resolve(), new Promise(() => {}), hostile]) {
      try { w.__privateClaimProviderCommandForTest(value) } catch {refused++}
    }
    return {refused, getters}
  })).toEqual({refused: 5, getters: 0})
  await beginProviderCommand(page)
  await page.waitForFunction('privateProviderCommandFixture.openingDone')
  expect(await page.evaluate('privateProviderCommandFixture.replayRefused')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
  expect(await page.evaluate(() => {
    const w = window as any
    try {w.__privateClaimProviderCommandForTest(w.privateProviderCommandFixture.command);return false} catch {return true}
  })).toBe(true)
  await closeProviderCommand(page)
  await page.waitForFunction('privateProviderCommandFixture.closeDone')
  expect(await page.evaluate('privateProviderCommandFixture.closeSamePromise')).toBe(true)
  expect(await lockAvailable(page, 'migration')).toBe(true)
})
test('private provider command spends wrong-root registration before any provider effect', async ({page}) => {
  await prepareProviderCommand(page, {wrongRoot: true})
  await beginProviderCommand(page)
  await page.waitForFunction('privateProviderCommandFixture.openingDone')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  expect(await page.evaluate('privateProviderCommandFixture.wrongRootRefused')).toBe(true)
  expect(await page.evaluate('effects')).toEqual(none)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
})
for (const direct of [false,true]) test(`private provider command ${direct ? 'early direct refusal' : 'cold wrapper'} owns capture preparation`, async ({page}) => {
  const href = await seed(page), account = await page.evaluate<string>('account')
  await install(page); await providerFixture(page, account)
  await page.addInitScript(() => { (window as any).privateProviderCommandFixture = {early: true} })
  await releaseFixture(page); await page.goto(href)
  await page.waitForFunction('privateProviderCommandFixture.captureEntered')
  if (direct) await page.evaluate(() => {
    const w = window as any
    w.directPending = w.__privateRestoreProviderNowForTest().then(() => {w.directDone = true}, () => {w.directDone = true})
  })
  else await beginProviderCommand(page)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
  expect(await lockAvailable(page, 'migration')).toBe(false)
  expect(await page.evaluate('privateProviderCommandFixture.commandState')).toBeUndefined()
  await page.evaluate('privateProviderCommandFixture.captureRelease();undefined')
  if (direct) {
    await page.waitForFunction('directDone')
    await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
    expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([0, 0])
  } else {
    await page.waitForFunction('privateProviderCommandFixture.openingDone')
    expect(await page.evaluate('[providerFixture.calls,providerFixture.signs]')).toEqual([1, 0])
    await closeProviderCommand(page)
    await page.waitForFunction('privateProviderCommandFixture.closeDone')
    expect(await lockAvailable(page, 'migration')).toBe(true)
  }
})
for (const fault of ['root-provider','root-capture','provider-action','native-resource','all'] as const) {
  test(`private provider cleanup continues after ${fault} stop failure and retains pending SDK close`, async ({page}) => {
    const rootStops = fault === 'all' ? ['provider','capture'] : fault.startsWith('root-') ? [fault.slice(5)] : []
    await prepareProviderCommand(page, {throwRootStops: rootStops,
      ...(fault === 'provider-action' || fault === 'all' ? {throwProviderStopAction:'foreground'} : {}),
      throwNativeStops: fault === 'native-resource' || fault === 'all'})
    await page.evaluate(() => { (window as any).providerFixture.closeMode = 'pending' })
    await beginProviderCommand(page)
    await page.waitForFunction('privateProviderCommandFixture.openingDone')
    await closeProviderCommand(page)
    await page.waitForFunction('providerFixture.closeCalls===1')
    expect(await page.evaluate('privateProviderCommandFixture.closeThrewSynchronously')).toBeUndefined()
    expect(await page.evaluate('privateProviderCommandFixture.closeSamePromise')).toBe(true)
    expect(await page.evaluate('privateProviderCommandFixture.closeDone')).toBeUndefined()
    expect(await lockAvailable(page, 'migration')).toBe(false)
    expect(await lockAvailable(page, 'lifetime:'+'a'.repeat(64))).toBe(false)
    const before = await page.evaluate<any>('privateProviderCommandFixture')
    expect(before.rootStops).toEqual(['provider','capture'])
    expect(before.providerStopActions).toEqual(['trusted-member','expiry','native-context','bootstrap','foreground','root','browser-owner','tab-owner'])
    if (fault === 'native-resource' || fault === 'all') expect(before.nativeStops).toEqual(['browser-throw','browser-later','tab-throw','tab-later'])
    await page.evaluate('providerFixture.closeRelease();undefined')
    await page.waitForFunction('privateProviderCommandFixture.closeDone')
    expect(await lockAvailable(page, 'migration')).toBe(true)
    const after = await page.evaluate<any>('privateProviderCommandFixture')
    expect(after.closeState).toBe('rejected')
    expect(after.closeError).toBe(fault === 'root-provider' || fault === 'all' ? 'Explicit root provider stop failure' :
      fault === 'root-capture' ? 'Explicit root capture stop failure' : fault === 'provider-action' ?
        'Explicit provider stop action failure' : 'Explicit browser native resource stop failure')
    expect([after.providerCloseStarts, after.captureCloseStarts]).toEqual([1,1])
    expect(await page.evaluate('[providerFixture.closeCalls,providerFixture.closeTerminal,providerFixture.calls,providerFixture.signs]')).toEqual([1,true,1,0])
  })
}
for (const stage of ['cancel-tab','operation-entered']) test(`private provider cleanup preserves original ${stage} error when stop also fails`, async ({page}) => {
  await prepareProviderCommand(page, {fail: stage, throwProviderStopAction:'foreground'})
  await beginProviderCommand(page)
  await page.waitForFunction('privateProviderCommandFixture.openingDone')
  await expect.poll(() => lockAvailable(page, 'migration')).toBe(true)
  const fixture = await page.evaluate<any>('privateProviderCommandFixture')
  expect([fixture.commandState,fixture.completedState]).toEqual(['rejected','rejected'])
  expect([fixture.commandError,fixture.completedError]).toEqual([
    'Explicit provider setup failure: '+stage,'Explicit provider setup failure: '+stage])
  expect(fixture.openingError).toBe('Explicit provider stop action failure')
  expect(fixture.providerStopActions).toEqual(['trusted-member','expiry','native-context','bootstrap','foreground','root','browser-owner','tab-owner'])
  expect(await page.evaluate('effects')).toEqual(none)
})

for (const fault of [false,true]) test(`private provider cleanup close reentry shares one actual promise, stopFaults=${fault}`, async ({page}) => {
  await prepareProviderCommand(page, fault ? {throwRootStops:['provider','capture'],throwProviderStopAction:'foreground',throwNativeStops:true} : {})
  await page.evaluate(() => { (window as any).providerFixture.closeMode = 'pending' })
  await beginProviderCommand(page); await page.waitForFunction('privateProviderCommandFixture.openingDone')
  await page.evaluate(() => {
    const w=window as any,f=w.privateProviderCommandFixture
    try {
      const first=w.__privateProviderCloseForTest(),second=w.__privateProviderCloseForTest()
      f.providerSamePromise=first===second
      void first.then(()=>{f.providerCloseDone=true},(error:Error)=>{f.providerCloseDone=true;f.providerCloseError=error.message})
    } catch(error) {f.providerCloseThrewSynchronously=(error as Error).message}
  })
  await closeProviderCommand(page)
  await page.waitForFunction('providerFixture.closeCalls===1')
  expect(await page.evaluate('privateProviderCommandFixture.providerCloseThrewSynchronously')).toBeUndefined()
  expect(await page.evaluate('privateProviderCommandFixture.providerSamePromise')).toBe(true)
  expect(await page.evaluate('privateProviderCommandFixture.providerCloseDone')).toBeUndefined()
  expect(await page.evaluate('privateProviderCommandFixture.closeDone')).toBeUndefined()
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate('providerFixture.closeRelease();undefined')
  await page.waitForFunction('privateProviderCommandFixture.providerCloseDone&&privateProviderCommandFixture.closeDone')
  expect(await lockAvailable(page,'migration')).toBe(true)
  const f=await page.evaluate<any>('privateProviderCommandFixture')
  expect([f.providerCloseStarts,f.captureCloseStarts]).toEqual([1,1])
  expect(f.providerCloseError).toBe(fault?'Explicit provider stop action failure':undefined)
  expect(f.closeError).toBe(fault?'Explicit root provider stop failure':undefined)
  expect(await page.evaluate('providerFixture.closeCalls')).toBe(1)
})
for (const first of ['sdk','capture'] as const) test(`private provider cleanup preserves initial resource error order when ${first} settles first`, async ({page}) => {
  await prepareProviderCommand(page, {captureCloseGate:true,captureCloseReject:true})
  await page.evaluate(() => {const f=(window as any).providerFixture;f.closeMode='pending';f.closeReject=true})
  await beginProviderCommand(page);await page.waitForFunction('privateProviderCommandFixture.openingDone')
  await closeProviderCommand(page)
  await page.waitForFunction('privateProviderCommandFixture.captureCloseEntered&&providerFixture.closeCalls===1')
  await page.evaluate(first=>{const w=window as any;if(first==='sdk')w.providerFixture.closeRelease();else w.privateProviderCommandFixture.captureCloseRelease()},first)
  await page.waitForFunction(first=>first==='sdk'?(window as any).providerFixture.closeTerminal:(window as any).privateProviderCommandFixture.captureCloseTerminal,first)
  expect(await page.evaluate('privateProviderCommandFixture.closeDone')).toBeUndefined()
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await lockAvailable(page,'lifetime:'+'a'.repeat(64))).toBe(false)
  await page.evaluate(first=>{const w=window as any;if(first==='sdk')w.privateProviderCommandFixture.captureCloseRelease();else w.providerFixture.closeRelease()},first)
  await page.waitForFunction('privateProviderCommandFixture.closeDone')
  expect(await lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('privateProviderCommandFixture.closeError')).toBe('Explicit SDK close fixture rejection')
  expect(await page.evaluate('[privateProviderCommandFixture.providerCloseStarts,privateProviderCommandFixture.captureCloseStarts,providerFixture.closeCalls]')).toEqual([1,1,1])
})
for(const keep of [false,true])test(`private provider cleanup stop failures retain the actual joined Session until erasure, keep=${keep}`,async({page})=>{
  await preparePrivateG0Join(page,keep,'grant',true)
  await beginPrivateG0Join(page);await page.waitForFunction('privateJoinDone')
  expect(await page.evaluate('privateJoinOutcome')).toBe('joined')
  const before=await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await page.evaluate(()=>{
    const w=window as any
    w.privateProviderCommandFixture={throwRootStops:['provider','capture'],throwProviderStopAction:'foreground'}
    w.__privateInstallNativeStopFaultForTest()
  })
  await closeProviderCommand(page)
  await page.waitForFunction('privateMemberDisposeCalls>0')
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await lockAvailable(page,'lifetime:'+'a'.repeat(64))).toBe(false)
  expect(await page.evaluate('privateProviderCommandFixture.closeDone')).toBeUndefined()
  expect(await page.evaluate('privateProviderCommandFixture.closeThrewSynchronously')).toBeUndefined()
  expect(await page.evaluate('providerFixture.closeCalls??0')).toBe(0)
  await page.evaluate(()=>{(window as any).privateMemberDisposePaused=false})
  await page.waitForFunction('privateProviderCommandFixture.closeDone')
  expect(await lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('privateProviderCommandFixture.closeError')).toBe('Explicit root provider stop failure')
  expect(await page.evaluate('[privateMemberCloseCalls,__privateSessionDisposedForTest,__privateSessionInputsWipedForTest(),__privateBootstrapWipedForTest(),providerFixture.closeCalls]')).toEqual([1,true,true,true,1])
  expect(await page.evaluate('privateProviderCommandFixture.nativeStops')).toEqual(['browser-throw','browser-later','tab-throw','tab-later'])
  expect(await page.evaluate('({signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
})


// Actual native owner preview mechanics. These privileged test hooks do not implement a
// trusted UI action, current membership, Unlock, Connect or production mounting.
async function prepareDraftSelectionPreview(page: Page, keep = true, signed = true): Promise<{account:string;roomId:string}> {
  const href = await seed(page, keep, false, signed)
  const expected = await page.evaluate<{account:string;roomId:string}>('({account,roomId})')
  await install(page); await enter(page, href, 'captured-held')
  return expected
}
async function beginDraftSelectionPreview(page: Page, kind = 'unlock-private-member'): Promise<void> {
  await page.evaluate(kind => {
    const w = window as any; w.draftPreviewDone = false
    w.draftPreviewPending = w.__draftPreviewForTest(kind).then((value:any) => {
      w.draftPreview = value; w.draftPreviewOutcome = 'preview'
    }, (error:Error) => {w.draftPreviewOutcome = error.name; w.draftPreviewError = error.message})
      .finally(() => {w.draftPreviewDone = true})
  }, kind)
}
for (const keep of [false,true]) test(`draft selection preview reads authenticated signed destinations without provider effects, keep=${keep}`,async({page})=>{
  const expected = await prepareDraftSelectionPreview(page,keep)
  await beginDraftSelectionPreview(page); await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('({outcome:draftPreviewOutcome,error:window.draftPreviewError})')).toEqual({outcome:'preview',error:undefined})
  expect(await page.evaluate(()=>{
    const w=window as any,p=w.draftPreview,d=p.display
    return{display:d,keys:Reflect.ownKeys(d),shape:[Object.getPrototypeOf(p)===null,Object.isFrozen(p),Object.getPrototypeOf(d)===null,Object.isFrozen(d),Object.isFrozen(d.relays),Object.getPrototypeOf(p.receipt)===null,Object.isFrozen(p.receipt),Reflect.ownKeys(p.receipt).length],available:w.__draftPreviewHasForTest(p.receipt)}
  })).toEqual({display:{...expected,roomLabel:'Fresh group',relays:['wss://signed.example/'],network:'direct'},keys:['account','roomId','roomLabel','relays','network'],shape:[true,true,true,true,true,true,true,0],available:true})
  expect(await page.evaluate('effects')).toEqual(none)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('window.__draftPreviewHasForTest(draftPreview.receipt)')).toBe(false)
})
test('draft selection preview refuses unsigned or fallback relay destinations before discovery',async({page})=>{
  await prepareDraftSelectionPreview(page,true,false);await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('draftPreviewOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('effects')).toEqual(none)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('draft selection preview refuses forged receipts without reflection then consumes its exact receipt once',async({page})=>{
  await prepareDraftSelectionPreview(page);await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate(()=>{
    const w=window as any;let reflected=0,refused=0
    const fake=new Proxy({},{get(){reflected++;throw Error('Foreign preview getter')},getPrototypeOf(){reflected++;throw Error('Foreign preview prototype')}})
    for(const receipt of [{},fake])try{w.__draftPreviewTakeForTest(receipt,'unlock-private-member')}catch{refused++}
    const available=w.__draftPreviewHasForTest(w.draftPreview.receipt)
    const value=w.__draftPreviewTakeForTest(w.draftPreview.receipt,'unlock-private-member')
    try{w.__draftPreviewTakeForTest(w.draftPreview.receipt,'unlock-private-member')}catch{refused++}
    return{reflected,refused,available,void:value===undefined,spent:!w.__draftPreviewHasForTest(w.draftPreview.receipt)}
  })).toEqual({reflected:0,refused:3,available:true,void:true,spent:true})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview spends a genuine receipt on wrong kind before replay',async({page})=>{
  await prepareDraftSelectionPreview(page);await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate(()=>{const w=window as any;let refused=0
    for(const kind of ['connect-private-member','unlock-private-member'])try{w.__draftPreviewTakeForTest(w.draftPreview.receipt,kind)}catch{refused++}
    return{refused,spent:!w.__draftPreviewHasForTest(w.draftPreview.receipt)}
  })).toEqual({refused:2,spent:true})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview spends a genuine receipt on foreign root without reflecting it',async({page})=>{
  await prepareDraftSelectionPreview(page);await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate(()=>{const w=window as any;let reflected=0,refused=0
    const root=new Proxy({},{get(){reflected++;throw Error('Foreign root getter')},getPrototypeOf(){reflected++;throw Error('Foreign root prototype')}})
    try{w.__draftPreviewTakeRootForTest(root,w.draftPreview.receipt,'unlock-private-member')}catch{refused++}
    try{w.__draftPreviewTakeForTest(w.draftPreview.receipt,'unlock-private-member')}catch{refused++}
    return{reflected,refused,spent:!w.__draftPreviewHasForTest(w.draftPreview.receipt)}
  })).toEqual({reflected:0,refused:2,spent:true})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview cannot supply Connect before actual trusted member construction',async({page})=>{
  await prepareDraftSelectionPreview(page);await beginDraftSelectionPreview(page,'connect-private-member');await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('draftPreviewOutcome')).toBe('OrdinaryStateHold')
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview rejects its receipt after privileged generation-cell drift',async({page})=>{
  await prepareDraftSelectionPreview(page);await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate(()=>{const w=window as any;w.__draftPreviewAdvanceForTest()
    try{w.__draftPreviewTakeForTest(w.draftPreview.receipt,'unlock-private-member');return'unexpected'}catch(error){return(error as Error).name}
  })).toBe('OrdinaryStateHold')
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview pagehide joins its pending authenticated read before MIGRATION release',async({page})=>{
  await prepareDraftSelectionPreview(page)
  await page.evaluate(()=>{(window as any).privateBootstrapGate={stage:'preview-tab'}})
  await beginDraftSelectionPreview(page);await page.waitForFunction('privateBootstrapGate.entered')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.evaluate('draftPreviewDone')).toBe(false)
  await page.evaluate(()=>(window as any).privateBootstrapGate.release())
  await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('draftPreviewOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('effects')).toEqual(none)
  expect(await page.evaluate('({browser:window.__draftPreviewBrowserWiped,tab:window.__draftPreviewTabWiped})')).toEqual({browser:true,tab:true})
})

// Decoder probes below exercise the actual private data reader using privileged
// hooks. Accessor-shaped objects cannot originate from JSON.parse; they are
// mechanics probes, separate from the real encrypted-store preview cases.
test('draft selection preview optional metadata ignores inherited getters, decoder mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{
    const w=window as any;let reads=0
    const names=['name','endedAt'],saved=names.map(key=>Object.getOwnPropertyDescriptor(Object.prototype,key))
    try{
      for(const key of names)Object.defineProperty(Object.prototype,key,{configurable:true,get(){reads++;throw Error('Inherited metadata getter')}})
      const metadata=JSON.parse('{"link":"owned","keep":false}')
      const missing=names.map(key=>w.__draftOwnDataForTest(metadata,key,true)===undefined)
      const owned=w.__draftOwnDataForTest(JSON.parse('{"name":"Own label"}'),'name',true)
      return{reads,missing,owned}
    }finally{for(let i=0;i<names.length;i++){if(saved[i])Object.defineProperty(Object.prototype,names[i],saved[i]!);else delete(Object.prototype as any)[names[i]]}}
  })).toEqual({reads:0,missing:[true,true],owned:'Own label'})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview refuses missing required and accessor fields without getter calls, decoder mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{
    const w=window as any;let reads=0,refused=0
    const inherited=Object.create({get link(){reads++;throw Error('Inherited required getter')}})
    const accessor=Object.create(null)
    Object.defineProperty(accessor,'name',{get(){reads++;throw Error('Own metadata getter')}})
    Object.defineProperty(accessor,'relays',{get(){reads++;throw Error('Own admission getter')}})
    for(const[value,key,optional]of [[inherited,'link',false],[accessor,'name',true],[accessor,'relays',false]]as const){
      try{w.__draftOwnDataForTest(value,key,optional)}catch(error){if((error as Error).name==='OrdinaryStateHold')refused++;else throw error}
    }
    return{reads,refused}
  })).toEqual({reads:0,refused:3})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview refuses malformed metadata containers, decoder mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{const w=window as any;let refused=0
    for(const value of [null,undefined,'text',false,7,[]])try{w.__draftOwnDataForTest(value,'name',true)}catch(error){if((error as Error).name==='OrdinaryStateHold')refused++;else throw error}
    return refused
  })).toBe(6)
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview native read ignores inherited work and receipt accessors',async({page})=>{
  await prepareDraftSelectionPreview(page)
  await page.evaluate(()=>{
    const w=window as any;w.draftPrototypeCalls=0;w.draftPrototypeSaved=['work','receipt'].map(key=>Object.getOwnPropertyDescriptor(Object.prototype,key))
    for(const key of ['work','receipt'])Object.defineProperty(Object.prototype,key,{configurable:true,get(){w.draftPrototypeCalls++;throw Error('Inherited '+key+' getter')},set(){w.draftPrototypeCalls++;throw Error('Inherited '+key+' setter')}})
  })
  try{
    await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
    expect(await page.evaluate('({outcome:draftPreviewOutcome,calls:draftPrototypeCalls})')).toEqual({outcome:'preview',calls:0})
    expect(await page.evaluate('window.__draftPreviewRecordsForTest(draftPreview.receipt)')).toEqual({workNull:true,slotNull:true,ownReceipt:true,ownWork:true})
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
    expect(await page.evaluate('({calls:draftPrototypeCalls,available:window.__draftPreviewHasForTest(draftPreview.receipt)})')).toEqual({calls:0,available:false})
  }finally{
    await page.evaluate(()=>{const w=window as any;for(const[i,key]of ['work','receipt'].entries()){const d=w.draftPrototypeSaved[i];if(d)Object.defineProperty(Object.prototype,key,d);else delete(Object.prototype as any)[key]}})
  }
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview refuses a concurrent preparation without disturbing the pending read',async({page})=>{
  await prepareDraftSelectionPreview(page)
  await page.evaluate(()=>{(window as any).privateBootstrapGate={stage:'preview-tab'}})
  await beginDraftSelectionPreview(page);await page.waitForFunction('privateBootstrapGate.entered')
  expect(await page.evaluate(async()=>{const w=window as any;try{await w.__draftPreviewForTest('unlock-private-member');return'unexpected'}catch(error){return(error as Error).name}})).toBe('OrdinaryStateHold')
  expect(await page.evaluate('draftPreviewDone')).toBe(false)
  await page.evaluate(()=>(window as any).privateBootstrapGate.release());await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('({outcome:draftPreviewOutcome,available:window.__draftPreviewHasForTest(draftPreview.receipt)})')).toEqual({outcome:'preview',available:true})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview replacement revokes the prior receipt before publishing its successor',async({page})=>{
  await prepareDraftSelectionPreview(page);await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  await page.evaluate('window.draftFirstPreview=draftPreview')
  await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate(()=>{const w=window as any;let refused=0
    const first=w.draftFirstPreview.receipt,next=w.draftPreview.receipt
    const available=[w.__draftPreviewHasForTest(first),w.__draftPreviewHasForTest(next)]
    try{w.__draftPreviewTakeForTest(first,'unlock-private-member')}catch{refused++}
    const result=w.__draftPreviewTakeForTest(next,'unlock-private-member')
    return{distinct:first!==next,available,refused,void:result===undefined,spent:!w.__draftPreviewHasForTest(next)}
  })).toEqual({distinct:true,available:[false,true],refused:1,void:true,spent:true})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview cleanup fault still wipes both images and drains MIGRATION',async({page})=>{
  await prepareDraftSelectionPreview(page)
  await page.evaluate('window.__draftPreviewCleanupFault=true')
  await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('({outcome:draftPreviewOutcome,fault:window.__draftPreviewCleanupFault, browser:window.__draftPreviewBrowserWiped,tab:window.__draftPreviewTabWiped})')).toEqual({outcome:'OrdinaryStateHold',fault:false,browser:true,tab:true})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview fixed root revoke spends the published receipt without provider effects',async({page})=>{
  await prepareDraftSelectionPreview(page);await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate(()=>{const w=window as any;w.__draftPreviewRevokeForTest();let refused=0
    try{w.__draftPreviewTakeForTest(w.draftPreview.receipt,'unlock-private-member')}catch{refused++}
    return{refused,available:w.__draftPreviewHasForTest(w.draftPreview.receipt)}
  })).toEqual({refused:1,available:false})
  expect(await page.evaluate('effects')).toEqual(none)
})

// Further data-boundary mechanics, separate from protected native read proof.
test('draft selection preview relay copy matches the direct transport canonical subset, mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{const w=window as any,values=['wss://relay.example/','wss://relay.example/path?a=1&b=2','ws://localhost:8080/','ws://127.0.0.1/','ws://[::1]/']
    const copied=w.__draftRelayDataForTest(values)
    return{values:copied,same:w.__draftSameRelaysForTest(copied,w.__draftRelayDataForTest(values)),frozen:Object.isFrozen(copied),nullPrototype:Object.getPrototypeOf(copied)===null}
  })).toEqual({values:['wss://relay.example/','wss://relay.example/path?a=1&b=2','ws://localhost:8080/','ws://127.0.0.1/','ws://[::1]/'],same:true,frozen:true,nullPrototype:true})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview relay copy rejects holes accessors and extra fields without getter calls, mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{const w=window as any;let getters=0,refused=0
    const sparse=new Array(1),accessor=['wss://safe.example/'],extra=['wss://safe.example/']
    Object.defineProperty(accessor,'0',{get(){getters++;throw Error('Own relay accessor')}})
    Object.defineProperty(extra,'extra',{value:true})
    const arrays=[sparse,accessor,extra,[],['wss://safe.example/','wss://safe.example/']]
    const saved=Object.getOwnPropertyDescriptor(Array.prototype,'0')
    try{Object.defineProperty(Array.prototype,'0',{configurable:true,get(){getters++;throw Error('Inherited relay element')}})
      for(let i=0;i<arrays.length;i++)try{w.__draftRelayDataForTest(arrays[i])}catch{refused++}
    }finally{if(saved)Object.defineProperty(Array.prototype,'0',saved);else delete(Array.prototype as any)[0]}
    return{getters,refused}
  })).toEqual({getters:0,refused:5})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview relay copy refuses unsafe or noncanonical destinations, mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{const w=window as any;let refused=0
    const invalid=['ws://public.example/','https://relay.example/','wss://user:password@relay.example/','wss://relay.example/#fragment',' wss://relay.example/','wss://relay.example','wss://RELAY.example/','wss://relay.example//path','wss://relay.example/path/','wss://relay.example/?b=2&a=1','wss://relay.example/?a=%20']
    for(let i=0;i<invalid.length;i++)try{w.__draftRelayDataForTest([invalid[i]])}catch{refused++}
    return{refused,total:invalid.length}
  })).toEqual({refused:11,total:11})
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview relay and metadata readers retain captured intrinsics, mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{const w=window as any;let calls=0
    const own=Object.getOwnPropertyDescriptor,define=Object.defineProperty,saved=[
      [Object,'getOwnPropertyDescriptor'],[Object.prototype,'hasOwnProperty'],[Array,'isArray'],[Array.prototype,'map'],[Array.prototype,Symbol.iterator],
      [JSON,'stringify'],[window,'URL'],[URLSearchParams.prototype,'sort'],[Object,'freeze'],[Object,'defineProperty'],[Object,'setPrototypeOf']
    ].map(([object,key])=>({object:object as object,key:key as PropertyKey,descriptor:own(object as object,key as PropertyKey)!}))
    const values=['wss://safe.example/path?a=1&b=2'],metadata=JSON.parse('{"link":"owned","keep":false}')
    let copied:any,missing=false,same=false
    const poison=()=>{calls++;throw Error('Ambient intrinsic used')}
    try{
      for(let i=0;i<saved.length;i++)define(saved[i].object,saved[i].key,{configurable:true,writable:true,value:poison})
      copied=w.__draftRelayDataForTest(values);missing=w.__draftOwnDataForTest(metadata,'name',true)===undefined
      same=w.__draftSameRelaysForTest(copied,w.__draftRelayDataForTest(values))
    }finally{for(let i=saved.length-1;i>=0;i--)define(saved[i].object,saved[i].key,saved[i].descriptor)}
    return{calls,copied,missing,same}
  })).toEqual({calls:0,copied:['wss://safe.example/path?a=1&b=2'],missing:true,same:true})
  expect(await page.evaluate('effects')).toEqual(none)
})

test('draft selection preview refuses replaced ambient validator helpers before native reading without invoking them',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(async()=>{const w=window as any;let calls=0,refused=0
    const get=Object.getOwnPropertyDescriptor,define=Object.defineProperty
    const fields:[[object,PropertyKey],[object,PropertyKey],[object,PropertyKey]]=[[JSON,'stringify'],[Map.prototype,'values'],[Array.prototype,'filter']]
    for(let i=0;i<fields.length;i++){
      const[object,key]=fields[i],saved=get(object,key)!
      try{
        define(object,key,{configurable:true,get(){calls++;throw Error('Ambient validator helper getter')}})
        try{await w.__draftPreviewForTest('unlock-private-member')}catch(error){if((error as Error).name==='OrdinaryStateHold')refused++;else throw error}
      }finally{define(object,key,saved)}
    }
    return{calls,refused}
  })).toEqual({calls:0,refused:3})
  await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('draftPreviewOutcome')).toBe('preview')
  expect(await page.evaluate('effects')).toEqual(none)
})
test('draft selection preview malformed URL decoder produces only owned Hold outcomes, mechanics',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(()=>{const w=window as any;let refused=0
    for(const value of ['not a URL','wss://[invalid/','wss://'])try{w.__draftRelayDataForTest([value])}catch(error){if((error as Error).name==='OrdinaryStateHold')refused++;else throw error}
    return refused
  })).toBe(3)
  expect(await page.evaluate('effects')).toEqual(none)
})

test('draft selection preview refuses inherited toJSON before any protected read or serializer callback',async({page})=>{
  await prepareDraftSelectionPreview(page)
  expect(await page.evaluate(async()=>{const w=window as any;let calls=0,refused=0
    const define=Object.defineProperty,get=Object.getOwnPropertyDescriptor,prototypes=[Object.prototype,Array.prototype]
    for(let i=0;i<prototypes.length;i++){
      const prototype=prototypes[i],saved=get(prototype,'toJSON')
      try{
        define(prototype,'toJSON',{configurable:true,get(){calls++;throw Error('Inherited serializer getter')}})
        try{await w.__draftPreviewForTest('unlock-private-member')}catch(error){if((error as Error).name==='OrdinaryStateHold')refused++;else throw error}
      }finally{if(saved)define(prototype,'toJSON',saved);else delete(prototype as any).toJSON}
    }
    return{calls,refused}
  })).toEqual({calls:0,refused:2})
  await beginDraftSelectionPreview(page);await page.waitForFunction('draftPreviewDone')
  expect(await page.evaluate('draftPreviewOutcome')).toBe('preview')
  expect(await page.evaluate('effects')).toEqual(none)
})

async function prepareTrustedMemberUI(page: Page, keep = true, gated = false, network = false): Promise<void> {
  const href=await seed(page,keep,false,true),account=await page.evaluate<string>('account'),secret=Uint8Array.from(await page.evaluate<number[]>('Array.from(participantSk)'))
  await page.exposeFunction('__controlSign',(event:Parameters<typeof finalizeEvent>[0])=>JSON.parse(JSON.stringify(finalizeEvent(event,secret))))
  const peer:PrivateG0JoinPeer|undefined=network?await page.evaluate(async()=>{const w=window as any,material=await w.bootstrap.load()
    if(!material)throw Error('Missing native fixture peer')
    try{return{roomId:w.roomId,credential:material.credential,secret:Array.from(material.admission.secret)as number[],authority:Array.from(w.inviterSk)as number[]}}
    finally{w.Ordinary.wipeOrdinaryPersistentBootstrapResult(material)}
  }):undefined
  await install(page);await providerFixture(page,account,gated)
  await page.addInitScript(()=>{(window as any).privateTrustedMemberFixture=true})
  await releaseFixture(page);await page.goto(href)
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='unlock-ready'")
  await page.evaluate(()=>{const w=window as any;w.providerFixture.closeMode='success';w.providerFixture.controlMode='success';w.privateMemberConstruction=true
    Object.defineProperty(window,'nostr',{configurable:true,writable:true,value:w.providerFixture.current})})
  if(peer)await installTrustedMemberPeer(page,peer)
}
for(const mode of ['pointer','Enter','Space']as const)test(`trusted member native Unlock constructs the member once without network, ${mode}`,async({page})=>{
  await prepareTrustedMemberUI(page)
  const button=page.locator('[data-private-member-action="unlock-private-member"]')
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put,effects.entropy]')).toEqual([0,0,0,0,0])
  await expect(page.locator('[data-private-member-view]')).toContainText('wss://signed.example/')
  if(mode==='pointer')await button.click();else{await button.focus();await page.keyboard.press(mode)}
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='verify-ready'||document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket]')).toEqual([1,0,0])
  const verify=page.locator('[data-private-member-action="verify-private-member"]')
  await page.evaluate(()=>{(document.querySelector('[data-private-member-action="verify-private-member"]') as HTMLButtonElement).click()})
  expect(await page.evaluate('providerFixture.signs')).toBe(0)
  if(mode==='pointer')await verify.click();else{await verify.focus();await page.keyboard.press(mode)}
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='connect-ready'||document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  const observed=await page.evaluate('({state:document.documentElement.dataset.ordinaryProtectedStartup,outcome:window.__trustedCommandOutcome,error:window.__trustedCommandError,calls:providerFixture.calls,signs:providerFixture.signs,effects,constructed:window.__privateMemberConstructedForTest,order:window.__privateControllerOrder})')
  expect(observed,JSON.stringify(observed)).toMatchObject({state:'connect-ready',outcome:'fulfilled',calls:1,signs:1,constructed:true,order:['controller','session','attached'],effects:{socket:0,put:0,storageWrite:0,key:0}})
  await expect(page.locator('[data-private-member-action="connect-private-member"]')).toBeEnabled()
  await expect(button).toHaveCount(0)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('trusted member synthetic clicks and keyboard events cannot request a wallet',async({page})=>{
  await prepareTrustedMemberUI(page)
  await page.evaluate(()=>{const button=document.querySelector('[data-private-member-action]') as HTMLButtonElement
    button.click();button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})
  expect(await page.evaluate('({state:document.documentElement.dataset.ordinaryProtectedStartup,calls:providerFixture.calls,signs:providerFixture.signs,effects})')).toMatchObject({state:'unlock-ready',calls:0,signs:0,effects:none})
  await expect(page.locator('[data-private-member-action="unlock-private-member"]')).toBeEnabled()
})


async function installTrustedMemberPeer(page:Page,peer:PrivateG0JoinPeer):Promise<void>{
  await page.exposeFunction('__privateJoinPeerGrant',(request:{id:string;pubkey:string})=>encodeEpochGrant({roomId:peer.roomId,authoritySk:Uint8Array.from(peer.authority),device:request.pubkey,request:request.id,
    epoch:{epoch:0,secret:Uint8Array.from(peer.secret)},credential:peer.credential!,removed:[],now:Math.floor(Date.now()/1000)}))
  await page.evaluate(({roomId,participant})=>{
    const w=window as any;w.privateJoinFixtureRoom=roomId;w.privateJoinFixturePrefix='kithmoot.account.'+participant+'.';w.privateJoinNetworkFixture=true;w.privateJoinGrantReady=false;w.privateJoinEpochRequested=false;w.privateJoinFrames=[];w.privateJoinSockets=[]
    w.__privateJoinSocket=class {
      readyState=0;onopen:any=null;onmessage:any=null;onclose:any=null;onerror:any=null;requests=new Map<string,any[]>()
      constructor(readonly url:string){w.privateJoinSockets.push(this);queueMicrotask(()=>{if(this.readyState===3)return;this.readyState=1;this.onopen?.({type:'open'})})}
      message(frame:unknown[]){if(this.readyState!==3)this.onmessage?.({data:JSON.stringify(frame)})}
      send(raw:string){
        if(!w.__controlDecision)throw Error('Join socket send outside native decision')
        const frame=JSON.parse(raw);w.privateJoinFrames.push({frame,native:!!w.__controlDecision,url:this.url})
        if(frame[0]==='REQ')this.requests.set(frame[1],frame.slice(2))
        if(frame[0]==='CLOSE')this.requests.delete(frame[1])
        queueMicrotask(async()=>{
          if(frame[0]==='REQ')this.message(['EOSE',frame[1]])
          if(frame[0]==='EVENT'){
            this.message(['OK',frame[1].id,true,'accepted'])
            if(frame[1].kind===20468){
              w.privateJoinEpochRequested=true
              const grant=await w.__privateJoinPeerGrant(frame[1]);if(!grant)return
              if(w.privateJoinPauseGrant){w.privateJoinGrantReady=true;await new Promise<void>(yes=>{w.privateJoinReleaseGrant=yes})}
              for(const socket of w.privateJoinSockets)for(const[id,filters]of socket.requests)
                if(filters.some((f:any)=>f.kinds?.includes(grant.kind)))socket.message(['EVENT',id,grant])
            }
          }
        })
      }
      close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.({type:'close'})}
    }
  },{roomId:peer.roomId,participant:peer.credential!.pubkey})
}
for(const {keep,mode} of [{keep:false,mode:'pointer'},{keep:true,mode:'pointer'},{keep:true,mode:'Enter'},{keep:true,mode:'Space'}])test(`trusted member Connect joins the retained member only after a fresh native action, keep=${keep}, ${mode}`,async({page})=>{
  await prepareTrustedMemberUI(page,keep,false,true)
  await page.locator('[data-private-member-action="unlock-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='verify-ready'||document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  expect(await page.evaluate('document.documentElement.dataset.ordinaryProtectedStartup')).toBe('verify-ready')
  await page.locator('[data-private-member-action="verify-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='connect-ready'||document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  expect(await page.evaluate('document.documentElement.dataset.ordinaryProtectedStartup')).toBe('connect-ready')
  const before=await page.evaluate('({calls:providerFixture.calls,signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')
  await page.evaluate(()=>{const button=document.querySelector('[data-private-member-action="connect-private-member"]')as HTMLButtonElement;button.click();button.dispatchEvent(new MouseEvent('click',{bubbles:true}))})
  expect(await page.evaluate('effects.socket')).toBe(0)
  const connect=page.locator('[data-private-member-action="connect-private-member"]');if(mode==='pointer')await connect.click();else{await connect.focus();await page.keyboard.press(mode)}
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='member-joined'||document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  const result=await page.evaluate('({state:document.documentElement.dataset.ordinaryProtectedStartup,outcome:window.__trustedCommandOutcome,error:window.__trustedCommandError,joinError:window.__privateJoinFailureForTest,effects,frames:window.privateJoinFrames})')
  expect(result,JSON.stringify(result)).toMatchObject({state:'member-joined',outcome:'fulfilled',effects:{socket:1,put:0,storageWrite:0,key:0}})
  expect(await page.evaluate('({calls:providerFixture.calls,signs:providerFixture.signs,put:effects.put,storage:effects.storageWrite})')).toEqual(before)
  expect(await page.evaluate('__privateJoinedSessionForTest()')).toMatchObject({state:'joined',outer:true,native:true,receipt:true,closed:false,snapshot:{epoch:0,channels:[]}})
  expect(await page.evaluate('privateJoinFrames.every((value)=>value.native&&value.url==="wss://signed.example/")')).toBe(true)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('privateJoinSockets.every((socket)=>socket.readyState===3)')).toBe(true)
})
test('trusted member pagehide joins pending account discovery before releasing MIGRATION',async({page})=>{
  await prepareTrustedMemberUI(page,true,true)
  await page.locator('[data-private-member-action]').click();await page.waitForFunction('providerFixture.started')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.locator('[data-private-member-view]').count()).toBe(0)
  await page.evaluate('providerFixture.release();undefined')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({calls:providerFixture.calls,signs:providerFixture.signs,sockets:effects.socket,put:effects.put})')).toEqual({calls:1,signs:0,sockets:0,put:0})
})
test('trusted member pagehide joins pending account proof without constructing or connecting the member',async({page})=>{
  await prepareTrustedMemberUI(page)
  await page.evaluate('providerFixture.controlGated=true')
  await page.locator('[data-private-member-action="unlock-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='verify-ready'")
  await page.locator('[data-private-member-action="verify-private-member"]').click();await page.waitForFunction('providerFixture.signingStarted')
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate('providerFixture.releaseControl();undefined')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({calls:providerFixture.calls,signs:providerFixture.signs,sockets:effects.socket,put:effects.put,constructed:!!window.__privateMemberConstructedForTest})')).toEqual({calls:1,signs:1,sockets:0,put:0,constructed:false})
})
test('trusted member later native input retires pending discovery instead of renewing its authority',async({page})=>{
  await prepareTrustedMemberUI(page,true,true)
  await page.evaluate(()=>{const button=document.createElement('button');button.type='button';button.id='laterInput';button.textContent='Other action';document.body.append(button)})
  await page.locator('[data-private-member-action]').click();await page.waitForFunction('providerFixture.started')
  await page.locator('#laterInput').click()
  expect(await page.locator('[data-private-member-view]').count()).toBe(0)
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate('providerFixture.release();undefined')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put]')).toEqual([1,0,0,0])
})
test('trusted member altered displayed destinations refuse before any wallet request',async({page})=>{
  await prepareTrustedMemberUI(page)
  await page.locator('[data-private-member-view] p').filter({hasText:'Direct relay destinations:'}).evaluate(node=>{node.textContent='Direct relay destinations: wss://substituted.example/'})
  await page.locator('[data-private-member-action]').click()
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put]')).toEqual([0,0,0,0])
})

test('trusted member pending wallet ticket refuses forged focus after blur and drains on pagehide',async({page})=>{
  await prepareTrustedMemberUI(page,true,true)
  await page.locator('[data-private-member-action]').click();await page.waitForFunction('providerFixture.started')
  expect(await page.evaluate('window.__trustedWalletRetryForTest()')).toBe('held')
  await page.evaluate(()=>window.dispatchEvent(new FocusEvent('blur')))
  expect(await page.locator('[data-private-member-view]').count()).toBe(1)
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate('providerFixture.release();undefined')
  await page.evaluate(()=>new Promise<void>(yes=>setTimeout(yes,100)))
  await page.evaluate(()=>window.dispatchEvent(new FocusEvent('focus')))
  await page.evaluate(()=>new Promise<void>(yes=>setTimeout(yes,100)))
  expect(await page.locator('[data-private-member-action="verify-private-member"]').count()).toBe(0)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket]')).toEqual([1,0,0])
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('window.__trustedWalletRetryForTest()')).toBe('held')
})

/** Labelled fault injection wraps the actual native methods before root capture.
 * It never returns an intent, provider, receipt or owner to the test. */
async function installTrustedMemberCleanupFault(page:Page):Promise<void>{
  await page.addInitScript(()=>{
    const w=window as any
    w.memberCleanupFault={armed:false,used:false,mode:'',removed:[]}
    const disabled=Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype,'disabled')!
    Object.defineProperty(HTMLButtonElement.prototype,'disabled',{...disabled,set(value){
      Reflect.apply(disabled.set!,this,[value]);const f=w.memberCleanupFault
      if(f.armed&&f.mode==='disable'&&this.hasAttribute('data-private-member-action')){f.removed.push('disable');if(!f.used){f.used=true;throw Error('Explicit member cleanup fault: disable')}}
    }})
    const remove=EventTarget.prototype.removeEventListener,detach=Node.prototype.removeChild
    EventTarget.prototype.removeEventListener=function(type,listener,options){
      const f=w.memberCleanupFault
      const owned=this instanceof HTMLButtonElement&&this.hasAttribute('data-private-member-action')
      const label=this===window?'window':this===document?'document':owned?'button':'other'
      const result=Reflect.apply(remove,this,[type,listener,options])
      if(f.armed){
        f.removed.push(label+':'+type)
        const match=f.mode==='wallet-focus'?label==='window'&&type==='focus':f.mode==='watch'?label==='window'&&type==='pointerdown':f.mode==='button'?owned&&type==='click':false
        if(match&&!f.used){f.used=true;throw Error('Explicit member cleanup fault: '+f.mode)}
      }
      return result
    }
    Node.prototype.removeChild=function<T extends Node>(child:T):T{
      const owned=child instanceof HTMLElement&&child.hasAttribute('data-private-member-view')
      const result=Reflect.apply(detach,this,[child])as T,f=w.memberCleanupFault
      if(f.armed&&owned){f.removed.push('node');if(f.mode==='node'&&!f.used){f.used=true;throw Error('Explicit member cleanup fault: node')}}
      return result
    }
  })
}
async function advanceTrustedMemberToProof(page:Page):Promise<void>{
  await page.locator('[data-private-member-action="unlock-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='verify-ready'")
}
for(const phase of ['unlock','verify']as const)for(const fault of ['wallet-focus','watch','button','node','disable','preview']as const)
test(`trusted member cleanup ${fault} failure during ${phase} refuses next publication and drains all owners`,async({page})=>{
  await installTrustedMemberCleanupFault(page);await prepareTrustedMemberUI(page,true,fault==='disable'&&phase==='unlock')
  if(phase==='verify')await advanceTrustedMemberToProof(page)
  if(fault==='disable'&&phase==='verify')await page.evaluate('providerFixture.controlGated=true')
  await page.evaluate(mode=>{const f=(window as any).memberCleanupFault;f.mode=mode;f.armed=mode!=='disable'},fault)
  await page.locator('[data-private-member-action="'+(phase==='unlock'?'unlock-private-member':'verify-private-member')+'"]').click()
  if(fault==='disable'){
    await page.waitForFunction(phase=>phase==='unlock'?(window as any).providerFixture.started:(window as any).providerFixture.signingStarted,phase)
    await page.evaluate(phase=>{const w=window as any;w.memberCleanupFault.armed=true;if(phase==='unlock')w.providerFixture.release();else w.providerFixture.releaseControl()},phase)
  }
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate(async()=>{try{await(window as any).__trustedRootCloseForTest();return'fulfilled'}catch(error){return(error as Error).message}})).toBe('Explicit member cleanup fault: '+fault)
  expect(await page.locator('[data-private-member-view]').count()).toBe(0)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put,effects.storageWrite,providerFixture.closeCalls]')).toEqual([1,phase==='unlock'?0:1,0,0,0,phase==='unlock'&&fault==='wallet-focus'?undefined:1])
  expect(await page.evaluate('__trustedSdkOutcomeForTest')).toBe(phase==='unlock'&&fault==='wallet-focus'?'rejected':'fulfilled')
  const f=await page.evaluate<any>('memberCleanupFault');expect(f.used).toBe(true)
  if(fault==='watch')expect(f.removed).toEqual(expect.arrayContaining(['window:pointerdown','window:mousedown','window:touchend','window:keydown','window:click','window:blur','window:pagehide','document:visibilitychange','button:click','node']))
})

for(const phase of ['unlock','verify']as const)for(const outcome of ['throw','reject']as const)
test(`trusted member ${phase} provider ${outcome} spends its ticket and drains without next action`,async({page})=>{
  await prepareTrustedMemberUI(page);if(phase==='verify')await advanceTrustedMemberToProof(page)
  await page.evaluate(({phase,outcome})=>{const f=(window as any).providerFixture;if(phase==='unlock')f.discoveryOutcome=outcome;else f.controlOutcome=outcome},{phase,outcome})
  await page.locator('[data-private-member-action="'+(phase==='unlock'?'unlock-private-member':'verify-private-member')+'"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('window.__trustedWalletRetryForTest()')).toBe('held')
  expect(await page.locator('[data-private-member-view]').count()).toBe(0)
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put,effects.storageWrite]')).toEqual([1,phase==='unlock'?0:1,0,0,0])
  expect(await page.evaluate('__trustedSdkOutcomeForTest')).toBe(phase==='unlock'?'rejected':'fulfilled')
})
for(const phase of ['unlock','verify']as const)for(const cut of ['controller','native-input']as const)
test(`trusted member ${phase} ${cut} revokes its pending ticket and joins actual provider before lock release`,async({page})=>{
  await prepareTrustedMemberUI(page,true,phase==='unlock');if(phase==='verify'){await advanceTrustedMemberToProof(page);await page.evaluate('providerFixture.controlGated=true')}
  if(cut==='native-input')await page.evaluate(()=>{const button=document.createElement('button');button.type='button';button.id='laterInput';button.textContent='Other action';document.body.append(button)})
  await page.locator('[data-private-member-action="'+(phase==='unlock'?'unlock-private-member':'verify-private-member')+'"]').click()
  await page.waitForFunction(phase=>phase==='unlock'?(window as any).providerFixture.started:(window as any).providerFixture.signingStarted,phase)
  expect(await page.evaluate('window.__trustedWalletRetryForTest()')).toBe('held')
  if(cut==='native-input')await page.locator('#laterInput').click();else await page.evaluate(()=>navigator.serviceWorker.dispatchEvent(new Event('controllerchange')))
  expect(await page.locator('[data-private-member-view]').count()).toBe(0)
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate(phase=>{const f=(window as any).providerFixture;if(phase==='unlock')f.release();else f.releaseControl()},phase)
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('window.__trustedWalletRetryForTest()')).toBe('held')
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put,effects.storageWrite]')).toEqual([1,phase==='unlock'?0:1,0,0,0])
})

test('private provider cleanup trusted member revoker cancellation failure clears authority and joins pending proof and SDK close',async({page})=>{
  await prepareTrustedMemberUI(page);await advanceTrustedMemberToProof(page)
  await page.evaluate(()=>{const w=window as any;w.providerFixture.controlGated=true;w.providerFixture.closeMode='pending';w.privateProviderCommandFixture={};w.__retiredTrustedButtonForTest=document.querySelector('[data-private-member-action]')})
  await page.locator('[data-private-member-action="verify-private-member"]').click();await page.waitForFunction('providerFixture.signingStarted')
  await page.evaluate(()=>{const w=window as any,f=w.privateProviderCommandFixture;f.throwTrustedMemberRevocation=true
    const a=w.__trustedRootCloseForTest(),b=w.__trustedRootCloseForTest();f.closeSame=a===b
    void a.then(()=>{f.closeState='fulfilled';f.closeDone=true},(error:Error)=>{f.closeState='rejected';f.closeError=error.message;f.closeDone=true})})
  const before=await page.evaluate<any>('privateProviderCommandFixture')
  expect(before.closeSame).toBe(true)
  expect(before.trustedRevocationBefore).toEqual({member:false,provider:true,pending:true})
  expect(before.trustedRevocationAfter).toEqual({member:false,provider:false,pendingStopped:true})
  expect(before.providerStopActions).toEqual(['trusted-member','expiry','native-context','bootstrap','foreground','root','browser-owner','tab-owner'])
  expect(before.closeDone).toBeUndefined()
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.locator('[data-private-member-view]').count()).toBe(0)
  expect(await page.evaluate('providerFixture.closeCalls??0')).toBe(0)
  await page.evaluate('__retiredTrustedButtonForTest.click();undefined')
  expect(await page.evaluate('window.__trustedWalletRetryForTest()')).toBe('held')
  expect(await page.evaluate('window.__privateRestoreProviderNowForTest().then(()=>"unexpected",()=>"held")')).toBe('held')
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put,effects.storageWrite,!!window.__privateMemberConstructedForTest]')).toEqual([1,1,0,0,0,false])
  await page.evaluate('providerFixture.releaseControl();undefined');await page.waitForFunction('providerFixture.closeCalls===1')
  expect(await lockAvailable(page,'migration')).toBe(false)
  expect(await page.evaluate('privateProviderCommandFixture.closeDone')).toBeUndefined()
  await page.evaluate('providerFixture.closeRelease();undefined');await page.waitForFunction('privateProviderCommandFixture.closeDone')
  expect(await lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('[privateProviderCommandFixture.closeState,privateProviderCommandFixture.closeError,providerFixture.closeCalls,providerFixture.closeTerminal]')).toEqual(['rejected','Explicit trusted member revoker cancellation failure',1,true])
  expect(await page.evaluate('[providerFixture.calls,providerFixture.signs,effects.socket,effects.put,effects.storageWrite,!!window.__privateMemberConstructedForTest]')).toEqual([1,1,0,0,0,false])
})

async function renewalDuePlumbingReady(page:any, joined:boolean, fault?:string):Promise<void>{
  await prepareTrustedMemberUI(page,true,false,true)
  if(fault)await page.evaluate((value:string)=>{(window as any).__privateRootIndexFault=value},fault)
  await page.locator('[data-private-member-action="unlock-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='verify-ready'")
  await page.locator('[data-private-member-action="verify-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='connect-ready'")
  if(joined){
    await page.locator('[data-private-member-action="connect-private-member"]').click()
    await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='member-joined'")
  }
}
test('renewal due plumbing refuses an attached but unjoined member without effects',async({page})=>{
  await renewalDuePlumbingReady(page,false)
  const result=await page.evaluate(()=>{
    const w=window as any,p=w.__privateControllerRenewalForTest,before=JSON.stringify(w.effects)
    let refused=false;try{p.joined()}catch{refused=true}
    return{refused,indexed:p.indexed(),effectsUnchanged:JSON.stringify(w.effects)===before,joined:w.__privateJoinControllerForTest().joined}
  })
  expect(result).toEqual({refused:true,indexed:true,effectsUnchanged:true,joined:false})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('renewal due plumbing captures only the genuine joined tuple and refuses foreign handles',async({page})=>{
  await renewalDuePlumbingReady(page,true)
  const result=await page.evaluate(()=>{
    const w=window as any,p=w.__privateControllerRenewalForTest,controller=w.__privateControllerResourceForTest,before=JSON.stringify(w.effects)
    const first=p.joined(),second=p.joined();let foreignRenewal=false,foreignBootstrap=false,foreignController=false
    try{p.joined(Object.freeze({}))}catch{foreignRenewal=true}
    try{p.joined(undefined,Object.freeze({}))}catch{foreignBootstrap=true}
    try{w.__privateControllerFunctionsForTest.captureJoined(Object.freeze({}),Object.freeze({}))}catch{foreignController=true}
    return{indexed:p.indexed(),frozen:Object.isFrozen(first),nullPrototype:Object.getPrototypeOf(first)===null,keys:Reflect.ownKeys(first).map(String).sort(),
      receiptOpaque:Object.isFrozen(first.receipt)&&Reflect.ownKeys(first.receipt).length===0,sameReceipt:first.receipt===second.receipt,
      dueAtMatches:first.dueAt===w.__privateJoinControllerForTest().dueAt,foreignRenewal,foreignBootstrap,foreignController,
      controllerOpaque:Reflect.ownKeys(controller).length===0,effectsUnchanged:JSON.stringify(w.effects)===before}
  })
  expect(result).toEqual({indexed:true,frozen:true,nullPrototype:true,keys:['dueAt','receipt'],receiptOpaque:true,sameReceipt:true,dueAtMatches:true,
    foreignRenewal:true,foreignBootstrap:true,foreignController:true,controllerOpaque:true,effectsUnchanged:true})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('renewal due plumbing retires its own root index and refuses capture after native stop',async({page})=>{
  await renewalDuePlumbingReady(page,true)
  expect(await page.evaluate('window.__privateControllerRenewalForTest.indexed()')).toBe(true)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  const result=await page.evaluate(()=>{
    const w=window as any,p=w.__privateControllerRenewalForTest;let refused=false;try{p.joined()}catch{refused=true}
    return{refused,indexed:p.indexed(),closed:p.state().closed}
  })
  expect(result).toEqual({refused:true,indexed:false,closed:true})
})

test('renewal root reservation refuses a same-root duplicate before another claim take',async({page})=>{
  await renewalDuePlumbingReady(page,true)
  const result=await page.evaluate(()=>{const w=window as any,p=w.__privateControllerRenewalForTest,before=p.joined();
    const duplicate=w.__privateRootIndexDuplicate();return{duplicate,sameReceipt:before.receipt===p.joined().receipt,indexed:p.indexed()}})
  expect(result.duplicate.refused).toBe(true)
  expect(result.duplicate.before).toEqual(result.duplicate.after)
  expect(result.duplicate.after).toMatchObject({indexed:true,takes:1,claimPresent:false,controllerClaimed:true,retained:true,closed:false})
  expect(result).toMatchObject({sameReceipt:true,indexed:true})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('renewal root reservation releases a rejected take before genuine same-root construction',async({page})=>{
  await renewalDuePlumbingReady(page,true,'take-rejection-retry')
  const result=await page.evaluate(()=>{const w=window as any;return{rejected:w.__privateRootIndexRejectedTake,current:w.__privateRootIndexProbe(),joined:w.__privateJoinControllerForTest().joined}})
  expect(result.rejected).toMatchObject({refused:true,state:{indexed:false,any:false,takes:1,controllerClaimed:false,generationClaimed:false,retained:false,closed:null}})
  expect(result.current).toMatchObject({indexed:true,takes:2,claimPresent:false,controllerClaimed:true,retained:true,closed:false})
  expect(result.joined).toBe(true)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
for(const fault of ['tuple','after-retention','replacement'])test(`renewal root reservation ${fault==='replacement'?'preserves replacement sentinel':`releases its ${fault} reservation`} and drains failed construction`,async({page})=>{
  await prepareTrustedMemberUI(page,true,false,true)
  await page.evaluate((value:string)=>{(window as any).__privateRootIndexFault=value},fault)
  await page.locator('[data-private-member-action="unlock-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='verify-ready'")
  await page.locator('[data-private-member-action="verify-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='held'")
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  const result=await page.evaluate(()=>{const w=window as any,before=w.__privateRootIndexProbe();
    if(w.__privateRootIndexReplacement)w.__privateRootIndexOldStop();
    return{before,after:w.__privateRootIndexProbe(),effects:w.effects,bootstrap:w.__privateBootstrapResourceForTest()}})
  expect(result.before).toEqual(result.after)
  expect(result.after).toMatchObject({indexed:false,any:fault==='replacement',replacement:fault==='replacement',takes:1,claimPresent:false,
    controllerClaimed:fault!=='tuple',generationClaimed:false,retained:false,closed:fault==='tuple'?null:true,ownerResources:[0,0]})
  expect(result.effects).toMatchObject({socket:0,put:0,storageWrite:0,key:0})
  expect(result.bootstrap).toMatchObject({closed:true,material:false,work:0})
})

async function renewalDueNoticeReady(page:Page,keep=true,joined=true):Promise<void>{
  await prepareTrustedMemberUI(page,keep,false,true)
  await page.locator('[data-private-member-action="unlock-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='verify-ready'")
  await page.locator('[data-private-member-action="verify-private-member"]').click()
  await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='connect-ready'")
  if(joined){await page.locator('[data-private-member-action="connect-private-member"]').click();await page.waitForFunction("document.documentElement.dataset.ordinaryProtectedStartup==='member-joined'")}
}
for(const keep of [false,true])test(`renewal due notice reads genuine joined rows readonly without signing or writing, keep=${keep}`,async({page})=>{
  await renewalDueNoticeReady(page,keep)
  const result=await page.evaluate(async()=>{
    const w=window as any,p=w.__privateControllerRenewalForTest;
    const effects=()=>({put:w.effects.put,storage:w.effects.storageWrite,entropy:w.effects.entropy,key:w.effects.key,socket:w.effects.socket,
      calls:w.providerFixture.calls,signs:w.providerFixture.signs,crypts:w.providerFixture.crypts??0})
    const before=effects();w.__dueTransactionModes=[];w.__dueObserveTransactions=true
    try{
      const notice=await p.due();w.__dueNotice=notice
      return{before,after:effects(),modes:w.__dueTransactionModes,state:p.dueState(notice.receipt),
        shape:{keys:Reflect.ownKeys(notice).map(String).sort(),frozen:Object.isFrozen(notice),nullPrototype:Object.getPrototypeOf(notice)===null,
          displayFrozen:Object.isFrozen(notice.display),displayNullPrototype:Object.getPrototypeOf(notice.display)===null,
          receiptOpaque:Object.isFrozen(notice.receipt)&&Object.getPrototypeOf(notice.receipt)===null&&Reflect.ownKeys(notice.receipt).length===0,
          dueAtMatches:Number.isSafeInteger(notice.dueAt)&&notice.dueAt===w.__privateJoinControllerForTest().dueAt,
          account:notice.display.account,roomId:notice.display.roomId,network:notice.display.network,
          relays:Array.from({length:notice.display.relays.length},(_,i)=>notice.display.relays[i])}}
    }finally{w.__dueObserveTransactions=false}
  })
  expect(result.after).toEqual(result.before)
  expect(result.modes.length).toBeGreaterThan(0)
  expect(result.modes.every((mode:string)=>mode==='readonly')).toBe(true)
  expect(result.shape).toMatchObject({keys:['display','dueAt','receipt'],frozen:true,nullPrototype:true,displayFrozen:true,displayNullPrototype:true,
    receiptOpaque:true,dueAtMatches:true,network:'direct',relays:['wss://signed.example/']})
  expect(result.shape.account).toMatch(/^[0-9a-f]{64}$/);expect(result.shape.roomId).toMatch(/^[0-9a-f]{64}$/)
  expect(result.state).toMatchObject({revision:1,work:true,pending:false,receipt:true,factoryStarted:false})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('renewal due notice refuses unjoined and unregistered roots without a native transaction',async({page})=>{
  await renewalDueNoticeReady(page,true,false)
  const result=await page.evaluate(async()=>{const w=window as any,p=w.__privateControllerRenewalForTest;w.__dueTransactionModes=[];w.__dueObserveTransactions=true;
    try{let unjoined=false,unregistered=false;try{await p.due()}catch{unjoined=true}try{await p.foreignDue(Object.freeze({}))}catch{unregistered=true}
      return{unjoined,unregistered,modes:w.__dueTransactionModes,state:p.dueState()}}finally{w.__dueObserveTransactions=false}})
  expect(result).toMatchObject({unjoined:true,unregistered:true,modes:[],state:{revision:null,work:false,receipt:false,factoryStarted:false}})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('renewal due notice replaces only its completed prior receipt and advances its revision',async({page})=>{
  await renewalDueNoticeReady(page)
  const result=await page.evaluate(async()=>{const w=window as any,p=w.__privateControllerRenewalForTest,first=await p.due(),before=p.dueState(first.receipt),second=await p.due();
    w.__dueNotice=second;return{before,old:p.dueState(first.receipt),current:p.dueState(second.receipt),distinct:first.receipt!==second.receipt}})
  expect(result.before).toMatchObject({revision:1,work:true,receipt:true})
  expect(result.old).toMatchObject({revision:2,work:true,receipt:false})
  expect(result.current).toMatchObject({revision:2,work:true,pending:false,receipt:true})
  expect(result.current.resources).toEqual(result.before.resources);expect(result.distinct).toBe(true)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('renewal due notice producer stop immediately revokes its published receipt and keeps the revision',async({page})=>{
  await renewalDueNoticeReady(page)
  const result=await page.evaluate(async()=>{const w=window as any,p=w.__privateControllerRenewalForTest,notice=await p.due(),before=p.dueState(notice.receipt);
    p.stopProducer();const stopped=p.dueState(notice.receipt);p.stopProducer();return{before,stopped,repeated:p.dueState(notice.receipt)}})
  expect(result.stopped).toMatchObject({revision:1,work:false,pending:null,receipt:false})
  expect(result.stopped.resources).toEqual(result.before.resources.map((n:number)=>n-1))
  expect(result.repeated).toEqual(result.stopped)
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
})
test('renewal due notice rejects a concurrent read and retains a stopped pending read until it drains',async({page})=>{
  await renewalDueNoticeReady(page)
  await page.evaluate(()=>{const w=window as any;w.privateBootstrapGate={stage:'due-before-db'};w.__dueOutcome='pending';
    w.__duePending=w.__privateControllerRenewalForTest.due().then(()=>{w.__dueOutcome='fulfilled'},()=>{w.__dueOutcome='rejected'});undefined})
  await page.waitForFunction('privateBootstrapGate.entered')
  const concurrent=await page.evaluate(async()=>{const w=window as any;let refused=false;try{await w.__privateControllerRenewalForTest.due()}catch{refused=true}
    return{refused,state:w.__privateControllerRenewalForTest.dueState(),outcome:w.__dueOutcome}})
  expect(concurrent).toMatchObject({refused:true,state:{revision:1,work:true,pending:true},outcome:'pending'})
  await page.evaluate(()=>{const w=window as any;w.__privateControllerRenewalForTest.stopProducer();window.dispatchEvent(new PageTransitionEvent('pagehide'))})
  expect(await lockAvailable(page,'migration')).toBe(false)
  await page.evaluate('privateBootstrapGate.release();undefined')
  await page.waitForFunction("window.__dueOutcome==='rejected'")
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('window.__privateControllerRenewalForTest.dueState()')).toMatchObject({revision:1,work:false,receipt:false})
})


async function dueEffects(page:Page){return page.evaluate(()=>{const w=window as any;return{put:w.effects.put,storage:w.effects.storageWrite,entropy:w.effects.entropy,key:w.effects.key,socket:w.effects.socket,calls:w.providerFixture.calls,signs:w.providerFixture.signs,crypts:w.providerFixture.crypts??0}})}
async function duePagehide(page:Page){await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)}
for(const fault of ['provider','sdk-sign','sdk-capability','sdk-account','deadline'])test(`renewal due notice refuses actual ${fault} drift without invoking a provider effect`,async({page})=>{
  await renewalDueNoticeReady(page)
  await page.evaluate(fault=>{const w=window as any,restore=w.__enterPrivateRenewalDecision();try{
    if(fault==='provider')w.nostr=w.providerFixture.current={}
    else if(fault==='sdk-sign')w.providerFixture.sdk.signEvent=async()=>{w.__dueUnexpectedSign=(w.__dueUnexpectedSign??0)+1;throw Error('Replacement signer')}
    else if(fault==='sdk-capability')w.providerFixture.sdk.capabilities={...w.providerFixture.sdk.capabilities,canSignEvents:false}
    else if(fault==='sdk-account')w.providerFixture.sdk.pubkey='f'.repeat(64)
    else{const now=Date.now;Date.now=()=>now()+1_201_000;w.__dueRestoreClock=()=>{Date.now=now}}
  }finally{restore()}},fault)
  const before=await dueEffects(page)
  const outcome=await page.evaluate(async()=>{try{await(window as any).__privateControllerRenewalForTest.due();return'unexpected'}catch(error){return(error as Error).name}})
  expect(outcome).toBe('OrdinaryStateHold');expect(await dueEffects(page)).toEqual(before);expect(await page.evaluate('window.__dueUnexpectedSign??0')).toBe(0)
  await page.evaluate('window.__dueRestoreClock?.()');await duePagehide(page)
})
for(const fault of ['browser','tab','pending','extra-owner'])test(`renewal due notice refuses actual native ${fault} row drift without writing or repairing it`,async({page})=>{
  await renewalDueNoticeReady(page)
  await page.evaluate(async fault=>{const w=window as any;
    w.__dueDiskSnapshot=async()=>{const q=indexedDB.open('kithmoot-ordinary-state-v1',1),db=await new Promise<IDBDatabase>((yes,no)=>{q.onsuccess=()=>yes(q.result);q.onerror=()=>no(q.error)});
      try{return await new Promise<string>((yes,no)=>{const tx=db.transaction('owners'),s=tx.objectStore('owners'),keys=s.getAllKeys(),rows=s.getAll();tx.oncomplete=()=>yes(JSON.stringify(keys.result.map((k,i)=>[k,rows.result[i]]),(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v));tx.onabort=()=>no(tx.error)})}finally{db.close()}}
    const q=indexedDB.open('kithmoot-ordinary-state-v1',1),db=await new Promise<IDBDatabase>((yes,no)=>{q.onsuccess=()=>yes(q.result);q.onerror=()=>no(q.error)});
    try{await new Promise<void>((yes,no)=>{const tx=db.transaction('owners','readwrite'),s=tx.objectStore('owners'),key=fault==='tab'||fault==='pending'?'tab:'+'a'.repeat(64):'browser',r=s.get(key);
      r.onsuccess=()=>{const raw=r.result,restore=w.__enterPrivateRenewalDecision(),allowed=w.allowPrivateRenewalEffects;w.allowPrivateRenewalEffects=true;try{if(fault==='extra-owner')s.put(raw,'unexpected-native-owner');else{if(fault==='pending')raw.pending=structuredClone(raw.frame);else new Uint8Array(raw.frame.ciphertext)[0]^=1;s.put(raw,key)}}finally{w.allowPrivateRenewalEffects=allowed;restore()}};tx.oncomplete=()=>yes();tx.onabort=()=>no(tx.error)})}finally{db.close()}
    w.__dueDiskBefore=await w.__dueDiskSnapshot();w.__dueTransactionModes=[];w.__dueObserveTransactions=true
  },fault)
  const before=await dueEffects(page)
  const result=await page.evaluate(async()=>{const w=window as any;let outcome='unexpected';try{await w.__privateControllerRenewalForTest.due()}catch(error){outcome=(error as Error).name}finally{w.__dueObserveTransactions=false}
    return{outcome,modes:w.__dueTransactionModes,unchanged:await w.__dueDiskSnapshot()===w.__dueDiskBefore,state:w.__privateControllerRenewalForTest.dueState()}})
  expect(result).toMatchObject({outcome:'OrdinaryStateHold',unchanged:true,state:{work:false,receipt:false}});expect(result.modes.length).toBeGreaterThan(0);expect(result.modes.every((m:string)=>m==='readonly')).toBe(true);expect(await dueEffects(page)).toEqual(before);await duePagehide(page)
})
for(const fault of ['generation','index','factory-started'])test(`renewal due notice refuses privileged synthetic ${fault} identity drift, mechanics only`,async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  const result=await page.evaluate(async fault=>{const p=(window as any).__privateControllerRenewalForTest,restore=p.drift(fault);try{try{await p.due();return'unexpected'}catch(error){return(error as Error).name}}finally{restore()}},fault)
  expect(result).toBe('OrdinaryStateHold');expect(await dueEffects(page)).toEqual(before);await duePagehide(page)
})
for(const stage of ['due-before-db','due-rows','due-browser','due-tab','due-after-transaction'])test(`renewal due notice drains actual pagehide at ${stage} before releasing native ownership`,async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  await page.evaluate(stage=>{const w=window as any;w.privateBootstrapGate={stage};w.__dueOutcome='pending';w.__duePending=w.__privateControllerRenewalForTest.due().then(()=>{w.__dueOutcome='fulfilled'},(error:any)=>{w.__dueOutcome=error.name});undefined},stage)
  await page.waitForFunction('privateBootstrapGate.entered');await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false);expect(await page.evaluate('window.__dueOutcome')).toBe('pending')
  await page.evaluate('privateBootstrapGate.release();undefined');await page.waitForFunction("window.__dueOutcome==='OrdinaryStateHold'")
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true);expect(await page.evaluate('window.__privateControllerRenewalForTest.dueState()')).toMatchObject({work:false,receipt:false});expect(await dueEffects(page)).toEqual(before)
})
for(const cut of [{at:1,before:true},{at:3,before:false}])test(`renewal due notice retains its real client probe through pagehide, at=${cut.at}, before=${cut.before}`,async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  await page.evaluate(cut=>{const w=window as any;w.privateRenewalClientCut={...cut,calls:0};w.__dueOutcome='pending';w.__duePending=w.__privateControllerRenewalForTest.due().then(()=>{w.__dueOutcome='fulfilled'},(error:any)=>{w.__dueOutcome='rejected';w.__dueError={name:error.name,message:error.message}});undefined},cut)
  await page.waitForFunction('privateRenewalClientCut.entered');await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false);expect(await page.evaluate('window.__dueOutcome')).toBe('pending')
  await page.evaluate('privateRenewalClientCut.release();undefined');await page.waitForFunction("window.__dueOutcome!=='pending'");expect(await page.evaluate('window.__dueOutcome')).toBe('rejected');expect(await page.evaluate('window.__dueError')).toMatchObject(cut.before?{name:'OrdinaryStateHold'}:{name:'Error',message:'Protected startup held'});await expect.poll(()=>lockAvailable(page,'migration')).toBe(true);expect(await dueEffects(page)).toEqual(before)
})
test('renewal due notice ignores inherited work and receipt accessors during read and producer stop',async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  const result=await page.evaluate(async()=>{const w=window as any,p=w.__privateControllerRenewalForTest,get=Object.getOwnPropertyDescriptor,define=Object.defineProperty,saved=['work','receipt'].map(k=>get(Object.prototype,k));let calls=0;
    try{for(const k of ['work','receipt'])define(Object.prototype,k,{configurable:true,get(){calls++;throw Error('Inherited '+k)},set(){calls++;throw Error('Inherited '+k)}});
      const notice=await p.due();p.stopProducer();return{calls,state:p.dueState(notice.receipt)}}finally{for(let i=0;i<saved.length;i++){const d=saved[i],k=i===0?'work':'receipt';if(d)define(Object.prototype,k,d);else delete(Object.prototype as any)[k]}}})
  expect(result).toMatchObject({calls:0,state:{work:false,receipt:false}});expect(await dueEffects(page)).toEqual(before);await duePagehide(page)
})
test('renewal due notice refuses ambient validator and serializer replacement before any native read',async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  const result=await page.evaluate(async()=>{const w=window as any,p=w.__privateControllerRenewalForTest,get=Object.getOwnPropertyDescriptor,define=Object.defineProperty;let calls=0,refused=0;w.__dueTransactionModes=[];w.__dueObserveTransactions=true;
    const fields:[object,PropertyKey][]=[[JSON,'stringify'],[Map.prototype,'values'],[Array.prototype,'filter'],[Object.prototype,'toJSON'],[Array.prototype,'toJSON']];
    try{for(let i=0;i<fields.length;i++){const[o,k]=fields[i],saved=get(o,k);try{define(o,k,{configurable:true,get(){calls++;throw Error('Replaced ambient helper')}});try{await p.due()}catch(error){if((error as Error).name==='OrdinaryStateHold')refused++;else throw error}}finally{if(saved)define(o,k,saved);else delete(o as any)[k]}}return{calls,refused,modes:w.__dueTransactionModes}}finally{w.__dueObserveTransactions=false}})
  expect(result).toEqual({calls:0,refused:5,modes:[]});expect(await dueEffects(page)).toEqual(before);await duePagehide(page)
})


for(const faults of [['receipt'],['slot'],['browser'],['tab'],['browser','tab']])test(`renewal due cleanup preserves independent edges and first owner error after published post-effect faults=${faults.join('+')}`,async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  const result=await page.evaluate(async faults=>{const w=window as any,p=w.__privateControllerRenewalForTest,notice=await p.due(),initial=p.dueState(notice.receipt);w.__dueCleanupFault={armed:true,faults,visited:[]};
    p.stopProducer();const state=p.dueState(notice.receipt),visited=[...w.__dueCleanupFault.visited],errors=p.dueCleanupErrors();p.stopProducer();return{initial,state,visited,errors,repeated:w.__dueCleanupFault.visited}},faults)
  expect(result.visited).toEqual(['abort','receipt','slot','browser','tab']);expect(result.repeated).toEqual(result.visited);expect(result.state).toMatchObject({revision:1,work:false,receipt:false});expect(result.state.resources).toEqual(result.initial.resources.map((n:number)=>n-1));expect(result.errors).toEqual([`Explicit due cleanup fault:${faults[0]}`,`Explicit due cleanup fault:${faults[0]}`])
  await duePagehide(page);await page.waitForFunction('window.__rootCloseDoneForTest');expect(await page.evaluate('window.__rootCloseFailure')).toContain(`Explicit due cleanup fault:${faults[0]}`);expect(await dueEffects(page)).toEqual(before)
})
for(const faults of [['abort'],['abort','receipt']])test(`renewal due cleanup drains a real aborted readonly transaction after post-effect faults=${faults.join('+')}`,async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  await page.evaluate(()=>{const w=window as any;w.privateBootstrapGate={stage:'due-browser'};w.__dueOutcome='pending';w.__duePending=w.__privateControllerRenewalForTest.due().then(()=>{w.__dueOutcome='fulfilled'},(error:any)=>{w.__dueOutcome=error.name});undefined})
  await page.waitForFunction('privateBootstrapGate.entered')
  const result=await page.evaluate(faults=>{const w=window as any,p=w.__privateControllerRenewalForTest;w.__dueCleanupFault={armed:true,faults,visited:[]};p.stopProducer();return{state:p.dueState(),visited:w.__dueCleanupFault.visited,errors:p.dueCleanupErrors()}},faults)
  expect(result.visited).toEqual(['abort','receipt','slot','browser','tab']);expect(result.state).toMatchObject({work:false,receipt:false});expect(result.errors).toEqual(['Explicit due cleanup fault:abort','Explicit due cleanup fault:abort'])
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));expect(await lockAvailable(page,'migration')).toBe(false);expect(await page.evaluate('window.__dueOutcome')).toBe('pending')
  await page.evaluate('privateBootstrapGate.release();undefined');await page.waitForFunction("window.__dueOutcome==='OrdinaryStateHold'");await expect.poll(()=>lockAvailable(page,'migration')).toBe(true);await page.waitForFunction('window.__rootCloseDoneForTest');expect(await page.evaluate('window.__rootCloseFailure')).toContain('Explicit due cleanup fault:abort');expect(await dueEffects(page)).toEqual(before)
})


test('renewal due publication tail keeps notice data opaque to late inherited then getters, tail-only mechanics',async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  const result=await page.evaluate(async()=>{const w=window as any,p=w.__privateControllerRenewalForTest,get=Object.getOwnPropertyDescriptor,define=Object.defineProperty,prototypes=[Object.prototype,Array.prototype],saved=prototypes.map(o=>get(o,'then'));let calls=0,armed=false;
    w.__dueLateThen=()=>{armed=true;for(let i=0;i<prototypes.length;i++)define(prototypes[i],'then',{configurable:true,get(){calls++;throw Error('Late inherited then getter')}})}
    try{const notice=await p.due();return{armed,calls,noticeNull:Object.getPrototypeOf(notice)===null,displayNull:Object.getPrototypeOf(notice.display)===null,receiptNull:Object.getPrototypeOf(notice.receipt)===null,relaysNull:Object.getPrototypeOf(notice.display.relays)===null,receipt:p.dueState(notice.receipt).receipt}}
    finally{delete w.__dueLateThen;for(let i=0;i<prototypes.length;i++){const d=saved[i];if(d)define(prototypes[i],'then',d);else delete(prototypes[i]as any).then}}
  })
  expect(result).toEqual({armed:true,calls:0,noticeNull:true,displayNull:true,receiptNull:true,relaysNull:true,receipt:true});expect(await dueEffects(page)).toEqual(before);await duePagehide(page)
})


test('renewal due native abort refusal before effect drains the actual readonly transaction and retains ownership until outer release',async({page})=>{
  await renewalDueNoticeReady(page);const before=await dueEffects(page)
  await page.evaluate(()=>{const w=window as any;w.privateBootstrapGate={stage:'due-browser'};w.__dueOutcome='pending';w.__duePending=w.__privateControllerRenewalForTest.due().then(()=>{w.__dueOutcome='fulfilled'},(error:any)=>{w.__dueOutcome=error.name});undefined})
  await page.waitForFunction('privateBootstrapGate.entered')
  const stopped=await page.evaluate(()=>{
    const w=window as any,p=w.__privateControllerRenewalForTest,probe=w.__dueNativeAbortProbe,
      descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'abort')!,actual=descriptor.value
    const initial={complete:probe.complete,aborted:probe.aborted,mode:probe.tx.mode},initialResources=p.dueState().resources
    try{
      Object.defineProperty(IDBTransaction.prototype,'abort',{...descriptor,value:function(this:IDBTransaction,...args:unknown[]){
        if(this===probe.tx){probe.calls++;throw Error('Explicit native readonly abort refusal before effect')}
        return Reflect.apply(actual,this,args)
      }})
      p.stopProducer()
      return{initial,initialResources,calls:probe.calls,state:p.dueState()}
    }finally{Object.defineProperty(IDBTransaction.prototype,'abort',descriptor)}
  })
  expect(stopped.initial).toEqual({complete:false,aborted:false,mode:'readonly'});expect(stopped.calls).toBe(1)
  expect(stopped.state).toMatchObject({work:false,receipt:false});expect(stopped.initialResources.every((n:number)=>Number.isSafeInteger(n)&&n>=1)).toBe(true);expect(stopped.state.resources).toEqual(stopped.initialResources.map((n:number)=>n-1))
  await page.waitForFunction('window.__dueNativeAbortProbe.complete')
  expect(await page.evaluate('({complete:__dueNativeAbortProbe.complete,aborted:__dueNativeAbortProbe.aborted,calls:__dueNativeAbortProbe.calls,outcome:__dueOutcome})')).toEqual({complete:true,aborted:false,calls:1,outcome:'pending'})
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
  expect(await lockAvailable(page,'migration')).toBe(false);expect(await page.evaluate('window.__dueOutcome')).toBe('pending')
  await page.evaluate('privateBootstrapGate.release();undefined');await page.waitForFunction("window.__dueOutcome!=='pending'")
  expect(await page.evaluate('window.__dueOutcome')).toBe('OrdinaryStateHold');await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('window.__privateControllerRenewalForTest.dueState()')).toMatchObject({work:false,receipt:false,resources:[0,0]})
  expect(await dueEffects(page)).toEqual(before)
})
