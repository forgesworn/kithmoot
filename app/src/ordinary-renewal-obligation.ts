/** @internal Fixed member-renewal construction plumbing. The registrar's sole
 * production callsite is the private bootstrap constructor. Its returned
 * closure never escapes that factory; there is no public token mint or writer. */
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import type { ParticipantIdentity } from '../../src/identity.js'
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { RESUME_MIN_REMAINING_SECONDS } from '../../src/session.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, ordinaryPairReadCustodyFor, ordinaryPairPredecessorSemanticDigestFor, ordinaryPairRenewalByteLengths,
  type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { verifyOrdinaryLifecycleRoot, verifyOrdinaryLifecyclePromise } from './ordinary-protocol-work.js'
import { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import { captureOrdinarySnapshotContext, captureOrdinaryProjectedSnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX, type DeviceStore } from './device-store.js'
import { inspectPersistentAdmissionProofs, accountPrefix, PERSISTENT_TAB_PROOF_V2_PREFIX, persistentProofName, persistentTabProofName, tabProofBytes } from './persistent-admission-proof.js'
import { ordinaryMemberLeaseName, readOrdinaryMemberLease, ordinaryMemberLeaseCredential, ordinaryMemberLeaseSource,
  makeOrdinaryMemberLeaseHeader, ordinaryMemberAuthorityUntil, type OrdinaryMemberAuthority } from './ordinary-member-lease.js'
import { credentialSeal } from '../../src/seal.js'
import { ROOM_PREFIX } from './rooms-store.js'

const HEX = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function hash(raw: string): string {
  const bytes = new TextEncoder().encode(raw)
  try { return bytesToHex(sha256(bytes)) } finally { bytes.fill(0) }
}
const records = (store: DeviceStore) => new Map(store.keys().map(name => [name,store.get(name)!]))
export interface OrdinaryRenewalIntent {
  readonly account: string|null
  readonly participant: string
  readonly invitationId: string
  readonly roomId: string
  readonly keep: boolean
  readonly device: string
  readonly credential: string
  readonly proof: string
  readonly bootstrap: string
  readonly predecessor: string
  readonly leaseSequence: number
  readonly epoch: number
  readonly epochId: string
  readonly linkDigest: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly authority: OrdinaryMemberAuthority
  readonly semanticDigest: string
  readonly sourceRevisions: readonly [number,number]
  readonly sourceFrames: readonly [string,string]
  readonly previousControlDigest: string|null
  readonly previousMarkers: readonly [string|null,string|null]
}
interface Factory {
  readonly browser: { readonly owner: OrdinaryStateOwner; readonly scope: OrdinaryScope }
  readonly tab: { readonly owner: OrdinaryStateOwner; readonly scope: OrdinaryScope }
  readonly account: string|null
  readonly participant: string
  readonly invitationId: string
  readonly keep: boolean
  readonly link: string
  readonly bootstrapCredentialExpiresAt: number
  readonly identity: ParticipantIdentity
  readonly live: () => boolean
}
declare const obligationBrand: unique symbol
export interface OrdinaryRenewalObligation { readonly [obligationBrand]: true }
interface Obligation {
  readonly factory: object
  readonly binding: Readonly<Factory>
  readonly root: ProtocolExecution
  readonly intent: OrdinaryRenewalIntent
  state: 'available'|'claimed'|'released'
}
const factories = new WeakSet<object>()
const obligations = new WeakMap<object,Obligation>()
/** Native facts and fixed preparation only. No entropy, provider or write. */
function intent(binding: Factory, browser: DeviceStore, tab: DeviceStore, token: OrdinaryPairCustody,
  desired: Readonly<{issuedAt:number;expiresAt:number;semanticDigest:string}>, reconstructed?: OrdinaryRenewalIntent): OrdinaryRenewalIntent {
  const b=records(browser),t=records(tab),checked=inspectPersistentAdmissionProofs(browser,tab)
  try {
    const headers=ordinaryPairReadCustodyFor(token,b,t)
    OrdinaryStateOwner.validatePairBinding(token,{browser:binding.browser,tab:binding.tab,live:binding.live})
    validateOrdinarySnapshot(b,t,{browser:true,tab:true},captureOrdinarySnapshotContext(b,t,token))
    const found=checked.selected.get(accountPrefix(binding.participant)+PERSISTENT_TAB_PROOF_V2_PREFIX+binding.invitationId)
    if(!found)hold()
    const proof=found.proof,bound=proof.binding
    if(proof.version!==2||bound.account!==binding.account||bound.participant!==binding.participant||bound.invitationId!==binding.invitationId||
      proof.kept.enabled!==binding.keep||JSON.stringify(bound.browser)!==JSON.stringify(binding.browser.scope)||
      JSON.stringify(bound.tab)!==JSON.stringify({...binding.tab.scope,purpose:binding.tab.owner.purpose,expiresAt:binding.tab.owner.expiresAt})||
      headers.browser.generation!==bound.browser.generation||headers.tab.generation!==bound.tab.generation)hold()
    const metadata=browser.get(accountPrefix(binding.participant)+ROOM_PREFIX+bound.roomId)
    if(metadata===null)hold()
    const room=JSON.parse(metadata)
    if(room.link!==binding.link||room.keep!==binding.keep||room.endedAt!==undefined)hold()
    const foreground=binding.account===null?null:OrdinaryForegroundSigner.nativeDeadline(binding.identity as OrdinaryForegroundSigner,browser,tab,token,binding.participant)
    if(binding.account===null){
      const raw=browser.get('kithmoot.participant');if(raw===null||!HEX.test(raw))hold()
      const key=hexToBytes(raw);try{if(getPublicKey(key)!==binding.participant)hold()}finally{key.fill(0)}
    }
    const owner=binding.keep?browser:tab,prefix=accountPrefix(binding.participant),raw=owner.get(prefix+OWN_CREDENTIAL_PREFIX+bound.roomId),seals=owner.get(prefix+OWN_SEAL_PREFIX+bound.roomId)
    if(raw===null||seals===null||bound.device.credentialIds.length!==1)hold()
    const credential=ordinaryMemberLeaseCredential(proof,bound.device.credentialIds[0]!)
    if(JSON.stringify(credential)!==raw)hold()
    const authority:OrdinaryMemberAuthority={tabExpiresAt:binding.tab.owner.expiresAt,admissionEndsAt:found.admission.endsAt??null,
      foregroundExpiresAt:foreground,membershipEndsAt:null}
    const leaseRaw=tab.get(ordinaryMemberLeaseName(bound)),lease=leaseRaw===null?undefined:readOrdinaryMemberLease(leaseRaw,JSON.stringify(proof))
    const bootstrap=lease?JSON.parse(lease.bootstrapProof):proof
    const first=ordinaryMemberLeaseCredential(bootstrap,bootstrap.binding.device.credentialIds[0]!),firstExpiry=Number(first.tags[2]![1])
    if(firstExpiry!==binding.bootstrapCredentialExpiresAt)hold()
    const previous=lease?.header??makeOrdinaryMemberLeaseHeader({sequence:0,bootstrap:bound.operation,predecessor:null,proof:bound.operation,
      credential:credential.id,seal:credentialSeal(credential)!,issuedAt:credential.created_at,expiresAt:Number(credential.tags[2]![1]),
      authority,source:ordinaryMemberLeaseSource(browser,tab,token)})
    if(JSON.stringify(previous.authority)!==JSON.stringify(authority)||previous.credential!==credential.id||
      !Number.isSafeInteger(previous.sequence+1)||!Number.isSafeInteger(desired.issuedAt)||desired.issuedAt<=credential.created_at||
      desired.issuedAt>Math.floor(Date.now()/1000)||desired.expiresAt!==Math.min(desired.issuedAt+firstExpiry-first.created_at,ordinaryMemberAuthorityUntil(authority))||
      desired.expiresAt<=previous.expiresAt||desired.expiresAt-Math.floor(Date.now()/1000)<RESUME_MIN_REMAINING_SECONDS)hold()
    // Recheck pruning and every future owner image before enrollment entropy.
    const retained=JSON.parse(seals) as string[],pruned=retained.length<128?[...retained]:retained.slice(-127),probeB=new Map(b),probeT=new Map(t)
    try{
      (binding.keep?probeB:probeT).set(prefix+OWN_SEAL_PREFIX+bound.roomId,JSON.stringify(pruned))
      validateOrdinarySnapshot(probeB,probeT,{browser:true,tab:true},captureOrdinaryProjectedSnapshotContext(b,t,token,probeB,probeT))
      const zero='0'.repeat(64),candidateCredential={kind:20460,created_at:desired.issuedAt,tags:[['d',bound.roomId],['device',bound.device.pubkey],
        ['expiration',String(desired.expiresAt)],['seal',zero]],content:'',pubkey:binding.participant,id:zero,sig:zero+zero}
      const owner=binding.keep?probeB:probeT
      owner.set(prefix+OWN_CREDENTIAL_PREFIX+bound.roomId,JSON.stringify(candidateCredential));owner.set(prefix+OWN_SEAL_PREFIX+bound.roomId,JSON.stringify([...pruned,zero]))
      const next={...proof,binding:{...bound,device:{...bound.device,credentialIds:[zero],credentials:[JSON.stringify(candidateCredential)],seals:[zero],recordsHash:zero},operation:zero}}
      const nextRaw=JSON.stringify(next)
      if(binding.keep)probeB.set(persistentProofName(next.binding),nextRaw)
      probeT.set(persistentTabProofName(next.binding),tabProofBytes(next))
      const lease=JSON.stringify({version:1,domain:'kithmoot/member-lease/v1',header:{sequence:previous.sequence+1,bootstrap:previous.bootstrap,
        predecessor:previous.operation,proof:zero,credential:zero,seal:zero,issuedAt:desired.issuedAt,expiresAt:desired.expiresAt,
        authority,source:ordinaryMemberLeaseSource(browser,tab,token),operation:zero},bootstrapProof:leaseRaw===null?JSON.stringify(proof):JSON.parse(leaseRaw).bootstrapProof,
        predecessorProof:JSON.stringify(proof),predecessorHeader:previous})
      probeT.set(ordinaryMemberLeaseName(bound),lease);if(binding.keep)probeB.set(ordinaryMemberLeaseName(bound),lease)
      ordinaryPairRenewalByteLengths(token,b,t,{browser:probeB,tab:probeT})
    }finally{probeB.clear();probeT.clear()}
    const semanticDigest=ordinaryPairPredecessorSemanticDigestFor(token,b,t)
    if(semanticDigest!==desired.semanticDigest)hold()
    const predecessor=reconstructed?{frames:reconstructed.sourceFrames,controlDigest:reconstructed.previousControlDigest,markers:reconstructed.previousMarkers}:OrdinaryStateOwner.captureRenewalPredecessor(token)
    const epoch=bound.device.epochs.find(value=>value.epoch===bound.device.epoch)
    if(!epoch)hold()
    return Object.freeze({account:binding.account,participant:binding.participant,invitationId:binding.invitationId,roomId:bound.roomId,keep:binding.keep,
      device:bound.device.pubkey,credential:credential.id,proof:bound.operation,bootstrap:previous.bootstrap,predecessor:previous.operation,
      leaseSequence:previous.sequence,epoch:bound.device.epoch,epochId:epoch.id,linkDigest:hash(binding.link),issuedAt:desired.issuedAt,
      expiresAt:desired.expiresAt,authority:Object.freeze(authority),semanticDigest,sourceRevisions:Object.freeze([headers.browser.revision,headers.tab.revision]) as readonly [number,number],
      sourceFrames:predecessor.frames,previousControlDigest:predecessor.controlDigest,previousMarkers:predecessor.markers})
  } finally { b.clear();t.clear();checked.close() }
}
/** Sole callsite: actual private bootstrap construction. The closure captures
 * its exact immutable actor/owner/scope/selection binding and is never exposed. */
export function registerOrdinaryRenewalFactory(factory: object, input: Factory):
  (root:ProtocolExecution,browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody,
    desired:Readonly<{issuedAt:number;expiresAt:number;semanticDigest:string}>)=>OrdinaryRenewalObligation {
  if(!factory||factories.has(factory)||input.account!==null&&input.account!==input.participant||!HEX.test(input.participant)||
    !HEX.test(input.invitationId)||typeof input.keep!=='boolean'||typeof input.live!=='function')hold()
  const binding=Object.freeze({...input,browser:Object.freeze({owner:input.browser.owner,scope:Object.freeze({...input.browser.scope})}),
    tab:Object.freeze({owner:input.tab.owner,scope:Object.freeze({...input.tab.scope})})})
  factories.add(factory)
  const usedRoots=new WeakSet<object>()
  return Object.freeze((root,browser,tab,custody,desired)=>{
    verifyOrdinaryLifecycleRoot(root)
    if(usedRoots.has(root)||binding.live()!==true)hold()
    const captured=intent(binding,browser,tab,custody,desired)
    verifyOrdinaryLifecycleRoot(root)
    OrdinaryStateOwner.validatePairBinding(custody,{browser:binding.browser,tab:binding.tab,live:binding.live})
    if(binding.live()!==true)hold()
    usedRoots.add(root)
    const token=Object.freeze({}) as OrdinaryRenewalObligation
    obligations.set(token,{factory,binding,root,intent:captured,state:'available'})
    return token
  })
}
/** Fixed owner transition consumer only. A root check is ownership, not phase
 * authority: enrollment still owes fresh native source/control authentication. */
export function takeOrdinaryRenewalObligation(token: OrdinaryRenewalObligation): Readonly<{
  binding:Readonly<Factory>;root:ProtocolExecution;intent:OrdinaryRenewalIntent
}> {
  const value=obligations.get(token)
  if(!value||value.state!=='available')hold()
  verifyOrdinaryLifecycleRoot(value.root)
  if(value.binding.live()!==true||value.binding.account!==null&&!OrdinaryForegroundSigner.nativeCurrent(value.binding.identity as OrdinaryForegroundSigner,
    value.binding.participant,value.intent.authority.foregroundExpiresAt))hold()
  verifyOrdinaryLifecycleRoot(value.root)
  value.state='claimed'
  return Object.freeze({binding:value.binding,root:value.root,intent:value.intent})
}
/** Cleanup only. It neither resumes a graph nor clears durable custody. */
export function releaseOrdinaryRenewalObligation(token: OrdinaryRenewalObligation|undefined): void {
  if(!token)return
  const value=obligations.get(token)
  if(value)value.state='released'
  obligations.delete(token)
}

/** Fixed transition guard only. It supplies no native snapshot or permission
 * to skip owner/control authentication. Selectors may revoke synchronously. */
export function checkOrdinaryRenewalObligation(token:OrdinaryRenewalObligation):void{
  const value=obligations.get(token)
  if(!value||value.state!=='claimed')hold()
  verifyOrdinaryLifecycleRoot(value.root)
  if(value.binding.live()!==true||value.binding.account!==null&&!OrdinaryForegroundSigner.nativeCurrent(value.binding.identity as OrdinaryForegroundSigner,
    value.binding.participant,value.intent.authority.foregroundExpiresAt))hold()
  verifyOrdinaryLifecycleRoot(value.root)
}
/** Revalidate all fixed intent references in the same genuine P callback as
 * enrollment preparation. A copied request or ownership root is insufficient. */
export function validateOrdinaryRenewalPredecessor(token:OrdinaryRenewalObligation,browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody):void{
  checkOrdinaryRenewalObligation(token)
  const value=obligations.get(token)!,current=intent(value.binding,browser,tab,custody,value.intent)
  if(JSON.stringify(current)!==JSON.stringify(value.intent))hold()
  checkOrdinaryRenewalObligation(token)
}


/** The fixed signing owner has retained this exact outer promise before any
 * native await. Ownership remains distinct from the authenticated phase. */
export function checkOrdinaryRenewalSigningObligation(token:OrdinaryRenewalObligation,pending:Promise<unknown>):void{
  const value=obligations.get(token)
  if(!value||value.state!=='claimed')hold()
  verifyOrdinaryLifecyclePromise(value.root,pending)
  if(value.intent.expiresAt-Math.floor(Date.now()/1000)<RESUME_MIN_REMAINING_SECONDS)hold()
  if(value.binding.live()!==true||value.binding.account!==null&&!OrdinaryForegroundSigner.nativeCurrent(value.binding.identity as OrdinaryForegroundSigner,
    value.binding.participant,value.intent.authority.foregroundExpiresAt))hold()
  verifyOrdinaryLifecyclePromise(value.root,pending)
}
/** Only the fixed owner constructs this temporary read token from authenticated
 * E and its exact bounded inverse. Original P frame/control metadata comes
 * from the retained obligation, never a caller reconstruction or nonce replay. */
export function validateOrdinaryRenewalReconstructedPredecessor(token:OrdinaryRenewalObligation,pending:Promise<unknown>,browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody):void{
  checkOrdinaryRenewalSigningObligation(token,pending)
  const value=obligations.get(token)!,current=intent(value.binding,browser,tab,custody,value.intent,value.intent)
  if(JSON.stringify(current)!==JSON.stringify(value.intent))hold()
  checkOrdinaryRenewalSigningObligation(token,pending)
}

/** Fixed foreground identity equality only, additional to root/promise and
 * current native source checks; no signer or template is returned. */
export function validateOrdinaryRenewalSigningForeground(token:OrdinaryRenewalObligation,pending:Promise<unknown>,signer:OrdinaryForegroundSigner):void{
  checkOrdinaryRenewalSigningObligation(token,pending)
  const value=obligations.get(token)!
  if(value.binding.account===null||value.binding.identity!==signer)hold()
  checkOrdinaryRenewalSigningObligation(token,pending)
}
