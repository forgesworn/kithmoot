import { captureOrdinaryNavigationContext } from './ordinary-navigation-snapshot.js'
import { describe, expect, it, vi } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'
import { getPublicKey } from 'nostr-tools/pure'
import { roomInvitation, deriveInvitationId, encodeInvitationGrant, decodeRoomAdmissionGrant } from '../../src/invitation.js'
import { encodeRoomLink } from '../../src/link.js'
import { deriveRoom } from '../../src/room.js'
import { memoryDeviceStore, storeKeptAdmission, KEPT_ADMISSION_PREFIX } from './device-store.js'
import { storeInvitationOwner, INVITATION_OWNER_PREFIX } from './invitation-store.js'
import { rememberRoom, ROOM_PREFIX } from './rooms-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { validateOrdinaryRoomAccessSnapshot as validate, captureOrdinaryStartupContext, validateOrdinaryRoomAccessAndBookmarksSnapshot } from './ordinary-room-access-snapshot.js'

const key=(n:number)=>{const bytes=new Uint8Array(32);bytes[31]=n;return bytes}
const ROOT=new Uint8Array(32).fill(5), ROOM=deriveRoom(ROOT).roomId, ACCOUNT=getPublicKey(key(4))
const BASE='https://rooms.kithmoot.test/j/', CACHE='kithmoot.admission.v1.'
function fixture(persistent=false,owner=false) {
  const inviter=key(1),requester=key(2),invitation=roomInvitation(new Uint8Array(32).fill(7),getPublicKey(inviter),persistent)
  const id=deriveInvitationId(invitation),url=encodeRoomLink(BASE,{invitation,relays:['wss://relay.example'],iceUrls:[],name:'Bench'})
  const store=memoryDeviceStore();rememberRoom(store,{roomId:ROOM,link:url,openedAt:100})
  const grant=encodeInvitationGrant({invitation,inviterSk:inviter,requester:getPublicKey(requester),request:'a'.repeat(64),roomSecret:ROOT,now:100,epoch:2,delegationTtlSeconds:30})
  const admission=decodeRoomAdmissionGrant(grant,{invitation,requesterSk:requester,request:'a'.repeat(64),now:100})!
  if(owner)storeInvitationOwner(store,invitation,ROOT,inviter,100)
  else storeKeptAdmission(store,id,persistent?{secret:ROOT,persistent:true,epoch:0}:admission,100)
  return {records:new Map(store.keys().map(name=>[name,store.get(name)!])),id,url,invitation,inviter,admission}
}
function startup(records: ReadonlyMap<string, string>, url: string, kind: 'browser' | 'tab' = 'browser') {
  vi.stubGlobal('location', { href: url })
  try {
    const browser = kind === 'browser' ? records : new Map<string, string>(), tab = kind === 'tab' ? records : new Map<string, string>()
    const context = captureOrdinaryStartupContext(browser, tab)
    return validateOrdinaryRoomAccessAndBookmarksSnapshot(browser, tab, { browser: false, tab: false }, context).access
  } finally { vi.unstubAllGlobals() }
}
const options={kind:'browser' as const}
describe('strict ordinary room/access snapshots',()=>{
  it.each([false,true])('preserves actual owner writer format with persistent=%s',persistent=>{
    const {records,id}=fixture(persistent,true),before=[...records],result=validate(records,false,options)
    expect(result.invitations).toEqual([{invitationId:id,roomId:ROOM,kind:'owner',persistent}]);expect([...records]).toEqual(before)
    expect(Object.isFrozen(result.invitations[0])).toBe(true)
  })
  it.each([false,true])('preserves actual kept writer format with persistent=%s, without expiry pruning',persistent=>{
    const {records,id}=fixture(persistent),before=[...records]
    expect(validate(records,false,options).invitations).toEqual([{invitationId:id,roomId:ROOM,kind:'kept',persistent}]);expect([...records]).toEqual(before)
  })
  it('accepts existing account-scoped room metadata before encrypted migration',()=>{
    const {records}=fixture();const raw=records.get(ROOM_PREFIX+ROOM)!;records.delete(ROOM_PREFIX+ROOM);records.set('kithmoot.account.'+ACCOUNT+'.'+ROOM_PREFIX+ROOM,raw)
    expect(validate(records,false,options).rooms).toEqual([{roomId:ROOM,account:ACCOUNT}])
  })
  it('checks legacy secret link derivation against the physical room namespace',()=>{
    const url=encodeRoomLink(BASE,{secret:ROOT,relays:[],iceUrls:[]}),records=new Map([[ROOM_PREFIX+ROOM,JSON.stringify({link:url,openedAt:100})]])
    expect(validate(records,false,options).rooms).toEqual([{roomId:ROOM}])
    const wrong=new Map([[ROOM_PREFIX+'a'.repeat(64),records.values().next().value!]])
    expect(()=>validate(wrong,false,options)).toThrow(OrdinaryStateHold)
  })
  it('requires a captured pinned link for creator records written before a room was listed',()=>{
    const {records,url}=fixture(false,true);records.delete(ROOM_PREFIX+ROOM)
    expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
    expect(startup(records,url).invitations[0]!.roomId).toBe(ROOM)
  })
  it('preserves an explicit group conversion beside an older meeting link',()=>{
    const {records,id,invitation,inviter}=fixture(false,true),store=memoryDeviceStore()
    storeInvitationOwner(store,{...invitation,persistent:true},ROOT,inviter,100,200,true)
    records.set(INVITATION_OWNER_PREFIX+id,store.get(INVITATION_OWNER_PREFIX+id)!)
    expect(validate(records,false,options).invitations[0]!.persistent).toBe(true)
  })
  it('never makes a retained meeting permanent merely because its link changed to v3',()=>{
    const {records,invitation}=fixture(false,true),url=encodeRoomLink(BASE,{invitation:{...invitation,persistent:true},relays:[],iceUrls:[]})
    records.set(ROOM_PREFIX+ROOM,JSON.stringify({link:url,openedAt:100,readAt:0}))
    expect(validate(records,false,options).invitations[0]!.persistent).toBe(false)
  })
  it('allows supported tab admission reload while forbidding relocation into browser custody',()=>{
    const {records,id,url}=fixture();const value=JSON.parse(records.get(KEPT_ADMISSION_PREFIX+id)!);delete value.createdAt
    const tab=new Map([[CACHE+id,JSON.stringify(value)],['kithmoot.way-back',JSON.stringify({link:url,name:'Bench'})],
      ['kithmoot.room-switch.v1',JSON.stringify({hash:new URL(url).hash,account:null,at:1000})]])
    expect(() => validate(tab,false,{kind:'tab'})).toThrow(OrdinaryStateHold)
    const navigation = captureOrdinaryNavigationContext(tab,{kind:'tab'})
    const rows = new Map([...tab].filter(([name]) => name !== 'kithmoot.room-switch.v1' && name !== 'kithmoot.way-back'))
    expect(validate(rows,false,{kind:'tab',navigation}).invitations[0]!.kind).toBe('tab')
    expect(()=>validate(tab,false,options)).toThrow(OrdinaryStateHold)
  })
  it.each(['room','owner','kept'] as const)('rejects browser %s records in tab custody even with a pinned link',family=>{
    const {records,id,url}=fixture(false,family==='owner')
    const physical=family==='room'?ROOM_PREFIX+ROOM:(family==='owner'?INVITATION_OWNER_PREFIX:KEPT_ADMISSION_PREFIX)+id
    expect(()=>startup(new Map([[physical,records.get(physical)!]]),url,'tab')).toThrow(OrdinaryStateHold)
  })
  it('binds two different room claims for the same invitation as a hold',()=>{
    const {records}=fixture();records.set(ROOM_PREFIX+'a'.repeat(64),records.get(ROOM_PREFIX+ROOM)!)
    expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
  })
  it('refuses an admission under a substituted invitation root',()=>{
    const {records,invitation}=fixture(),url=encodeRoomLink(BASE,{invitation:{...invitation,inviter:getPublicKey(key(3))},relays:[],iceUrls:[]})
    records.set(ROOM_PREFIX+ROOM,JSON.stringify({link:url,openedAt:100,readAt:0}))
    expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
  })
  it('refuses reuse of a creator key across two distinct invitation rendezvous',()=>{
    const {records,inviter}=fixture(false,true),other=roomInvitation(new Uint8Array(32).fill(8),getPublicKey(inviter)),store=memoryDeviceStore()
    storeInvitationOwner(store,other,ROOT,inviter,100);for(const name of store.keys())records.set(name,store.get(name)!)
    expect(()=>startup(records,encodeRoomLink(BASE,{invitation:other,relays:[],iceUrls:[]}))).toThrow(OrdinaryStateHold)
  })
  it('refuses a delegate key reused across distinct rooms even when both grant chains verify',()=>{
    const {records}=fixture(),root=new Uint8Array(32).fill(6),otherRoom=deriveRoom(root).roomId,inviter=key(3),requester=key(2)
    const other=roomInvitation(new Uint8Array(32).fill(8),getPublicKey(inviter)),grant=encodeInvitationGrant({invitation:other,inviterSk:inviter,requester:getPublicKey(requester),request:'b'.repeat(64),roomSecret:root,now:100})
    const admitted=decodeRoomAdmissionGrant(grant,{invitation:other,requesterSk:requester,request:'b'.repeat(64),now:100})!
    expect(admitted).not.toBeNull()
    const store=memoryDeviceStore();storeKeptAdmission(store,deriveInvitationId(other),admitted,100)
    rememberRoom(store,{roomId:otherRoom,link:encodeRoomLink(BASE,{invitation:other,relays:[],iceUrls:[]}),openedAt:100})
    for(const name of store.keys())records.set(name,store.get(name)!)
    expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
  })
  it.each([false,true])('rejects valid cross-role signing key reuse in either record order: reverse=%s',reverse=>{
    const {records,inviter}=fixture(false,true),root=new Uint8Array(32).fill(6),otherRoom=deriveRoom(root).roomId,otherInviter=key(3)
    const other=roomInvitation(new Uint8Array(32).fill(8),getPublicKey(otherInviter))
    const grant=encodeInvitationGrant({invitation:other,inviterSk:otherInviter,requester:getPublicKey(inviter),request:'b'.repeat(64),roomSecret:root,now:100})
    const admission=decodeRoomAdmissionGrant(grant,{invitation:other,requesterSk:inviter,request:'b'.repeat(64),now:100})!
    expect(admission).not.toBeNull()
    const store=memoryDeviceStore();storeKeptAdmission(store,deriveInvitationId(other),admission,100)
    rememberRoom(store,{roomId:otherRoom,link:encodeRoomLink(BASE,{invitation:other,relays:[],iceUrls:[]}),openedAt:100})
    for(const name of store.keys())records.set(name,store.get(name)!)
    expect(()=>validate(new Map(reverse?[...records].reverse():records),false,options)).toThrow(OrdinaryStateHold)
  })
  it('refuses simultaneous legacy and account-scoped secret custody for one invitation',()=>{
    const {records,id}=fixture(false,true),name=INVITATION_OWNER_PREFIX+id
    records.set('kithmoot.account.'+ACCOUNT+'.'+name,records.get(name)!)
    expect(()=>validate(records,true,options)).toThrow(OrdinaryStateHold)
  })
  it.each([false,true])('preserves same-invitation copies across encrypted account scopes, owner=%s',owner=>{
    const {records,id}=fixture(false,owner),name=(owner?INVITATION_OWNER_PREFIX:KEPT_ADMISSION_PREFIX)+id,raw=records.get(name)!
    records.delete(name)
    for(const account of [ACCOUNT,getPublicKey(key(9))])records.set('kithmoot.account.'+account+'.'+name,raw)
    expect(validate(records,true,options).invitations).toHaveLength(2)
  })
  it('preserves a delegate key reused for grants within the same room',()=>{
    const {records,url}=fixture(),inviter=key(3),requester=key(2),other=roomInvitation(new Uint8Array(32).fill(8),getPublicKey(inviter))
    const grant=encodeInvitationGrant({invitation:other,inviterSk:inviter,requester:getPublicKey(requester),request:'b'.repeat(64),roomSecret:ROOT,now:100})
    const admission=decodeRoomAdmissionGrant(grant,{invitation:other,requesterSk:requester,request:'b'.repeat(64),now:100})!
    expect(admission).not.toBeNull()
    const store=memoryDeviceStore();storeKeptAdmission(store,deriveInvitationId(other),admission,100)
    for(const name of store.keys())records.set(name,store.get(name)!)
    expect(startup(records,encodeRoomLink(BASE,{invitation:other,relays:[],iceUrls:[]})).invitations).toHaveLength(2)
  })
  it('preserves recognised restrictive access policy fields',()=>{
    const {records,url}=fixture(),payload=JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(url).hash.slice(1))))
    payload.a={tier:'kith',admitted:[ACCOUNT],agents:'owned-by-members',members:[ACCOUNT],quiet:true}
    records.set(ROOM_PREFIX+ROOM,JSON.stringify({link:BASE+'#'+base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload))),openedAt:100}))
    const before=[...records];expect(validate(records,false,options).invitations).toHaveLength(1);expect([...records]).toEqual(before)
  })
  it('requires captured evidence for every rotated owner rather than dropping the old key',()=>{
    const {records,url}=fixture(false,true),other=roomInvitation(new Uint8Array(32).fill(8),getPublicKey(key(3))),store=memoryDeviceStore()
    storeInvitationOwner(store,other,ROOT,key(3),100);for(const name of store.keys())records.set(name,store.get(name)!)
    const otherUrl=encodeRoomLink(BASE,{invitation:other,relays:[],iceUrls:[]})
    expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
    expect(startup(records,otherUrl).invitations).toHaveLength(2)
  })
  it.each(['json','extra','bad-time','bad-room','wrong-inviter','zero-inviter','temporary-end','false-persistent'] as const)
    ('holds %s owner corruption before permissive removal loaders',fault=>{
      const {records,id}=fixture(false,true),name=INVITATION_OWNER_PREFIX+id,value=JSON.parse(records.get(name)!)
      if(fault==='json')records.set(name,'{')
      if(fault==='extra')value.extra=true
      if(fault==='bad-time')value.createdAt=-1
      if(fault==='bad-room')value.roomSecret=bytesToHex(new Uint8Array(32).fill(6))
      if(fault==='wrong-inviter')value.inviterSk=bytesToHex(key(3))
      if(fault==='zero-inviter')value.inviterSk='0'.repeat(64)
      if(fault==='temporary-end')value.ends=200
      if(fault==='false-persistent')value.persistent=false
      if(fault!=='json')records.set(name,JSON.stringify(value))
      const before=[...records];expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold);expect([...records]).toEqual(before)
    })
  it.each(['signature','empty-chain','wrong-room','wrong-invitation','wrong-key','zero-key','expired-number','extra-certificate','false-persistent','group-epoch','group-delegate'] as const)
    ('holds %s delegated or persistent admission corruption',fault=>{
      const {records,id}=fixture(fault==='group-epoch'||fault==='group-delegate'),name=KEPT_ADMISSION_PREFIX+id,value=JSON.parse(records.get(name)!)
      if(fault==='signature')value.delegation[0].sig='0'.repeat(128)
      if(fault==='empty-chain')value.delegation=[]
      if(fault==='wrong-room')value.delegation[0].room='a'.repeat(64)
      if(fault==='wrong-invitation')value.delegation[0].invitation='a'.repeat(64)
      if(fault==='wrong-key')value.delegateSk=bytesToHex(key(3))
      if(fault==='zero-key')value.delegateSk='0'.repeat(64)
      if(fault==='expired-number')value.delegation[0].expiresAt=0
      if(fault==='extra-certificate')value.delegation[0].extra=true
      if(fault==='false-persistent')value.persistent=false
      if(fault==='group-epoch')value.epoch=2
      if(fault==='group-delegate')value.delegateSk=bytesToHex(key(3))
      records.set(name,JSON.stringify(value));expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
    })
  it("preserves a member's own link that names the room's authority (version 5)",()=>{
    const memberSk=key(9),invitation={...roomInvitation(new Uint8Array(32).fill(8),getPublicKey(memberSk)),authority:getPublicKey(key(1))}
    const url=encodeRoomLink(BASE,{invitation,relays:['wss://relay.example'],iceUrls:[]}),store=memoryDeviceStore()
    rememberRoom(store,{roomId:ROOM,link:url,openedAt:100});storeInvitationOwner(store,invitation,ROOT,memberSk,100)
    const records=new Map(store.keys().map(name=>[name,store.get(name)!]))
    expect(validate(records,false,options).invitations).toEqual([{invitationId:deriveInvitationId(invitation),roomId:ROOM,kind:'owner',persistent:false}])
  })
  it.each(['o-without-v5','v5-without-o'] as const)('holds a retained link whose authority field does not match its version (%s)',fault=>{
    const {records,url}=fixture(),payload=JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(url).hash.slice(1))))
    if(fault==='o-without-v5')payload.o=getPublicKey(key(3))
    if(fault==='v5-without-o')payload.v=5
    records.set(ROOM_PREFIX+ROOM,JSON.stringify({link:BASE+'#'+base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload))),openedAt:100,readAt:0}))
    expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
  })
  it.each(['pairing','ambiguous','unsafe-relay','unknown-field','invalid-name','bad-policy','null-policy','unknown-policy-field'] as const)
    ('holds %s retained link rather than silently filtering it',fault=>{
      const {records,url}=fixture(),payload=JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(url).hash.slice(1))))
      if(fault==='pairing')payload.c='01'.repeat(16)
      if(fault==='ambiguous')payload.s=base64urlnopad.encode(ROOT)
      if(fault==='unsafe-relay')payload.r=['https://leak.example']
      if(fault==='unknown-field')payload.hiddenKey=bytesToHex(ROOT)
      if(fault==='invalid-name')payload.n='bad\nname'
      if(fault==='bad-policy')payload.a={tier:'unknown'}
      if(fault==='null-policy')payload.a=null
      if(fault==='unknown-policy-field')payload.a={tier:'open',futureRestrictiveRule:true}
      records.set(ROOM_PREFIX+ROOM,JSON.stringify({link:BASE+'#'+base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload))),openedAt:100,readAt:0}))
      expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
    })
  it.each(['read-id','duplicate-read-id','read-time','name','extra','room-namespace'] as const)('holds %s room metadata',fault=>{
    const {records}=fixture(),value=JSON.parse(records.get(ROOM_PREFIX+ROOM)!)
    if(fault==='read-id')value.readIds=['x'.repeat(129)]
    if(fault==='duplicate-read-id')value.readIds=['x','x']
    if(fault==='read-time')value.readAt=-1
    if(fault==='name')value.name='bad\nname'
    if(fault==='extra')value.extra=true
    records.set(ROOM_PREFIX+ROOM,JSON.stringify(value))
    if(fault==='room-namespace')records.set(ROOM_PREFIX+'invalid',JSON.stringify(value))
    expect(()=>validate(records,false,options)).toThrow(OrdinaryStateHold)
  })
})
