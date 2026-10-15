import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { deriveEpoch, MAX_EPOCH, MAX_HISTORY_EPOCHS } from '../../src/epoch.js'
import { deriveRoom } from '../../src/room.js'
import { memoryDeviceStore } from './device-store.js'
import { ROOM_EPOCH_PREFIX as V1, ROOM_EPOCH_V2_PREFIX as V2, storeKeptRoomEpoch, loadKeptRoomEpoch } from './room-epoch-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { validateOrdinaryEpochSnapshot as validate } from './ordinary-epoch-snapshot.js'

const ROOT = new Uint8Array(32).fill(5), ROOM = deriveRoom(ROOT).roomId, ACCOUNT = 'a'.repeat(64)
const secret = (n: number) => new Uint8Array(32).fill(n+40)
function snapshot() {
  const store = memoryDeviceStore()
  storeKeptRoomEpoch(store,ROOM,{epoch:{epoch:3,secret:secret(3)},past:[{epoch:2,secret:secret(2),leftAt:90},{epoch:0,secret:ROOT,leftAt:80}],
    removed:['b'.repeat(64)],members:['a'.repeat(64)]},100)
  return new Map(store.keys().map(name=>[name,store.get(name)!]))
}
function v1(n: number) { const keys=deriveEpoch({epoch:n,secret:secret(n)});try{return JSON.stringify({epoch:n,id:keys.id,key:bytesToHex(keys.key)})}finally{keys.key.fill(0)} }
describe('strict ordinary epoch snapshot custody',()=>{
  it('preserves real writer formats and expired history byte-exactly without pruning or time authority',()=>{
    const records=snapshot(),before=[...records],result=validate(records,false)
    expect(result.rooms).toEqual([{roomId:ROOM,watchedEpoch:3,keptEpoch:3}]);expect([...records]).toEqual(before)
    expect(Object.isFrozen(result.rooms[0])).toBe(true)
  })
  it('keeps v1-only custody from older releases',()=>{expect(validate(new Map([[V1+ROOM,v1(4)]]),false).rooms).toEqual([{roomId:ROOM,watchedEpoch:4}])})
  it('keeps v1 ahead of v2 after an older client followed a later rekey',()=>{
    const records=snapshot();records.set(V1+ROOM,v1(4));expect(validate(records,false).rooms[0]).toEqual({roomId:ROOM,watchedEpoch:4,keptEpoch:3})
  })
  it('accepts v2 with no redundant v1 cache after a cut between the old writer calls',()=>{
    const records=snapshot();records.delete(V1+ROOM);expect(validate(records,false).rooms[0]!.watchedEpoch).toBe(3)
  })
  it('checks a v1 matching a retained earlier epoch after a cut before its update',()=>{
    const records=snapshot();records.set(V1+ROOM,v1(2));expect(validate(records,false).rooms[0]!.watchedEpoch).toBe(3)
    const event=JSON.parse(records.get(V1+ROOM)!);event.key='0'.repeat(64);records.set(V1+ROOM,JSON.stringify(event))
    expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
  })
  it('permits account-scoped caches only in completed encrypted custody',()=>{
    const records=new Map([...snapshot()].map(([name,value])=>['kithmoot.account.'+ACCOUNT+'.'+name,value]))
    expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
    expect(validate(records,true).rooms[0]!.account).toBe(ACCOUNT)
  })
  it.each(['v1-id','v1-key','v2-current','v2-retained','v2-secret'] as const)('holds %s material reused across distinct rooms',which=>{
    const records=snapshot(),otherRoom='c'.repeat(64)
    if(which==='v1-id'||which==='v1-key'){
      const value=JSON.parse(records.get(V1+ROOM)!)
      value[which==='v1-id'?'key':'id']='d'.repeat(64)
      records.set(V1+otherRoom,JSON.stringify(value))
    }else{
      const value=JSON.parse(records.get(V2+ROOM)!);value.past=[]
      if(which==='v2-retained'){value.epoch=2;value.secret=bytesToHex(secret(2))}
      if(which==='v2-secret')value.epoch=4
      records.set(V2+otherRoom,JSON.stringify(value))
    }
    expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
  })
  it('refuses simultaneous legacy and account-scoped epoch custody for one room',()=>{
    const records=snapshot();for(const [name,value]of snapshot())records.set('kithmoot.account.'+ACCOUNT+'.'+name,value)
    expect(()=>validate(records,true)).toThrow(OrdinaryStateHold)
  })
  it('allows two scoped accounts to retain byte-identical caches for the same room',()=>{
    const records=new Map<string,string>()
    for(const account of [ACCOUNT,'c'.repeat(64)])for(const [name,value]of snapshot())records.set('kithmoot.account.'+account+'.'+name,value)
    expect(validate(records,true).rooms.map(room=>room.account)).toEqual([ACCOUNT,'c'.repeat(64)])
  })
  it('preserves actual writer history after its clock moved back between rekeys',()=>{
    const store=memoryDeviceStore()
    storeKeptRoomEpoch(store,ROOM,{epoch:{epoch:3,secret:secret(3)},past:[{epoch:2,secret:secret(2),leftAt:80},{epoch:1,secret:secret(1),leftAt:90}],removed:[],members:[]},100)
    const records=new Map(store.keys().map(name=>[name,store.get(name)!])),before=[...records]
    expect(JSON.parse(records.get(V2+ROOM)!).past.map((past:{leftAt:number})=>past.leftAt)).toEqual([80,90])
    expect(validate(records,false).rooms[0]!.keptEpoch).toBe(3);expect([...records]).toEqual(before)
  })
  it.each(['json','extra','missing-roster','bad-member','duplicate-member','unsorted-member','removed-member','bad-past','duplicate-past','unsorted-past','future-past','negative-time','oversize-history','wrong-root','too-large-epoch','zero-epoch','bad-secret'] as const)
    ('holds %s rather than allowing permissive history/roster pruning',fault=>{
      const records=snapshot(),value=JSON.parse(records.get(V2+ROOM)!)
      if(fault==='json')records.set(V2+ROOM,'{')
      if(fault==='extra')value.extra=true
      if(fault==='missing-roster')delete value.members
      if(fault==='bad-member')value.members.push('invalid')
      if(fault==='duplicate-member')value.members.push(value.members[0])
      if(fault==='unsorted-member')value.members=['c'.repeat(64),'a'.repeat(64)]
      if(fault==='removed-member')value.members.push(value.removed[0])
      if(fault==='bad-past')value.past.push(null)
      if(fault==='duplicate-past')value.past.push(value.past[0])
      if(fault==='unsorted-past')value.past.reverse()
      if(fault==='future-past')value.past[0].epoch=value.epoch
      if(fault==='negative-time')value.past[0].leftAt=-1
      if(fault==='oversize-history')value.past=Array.from({length:MAX_HISTORY_EPOCHS+1},()=>value.past[0])
      if(fault==='wrong-root')value.past[1].secret=bytesToHex(secret(1))
      if(fault==='too-large-epoch')value.epoch=MAX_EPOCH+1
      if(fault==='zero-epoch')value.epoch=0
      if(fault==='bad-secret')value.secret='nope'
      if(fault!=='json')records.set(V2+ROOM,JSON.stringify(value))
      const before=[...records];expect(()=>validate(records,false)).toThrow(OrdinaryStateHold);expect([...records]).toEqual(before)
    })
  it.each(['id','key','epoch','extra'] as const)('holds conflicting or malformed v1 %s',fault=>{
    const records=snapshot(),value=JSON.parse(records.get(V1+ROOM)!)
    if(fault==='id'||fault==='key')value[fault]='0'.repeat(64)
    if(fault==='epoch')value.epoch=MAX_EPOCH+1
    if(fault==='extra')value.extra=true
    records.set(V1+ROOM,JSON.stringify(value));expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
  })
  it.each(['kithmoot.room-epoch.v3.'+ROOM,V1+'invalid','kithmoot.account.bad.'+V1+ROOM])('holds unsupported or ambiguous epoch namespace %s',name=>{
    expect(()=>validate(new Map([[name,v1(3)]]),false)).toThrow(OrdinaryStateHold)
  })
  it('refuses a malformed history that the old loader would silently reduce',()=>{
    const records=snapshot(),value=JSON.parse(records.get(V2+ROOM)!);value.past.push(null);records.set(V2+ROOM,JSON.stringify(value))
    const store=memoryDeviceStore();for(const [name,raw]of records)store.set(name,raw)
    expect(loadKeptRoomEpoch(store,ROOM)!.past).toHaveLength(2)
    expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
  })
})
