export * from './ordinary-state.browser-entry.js'
import { captureOrdinaryStartupContext, validateOrdinaryRoomAccessAndBookmarksSnapshot } from '../app/src/ordinary-room-access-snapshot.js'
export { base64urlnopad } from '@scure/base'

import { getPublicKey } from 'nostr-tools/pure'
import { roomInvitation,deriveInvitationId,encodeInvitationGrant,decodeRoomAdmissionGrant } from '../src/invitation.js'
import { deriveRoom } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { memoryDeviceStore,storeKeptAdmission,KEPT_ADMISSION_PREFIX } from '../app/src/device-store.js'
import { storeInvitationOwner } from '../app/src/invitation-store.js'
import { rememberRoom,ROOM_PREFIX } from '../app/src/rooms-store.js'

// Test-only source fixtures use the real writers and real verified grant path.
export function roomAccessFixture(options:{persistent?:boolean;owner?:boolean;tab?:boolean;rootSeed?:number;inviterSeed?:number;requesterSeed?:number;bearerSeed?:number}={}) {
  const key=(n:number)=>{const bytes=new Uint8Array(32);bytes[31]=n;return bytes}
  const root=new Uint8Array(32).fill(options.rootSeed??5),roomId=deriveRoom(root).roomId,inviter=key(options.inviterSeed??1),requester=key(options.requesterSeed??2)
  const invitation=roomInvitation(new Uint8Array(32).fill(options.bearerSeed??7),getPublicKey(inviter),options.persistent),id=deriveInvitationId(invitation)
  const url=encodeRoomLink('https://ordinary-room-access.kithmoot.test/j/',{invitation,relays:['wss://relay.example'],iceUrls:[],name:'Bench'})
  const store=memoryDeviceStore();rememberRoom(store,{roomId,link:url,openedAt:100})
  if(options.owner)storeInvitationOwner(store,invitation,root,inviter,100)
  else {
    const grant=encodeInvitationGrant({invitation,inviterSk:inviter,requester:getPublicKey(requester),request:'a'.repeat(64),roomSecret:root,now:100,epoch:2,delegationTtlSeconds:30})
    const admission=decodeRoomAdmissionGrant(grant,{invitation,requesterSk:requester,request:'a'.repeat(64),now:100})!
    storeKeptAdmission(store,id,options.persistent?{secret:root,persistent:true,epoch:0}:admission,100)
  }
  const records=new Map(store.keys().map(name=>[name,store.get(name)!]))
  if(options.tab){
    const value=JSON.parse(records.get(KEPT_ADMISSION_PREFIX+id)!);delete value.createdAt;records.clear()
    records.set('kithmoot.admission.v1.'+id,JSON.stringify(value))
    records.set('kithmoot.way-back',JSON.stringify({link:url,name:'Bench'}))
    records.set('kithmoot.room-switch.v1',JSON.stringify({hash:new URL(url).hash,account:null,at:1000}))
  }
  return {records,id,url,roomId,roomName:ROOM_PREFIX+roomId}
}

// Test-only component composition with the other owner explicitly empty. The
// actual production barrier and the other ordinary family bindings remain open.
export function validateOrdinaryRoomAccessSnapshot(records: ReadonlyMap<string, string>, migrated: boolean,
  options: { kind: 'browser' | 'tab' }) {
  const browser = options.kind === 'browser' ? records : new Map<string, string>()
  const tab = options.kind === 'tab' ? records : new Map<string, string>()
  const context = captureOrdinaryStartupContext(browser, tab)
  return validateOrdinaryRoomAccessAndBookmarksSnapshot(browser, tab, { browser: migrated, tab: migrated }, context).access
}
