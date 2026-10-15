/** @internal Versioned fixed renewal request data only. Neither a canonical
 * request nor its inverse grants current authority or a phase continuation. */
import { captureProtocolData } from '../../src/protocol-execution.js'
import { OrdinaryStateHold, ordinaryUtf8Length, type OrdinaryImage, type OrdinaryPurpose } from './ordinary-state-codec.js'
import { ORDINARY_OPERATION_DATA_BYTES, ordinaryOperationSemanticDigest, ordinaryOperationMarker, ordinaryOperationNames,
  ordinaryOperationCommitment, type OrdinaryOperationClassification } from './ordinary-operation-codec.js'
import { ordinaryMemberAuthorityUntil } from './ordinary-member-lease.js'
import type { OrdinaryRenewalIntent } from './ordinary-renewal-obligation.js'

const DOMAIN='kithmoot/member-renewal/request/v1'
const HEX=/^[0-9a-f]{64}$/
function hold():never{throw new OrdinaryStateHold()}
function object(raw:unknown,fields:readonly string[]):Record<string,unknown>{
  if(!raw||typeof raw!=='object'||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).length!==fields.length)hold()
  const values:Record<string,unknown>={}
  for(const name of fields){const d=Object.getOwnPropertyDescriptor(raw,name);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))hold();values[name]=d.value}
  return values
}
function array(raw:unknown,max:number):unknown[]{
  if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length>max||Reflect.ownKeys(raw).length!==raw.length+1)hold()
  return Array.from({length:raw.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(raw,String(i));if(!d||!Object.hasOwn(d,'value'))hold();return d.value})
}
function integer(raw:unknown):number{if(!Number.isSafeInteger(raw)||(raw as number)<0)hold();return raw as number}
function hex(raw:unknown):string{if(typeof raw!=='string'||!HEX.test(raw))hold();return raw}
function pair<T>(raw:unknown,read:(raw:unknown)=>T):readonly [T,T]{const v=array(raw,2);if(v.length!==2)hold();return Object.freeze(v.map(read)) as unknown as readonly [T,T]}
const INTENT=['account','participant','invitationId','roomId','keep','device','credential','proof','bootstrap','predecessor','leaseSequence','epoch','epochId',
  'linkDigest','issuedAt','expiresAt','authority','semanticDigest','sourceRevisions','sourceFrames','previousControlDigest','previousMarkers'] as const
function intent(raw:unknown):OrdinaryRenewalIntent{
  const v=object(raw,INTENT),a=object(v.authority,['tabExpiresAt','admissionEndsAt','foregroundExpiresAt','membershipEndsAt'])
  const authority=Object.freeze({tabExpiresAt:integer(a.tabExpiresAt),admissionEndsAt:a.admissionEndsAt===null?null:integer(a.admissionEndsAt),
    foregroundExpiresAt:a.foregroundExpiresAt===null?null:integer(a.foregroundExpiresAt),membershipEndsAt:null})
  if(a.membershipEndsAt!==null||typeof v.keep!=='boolean')hold()
  const result:OrdinaryRenewalIntent={account:v.account===null?null:hex(v.account),participant:hex(v.participant),invitationId:hex(v.invitationId),roomId:hex(v.roomId),
    keep:v.keep,device:hex(v.device),credential:hex(v.credential),proof:hex(v.proof),bootstrap:hex(v.bootstrap),predecessor:hex(v.predecessor),leaseSequence:integer(v.leaseSequence),
    epoch:integer(v.epoch),epochId:hex(v.epochId),linkDigest:hex(v.linkDigest),issuedAt:integer(v.issuedAt),expiresAt:integer(v.expiresAt),authority,
    semanticDigest:hex(v.semanticDigest),sourceRevisions:pair(v.sourceRevisions,integer),sourceFrames:pair(v.sourceFrames,hex),
    previousControlDigest:v.previousControlDigest===null?null:hex(v.previousControlDigest),previousMarkers:pair(v.previousMarkers,value=>{
      if(value!==null&&typeof value!=='string')hold();return value as string|null
    })}
  if(result.account!==null&&result.account!==result.participant||result.account===null&&authority.foregroundExpiresAt!==null||
    result.expiresAt<=result.issuedAt||result.expiresAt>ordinaryMemberAuthorityUntil(authority)||!Number.isSafeInteger(result.leaseSequence+1)||
    result.sourceRevisions.some(revision=>!Number.isSafeInteger(revision+3)))hold()
  return Object.freeze(result)
}
export interface OrdinaryRenewalSourceHeader{
  readonly purpose:OrdinaryPurpose;readonly keyId:string;readonly generation:string;readonly revision:number;readonly expiresAt:number
}
/** The fixed enrollment changes only these scope cells. Prior absence is
 * distinct from an existing zero; both are retained explicitly. */
export type OrdinaryRenewalFenceDelta=readonly [OrdinaryPurpose,string,boolean,number|null,number]
export interface OrdinaryRenewalRequest{
  readonly version:1;readonly domain:typeof DOMAIN;readonly credentialFormat:1
  readonly intent:OrdinaryRenewalIntent
  readonly sources:readonly [OrdinaryRenewalSourceHeader,OrdinaryRenewalSourceHeader]
  readonly scopes:readonly (readonly [OrdinaryPurpose,string,string,number])[]
  readonly fences:readonly OrdinaryRenewalFenceDelta[]
  readonly previous:Readonly<{digest:string;header:OrdinaryOperationClassification}>|null
}
function request(raw:unknown):OrdinaryRenewalRequest{
  const v=object(raw,['version','domain','credentialFormat','intent','sources','scopes','fences','previous'])
  if(v.version!==1||v.domain!==DOMAIN||v.credentialFormat!==1)hold()
  const core=intent(v.intent),sources=pair(v.sources,raw=>{
    const h=object(raw,['purpose','keyId','generation','revision','expiresAt'])
    if(h.purpose!=='browser'&&(typeof h.purpose!=='string'||h.purpose.length!==68||!/^tab:[0-9a-f]{64}$/.test(h.purpose)))hold()
    return Object.freeze({purpose:h.purpose as OrdinaryPurpose,keyId:hex(h.keyId),generation:hex(h.generation),revision:integer(h.revision),expiresAt:integer(h.expiresAt)})
  })
  const tab=sources[1].purpose
  if(sources[0].purpose!=='browser'||sources[0].expiresAt!==0||tab==='browser'||sources[1].expiresAt!==core.authority.tabExpiresAt||
    sources.some((h,i)=>h.revision!==core.sourceRevisions[i]))hold()
  const scopeName='invitation:'+core.participant+':'+core.invitationId
  const scopes=array(v.scopes,2).map((raw,i)=>{
    const s=array(raw,4);if(s.length!==4||s[0]!==sources[i]?.purpose||s[1]!==scopeName||s[2]!==sources[i]?.generation||integer(s[3])>sources[i]!.revision)hold()
    return Object.freeze([s[0],s[1],s[2],s[3]]) as readonly [OrdinaryPurpose,string,string,number]
  })
  if(scopes.length!==2)hold()
  const fences=array(v.fences,2).map((raw,i)=>{
    const d=array(raw,5);if(d.length!==5||d[0]!==scopes[i]?.[0]||d[1]!==scopes[i]?.[1]||typeof d[2]!=='boolean'||
      integer(d[4])!==scopes[i]![3]||(d[2]?integer(d[3])!==d[4]:d[3]!==null||d[4]!==0))hold()
    return Object.freeze(d) as unknown as OrdinaryRenewalFenceDelta
  })
  if(fences.length!==2)hold()
  let previous:OrdinaryRenewalRequest['previous']=null
  if(v.previous!==null){
    const old=object(v.previous,['digest','header']),digest=hex(old.digest)
    // The codec rejects accessors, extra fields and malformed nested tuples
    // before this bounded plain-data copy is made.
    const commitment=ordinaryOperationCommitment(old.header as OrdinaryOperationClassification),header=captureProtocolData(old.header) as OrdinaryOperationClassification
    if(header.tab!==tab||header.phase!=='settled'||digest!==core.previousControlDigest||!Number.isSafeInteger(header.sequence+1)||
      header.requestBytes!==0||header.resultBytes!==null||header.secretCount!==0||header.hasNonces)hold()
    const marker=ordinaryOperationMarker({id:header.id,tab,sequence:header.sequence,commitment})
    if(core.previousMarkers.some(value=>value!==marker))hold()
    previous=Object.freeze({digest,header})
  }else if(core.previousControlDigest!==null||core.previousMarkers.some(value=>value!==null))hold()
  return Object.freeze({version:1,domain:DOMAIN,credentialFormat:1,intent:core,sources,scopes:Object.freeze(scopes),fences:Object.freeze(fences),previous})
}
export function encodeOrdinaryRenewalRequest(value:OrdinaryRenewalRequest):string{
  const raw=JSON.stringify(request(value));ordinaryUtf8Length(raw,ORDINARY_OPERATION_DATA_BYTES);return raw
}
export function readOrdinaryRenewalRequest(raw:string):OrdinaryRenewalRequest{
  try{ordinaryUtf8Length(raw,ORDINARY_OPERATION_DATA_BYTES);const value=request(JSON.parse(raw));if(JSON.stringify(value)!==raw)hold();return value}catch{return hold()}
}
/** Verify the exact inverse on owned copies of AUTHENTICATED E. This parser
 * does not authenticate frames, the control, current actor or lifecycle root.
 * Its caller must establish those facts before supplying these images. */
export function restoreOrdinaryRenewalPredecessor(browser:OrdinaryImage,tab:OrdinaryImage,raw:string,
  operation:Readonly<{id:string;sequence:number}>):void{
  const retained=readOrdinaryRenewalRequest(raw),names=ordinaryOperationNames(tab.purpose)
  const marker=ordinaryOperationMarker({id:operation.id,tab:tab.purpose as `tab:${string}`,sequence:operation.sequence,commitment:null})
  if(operation.sequence!==(retained.previous?retained.previous.header.sequence+1:1))hold()
  for(const [i,image]of [browser,tab].entries()){
    const h=retained.sources[i]!,d=retained.fences[i]!
    if(image.purpose!==h.purpose||image.keyId!==h.keyId||image.generation!==h.generation||image.expiresAt!==h.expiresAt||
      image.revision!==h.revision+1||image.records.get(names.marker)!==marker||image.fences.get(d[1])!==d[4])hold()
  }
  for(const [i,image]of [browser,tab].entries()){
    const records=new Map(image.records),fences=new Map(image.fences),old=retained.intent.previousMarkers[i]!,d=retained.fences[i]!
    if(old===null)records.delete(names.marker);else records.set(names.marker,old)
    if(d[2])fences.set(d[1],d[3]!);else fences.delete(d[1])
    image.records=records;image.fences=fences;image.revision--
  }
  if(ordinaryOperationSemanticDigest(browser,tab)!==retained.intent.semanticDigest)hold()
}
