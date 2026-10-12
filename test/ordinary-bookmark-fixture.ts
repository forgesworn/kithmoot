import { finalizeEvent,getPublicKey,type Event } from 'nostr-tools/pure'
import { encrypt,decrypt,getConversationKey } from 'nostr-tools/nip44'
import { bytesToHex } from '@noble/hashes/utils'
import type { SignetSigner } from 'signet-login'
import { deriveRoom } from '../src/room.js'
import { roomInvitation } from '../src/invitation.js'
import { encodeRoomLink } from '../src/link.js'
import type { RelayTransport } from '../src/relay-pool.js'
import { memoryDeviceStore } from '../app/src/device-store.js'
import { RoomBookmarks } from '../app/src/room-bookmarks.js'

export type BookmarkFixtureMode='signed'|'older'|'unsigned-pending'|'signed-pending'|'record-pending'|'tombstone'|'pending-tombstone'
/** Real bookmark writer, real NIP-44 and signature; the relay is offline. */
export async function bookmarkFixture(mode:BookmarkFixtureMode='signed',options:{rootSeed?:number;accountSeed?:number;bearerSeed?:number}={}){
  const key=new Uint8Array(32);key[31]=options.accountSeed??4
  const inviter=new Uint8Array(32);inviter[31]=1
  const secret=new Uint8Array(32).fill(options.rootSeed??5),roomId=deriveRoom(secret).roomId,account=getPublicKey(key)
  const invitation=roomInvitation(new Uint8Array(32).fill(options.bearerSeed??7),getPublicKey(inviter),true)
  const link=encodeRoomLink('https://ordinary-bookmark.kithmoot.test/j/',{invitation,relays:['wss://relay.example'],iceUrls:[],name:'Library'})
  const room={roomId,link,name:'Library',openedAt:100,readAt:0},store=memoryDeviceStore(),published:Event[]=[]
  let deny=mode==='unsigned-pending',fail=mode==='signed-pending',resolveReport:()=>void=()=>{}
  const signer:SignetSigner={pubkey:account,method:'nip07',capabilities:{canSignEvents:true,hasNip44:true},close:async()=>{},
    signEvent:async template=>{
      if(deny)throw new Error('test signer refusal')
      if(template.tags===undefined||template.created_at===undefined)throw new Error('test requires explicit bookmark event fields')
      return finalizeEvent({...template,tags:template.tags,created_at:template.created_at},key)
    },
    nip44:{encrypt:async(peer,plain)=>encrypt(plain,getConversationKey(key,peer)),decrypt:async(peer,cipher)=>decrypt(cipher,getConversationKey(key,peer))}}
  const relay:RelayTransport={publish:async event=>{published.push(event);if(fail)throw new Error('test acknowledgement uncertainty')},subscribe:()=>()=>{},close:()=>{}}
  const library=new RoomBookmarks(store,signer,relay,()=>{},message=>{
    if(message.startsWith('Saved in this browser,')||message.startsWith('Room bookmarks accepted'))resolveReport()
  },{current:()=>bytesToHex(secret),adopt:()=>{}})
  const perform=async(action:()=>void)=>{const report=new Promise<void>(resolve=>{resolveReport=resolve});action();await report}
  try{
    await perform(()=>library.save(room))
    if(['record-pending','tombstone','pending-tombstone'].includes(mode)){
      deny=false;fail=mode!=='tombstone'
      await perform(()=>mode==='record-pending'?library.save({...room,name:'Revised library'}):library.remove(roomId))
    }
    const name='kithmoot.bookmarks.'+account+'.'+roomId
    if(mode==='older'){const saved=JSON.parse(store.get(name)!);delete saved.record.event;store.set(name,JSON.stringify(saved))}
    return {records:new Map(store.keys().map(name=>[name,store.get(name)!])),name,roomId,account,url:link,secret:bytesToHex(secret),published,
      sign:(template:Parameters<typeof finalizeEvent>[0])=>finalizeEvent(template,key)}
  }finally{library.close()}
}
