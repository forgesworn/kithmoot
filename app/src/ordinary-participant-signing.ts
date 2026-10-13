import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import type { UnsignedEvent } from '../../src/identity.js'
import type { DeviceStore } from './device-store.js'
import { captureOrdinarySigningStatement } from './ordinary-foreground-signer.js'
import { ordinaryPairReadCustodyFor, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { verifyEventUncached } from '../../src/verify.js'
import { KINDS } from '../../src/kinds.js'

/** Internal visitor signing within an already-authorised native pair callback.
 * The caller checks its owner/scope/selection binding in this same callback.
 * A consent identity's external signEvent function is never invoked. Only the
 * authentic native participant key matching its selected pubkey can sign. */
function signParticipant(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody,
  participant:string,input:UnsignedEvent):Event {
  const unsigned=captureOrdinarySigningStatement(input)
  const b=new Map(browser.keys().map(n=>[n,browser.get(n)!])),t=new Map(tab.keys().map(n=>[n,tab.get(n)!]))
  let key:Uint8Array|undefined
  try{
    ordinaryPairReadCustodyFor(custody,b,t)
    validateOrdinarySnapshot(b,t,{browser:true,tab:true},captureOrdinarySnapshotContext(b,t,custody))
    const raw=b.get('kithmoot.participant')
    if(typeof participant!=='string'||!/^[0-9a-f]{64}$/.test(participant)||!raw||!/^[0-9a-f]{64}$/.test(raw))throw new OrdinaryStateHold()
    key=hexToBytes(raw)
    if(getPublicKey(key)!==participant)throw new OrdinaryStateHold()
    // No await, external callback or mutable signer receiver between the
    // actual key check and local signing. These owned bytes never escape.
    const expected=JSON.stringify(unsigned),signed=finalizeEvent(unsigned,key)
    if(signed.pubkey!==participant||JSON.stringify(captureOrdinarySigningStatement(signed))!==expected||!verifyEventUncached(signed))throw new OrdinaryStateHold()
    return Object.freeze({...signed,tags:Object.freeze(signed.tags.map(tag=>Object.freeze([...tag])))}) as unknown as Event
  }catch(error){throw error instanceof OrdinaryStateHold?error:new OrdinaryStateHold()}
  finally{key?.fill(0);b.clear();t.clear()}
}
export function signOrdinaryVisitorAuthentication(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody,
  binding:{account:string|null;participant:string;url:string;challenge:string;createdAt:number},input:UnsignedEvent):Event {
  const unsigned=captureOrdinarySigningStatement(input)
  if(binding.account!==null||unsigned.kind!==22242||unsigned.content!==''||unsigned.created_at!==binding.createdAt||
    !binding.challenge||binding.challenge.length>1024||JSON.stringify(unsigned.tags)!==JSON.stringify([['relay',binding.url],['challenge',binding.challenge]]))throw new OrdinaryStateHold()
  return signParticipant(browser,tab,custody,binding.participant,unsigned)
}
export function signOrdinaryVisitorCredential(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody,
  binding:{account:string|null;participant:string;roomId:string;devicePubkey:string;seal:string;expiresAt:number;createdAt:number},input:UnsignedEvent):Event {
  const unsigned=captureOrdinarySigningStatement(input)
  if(binding.account!==null||unsigned.kind!==KINDS.CREDENTIAL||unsigned.content!==''||unsigned.created_at!==binding.createdAt||
    ![binding.participant,binding.roomId,binding.devicePubkey,binding.seal].every(value=>/^[0-9a-f]{64}$/.test(value))||
    !Number.isSafeInteger(binding.expiresAt)||binding.expiresAt<=binding.createdAt||JSON.stringify(unsigned.tags)!==JSON.stringify([
      ['d',binding.roomId],['device',binding.devicePubkey],['expiration',String(binding.expiresAt)],['seal',binding.seal]]))throw new OrdinaryStateHold()
  return signParticipant(browser,tab,custody,binding.participant,unsigned)
}
