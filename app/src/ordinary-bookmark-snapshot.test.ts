import { describe,it,expect } from 'vitest'
import { base64,base64urlnopad } from '@scure/base'
import { bookmarkFixture,type BookmarkFixtureMode } from '../../test/ordinary-bookmark-fixture.js'
import { roomAccessFixture } from '../../test/ordinary-room-access.browser-entry.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { validateOrdinaryRoomBookmarkSnapshot as validate } from './ordinary-bookmark-snapshot.js'

const browser={kind:'browser' as const}
describe('strict ordinary bookmark custody',()=>{
  it.each(['signed','older','unsigned-pending','signed-pending','record-pending','tombstone','pending-tombstone'] as BookmarkFixtureMode[])
    ('preserves actual %s writer state byte-exactly, including removal and uncertainty',async mode=>{
      const {records,roomId,account}=await bookmarkFixture(mode),before=[...records],result=validate(records,false,browser)
      expect(result.bookmarks).toEqual([{account,roomId,record:!['unsigned-pending','signed-pending'].includes(mode),
        pending:['unsigned-pending','signed-pending','record-pending','pending-tombstone'].includes(mode),removed:['tombstone','pending-tombstone'].includes(mode)}])
      expect([...records]).toEqual(before);expect(Object.isFrozen(result.bookmarks[0])).toBe(true)
      expect(JSON.stringify(result)).not.toContain('https://')
    })
  it('binds an orphaned creator from its account bookmark without a raw room-list copy',async()=>{
    const cached=await bookmarkFixture(),records=new Map([[cached.name,cached.records.get(cached.name)!]]),owner=roomAccessFixture({persistent:true,owner:true})
    for(const [name,raw]of owner.records)if(name.startsWith('kithmoot.invitation-owner.'))records.set(name,raw)
    expect(validate(records,false,browser).access.invitations).toHaveLength(1)
  })
  it('preserves independent account bookmark caches',async()=>{
    const first=await bookmarkFixture(),second=await bookmarkFixture('signed',{rootSeed:6,accountSeed:9,bearerSeed:8})
    for(const [name,raw]of second.records)first.records.set(name,raw)
    expect(validate(first.records,false,browser).bookmarks).toHaveLength(2)
  })
  it('does not claim the signed ciphertext proves separately cached plaintext',async()=>{
    const {records,name}=await bookmarkFixture(),saved=JSON.parse(records.get(name)!)
    saved.record.room.name='Locally renamed';records.set(name,JSON.stringify(saved))
    expect(validate(records,false,browser).bookmarks).toHaveLength(1)
  })
  it.each(['signature','event-account','event-time','event-id','event-kind','duplicate-d','unknown-tag','plaintext-content','cipher-version','extra-event','wrong-secret','extra-admission','orphan-admission','room-namespace','extra-room','null-policy','unknown-policy','empty','null-record','extra-cache','bad-key','wrapped-key','tab'] as const)
    ('holds %s cache corruption without modifying raw records',async fault=>{
      const {records,name,roomId,sign}=await bookmarkFixture(),saved=JSON.parse(records.get(name)!),record=saved.record
      if(fault==='signature')record.event.sig='0'.repeat(128)
      if(fault==='event-account')record.event.pubkey='a'.repeat(64)
      if(fault==='event-time')record.event.created_at++
      if(fault==='event-id')record.id='a'.repeat(64)
      if(fault==='event-kind')record.event=sign({...record.event,kind:1})
      if(fault==='duplicate-d')record.event=sign({...record.event,tags:[...record.event.tags,record.event.tags.find((tag:string[])=>tag[0]==='d')]})
      if(fault==='unknown-tag')record.event=sign({...record.event,tags:[...record.event.tags,['expiration','1']]})
      if(fault==='plaintext-content')record.event=sign({...record.event,content:'plain secret '+record.admission.secret})
      if(fault==='cipher-version'){const bytes=base64.decode(record.event.content);bytes[0]=1;record.event=sign({...record.event,content:base64.encode(bytes)})}
      if(['event-kind','duplicate-d','unknown-tag','plaintext-content','cipher-version'].includes(fault))record.id=record.event.id
      if(fault==='extra-event')record.event.extra=true
      if(fault==='wrong-secret')record.admission.secret='6'.repeat(64)
      if(fault==='extra-admission')record.admission.delegate='a'.repeat(64)
      if(fault==='orphan-admission')delete record.room
      if(fault==='room-namespace')record.roomId='a'.repeat(64)
      if(fault==='extra-room')record.room.extra=true
      if(fault==='null-policy'||fault==='unknown-policy'){
        const payload=JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(record.room.link).hash.slice(1))))
        payload.a=fault==='null-policy'?null:{tier:'open',futureRestriction:true}
        record.room.link='https://ordinary-bookmark.kithmoot.test/#'+base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
      }
      if(fault==='null-record')saved.record=null
      if(fault==='extra-cache')saved.extra=true
      records.set(name,JSON.stringify(fault==='empty'?{}:saved))
      if(fault==='bad-key'){records.set('kithmoot.bookmarks.invalid.'+roomId,records.get(name)!);records.delete(name)}
      if(fault==='wrapped-key'){records.set('kithmoot.account.'+'a'.repeat(64)+'.'+name,records.get(name)!);records.delete(name)}
      const before=[...records];expect(()=>validate(records,false,{kind:fault==='tab'?'tab':'browser'})).toThrow(OrdinaryStateHold);expect([...records]).toEqual(before)
    })
  it('rejects the same repair event paired with conflicting record and pending plaintext',async()=>{
    const {records,name}=await bookmarkFixture(),saved=JSON.parse(records.get(name)!),{d,id:_id,event,...plain}=saved.record
    saved.pending={d,event,value:{...plain,room:{...plain.room,name:'Conflicting plaintext'}}};records.set(name,JSON.stringify(saved))
    expect(()=>validate(records,false,browser)).toThrow(OrdinaryStateHold)
  })
  it('preserves an exact signed repair candidate beside the older cache format',async()=>{
    const {records,name}=await bookmarkFixture(),saved=JSON.parse(records.get(name)!),{d,id:_id,event,...plain}=saved.record
    saved.pending={d,event,value:plain};delete saved.record.event;records.set(name,JSON.stringify(saved))
    expect(validate(records,false,browser).bookmarks[0]!.pending).toBe(true)
  })
  it('rejects reuse of a random bookmark address across different rooms despite valid signatures',async()=>{
    const first=await bookmarkFixture(),second=await bookmarkFixture('signed',{rootSeed:6,bearerSeed:8})
    const a=JSON.parse(first.records.get(first.name)!),b=JSON.parse(second.records.get(second.name)!)
    b.record.d=a.record.d;b.record.event=second.sign({...b.record.event,tags:[['d',a.record.d],['l','kithmoot.rooms.v1']]});b.record.id=b.record.event.id
    for(const [name,raw]of second.records)first.records.set(name,name===second.name?JSON.stringify(b):raw)
    expect(()=>validate(first.records,false,browser)).toThrow(OrdinaryStateHold)
  })
  it.each(['zero','version','variant'] as const)('rejects %s UUID addresses with or without a signed copy',async fault=>{
    for(const mode of ['signed','older'] as const){
      const {records,name,sign}=await bookmarkFixture(mode),saved=JSON.parse(records.get(name)!),parts=saved.record.d.slice('kithmoot.rooms.v1.'.length).split('-')
      if(fault==='version')parts[2]='1'+parts[2].slice(1)
      if(fault==='variant')parts[3]='0'+parts[3].slice(1)
      saved.record.d='kithmoot.rooms.v1.'+(fault==='zero'?'00000000-0000-0000-0000-000000000000':parts.join('-'))
      if(saved.record.event){saved.record.event=sign({...saved.record.event,tags:[['d',saved.record.d],['l','kithmoot.rooms.v1']]});saved.record.id=saved.record.event.id}
      records.set(name,JSON.stringify(saved));const before=[...records]
      expect(()=>validate(records,false,browser)).toThrow(OrdinaryStateHold);expect([...records]).toEqual(before)
    }
  })
  it('rejects an older cache event identifier relocated to another room',async()=>{
    const first=await bookmarkFixture('older'),second=await bookmarkFixture('older',{rootSeed:6,bearerSeed:8})
    const a=JSON.parse(first.records.get(first.name)!),b=JSON.parse(second.records.get(second.name)!)
    b.record.id=a.record.id
    for(const [name,raw]of second.records)first.records.set(name,name===second.name?JSON.stringify(b):raw)
    expect(()=>validate(first.records,false,browser)).toThrow(OrdinaryStateHold)
  })
  it('rejects pending and retained links that pin different roots for the same invitation',async()=>{
    const {records,name}=await bookmarkFixture('record-pending'),saved=JSON.parse(records.get(name)!)
    const payload=JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(saved.pending.value.room.link).hash.slice(1))))
    payload.h='a'.repeat(64);saved.pending.value.room.link='https://ordinary-bookmark.kithmoot.test/#'+base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
    records.set(name,JSON.stringify(saved))
    expect(()=>validate(records,false,browser)).toThrow(OrdinaryStateHold)
  })
})
