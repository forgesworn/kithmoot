import { base64 } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils'
import { deriveRoom } from '../../src/room.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { Event } from 'nostr-tools/pure'
import { ROOM_PREFIX } from './rooms-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { validateOrdinaryRoomAccessSnapshot, type OrdinaryRoomAccessSnapshot } from './ordinary-room-access-snapshot.js'

const PREFIX='kithmoot.bookmarks.', APP='kithmoot.rooms.v1'
// Exact randomUUID writer format. Its shape cannot prove actual randomness.
const HEX=/^[0-9a-f]{64}$/, ADDRESS=/^kithmoot\.rooms\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function hold():never { throw new OrdinaryStateHold() }
function object(value:unknown,required:readonly string[],optional:readonly string[]=[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||
    required.some(name=>!Object.hasOwn(value,name))||Reflect.ownKeys(value).some(name=>typeof name!=='string'||!required.includes(name)&&!optional.includes(name)))hold()
}
function integer(value:unknown):value is number { return Number.isSafeInteger(value)&&(value as number)>=0 }
function hex(value:unknown):asserts value is string { if(typeof value!=='string'||!HEX.test(value))hold() }
function parsed(raw:string):unknown { try{return JSON.parse(raw)}catch{return hold()} }
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}'
  return JSON.stringify(value)
}
export interface OrdinaryBookmarkSnapshot {
  readonly access:OrdinaryRoomAccessSnapshot
  readonly bookmarks:readonly {readonly account:string;readonly roomId:string;readonly record:boolean;readonly pending:boolean;readonly removed:boolean}[]
}
/** Offline custody checks only. A signed ciphertext authenticates its exact
 * event and address/account, never the separately cached plaintext. Restoration
 * still needs the account signer to decrypt and compare it before effects.
 * No expiry pruning, relay repair, signing or publication occurs here. */
export function validateOrdinaryRoomBookmarkSnapshot(records:ReadonlyMap<string,string>,migrated:boolean,
  options:{kind:'browser'|'tab';links?:readonly string[]}):OrdinaryBookmarkSnapshot {
  const links:{roomId:string;link:string}[]=[],bookmarks:{account:string;roomId:string;record:boolean;pending:boolean;removed:boolean}[]=[]
  const addresses=new Map<string,string>(),ids=new Map<string,string>(),events=new Map<string,{scope:string;d:string;value:string}>()
  const claimId=(id:string,scope:string)=>{
    const prior=ids.get(id);if(prior!==undefined&&prior!==scope)hold();ids.set(id,scope)
  }
  const claimAddress=(raw:unknown,scope:string):string=>{
    if(typeof raw!=='string'||!ADDRESS.test(raw))hold()
    const prior=addresses.get(raw);if(prior!==undefined&&prior!==scope)hold();addresses.set(raw,scope);return raw
  }
  const value=(raw:unknown,roomId:string):Record<string,unknown>=>{
    object(raw,['roomId','at'],['room','admission'])
    if(raw.roomId!==roomId||!integer(raw.at))hold()
    if(Object.hasOwn(raw,'room')){
      object(raw.room,['roomId','link','openedAt','readAt'],['readIds','name','keep','endedAt','endsAt','destruct','startsAt'])
      if(raw.room.roomId!==roomId)hold()
      const {roomId:_,...metadata}=raw.room
      // Reuse exact retained-link/room checks, not the permissive cache loader.
      validateOrdinaryRoomAccessSnapshot(new Map([[ROOM_PREFIX+roomId,JSON.stringify(metadata)]]),false,{kind:'browser'})
      links.push({roomId,link:raw.room.link as string})
    }
    if(Object.hasOwn(raw,'admission')){
      if(!Object.hasOwn(raw,'room'))hold()
      object(raw.admission,['secret']);hex(raw.admission.secret)
      const secret=hexToBytes(raw.admission.secret);let key:Uint8Array|undefined
      try{const derived=deriveRoom(secret);key=derived.roomKey;if(derived.roomId!==roomId)hold()}finally{secret.fill(0);key?.fill(0)}
    }
    return raw
  }
  const event=(raw:unknown,account:string,roomId:string,d:string,stored:Record<string,unknown>,id?:string)=>{
    object(raw,['id','pubkey','kind','created_at','tags','content','sig'])
    hex(raw.id);hex(raw.pubkey)
    if(raw.pubkey!==account||raw.kind!==30078||!integer(raw.created_at)||raw.created_at!==Math.floor((stored.at as number)/1000)||
      id!==undefined&&raw.id!==id||typeof raw.sig!=='string'||!/^[0-9a-f]{128}$/.test(raw.sig)||
      typeof raw.content!=='string'||raw.content.length<132||raw.content.length>60_000||!Array.isArray(raw.tags)||raw.tags.length!==2||
      raw.tags.some(tag=>!Array.isArray(tag)||tag.length!==2||typeof tag[0]!=='string'||typeof tag[1]!=='string')||
      raw.tags.filter(tag=>tag[0]==='d'&&tag[1]===d).length!==1||raw.tags.filter(tag=>tag[0]==='l'&&tag[1]===APP).length!==1)hold()
    if(!verifyEventUncached(raw as unknown as Event))hold()
    // NIP-44 v2 envelope only. No MAC or plaintext assertion without signer.
    let bytes:Uint8Array|undefined
    try{bytes=base64.decode(raw.content);if(bytes.length<99||bytes[0]!==2||base64.encode(bytes)!==raw.content)hold()}
    catch{return hold()}finally{bytes?.fill(0)}
    const scope=account+':'+roomId,encoded=canonical(stored),prior=events.get(raw.id)
    claimId(raw.id,scope)
    if(prior&&(prior.scope!==scope||prior.d!==d||prior.value!==encoded))hold()
    events.set(raw.id,{scope,d,value:encoded})
  }
  try{
    for(const [physical,raw]of records){
      let name=physical
      if(name.startsWith('kithmoot.account.')){
        const scoped=/^kithmoot\.account\.[0-9a-f]{64}\.(.+)$/.exec(name)
        if(!scoped)hold();name=scoped[1]!
        if(name.startsWith(PREFIX))hold() // Existing bookmark key already includes its account.
      }
      if(!name.startsWith(PREFIX))continue
      if(options.kind!=='browser')hold()
      const match=/^kithmoot\.bookmarks\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(name)
      if(!match)hold()
      const account=match[1]!,roomId=match[2]!,scope=account+':'+roomId,saved=parsed(raw)
      object(saved,[],['record','pending'])
      if(!Object.hasOwn(saved,'record')&&!Object.hasOwn(saved,'pending'))hold()
      let recordValue:Record<string,unknown>|undefined,recordId:string|undefined,recordD:string|undefined
      if(Object.hasOwn(saved,'record')){
        object(saved.record,['roomId','at','d','id'],['room','admission','event'])
        const {d,id,event:signed,...plain}=saved.record;recordValue=value(plain,roomId);hex(id);recordId=id;claimId(id,scope);recordD=claimAddress(d,scope)
        if(Object.hasOwn(saved.record,'event'))event(signed,account,roomId,recordD,recordValue,recordId)
      }
      if(Object.hasOwn(saved,'pending')){
        object(saved.pending,['value','d'],['event'])
        const plain=value(saved.pending.value,roomId),d=claimAddress(saved.pending.d,scope)
        if(Object.hasOwn(saved.pending,'event')){
          event(saved.pending.event,account,roomId,d,plain)
          const id=(saved.pending.event as Record<string,unknown>).id
          if(id===recordId&&(d!==recordD||canonical(plain)!==canonical(recordValue)))hold()
        }
      }
      const current=Object.hasOwn(saved,'pending')?(saved.pending as Record<string,unknown>).value:recordValue
      bookmarks.push(Object.freeze({account,roomId,record:Object.hasOwn(saved,'record'),pending:Object.hasOwn(saved,'pending'),removed:!Object.hasOwn(current as object,'room')}))
    }
    const access=validateOrdinaryRoomAccessSnapshot(records,migrated,{...options,retainedRooms:links})
    bookmarks.sort((a,b)=>a.account.localeCompare(b.account)||a.roomId.localeCompare(b.roomId))
    return Object.freeze({access,bookmarks:Object.freeze(bookmarks)})
  }finally{links.length=0;addresses.clear();ids.clear();events.clear()}
}
