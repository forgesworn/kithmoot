import { describe,it,expect,vi } from 'vitest'
import { getPublicKey,finalizeEvent,verifiedSymbol } from 'nostr-tools/pure'
import { createLocalSignerFromNsec,SIGNET_VERIFIED_EVENT_SYMBOL } from 'signet-login'
import { nip19 } from 'nostr-tools'
import { createDeviceCredential } from '../../src/credential.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { encodeOrdinaryRenewalRequest,type OrdinaryRenewalRequest } from './ordinary-renewal-request.js'
import { ordinaryRenewalStatement,ordinaryRenewalResult,ordinaryRenewalResultForStatement,ORDINARY_RENEWAL_RESULT_BYTES } from './ordinary-renewal-credential.js'
const actor=new Uint8Array(32).fill(7),seal=new Uint8Array(32).fill(17),participant=getPublicKey(actor),device=getPublicKey(new Uint8Array(32).fill(9)),tab=('tab:'+'3'.repeat(64)) as `tab:${string}`
function request(){
 const hex='4'.repeat(64),scope='invitation:'+participant+':'+hex
 const value:OrdinaryRenewalRequest={version:1,domain:'kithmoot/member-renewal/request/v1',credentialFormat:1,
  intent:{account:participant,participant,invitationId:hex,roomId:hex,keep:true,device,credential:hex,proof:hex,bootstrap:hex,predecessor:hex,leaseSequence:0,epoch:0,epochId:hex,linkDigest:hex,issuedAt:100,expiresAt:200,
   authority:{tabExpiresAt:600000,admissionEndsAt:400,foregroundExpiresAt:500000,membershipEndsAt:null},semanticDigest:hex,sourceRevisions:[0,0],sourceFrames:[hex,hex],previousControlDigest:null,previousMarkers:[null,null]},
  sources:[{purpose:'browser',keyId:hex,generation:hex,revision:0,expiresAt:0},{purpose:tab,keyId:hex,generation:hex,revision:0,expiresAt:600000}],
  scopes:[['browser',scope,hex,0],[tab,scope,hex,0]],fences:[['browser',scope,false,null,0],[tab,scope,false,null,0]],previous:null}
 return encodeOrdinaryRenewalRequest(value)
}
async function signed(){return JSON.parse(JSON.stringify(finalizeEvent(JSON.parse(JSON.stringify(await ordinaryRenewalStatement(request(),seal))),actor)))}
describe('fixed renewal credential data, never signer authority',()=>{
 it('accepts a genuine separately installed SDK LocalSigner and captures its result synchronously',async()=>{
  const signer=createLocalSignerFromNsec(nip19.nsecEncode(actor)),statement=await ordinaryRenewalStatement(request(),seal)
  try{
   const event=await signer.signEvent(statement),before=JSON.stringify(event)
   expect(SIGNET_VERIFIED_EVENT_SYMBOL).not.toBe(verifiedSymbol)
   expect(Object.getOwnPropertySymbols(event)).toEqual([SIGNET_VERIFIED_EVENT_SYMBOL])
   const result=ordinaryRenewalResultForStatement(request(),statement,event)
   expect(JSON.parse(result)).toEqual(JSON.parse(before));expect(JSON.stringify(event)).toBe(before)
   event.sig='0'.repeat(128)
   expect(()=>ordinaryRenewalResultForStatement(request(),statement,event)).toThrow(OrdinaryStateHold)
  }finally{await signer.close()}
 })
 it('rejects two known but distinct verification cache identities',async()=>{
  const event=await signed();event[verifiedSymbol]=true;event[SIGNET_VERIFIED_EVENT_SYMBOL]=true
  await expect(ordinaryRenewalResult(request(),seal,event)).rejects.toThrow(OrdinaryStateHold)
 })
 it('accepts the actual SDK bunker class with a delayed SDK-local result',async()=>{
  const {BunkerSignerImpl}=await import('../../node_modules/signet-login/dist/signers.js')
  const local=createLocalSignerFromNsec(nip19.nsecEncode(actor)),statement=await ordinaryRenewalStatement(request(),seal)
  let release!:()=>void;const wait=new Promise<void>(yes=>{release=yes})
  const backend={signEvent:async(event:any)=>{await wait;return local.signEvent(event)},close:async()=>local.close()}
  const bunker=new BunkerSignerImpl(participant,backend as unknown as ConstructorParameters<typeof BunkerSignerImpl>[1],
   'bunker://'+participant+'?relay=wss://relay.invalid',new Uint8Array(32).fill(8))
  try{
   let done=false;const pending=bunker.signEvent(statement).then(event=>{done=true;return event})
   await Promise.resolve();expect(done).toBe(false);release()
   const event=await pending;expect(Object.getOwnPropertySymbols(event)).toEqual([SIGNET_VERIFIED_EVENT_SYMBOL])
   expect(JSON.parse(ordinaryRenewalResultForStatement(request(),statement,event))).toEqual(JSON.parse(JSON.stringify(event)))
  }finally{await bunker.close()}
 })
 it.each(['false','accessor'])('rejects SDK-local cache %s without invoking it',async field=>{
  const event=await signed(),getter=vi.fn(()=>true)
  Object.defineProperty(event,SIGNET_VERIFIED_EVENT_SYMBOL,field==='false'?{value:false}:{get:getter})
  await expect(ordinaryRenewalResult(request(),seal,event)).rejects.toThrow(OrdinaryStateHold)
  expect(getter).not.toHaveBeenCalled()
 })
 it.each(['tag-symbol','tag-property','tags-property','tag-accessor','tag-prototype'])('rejects hidden %s metadata without invoking it',async field=>{
  const event=await signed(),getter=vi.fn(()=>event.tags[0][0])
  if(field==='tag-symbol')event.tags[0][Symbol('cache')]=true
  if(field==='tag-property')event.tags[0].extra=true
  if(field==='tags-property')event.tags.extra=true
  if(field==='tag-accessor')Object.defineProperty(event.tags[0],'0',{enumerable:true,get:getter})
  if(field==='tag-prototype')Object.setPrototypeOf(event.tags[0],[])
  await expect(ordinaryRenewalResult(request(),seal,event)).rejects.toThrow(OrdinaryStateHold)
  expect(getter).not.toHaveBeenCalled()
 })
 it('derives the same statement as the pinned Fold-kit producer without provider or entropy',async()=>{
  const raw=request(),random=vi.spyOn(crypto,'getRandomValues'),before=seal.slice()
  try{
   const statement=await ordinaryRenewalStatement(raw,seal)
   expect(random).not.toHaveBeenCalled()
   const event=await createDeviceCredential({identity:{pubkey:participant,signEvent:async e=>finalizeEvent(e,actor)},roomId:'4'.repeat(64),devicePubkey:device,expiresAt:200,seal:getPublicKey(seal),now:()=>100})
   expect(statement).toEqual({kind:event.kind,created_at:event.created_at,tags:event.tags,content:event.content})
   expect(seal).toEqual(before);expect(Object.isFrozen(statement.tags[0])).toBe(true)
  }finally{random.mockRestore()}
 })
 it('retains one bounded canonical exact result regardless of incoming field order',async()=>{
  const e=await signed(),a=await ordinaryRenewalResult(request(),seal,e),b=await ordinaryRenewalResult(request(),seal,Object.fromEntries(Object.entries(e).reverse()) as any)
  expect(a).toBe(b);expect(JSON.parse(a)).toEqual(e);expect(new TextEncoder().encode(a).length).toBeLessThanOrEqual(ORDINARY_RENEWAL_RESULT_BYTES)
 })
 it('ignores the standard local verification cache and always verifies the exact result again',async()=>{
  const e=finalizeEvent(JSON.parse(JSON.stringify(await ordinaryRenewalStatement(request(),seal))),actor),raw=await ordinaryRenewalResult(request(),seal,e)
  expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(e)))
  e.sig='0'.repeat(128);e[verifiedSymbol]=true
  await expect(ordinaryRenewalResult(request(),seal,e)).rejects.toThrow(OrdinaryStateHold)
 })
 it.each(['false','accessor','lookalike','second'])('rejects nonstandard verification cache %s without mutating the input',async field=>{
  const e=await signed(),before=JSON.stringify(e),getter=vi.fn(()=>true)
  if(field==='false')Object.defineProperty(e,verifiedSymbol,{value:false})
  if(field==='accessor')Object.defineProperty(e,verifiedSymbol,{get:getter})
  if(field==='lookalike')e[Symbol(verifiedSymbol.description)]=true
  if(field==='second'){e[verifiedSymbol]=true;e[Symbol('other')]=true}
  await expect(ordinaryRenewalResult(request(),seal,e)).rejects.toThrow(OrdinaryStateHold)
  expect(JSON.stringify(e)).toBe(before);expect(getter).not.toHaveBeenCalled()
 })
 it.each(['restamp','device','room','expiry','seal','content','kind','actor','id','signature','extra','symbol','accessor','prototype'])('refuses %s even if its terms are signed',async field=>{
  let e=await signed()
  if(['restamp','device','room','expiry','seal','content','kind','actor'].includes(field)){
   const s=await ordinaryRenewalStatement(request(),seal),u=JSON.parse(JSON.stringify(s))
   if(field==='restamp')u.created_at++
   if(field==='device')u.tags[1][1]=participant
   if(field==='room')u.tags[0][1]='5'.repeat(64)
   if(field==='expiry')u.tags[2][1]='201'
   if(field==='seal')u.tags[3][1]=device
   if(field==='content')u.content='changed'
   if(field==='kind')u.kind=1
   e=JSON.parse(JSON.stringify(finalizeEvent(u,field==='actor'?new Uint8Array(32).fill(8):actor)))
  }
  if(field==='id')e.id='0'.repeat(64)
  if(field==='signature')e.sig='0'.repeat(128)
  if(field==='extra')e.extra=true
  if(field==='symbol')e[Symbol('provider-cache')]=true
  let getter=vi.fn(()=>e.kind)
  if(field==='accessor')Object.defineProperty(e,'kind',{enumerable:true,get:getter})
  if(field==='prototype')Object.setPrototypeOf(e,{})
  await expect(ordinaryRenewalResult(request(),seal,e)).rejects.toThrow(OrdinaryStateHold)
  expect(getter).not.toHaveBeenCalled()
 })
 it.each([new Uint8Array(0),new Uint8Array(31),new Uint8Array(33),new Uint8Array(32)])('rejects invalid retained seal material',async key=>{
  await expect(ordinaryRenewalStatement(request(),key)).rejects.toThrow(OrdinaryStateHold)
 })
})
