/** @internal Offline meaning of an authenticated native startup pair only.
 * This inspector returns no image, key, signer, receipt or phase permission.
 * A recovery producer must repeat all native and current-authority checks. */
import { bytesToHex,hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { credentialSeal } from '../../src/seal.js'
import { getPublicKey } from 'nostr-tools/pure'
import { OrdinaryStateHold,type OrdinaryImage,type OrdinaryFrame } from './ordinary-state-codec.js'
import { ordinaryFrameDigest,ordinaryOperationNames,type OrdinaryOperationJournal } from './ordinary-operation-codec.js'
import { readOrdinaryRenewalRequest,restoreOrdinaryRenewalPredecessor } from './ordinary-renewal-request.js'
import { ordinaryRenewalStatement,ordinaryRenewalStatementForPublicSeal,ordinaryRenewalResultForStatement } from './ordinary-renewal-credential.js'
import { inspectPersistentAdmissionProofs,accountPrefix,PERSISTENT_TAB_PROOF_V2_PREFIX } from './persistent-admission-proof.js'
import { ordinaryMemberLeaseName,readOrdinaryMemberLease,ordinaryMemberLeaseCredential,makeOrdinaryMemberLeaseHeader,memberLeaseDigest,ordinaryMemberAuthorityUntil } from './ordinary-member-lease.js'
import { OWN_CREDENTIAL_PREFIX,type DeviceStore } from './device-store.js'
import { ROOM_PREFIX } from './rooms-store.js'
import { ORDINARY_SIGNET_KEYS } from './ordinary-signet-snapshot.js'
import type { OrdinaryRenewalIntent } from './ordinary-renewal-obligation.js'
function hold():never{throw new OrdinaryStateHold()}
const copy=(image:OrdinaryImage):OrdinaryImage=>({...image,records:new Map(image.records),fences:new Map(image.fences),
  migration:image.migration?{...image.migration,sources:new Map(image.migration.sources),names:[...image.migration.names]}:undefined})
const clear=(image:OrdinaryImage)=>{(image.records as Map<string,string>).clear();(image.fences as Map<string,number>).clear();(image.migration?.sources as Map<string,string>|undefined)?.clear()}
const store=(image:OrdinaryImage):DeviceStore=>({keys:()=>[...image.records.keys()],get:n=>image.records.get(n)??null,set:hold,remove:hold})
/** Immutable historical references only, reconstructed on owned P copies.
 * Actual recovery still owes native current Fore/visitor and full-role checks. */
function predecessorRole(images:readonly [OrdinaryImage,OrdinaryImage],intent:OrdinaryRenewalIntent):void{
  const b=store(images[0]),t=store(images[1]),checked=inspectPersistentAdmissionProofs(b,t)
  try{
    const found=checked.selected.get(accountPrefix(intent.participant)+PERSISTENT_TAB_PROOF_V2_PREFIX+intent.invitationId)
    if(!found)hold()
    const proof=found.proof,bound=proof.binding
    if(bound.operation!==intent.proof||bound.account!==intent.account||bound.participant!==intent.participant||bound.invitationId!==intent.invitationId||
      bound.roomId!==intent.roomId||proof.kept.enabled!==intent.keep||bound.device.pubkey!==intent.device||bound.device.epoch!==intent.epoch||
      bound.device.epochs.find(epoch=>epoch.epoch===intent.epoch)?.id!==intent.epochId||bound.device.credentialIds.length!==1||bound.device.credentialIds[0]!==intent.credential||
      bound.browser.generation!==images[0].generation||bound.tab.generation!==images[1].generation||bound.tab.purpose!==images[1].purpose||
      bound.tab.expiresAt!==images[1].expiresAt||intent.authority.tabExpiresAt!==images[1].expiresAt||intent.authority.admissionEndsAt!==(found.admission.endsAt??null))hold()
    const credential=ordinaryMemberLeaseCredential(proof,intent.credential),owner=intent.keep?b:t,prefix=accountPrefix(intent.participant)
    if(owner.get(prefix+OWN_CREDENTIAL_PREFIX+intent.roomId)!==JSON.stringify(credential))hold()
    const metadata=b.get(prefix+ROOM_PREFIX+intent.roomId);if(metadata===null)hold()
    const room=JSON.parse(metadata),linkBytes=new TextEncoder().encode(room.link)
    try{if(room.keep!==intent.keep||bytesToHex(sha256(linkBytes))!==intent.linkDigest)hold()}finally{linkBytes.fill(0)}
    const sorted=(values:ReadonlyMap<string,unknown>)=>[...values].sort(([a],[b])=>a<b?-1:a>b?1:0)
    const sourceImage=(image:OrdinaryImage)=>[image.purpose,image.expiresAt,image.generation,image.revision,sorted(image.fences),sorted(image.records)]
    const source={browserRevision:images[0].revision,tabRevision:images[1].revision,
      hash:memberLeaseDigest(['kithmoot/member-lease/v1/source',1,sourceImage(images[0]),sourceImage(images[1])])}
    const raw=t.get(ordinaryMemberLeaseName(bound)),lease=raw===null?undefined:readOrdinaryMemberLease(raw,JSON.stringify(proof)),previous=!lease?makeOrdinaryMemberLeaseHeader({sequence:0,bootstrap:bound.operation,predecessor:null,
      proof:bound.operation,credential:credential.id,seal:credentialSeal(credential)!,issuedAt:credential.created_at,expiresAt:Number(credential.tags[2]![1]),
      authority:intent.authority,source}):lease.header
    const bootstrap=lease?JSON.parse(lease.bootstrapProof):proof,first=ordinaryMemberLeaseCredential(bootstrap,bootstrap.binding.device.credentialIds[0]!)
    if(intent.expiresAt!==Math.min(intent.issuedAt+Number(first.tags[2]![1])-first.created_at,ordinaryMemberAuthorityUntil(intent.authority)))hold()
    if(previous.operation!==intent.predecessor||previous.sequence!==intent.leaseSequence||previous.bootstrap!==intent.bootstrap||
      JSON.stringify(previous.authority)!==JSON.stringify(intent.authority)||intent.issuedAt<=credential.created_at||intent.expiresAt<=previous.expiresAt)hold()
    if(intent.account===null){
      const raw=b.get('kithmoot.participant');if(raw===null)hold();const key=hexToBytes(raw)
      try{if(getPublicKey(key)!==intent.participant)hold()}finally{key.fill(0)}
    }else if(b.get(ORDINARY_SIGNET_KEYS.pubkey)!==intent.account)hold()
  }finally{checked.close()}
}
/** Native authentication is owed by the owner. Canonical producer request,
 * exact current E/C frames, inverse P and retained result meaning are checked
 * here without applying current expiry to historical custody. */
export async function validateOrdinaryRenewalStartupRows(journal:OrdinaryOperationJournal,frames:readonly [OrdinaryFrame,OrdinaryFrame],images:readonly [OrdinaryImage,OrdinaryImage]):Promise<void>{
  if(journal.phase==='settled')hold()
  const request=readOrdinaryRenewalRequest(journal.request),intent=request.intent,committed=journal.phase==='candidate-committed',names=ordinaryOperationNames(journal.tab)
  if(request.sources[1].purpose!==journal.tab||JSON.stringify(intent.sourceFrames)!==JSON.stringify(journal.source)||
    JSON.stringify(intent.sourceRevisions)!==JSON.stringify(journal.sourceRevisions)||JSON.stringify(request.scopes)!==JSON.stringify(journal.scopes)||
    JSON.stringify(journal.ceilings)!==JSON.stringify([intent.authority.tabExpiresAt,intent.authority.admissionEndsAt??0,intent.authority.foregroundExpiresAt??0])||
    journal.sequence!==(request.previous?request.previous.header.sequence+1:1))hold()
  const digests=committed?journal.target:journal.enrolled,revisions=committed?journal.targetRevisions:journal.enrolledRevisions
  if(!digests||!revisions||frames.some((frame,i)=>ordinaryFrameDigest(frame)!==digests[i]||frame.revision!==revisions[i]))hold()
  for(const[i,image]of images.entries()){
    const source=request.sources[i]!
    if(image.purpose!==source.purpose||image.keyId!==source.keyId||image.generation!==source.generation||image.expiresAt!==source.expiresAt||
      image.revision!==revisions[i]||request.scopes[i]![2]!==image.generation||image.fences.get(request.scopes[i]![1])!==request.scopes[i]![3])hold()
  }
  if(!committed){
    const inverse=[copy(images[0]),copy(images[1])] as const
    try{restoreOrdinaryRenewalPredecessor(inverse[0],inverse[1],journal.request,{id:journal.id,sequence:journal.sequence});predecessorRole(inverse,intent)}
    finally{inverse.forEach(clear)}
  }
  if(journal.phase==='prepared')return
  if(!committed&&journal.secrets.length!==1)hold()
  if(journal.phase==='provider-started'){
    try{getPublicKey(journal.secrets[0]!)}catch{return hold()};return
  }
  if(!journal.result)hold()
  let result:import('signet-login').NostrEvent
  try{result=JSON.parse(journal.result)}catch{return hold()}
  const publicSeal=result.tags?.[3]?.[1]
  if(typeof publicSeal!=='string')hold()
  const statement=committed?await ordinaryRenewalStatementForPublicSeal(journal.request,publicSeal):await ordinaryRenewalStatement(journal.request,journal.secrets[0]!)
  if(ordinaryRenewalResultForStatement(journal.request,statement,result)!==journal.result)hold()
  if(committed){
    const b=store(images[0]),t=store(images[1]),checked=inspectPersistentAdmissionProofs(b,t)
    try{
      const found=checked.selected.get(accountPrefix(intent.participant)+PERSISTENT_TAB_PROOF_V2_PREFIX+intent.invitationId)
      if(!found)hold()
      const proof=found.proof,bound=proof.binding,raw=t.get(ordinaryMemberLeaseName(bound)),owner=intent.keep?b:t
      if(raw===null||bound.participant!==intent.participant||bound.account!==intent.account||bound.roomId!==intent.roomId||
        bound.invitationId!==intent.invitationId||proof.kept.enabled!==intent.keep||bound.device.pubkey!==intent.device||bound.device.epoch!==intent.epoch||bound.device.epochs.find(epoch=>epoch.epoch===intent.epoch)?.id!==intent.epochId||
        bound.browser.name!==request.scopes[0]![1]||bound.browser.generation!==images[0].generation||bound.browser.fence!==request.scopes[0]![3]||
        bound.tab.name!==request.scopes[1]![1]||bound.tab.generation!==images[1].generation||bound.tab.fence!==request.scopes[1]![3]||
        bound.tab.purpose!==journal.tab||bound.tab.expiresAt!==images[1].expiresAt||bound.device.credentialIds.length!==1||bound.device.credentialIds[0]!==result.id||
        owner.get(accountPrefix(intent.participant)+OWN_CREDENTIAL_PREFIX+intent.roomId)!==journal.result)hold()
      const metadata=b.get(accountPrefix(intent.participant)+ROOM_PREFIX+intent.roomId);if(metadata===null)hold()
      const room=JSON.parse(metadata),linkBytes=new TextEncoder().encode(room.link)
      try{if(room.keep!==intent.keep||bytesToHex(sha256(linkBytes))!==intent.linkDigest)hold()}finally{linkBytes.fill(0)}
      const lease=readOrdinaryMemberLease(raw,JSON.stringify(proof))
      if(lease.predecessorHeader.sequence!==intent.leaseSequence||lease.predecessorHeader.proof!==intent.proof||lease.predecessorHeader.credential!==intent.credential||
        lease.predecessorHeader.operation!==intent.predecessor||lease.predecessorHeader.bootstrap!==intent.bootstrap||lease.header.sequence!==intent.leaseSequence+1||lease.header.bootstrap!==intent.bootstrap||lease.header.predecessor!==intent.predecessor||
        lease.header.credential!==result.id||lease.header.proof!==bound.operation||lease.header.issuedAt!==intent.issuedAt||lease.header.expiresAt!==intent.expiresAt||
        JSON.stringify(lease.header.authority)!==JSON.stringify(intent.authority))hold()
      if(images[0].records.get(names.marker)!==images[1].records.get(names.marker))hold()
    }finally{checked.close()}
  }
}
