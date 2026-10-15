/** @internal Fixed C projection only, from the owner's authenticated inverse
 * P callback. No signer, writer, raw-key return or Session adoption. */
import { bytesToHex,hexToBytes } from '@noble/hashes/utils'
import type { ParticipantIdentity } from '../../src/identity.js'
import { roomInvitation } from '../../src/invitation.js'
import { OrdinaryStateHold,type OrdinaryImage } from './ordinary-state-codec.js'
import { ordinaryOperationNames } from './ordinary-operation-codec.js'
import { readOrdinaryRenewalRequest } from './ordinary-renewal-request.js'
import { OWN_CREDENTIAL_PREFIX,OWN_SEAL_PREFIX,type DeviceStore } from './device-store.js'
import { accountPrefix,inspectPersistentAdmissionProofs,makePersistentAdmissionProof,persistentAdmissionDeviceInPair,
  persistentProofName,persistentTabProofName,tabProofBytes,PERSISTENT_TAB_PROOF_V2_PREFIX } from './persistent-admission-proof.js'
import { captureOrdinaryProjectedSnapshotContext,validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { makeOrdinaryMemberLease,makeOrdinaryRetainedRenewalLease } from './ordinary-member-lease-preparation.js'
import { ordinaryMemberLeaseName } from './ordinary-member-lease.js'
import type { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import type { OrdinaryPairCustody } from './ordinary-state-owner.js'
function hold():never{throw new OrdinaryStateHold()}
const records=(store:DeviceStore)=>new Map(store.keys().map(n=>[n,store.get(n)!]))
const view=(map:Map<string,string>):DeviceStore=>({get:n=>map.get(n)??null,keys:()=>[...map.keys()],set:hold,remove:hold})
export function prepareOrdinaryRenewalCandidate(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody,request:string,result:string,seal:Uint8Array,
  identity:ParticipantIdentity,enrolled:readonly [OrdinaryImage,OrdinaryImage]):readonly [OrdinaryImage,OrdinaryImage]{
  const candidate=projectOrdinaryRenewalCandidate(browser,tab,request,result,seal,enrolled,
    (predecessorProof,currentProof)=>makeOrdinaryMemberLease(browser,tab,custody,{predecessorProof,currentProof,
      ...(readOrdinaryRenewalRequest(request).intent.account===null?{}:{identity:identity as OrdinaryForegroundSigner})}),
    (sourceB,sourceT,b,t)=>validateOrdinarySnapshot(b,t,{browser:true,tab:true},captureOrdinaryProjectedSnapshotContext(sourceB,sourceT,custody,b,t)))
  return candidate
}
/** @internal Fixed historical C image construction only. The startup owner
 * must authenticate exact E/inverse P, retained result and whole origin, then
 * validate the complete projected image before sealing or writing. This pure
 * function produces data, never PairReadCU, role, writer or adoption authority. */
export function prepareOrdinaryRetainedRenewalCandidate(predecessor:readonly [OrdinaryImage,OrdinaryImage],request:string,result:string,seal:Uint8Array,
  enrolled:readonly [OrdinaryImage,OrdinaryImage]):readonly [OrdinaryImage,OrdinaryImage]{
  const b=new Map(predecessor[0].records),t=new Map(predecessor[1].records)
  try{return projectOrdinaryRenewalCandidate(view(b),view(t),request,result,seal,enrolled,
    (_old,current)=>makeOrdinaryRetainedRenewalLease(predecessor,current,request))}
  finally{b.clear();t.clear()}
}
/** Fixed module-private pure plumbing shared by the two constructors. Its
 * callbacks are defined above; no caller supplies construction or validation. */
function projectOrdinaryRenewalCandidate(browser:DeviceStore,tab:DeviceStore,request:string,result:string,seal:Uint8Array,
  enrolled:readonly [OrdinaryImage,OrdinaryImage],leaseFor:(old:string,current:string)=>string,
  validateProjection?:(sourceB:Map<string,string>,sourceT:Map<string,string>,b:Map<string,string>,t:Map<string,string>)=>void):readonly [OrdinaryImage,OrdinaryImage]{
  const intent=readOrdinaryRenewalRequest(request).intent,checked=inspectPersistentAdmissionProofs(browser,tab),sourceB=records(browser),sourceT=records(tab),b=new Map(sourceB),t=new Map(sourceT)
  let bearer:Uint8Array|undefined,success=false
  try{
    const found=checked.selected.get(accountPrefix(intent.participant)+PERSISTENT_TAB_PROOF_V2_PREFIX+intent.invitationId)
    if(!found||found.proof.binding.operation!==intent.proof)hold()
    const old=found.proof,prefix=accountPrefix(intent.participant),owner=intent.keep?b:t,name=prefix+OWN_SEAL_PREFIX+intent.roomId,raw=owner.get(name)
    if(raw===undefined)hold()
    const retained=JSON.parse(raw) as string[],pruned=retained.length<128?[...retained]:retained.slice(-127)
    owner.set(prefix+OWN_CREDENTIAL_PREFIX+intent.roomId,result);owner.set(name,JSON.stringify([...pruned,bytesToHex(seal)]))
    bearer=hexToBytes(old.capability.bearer)
    const invitation=roomInvitation(bearer,old.capability.inviter,true)
    try{
      const verified=makePersistentAdmissionProof({invitation,evidence:old.evidence,account:intent.account,participant:intent.participant,browser:old.binding.browser,tab:old.binding.tab,
        deviceCustody:old.binding.deviceCustody,device:persistentAdmissionDeviceInPair(view(b),view(t),intent.roomId,intent.participant,intent.account,intent.keep?'browser':'tab'),
        keep:intent.keep,now:old.kept.at,expectedRoomSecret:found.admission.secret})
      try{
        const proofRaw=JSON.stringify(verified.proof),lease=leaseFor(JSON.stringify(old),proofRaw)
        if(intent.keep)b.set(persistentProofName(verified.proof.binding),proofRaw)
        t.set(persistentTabProofName(verified.proof.binding),tabProofBytes(verified.proof))
        const leaseName=ordinaryMemberLeaseName(verified.proof.binding);t.set(leaseName,lease);if(intent.keep)b.set(leaseName,lease)
        validateProjection?.(sourceB,sourceT,b,t)
        const marker=ordinaryOperationNames(enrolled[1].purpose).marker
        for(const[map,image]of [[b,enrolled[0]],[t,enrolled[1]]] as const){const value=image.records.get(marker);if(value===undefined)hold();map.set(marker,value)}
        success=true
        const make=(image:OrdinaryImage,records:Map<string,string>):OrdinaryImage=>({...image,revision:image.revision+1,records,fences:new Map(image.fences),
          migration:image.migration?{...image.migration,sources:new Map(image.migration.sources),names:[...image.migration.names]}:undefined})
        return Object.freeze([make(enrolled[0],b),make(enrolled[1],t)]) as readonly [OrdinaryImage,OrdinaryImage]
      }finally{verified.admission.secret.fill(0)}
    }finally{invitation.bearer.fill(0)}
  }finally{bearer?.fill(0);checked.close();sourceB.clear();sourceT.clear();if(!success){b.clear();t.clear()}}
}
