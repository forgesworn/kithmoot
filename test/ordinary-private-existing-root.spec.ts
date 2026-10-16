import { build, type Plugin } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { test } from './ordinary-native-browser.fixture.js'
import { finalizeEvent } from 'nostr-tools/pure'
import { setup } from './ordinary-bootstrap.setup.js'
import { controls } from './ordinary-member-session.setup.js'

let server: Server, origin = '', fixture = '', worker = '', pureFence = ''
const modules = new Map<string, string>()
const ROOT_ENTRY = '/j/build/ordinary-private-existing-root.browser-entry.js'
const probes = `window.effects={provider:0,socket:0,storageWrite:0,put:0,entropy:0,key:0};window.probeNonces=0;window.curveInitializationProbes=0;window.curveProbeActive=false;window.privateEntropyCalls=[];
const nativeProbeRandom=crypto.getRandomValues.bind(crypto);window.__probeRandom=value=>{probeNonces++;return nativeProbeRandom(value)};
window.__curveProbeRandom=(random,length)=>{curveInitializationProbes++;curveProbeActive=true;try{return random(length)}finally{curveProbeActive=false}};
Object.defineProperty(window,'nostr',{configurable:true,get(){effects.provider++;if(window.providerFixture)return window.providerFixture.current;throw Error('provider forbidden')}});
window.WebSocket=class{constructor(){effects.socket++;throw Error('socket forbidden')}};
for(const name of ['setItem','removeItem','clear'])Storage.prototype[name]=()=>{effects.storageWrite++;throw Error('Storage write forbidden')};
window.__privateBootstrapPause=async stage=>{const cut=window.privateBootstrapGate;if(!cut||cut.stage!==stage||cut.used)return;cut.used=true;cut.entered=true;await new Promise((yes,no)=>{cut.release=()=>cut.reject?no(Error('Explicit bootstrap fixture failure')):yes()})};\nwindow.privateRenewalEntropy=[];window.privateRenewalWrites=[];window.privateRenewalPackets=[];window.privateRenewalEncryptedRows={};window.privateRenewalEncryptedCohorts={};
window.__enterPrivateRenewalDecision=()=>{const before=[window.__privateRenewalDecision,window.__controlDecision,window.__foregroundDecision];window.__privateRenewalDecision=true;window.__controlDecision=true;window.__foregroundDecision=true;return()=>{[window.__privateRenewalDecision,window.__controlDecision,window.__foregroundDecision]=before}};
for(const name of ['put','add','delete','clear']){const actual=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){effects.put++;if(window.allowPrivateRenewalEffects&&window.__privateRenewalDecision){privateRenewalWrites.push([name,args[1]??null]);privateRenewalPackets.push({phase:window.__privateRenewalWritePhase,key:args[1],packet:JSON.stringify(args[0],(_k,v)=>v instanceof ArrayBuffer?Array.from(new Uint8Array(v)):v)});const result=Reflect.apply(actual,this,args);if(name==='put'&&window.__privateRenewalWritePhase){privateRenewalEncryptedRows[args[1]]=structuredClone(args[0]);if(String(args[1]).startsWith('journal:'))privateRenewalEncryptedCohorts[window.__privateRenewalWritePhase]=structuredClone(privateRenewalEncryptedRows)}const fault=window.privateRenewalAckFault;if(fault&&!fault.used&&fault.phase===window.__privateRenewalWritePhase){fault.used=true;const tx=this.transaction;if(fault.prior){fault.entered=true;tx.abort();if(fault.close)window.dispatchEvent(new PageTransitionEvent('pagehide'))}else{const complete=tx.oncomplete,abort=tx.onabort;tx.oncomplete=event=>{fault.entered=true;fault.release=()=>{fault.delivered=true;if(fault.reject)abort.call(tx,new Event('abort'));else complete.call(tx,event)}}}}return result}throw Error('native write forbidden')}};
crypto.getRandomValues=value=>{if(curveProbeActive)return nativeProbeRandom(value);effects.entropy++;if(window.allowPrivateRenewalEffects&&window.__privateRenewalDecision){privateRenewalEntropy.push(value.byteLength);if(value.byteLength===12&&window.privateRenewalNonceCollision){const prior=window.privateRenewalNonceCollision==='existing'?window.__privateRenewalPriorNonces[0]:window.__privateRenewalFirstNonce;if(prior){value.set(Uint8Array.from(prior.match(/../g).map(v=>parseInt(v,16))));return value}}const result=nativeProbeRandom(value);if(value.byteLength===12&&!window.__privateRenewalFirstNonce)window.__privateRenewalFirstNonce=Array.from(value,v=>v.toString(16).padStart(2,'0')).join('');return result}const error=Error('entropy forbidden');privateEntropyCalls.push(error.stack);throw error};
crypto.subtle.generateKey=()=>{effects.key++;throw Error('key allocation forbidden')};`
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
        const source = await readFile(input.path, 'utf8'), marker = '}, async () => {\n      this.#stop()'
        if (source.split(marker).length !== 2) throw Error('Private root observation fixture drift')
        return { loader: 'ts', contents: source.replace(marker,
          '}, async (error) => { (globalThis as any).__rootFailure=error?.stack; this.#stop()').replace(
            '}, async () => { this.#stop(); await this.close() })',
            '}, async (error) => { (globalThis as any).__providerFailure=error?.stack; this.#stop(); await this.close() })').replace(
            'this.#provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot)',
            `const provider = this.#beginProvider!(this as unknown as OrdinaryPrivateExistingRoot)
             if ((globalThis as any).providerFixture?.cutAssignment === 'before') window.dispatchEvent(new PageTransitionEvent('pagehide'))
             this.#provider = provider
             if ((globalThis as any).providerFixture?.cutAssignment === 'after') window.dispatchEvent(new PageTransitionEvent('pagehide'))`).replace(
            '#pagehide = () => { void this.close().catch(() => {}) }',
            '#pagehide = () => { void this.close().catch(error => { (globalThis as any).__rootCloseFailure=error?.message }) }').replace(
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
             ;(globalThis as any).__invokePrivateForegroundForTest = () => (globalThis as any).__privateForegroundForTest(this)`) }
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
      builder.onLoad({filter:/ordinary-renewal-obligation\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8'),at=source.indexOf('export function registerOrdinaryRenewalFactory(')
        const body=source.indexOf('  if(!factory',at)
        if(at<0||body<0)throw Error('Legacy factory observer drift')
        source=source.slice(0,body)+`  if((globalThis as any).privateBootstrapTesting)(globalThis as any).privateBootstrapLegacyFactoryCalls++\n`+source.slice(body)
        return {loader:'ts',contents:source}
      })
      builder.onLoad({filter:/ordinary-persistent-bootstrap\.ts$/},async input=>{
        let source=await readFile(input.path,'utf8')
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
        const closed='    this.#openedImage = undefined; this.#options.invitation.bearer.fill(0)\n  }'
        if(source.split(closed).length!==2)throw Error('Private bootstrap close observer drift')
        source=source.replace(closed,`    this.#openedImage = undefined; this.#options.invitation.bearer.fill(0)\n    if(this.#private)await (globalThis as any).__privateBootstrapPause('close')\n  }`)
        return {loader:'ts',contents:`;(globalThis as any).__privateBootstrapModuleEvaluated=((globalThis as any).__privateBootstrapModuleEvaluated??0)+1\n`+source+`
          ;(globalThis as any).__privateBootstrapClassForTest=OrdinaryPersistentBootstrap
          if((globalThis as any).privateBootstrapReplacePublic){
            const fail=()=>{(globalThis as any).privateBootstrapPublicDispatches++;throw Error('Private bootstrap public dispatch')}
            for(const name of ['open','recoverPreparedAtStartup'])Object.defineProperty(OrdinaryPersistentBootstrap,name,{configurable:true,value:fail})
            for(const name of ['load','revoke','close','bootstrap','openMemberSession'])Object.defineProperty(OrdinaryPersistentBootstrap.prototype,name,{configurable:true,value:fail})
          }
          ;(globalThis as any).__privateBootstrapFunctionsForTest=Object.freeze({open:openOrdinaryPrivateBootstrapFromOwnerClaim,completed:ordinaryPrivateBootstrapCompleted,stop:stopOrdinaryPrivateBootstrap,close:closeOrdinaryPrivateBootstrap})
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
        for(const args of ['facts,selected','inverse,facts,selected']){
          const begin='await context.step(()=>{check();const value=work(j!,[br,tr],[b!,t!],'+args+')'
          const at=source.indexOf(begin)
          if(at<0)throw Error('Cold recovery native decision fixture drift')
          const end=source.indexOf('result=value})',at)
          if(end<0)throw Error('Cold recovery native postcheck fixture drift')
          source=source.slice(0,at)+source.slice(at,end).replace(begin,'await context.step(()=>{const restore=(globalThis as any).__enterPrivateRenewalDecision();try{if(mode===\'readwrite\'&&\''+args+'\'===\'facts,selected\')(globalThis as any).__privateRenewalWritePhase=\'settled\';check();const value=work(j!,[br,tr],[b!,t!],'+args+')')+'result=value}finally{restore()}})'+source.slice(end+'result=value})'.length)
        }
        source=source.replace("if(stage==='prepare'){check();attempted=true;","if(stage==='prepare'){(globalThis as any).__privateRenewalWritePhase='candidate-prepared';check();attempted=true;").replace("else{const br={key:rows[0].key,frame:validateOrdinaryFrame(frames[0])},tr={key:rows[1].key,frame:validateOrdinaryFrame(frames[1])}","else{(globalThis as any).__privateRenewalWritePhase='candidate-committed';const br={key:rows[0].key,frame:validateOrdinaryFrame(frames[0])},tr={key:rows[1].key,frame:validateOrdinaryFrame(frames[1])}")
        if(source.split('for (const operation of [...privateRenewalOwnerResources.get(this) ?? []]) OrdinaryStateOwner.#disposePrivateRenewal(operation)\n    this.#db?.close(); this.#db = undefined').length!==2)throw Error('Native owner close observer drift')
        for(const [marker,stage] of [["const module = await import('./ordinary-persistent-bootstrap.js'); check()",'after-import'],['await clients()\n        await read(live, () => {','before-claim']] as const){
          if(source.split(marker).length!==2)throw Error('Private bootstrap owner pause drift '+stage)
          source=source.replace(marker,marker+`\n${stage==='before-claim'?'':`await (globalThis as any).__privateBootstrapPause('${stage}');check()`}`)
        }
        const before="check()\n        const module = await import('./ordinary-persistent-bootstrap.js')"
        if(source.split(before).length!==2)throw Error('Private bootstrap preimport observer drift')
        source=source.replace(before,"check();await (globalThis as any).__privateBootstrapPause('before-import');check()\n        const module = await import('./ordinary-persistent-bootstrap.js')")
        const bootstrapLatch='member.bootstrap.claimed = true'
        if(source.split(bootstrapLatch).length!==2)throw Error('Private bootstrap latch observer drift')
        source=source.replace(bootstrapLatch,bootstrapLatch+`; (globalThis as any).__privateBootstrapLatchForTest=()=>Object.freeze({bootstrap:member.bootstrap.claimed,renewal:member.renewal.claimed})`)
        const beforeClaim='await clients()\n        await read(live, () => {'
        source=source.replace(beforeClaim,"await clients();await (globalThis as any).__privateBootstrapPause('before-claim');check()\n        await read(live, () => {")
        const resource='const resource = module.openOrdinaryPrivateBootstrapFromOwnerClaim(claim)'
        if(source.split(resource).length!==2)throw Error('Private bootstrap assignment observer drift')
        source=source.replace(resource,resource+`; if((globalThis as any).privateBootstrapCut==='after-resource')window.dispatchEvent(new PageTransitionEvent('pagehide'))`)
        const decision='work: (b, t, _bn, _tn, c) => { validate(b, t, c); const answer = work(b, t, c); validate(b, t, c); return answer }'
        if(source.split(decision).length!==2)throw Error('Private bootstrap read observer drift')
        source=source.replace(decision,`work: (b,t,_bn,_tn,c)=>{validate(b,t,c);const f=(globalThis as any),n=(f.privateBootstrapReadCount=(f.privateBootstrapReadCount??0)+1);const answer=work(b,t,c);if(f.privateBootstrapReadCut===n)window.dispatchEvent(new PageTransitionEvent('pagehide'));validate(b,t,c);return answer}`)
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
              if (fixture.closeMode === 'reject') throw Error('Explicit SDK close fixture rejection')
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
               if(raw[2]===undefined){context.stop();await context.ended;return {phase:'absent',result:false,secretCount:0,sequence:0,initialEpochUnchanged:true,changedRows:[rowDigest(br)!==value.member.epoch.current.rows[0],rowDigest(tr)!==value.member.epoch.current.rows[1]]}}
               b=await openOrdinaryFrame(br.frame!,br.key);t=await openOrdinaryFrame(tr.frame!,tr.key)
               j=await openOrdinaryOperationControl(raw[2],{browser:{binding:{purpose:b.purpose,keyId:b.keyId,generation:b.generation,expiresAt:b.expiresAt},key:br.key},tab:{binding:{purpose:t.purpose,keyId:t.keyId,generation:t.generation,expiresAt:t.expiresAt},key:tr.key}})
               context.stop();await context.ended
               return {phase:j.phase,result:!!j.result,secretCount:j.secrets.length,sequence:j.sequence,initialEpochUnchanged:value.member.epoch.current.rows.every((r,i)=>r===value.member.capture.rows[i]),changedRows:[rowDigest(br)!==value.member.epoch.current.rows[0],rowDigest(tr)!==value.member.epoch.current.rows[1]]}
             } finally {context.stop();db.close();clearImage(b);clearImage(t);wipeOrdinaryOperationJournal(j)}
           }
           const resource = {stop: () => { op.revoked = true; if (!op.custodyOnly) { op.context?.abort(); op.revokeWait?.() } }}`).replace(
          'privateRenewalFactories.set(factory, {native, foreground, member, scopes, foregroundExpiresAt, closed: false})',
          `privateRenewalFactories.set(factory, {native, foreground, member,
            scopes: (globalThis as any).providerFixture?.renewalScopeFamily === 'signet' ? member.foregroundScopes()! : scopes,
            foregroundExpiresAt, closed: false})`).replace(
          'createdWitness = witness',
          'createdWitness = witness; (globalThis as any).__seenPrivateRenewalWitness = witness').replace(
          'createdFactory = factory; createdClaim = claim',
          'createdFactory = factory; createdClaim = claim; (globalThis as any).__seenPrivateRenewalClaim = claim').replace(
          'beginPrivateExistingProvider = root => this.#beginPrivateExistingProvider(root)',
          `beginPrivateExistingProvider = root => this.#beginPrivateExistingProvider(root)
           ;(globalThis as any).__privateOwnerPrototypeForTest = this.prototype
           ;(globalThis as any).__privateColdResourceForTest = (owner:OrdinaryStateOwner) => ({closed:owner.#closed,work:owner.#work.size,waiting:!!owner.#retry})
           ;(globalThis as any).__takePrivateRenewalIntentForTest = takeOrdinaryPrivateRenewalIntent
           ;(globalThis as any).__takePrivateRenewalClaimForTest = takeOrdinaryPrivateRenewalFactoryClaim
           ;(globalThis as any).__privateRenewForTest = renewOrdinaryPrivateMember
           ;(globalThis as any).__privateControlForTest = (root: OrdinaryPrivateExistingRoot) => this.#authenticatePrivateExistingProvider(root)
           ;(globalThis as any).__privateForegroundForTest = (root: OrdinaryPrivateExistingRoot) => this.#beginPrivateExistingForeground(root)`).replace(
          'challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))',
          'challenge = bytesToHex((globalThis as any).__controlRandom(new Uint8Array(32)))').replace(
          'await context.step(() => {\n              check(); if (controlMode',
          'await context.step(() => { const previous = (globalThis as any).__controlDecision; if (controlMode) (globalThis as any).__controlDecision = true; try {\n              check(); if (controlMode').replace(
          'start?.(); check(); if (controlMode && (!sdkCurrent || !sdkCurrent())) hold()\n            })',
          'start?.(); check(); if (controlMode && (!sdkCurrent || !sdkCurrent())) hold()\n            } finally { (globalThis as any).__controlDecision = previous } })').replace(
          'for (const operation of [...privateRenewalOwnerResources.get(this) ?? []]) OrdinaryStateOwner.#disposePrivateRenewal(operation)\n    this.#db?.close(); this.#db = undefined',
          `for (const operation of [...privateRenewalOwnerResources.get(this) ?? []]) OrdinaryStateOwner.#disposePrivateRenewal(operation)
           this.#db?.close(); this.#db = undefined
           const fixture = (globalThis as any).__privateOwnerCloseFixture
           if (fixture) {
             const name = this.purpose === 'browser' ? 'browser' : 'tab'
             fixture.entered.push(name)
             if (fixture.pending === name) await new Promise<void>(yes => { fixture.release = yes })
             fixture.terminal.push(name)
             if (fixture.reject === name) throw Error('Explicit ' + name + ' native owner close failure')
           }`).replace('return work(browser, tab, custody)',
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
      builder.onLoad({ filter: /@noble[/\\]curves[/\\]abstract[/\\]curve\.js$/ }, async input => {
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
test.afterAll(() => new Promise<void>((yes, no) => server?.close(error => error ? no(error) : yes())))
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => console.error('Private root fixture page error:', error.message))
  page.on('console', message => { if (message.type() === 'error') console.error('Private root fixture console:', message.text()) })
})

async function seed(page: Page, keep = true, visitor = false): Promise<string> {
  await page.goto(origin + '/j/setup')
  await page.evaluate(`(${setup})(${JSON.stringify({ keep, visitor, noRelays: true })})`)
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
      getPublicKey: async () => {
        fixture.calls++; fixture.started = true
        if (fixture.gated) await new Promise<void>(yes => { fixture.release = yes })
        return fixture.account
      },
      signEvent: (event: any) => {
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
        fixture.signingStarted = true; fixture.statement = structuredClone(event)
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
  duplicated?: { family: 'sign' | 'crypto'; timing: 'sequential' | 'microtask' }, seedFixture?:()=>Promise<void>): Promise<void> {
  const href = await seed(page, keep)
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
    initialEpochUnchanged: true, changedRows: [true, true]})
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
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'provider-started', result: false, initialEpochUnchanged: true})
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
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'provider-started', result: false, initialEpochUnchanged: true})
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
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: 'provider-returned', result: true, initialEpochUnchanged: true})
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
    expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase: closing ? phase : 'settled', initialEpochUnchanged: true})
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
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'provider-returned',result:true,initialEpochUnchanged:true})
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
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'provider-returned',result:true,initialEpochUnchanged:true})
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
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:closing?phase:'settled',initialEpochUnchanged:true})
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
  expect(await page.evaluate('__privateRenewalDiskForTest()')).toMatchObject({phase:'candidate-prepared',initialEpochUnchanged:true})
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  expect(await page.evaluate('privateBootstrapLegacyFactoryCalls')).toBe(0)
})
for(const stage of ['before-import','after-import','before-claim','before-load','after-load','close'])for(const reject of [false,true])test(`private bootstrap joins revoked ${stage} tail, reject=${reject}`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  await page.evaluate(stage=>{(window as any).privateBootstrapCut=stage},stage)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('privateBootstrapOutcome')).toBe('OrdinaryStateHold')
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
  if(stage==='after-load')expect(await page.evaluate('__privateBootstrapWipedForTest()')).toBe(true)
})
for(const read of [1,2,3,4])test(`private bootstrap refuses revoked native decision ${read}`,async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  await page.evaluate(fault=>{(window as any).privateBootstrapMaterialFault=fault},fault)
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('[privateBootstrapOutcome,privateBootstrapMaterialFaultUsed,__privateBootstrapWipedForTest()]')).toEqual(['OrdinaryStateHold',true,true])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})
for(const fault of ['provider','sdk','native','controller','expiry','credential-floor'] as const)test(`private bootstrap refuses ${fault} change after material assignment`,async({page})=>{
  if(fault==='expiry'||fault==='credential-floor')await page.clock.install()
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
  await page.evaluate(()=>{(window as any).privateBootstrapMaterialFault='seal-history'})
  await beginPrivateBootstrapLoad(page);await page.waitForFunction('privateBootstrapDone')
  expect(await page.evaluate('[privateBootstrapOutcome,privateBootstrapMaterialFaultUsed,__privateBootstrapWipedForTest()]')).toEqual(['OrdinaryStateHold',true,true])
  await expect.poll(()=>lockAvailable(page,'migration')).toBe(true)
  expect(await page.evaluate('({...effects,signs:providerFixture.signs})')).toEqual(before)
})
test('private bootstrap failed first start keeps its latch spent and excludes renewal',async({page})=>{
  await prepareControlStage(page,false,true);await startPrivateForeground(page)
  const before=await page.evaluate('({...effects,signs:providerFixture.signs})')
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
