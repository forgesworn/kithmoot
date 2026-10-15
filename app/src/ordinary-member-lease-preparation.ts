import type { DeviceCredential } from '../../src/types.js'
import { credentialSeal } from '../../src/seal.js'
import type { DeviceStore } from './device-store.js'
import { OWN_CREDENTIAL_PREFIX } from './device-store.js'
import { OrdinaryStateHold, type OrdinaryImage } from './ordinary-state-codec.js'
import { ordinaryPairReadCustodyFor, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import { readPersistentAdmissionProof, persistentProofName, persistentTabProofName, tabProofBytes, accountPrefix, inspectPersistentAdmissionProofs, PERSISTENT_TAB_PROOF_V2_PREFIX,
  type VerifiedPersistentProof } from './persistent-admission-proof.js'
import { ordinaryMemberLeaseSource, ordinaryMemberLeaseName, ordinaryMemberLeaseCredential, makeOrdinaryMemberLeaseHeader,
  readOrdinaryMemberLease, memberLeaseDigest, type OrdinaryMemberAuthority, type OrdinaryMemberLeaseHeaderBody, type OrdinaryMemberLeaseSource } from './ordinary-member-lease.js'

import { readOrdinaryRenewalRequest } from './ordinary-renewal-request.js'

function hold(): never { throw new OrdinaryStateHold() }
const records = (store: DeviceStore) => new Map(store.keys().map(name => [name, store.get(name)!]))
/** Pure, native-input preparation only. No entropy, signer invocation or write
 * runs here. A producer still owes pre-entropy capacity, exact-image CAS, ACK
 * reconciliation and the guarded Session handoff before enabling renewal. */
export function makeOrdinaryMemberLease(browser: DeviceStore, tab: DeviceStore, token: OrdinaryPairCustody,
  input: { readonly predecessorProof: string; readonly currentProof: string; readonly identity?: OrdinaryForegroundSigner }): string {
  const predecessor = readPersistentAdmissionProof(input.predecessorProof)
  const b = records(browser), t = records(tab)
  try {
    const old = predecessor.proof, name = ordinaryMemberLeaseName(old.binding), priorRaw = tab.get(name)
    const headers = ordinaryPairReadCustodyFor(token, b, t)
    validateOrdinarySnapshot(b, t, { browser: true, tab: true }, captureOrdinarySnapshotContext(b, t, token))
    if (old.version !== 2 || tab.get(persistentTabProofName(old.binding)) !== tabProofBytes(old) ||
        old.kept.enabled && browser.get(persistentProofName(old.binding)) !== input.predecessorProof ||
        !old.kept.enabled && browser.get(name) !== null || old.kept.enabled && browser.get(name) !== priorRaw ||
        old.binding.browser.generation !== headers.browser.generation || old.binding.tab.generation !== headers.tab.generation ||
        old.binding.tab.purpose !== headers.tab.purpose || old.binding.tab.expiresAt !== headers.tab.expiresAt ||
        old.binding.browser.fence !== (headers.browser.fences.get(old.binding.browser.name) ?? 0) ||
        old.binding.tab.fence !== (headers.tab.fences.get(old.binding.tab.name) ?? 0)) hold()
    let foregroundExpiresAt: number | null = null
    if (old.binding.account !== null) {
      if (!input.identity || input.identity.pubkey !== old.binding.account) hold()
      foregroundExpiresAt = OrdinaryForegroundSigner.nativeDeadline(input.identity, browser, tab, token, old.binding.account)
    } else if (input.identity !== undefined) hold()
    // Repeat after current SDK selectors, which may synchronously revoke.
    const source = ordinaryMemberLeaseSource(browser, tab, token)
    const immutable: OrdinaryMemberAuthority = { tabExpiresAt: headers.tab.expiresAt, admissionEndsAt: old.selection.endsAt,
      foregroundExpiresAt, membershipEndsAt: null }
    const selected = (old.kept.enabled ? browser : tab).get(accountPrefix(old.binding.participant) + OWN_CREDENTIAL_PREFIX + old.binding.roomId)
    if (selected === null) hold()
    const oldCredential = JSON.parse(selected) as DeviceCredential
    ordinaryMemberLeaseCredential(old, oldCredential.id)
    return deriveLease(input.predecessorProof,input.currentProof,priorRaw,immutable,source)
  } finally { b.clear(); t.clear(); predecessor.admission.secret.fill(0) }
}

/** Pure shared lineage bytes. Live authority acquisition remains in the
 * native-custody producer above; this function grants no custody or effects. */
function deriveLease(predecessorProof:string,currentProof:string,priorRaw:string|null,
  immutable:OrdinaryMemberAuthority,source:OrdinaryMemberLeaseSource):string{
  const predecessor=readPersistentAdmissionProof(predecessorProof)
  let current:VerifiedPersistentProof|undefined
  try{
    current=readPersistentAdmissionProof(currentProof)
    const old=predecessor.proof,oldCredential=ordinaryMemberLeaseCredential(old,old.binding.device.credentialIds[0]!)
    const prior=priorRaw===null?undefined:readOrdinaryMemberLease(priorRaw,predecessorProof)
    if(prior&&(prior.header.credential!==oldCredential.id||JSON.stringify(prior.header.authority)!==JSON.stringify(immutable)))hold()
    const priorBody:OrdinaryMemberLeaseHeaderBody={sequence:0,bootstrap:old.binding.operation,predecessor:null,proof:old.binding.operation,
      credential:oldCredential.id,seal:credentialSeal(oldCredential)!,issuedAt:oldCredential.created_at,
      expiresAt:Number(oldCredential.tags[2]![1]),authority:immutable,source}
    const previous=prior?.header??makeOrdinaryMemberLeaseHeader(priorBody),oldEvents=new Set(old.binding.device.credentials)
    const next=current.proof.binding.device.credentials.filter(raw=>!oldEvents.has(raw)).map(raw=>JSON.parse(raw) as DeviceCredential)
    if(next.length!==1||!Number.isSafeInteger(previous.sequence+1))hold()
    const event=next[0]!,body:OrdinaryMemberLeaseHeaderBody={sequence:previous.sequence+1,bootstrap:previous.bootstrap,predecessor:previous.operation,
      proof:current.proof.binding.operation,credential:event.id,seal:credentialSeal(event)!,issuedAt:event.created_at,
      expiresAt:Number(event.tags.find(tag=>tag[0]==='expiration')?.[1]),authority:immutable,source}
    const raw=JSON.stringify({version:1,domain:'kithmoot/member-lease/v1',header:makeOrdinaryMemberLeaseHeader(body),
      bootstrapProof:prior?.bootstrapProof??predecessorProof,predecessorProof,predecessorHeader:previous})
    readOrdinaryMemberLease(raw,currentProof)
    return raw
  }finally{predecessor.admission.secret.fill(0);current?.admission.secret.fill(0)}
}
/** @internal Pure historical lease projection from the owner's inverse P.
 * Native authentication, complete meaning and exact retained-result checks
 * remain owed by the fixed startup producer. No PairReadCU is fabricated. */
export function makeOrdinaryRetainedRenewalLease(images:readonly [OrdinaryImage,OrdinaryImage],currentProof:string,requestRaw:string):string{
  const request=readOrdinaryRenewalRequest(requestRaw),intent=request.intent,prefix=accountPrefix(intent.participant)
  const b=images[0].records,t=images[1].records
  for(const[i,image]of images.entries()){
    const source=request.sources[i]!
    if(image.purpose!==source.purpose||image.keyId!==source.keyId||image.generation!==source.generation||image.expiresAt!==source.expiresAt||image.revision!==source.revision)hold()
  }
  const readonly=(map:ReadonlyMap<string,string>):DeviceStore=>({keys:()=>[...map.keys()],get:n=>map.get(n)??null,set:hold,remove:hold})
  const selected=inspectPersistentAdmissionProofs(readonly(b),readonly(t))
  try{
    const found=selected.selected.get(prefix+PERSISTENT_TAB_PROOF_V2_PREFIX+intent.invitationId)
    if(!found)hold()
    return historicalFromProof(JSON.stringify(found.proof))
  }finally{selected.close()}
  function historicalFromProof(predecessorProof:string):string{
    const checked=readPersistentAdmissionProof(predecessorProof)
    try{
      const old=checked.proof,bound=old.binding,name=ordinaryMemberLeaseName(bound),prior=t.get(name)??null
      if(bound.operation!==intent.proof||bound.participant!==intent.participant||bound.account!==intent.account||bound.invitationId!==intent.invitationId||
        bound.roomId!==intent.roomId||old.kept.enabled!==intent.keep||bound.device.pubkey!==intent.device||bound.device.epoch!==intent.epoch||
        bound.device.epochs.find(epoch=>epoch.epoch===intent.epoch)?.id!==intent.epochId||bound.device.credentialIds.length!==1||bound.device.credentialIds[0]!==intent.credential||
        t.get(persistentTabProofName(bound))!==tabProofBytes(old)||intent.keep&&b.get(persistentProofName(bound))!==predecessorProof||
        !intent.keep&&b.has(name)||intent.keep&&(b.get(name)??null)!==prior)hold()
      if((intent.keep?b:t).get(prefix+OWN_CREDENTIAL_PREFIX+intent.roomId)!==JSON.stringify(ordinaryMemberLeaseCredential(old,intent.credential)))hold()
      const sorted=(map:ReadonlyMap<string,unknown>)=>[...map].sort(([a],[b])=>a<b?-1:a>b?1:0)
      const sourceImage=(image:OrdinaryImage)=>[image.purpose,image.expiresAt,image.generation,image.revision,sorted(image.fences),sorted(image.records)]
      const source={browserRevision:images[0].revision,tabRevision:images[1].revision,
        hash:memberLeaseDigest(['kithmoot/member-lease/v1/source',1,sourceImage(images[0]),sourceImage(images[1])])}
      const raw=deriveLease(predecessorProof,currentProof,prior,intent.authority,source),lease=readOrdinaryMemberLease(raw,currentProof)
      if(lease.predecessorHeader.operation!==intent.predecessor||lease.predecessorHeader.sequence!==intent.leaseSequence||lease.predecessorHeader.bootstrap!==intent.bootstrap||
        lease.header.issuedAt!==intent.issuedAt||lease.header.expiresAt!==intent.expiresAt)hold()
      return raw
    }finally{checked.admission.secret.fill(0)}
  }
}
