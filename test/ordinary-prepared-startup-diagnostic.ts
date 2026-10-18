// Copied-test observations only. Nothing here is imported by production entry points.
export function instrumentPreparedStartup(original:string):string {
  let source=original
  const once=(marker:string,replacement:string)=>{
    if(source.split(marker).length!==2)throw Error('Exact prepared-startup diagnostic marker drift')
    source=source.replace(marker,replacement)
  }
  const stage=(label:string)=>`;(globalThis as any).__pstartStage?.('${label}')`
  once('        const renew = async (root: ProtocolExecution): Promise<void> => {',
       '        const renew = async (root: ProtocolExecution): Promise<void> => {'+stage('renewal-entered'))
  once('          const oldImage = await this.#read((b,t,c) => protocol!.enterLifecycle(root,b,t,c,() => this.#image(b,t,c,true)))',
       '          const oldImage = await this.#read((b,t,c) => protocol!.enterLifecycle(root,b,t,c,() => this.#image(b,t,c,true)))'+stage('old-image-read'))
  once('            await protocol!.work.suspend(root)','            await protocol!.work.suspend(root)'+stage('suspend-completed'))
  once('              const prepared=this.#renewalSource(b,t,c,nativeView!.snapshot())',
       '              const prepared=this.#renewalSource(b,t,c,nativeView!.snapshot())'+stage('source-prepared'))
  once('try { obligation=this.#prepareRenewalObligation(root,b,t,c,{issuedAt:prepared.issuedAt,expiresAt:prepared.expiresAt,semanticDigest:prepared.semanticDigest});return prepared }',
       'try { obligation=this.#prepareRenewalObligation(root,b,t,c,{issuedAt:prepared.issuedAt,expiresAt:prepared.expiresAt,semanticDigest:prepared.semanticDigest});'+stage('obligation-prepared')+';return prepared }')
  once('            const selected = source\n',stage('source-read-completed')+'\n            const selected = source\n')
  once('            const enrolled=await OrdinaryStateOwner.enrollMemberRenewal(obligation!)',
       '            const enrolled=await OrdinaryStateOwner.enrollMemberRenewal(obligation!)'+stage('enrollment-returned')+";(globalThis as any).__pstartEnrollment?.(enrolled.status)")
  once('            const returned=await OrdinaryStateOwner.signMemberRenewal(enrolled.enrollment)',
       '            const returned=await OrdinaryStateOwner.signMemberRenewal(enrolled.enrollment)'+stage('signer-returned'))
  once('            const candidate=await OrdinaryStateOwner.commitMemberRenewalCandidate(returned)',
       '            const candidate=await OrdinaryStateOwner.commitMemberRenewalCandidate(returned)'+stage('candidate-committed'))
  once('            settled=await OrdinaryStateOwner.settleMemberRenewalCandidate(candidate)',
       '            settled=await OrdinaryStateOwner.settleMemberRenewalCandidate(candidate)'+stage('settled'))
  once('                carrierPlan=OrdinaryRelayCarrier.prepareSuccessor(carrier!,root,successor!)',
       '                carrierPlan=OrdinaryRelayCarrier.prepareSuccessor(carrier!,root,successor!)'+stage('session-and-carrier-plans-prepared'))
  // Observe only after the assignment callback and its enclosing read return.
  once('            await this.#read((b,t,c)=>protocol!.enterLifecycle(root,b,t,c,()=>{\n              protocol!.work.checkTransition(root)\n              OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settled!,c)',
       stage('assignment-adopted')+'\n            await this.#read((b,t,c)=>protocol!.enterLifecycle(root,b,t,c,()=>{\n              protocol!.work.checkTransition(root)\n              OrdinaryStateOwner.validateSettledMemberRenewalReceipt(settled!,c)')
  once('            if (!memberLive()) hold()\n            protocol!.work.resume(root)',
       stage('post-adoption-native-check-completed')+'\n            if (!memberLive()) hold()\n            protocol!.work.resume(root)'+stage('root-resumed'))
  once('                const started = await scope.run(\'credential-restatement-start\', () => {',
       stage('restatement-started')+'\n                const started = await scope.run(\'credential-restatement-start\', () => {')
  once('                await started.pending\n              } else schedule(5000)',
       '                await started.pending'+stage('restatement-completed')+'\n              } else schedule(5000)')
  once('          }catch(error){\n            if(!commitStarted&&!closed){',
       '          }catch(error){'+stage('renewal-catch')+";(globalThis as any).__pstartError?.('renewal',error)\n            if(!commitStarted&&!closed){")
  once('          }finally{\n            releaseOrdinaryRenewalObligation(obligation)',
       '          }finally{'+stage('renewal-finally')+'\n            releaseOrdinaryRenewalObligation(obligation)')
  once('  async #load(operation = this.#ownedOperation): Promise<OrdinaryPersistentBootstrapResult | undefined> {',
       '  async #load(operation = this.#ownedOperation): Promise<OrdinaryPersistentBootstrapResult | undefined> {'+";(globalThis as any).__pstartLoadEntry?.()")
  once('      return answer\n    } catch (error) { wipeOrdinaryPersistentBootstrapResult(result); throw error }',
       "      ;(globalThis as any).__pstartLoadResult?.(answer)\n      return answer\n    } catch (error) { (globalThis as any).__pstartError?.('load',error); wipeOrdinaryPersistentBootstrapResult(result); throw error }")
  return source
}

export function instrumentPreparedStartupOwner(source:string):string {
  const marker='  get holdingRetention(): boolean { return this.#retry !== undefined }'
  if(source.split(marker).length!==2)throw Error('Exact prepared-startup owner diagnostic marker drift')
  return source.replace(marker,marker+'\n  get __pstartResourceCount(): number { return this.#resources.size }')
}

// Installed immediately before the first prior-lease clock advance. Hooks are
// synchronous, bounded and contain no raw error, identifier, row or key data.
export function installPreparedStartupDiagnostic():void {
  const w=window as any,d=Object.create(null)
  d.stages=[];d.errors=[];d.loads=Object.create(null);d.loadEntries=0;d.enrollment='not-returned'
  w.__pstartRecord=d
  const bump=(key:string)=>{d.loads[key]=Math.min(1024,(d.loads[key]??0)+1)}
  w.__pstartStage=(label:string)=>{if(d.stages.length<64)d.stages.push(label)}
  w.__pstartEnrollment=(value:string)=>{d.enrollment=value==='enrolled'?'enrolled':value==='definite-abort'?'definite-abort':'other'}
  w.__pstartLoadEntry=()=>{d.loadEntries=Math.min(1024,d.loadEntries+1)}
  w.__pstartLoadResult=(value:any)=>{
    if(value===undefined){bump('none');return}
    if(!Object.prototype.hasOwnProperty.call(value,'sealKeys')){bump('initial-without-own-sealKeys');return}
    const n=value.sealKeys?.length
    bump('successor');d.lastOwnSealCount=Number.isSafeInteger(n)&&n>=0&&n<=32?n:'out-of-range'
  }
  w.__pstartError=(where:string,error:any)=>{
    const name=['OrdinaryStateHold','Error','TypeError','DOMException','AbortError','InvalidStateError','OperationError'].includes(error?.name)?error.name:'other'
    const messageClass=error?.name==='OrdinaryStateHold'?'held':error?.name==='AbortError'?'native-abort':error?.name==='OperationError'?'crypto-operation':'other'
    if(d.errors.length<32)d.errors.push({where,name,messageClass})
  }
}

// Read-only projection. Never serialise the actual fixture globals or material.
export function snapshotPreparedStartupDiagnostic():unknown {
  const w=window as any,count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?Math.min(100000,n):null
  const stage=(value:unknown)=>['prepared','candidate-prepared','candidate-committed','settled','provider-started','provider-returned'].includes(value as string)?value:null
  const sockets=[0,0,0,0,0]
  for(const socket of (w.sockets??[]).slice(0,1000)){const n=socket.readyState;sockets[Number.isInteger(n)&&n>=0&&n<=3?n:4]++}
  return {record:w.__pstartRecord??null,requestedStage:stage(w.requestedStage),actualStage:stage(w.actualStage),skipStartupCuts:count(w.skipStartupCuts),
    joinState:['pending','ok','OrdinaryStateHold','Error'].includes(w.joinState)?w.joinState:null,
    effects:{signCalls:count(w.signCalls),dials:count(w.dials?.length),frames:count(w.frames?.length),socketReadyStates:sockets,entropy:count(w.randomness?.length??w.entropy),writes:count(w.puts)},
    resources:{browser:count(w.browserOwner?.__pstartResourceCount),tab:count(w.tabOwner?.__pstartResourceCount),browserRetention:w.browserOwner?.holdingRetention===true,tabRetention:w.tabOwner?.holdingRetention===true}}
}
