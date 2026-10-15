import { describe,expect,it,vi } from 'vitest'
import { getPublicKey as contactFixtureKey } from 'nostr-tools/pure'
const scalarCopies = vi.hoisted(() => [] as Uint8Array[])
vi.mock('nostr-tools/pure', async importOriginal => {
  const actual = await importOriginal<typeof import('nostr-tools/pure')>()
  return { ...actual, getPublicKey: (...args: Parameters<typeof actual.getPublicKey>) => { scalarCopies.push(args[0]); return actual.getPublicKey(...args) } }
})
import { CONTACT_MODES,CONTACT_FAULTS,contactFixture,damageContactFixture,CONTACT_NOW,WEEK } from '../../test/ordinary-contact-fixture.js'
import { validateOrdinaryContactSnapshot as validate } from './ordinary-contact-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { CONTACT_PREFIX,RENDEZVOUS_KEY } from './contact-store.js'
import { VERIFIED_PREFIX } from './verified-store.js'
import { memoryDeviceStore } from './device-store.js'
import { rememberVerified,scopedVerificationStore } from './verified-store.js'
const browser = {kind:'browser' as const}

describe('offline contact, rendezvous and local observation custody',()=>{
  it.each(CONTACT_MODES)('preserves actual %s writer bytes without endorsement, discovery, rotation or account attribution',mode=>{
    const noContacts=['empty','self-only'].includes(mode),f=contactFixture(mode),before=[...f.records],result=validate(f.records,false,browser)
    expect([...f.records]).toEqual(before);expect(Object.isFrozen(result)).toBe(true)
    expect(result.rendezvous).toBe(!['empty','rotated'].includes(mode))
    expect(result.contacts).toEqual(noContacts?[]:[{participant:f.p,retainedBoxCards:mode.startsWith('legacy-')?0:mode==='duplicate-boxes'?2:1}])
    for(const item of [...result.contacts,...result.observations])expect(Object.isFrozen(item)).toBe(true)
    expect(result.observations.filter(item=>item.participant===f.p)).toEqual(noContacts?[]:[{participant:f.p}])
    expect(result.observations.filter(item=>item.participant===f.boxP).map(item=>item.observer)).toEqual(noContacts?[]:mode==='multi-observer'?[f.observer,f.otherObserver].sort():[f.observer])
  })
  it.each(CONTACT_FAULTS)('holds %s with the exact captured records unchanged',fault=>{
    const f=contactFixture(fault.startsWith('refreshed-')?'refreshed':'card');damageContactFixture(f,f.records,fault)
    const before=[...f.records];expect(()=>validate(f.records,true,browser)).toThrow(OrdinaryStateHold);expect([...f.records]).toEqual(before)
  })
  it('preserves expired cards without wall-clock pruning or using new hints as the retained signature clock',()=>{
    vi.useFakeTimers();vi.setSystemTime((CONTACT_NOW+3*WEEK)*1000)
    try {for(const mode of ['expired','replayed','equal-replayed'] as const){const f=contactFixture(mode);expect(validate(f.records,false,browser).contacts).toHaveLength(1)}}
    finally{vi.useRealTimers()}
  })
  it('accepts absence after explicit rotation and first-use absence without creating a scalar',()=>{
    const f=contactFixture('rotated');expect(f.records.has(RENDEZVOUS_KEY)).toBe(false);expect(validate(f.records,true,browser).rendezvous).toBe(false)
    expect(validate(new Map(),false,browser)).toEqual({contacts:[],rendezvous:false,observations:[]})
  })
  it('rejects every family in tab custody and does not introduce completed account wrappers',()=>{
    const f=contactFixture();for(const [name,raw]of f.records){expect(()=>validate(new Map([[name,raw]]),false,{kind:'tab'})).toThrow(OrdinaryStateHold)
      expect(()=>validate(new Map([['kithmoot.account.'+f.observer+'.'+name,raw]]),true,browser)).toThrow(OrdinaryStateHold)}
  })
  it('keeps separate observer capacities and holds an interrupted set-before-prune overflow intact',()=>{
    const f=contactFixture('empty'),store=memoryDeviceStore()
    for(const observer of [undefined,f.observer,f.otherObserver]){
      const target=observer?scopedVerificationStore(store,observer):store
      for(let i=0;i<500;i++)rememberVerified(target,i.toString(16).padStart(64,'0'),'Local observation',CONTACT_NOW*1000+i*1000)
    }
    const records=new Map(store.keys().map(name=>[name,store.get(name)!]));expect(validate(records,false,browser).observations).toHaveLength(1500)
    records.set(VERIFIED_PREFIX+'f'.repeat(64),JSON.stringify({participant:'f'.repeat(64),name:'Cut before old prune',verifiedAt:CONTACT_NOW}))
    const before=[...records];expect(()=>validate(records,false,browser)).toThrow(OrdinaryStateHold);expect([...records]).toEqual(before)
  })
  it('holds contact capacity overflow instead of dropping a cached pin',()=>{
    const f=contactFixture(),raw=f.records.get(f.name)!,records=new Map<string,string>()
    // Fresh on-curve participants, no retained signature is invented for
    // the copied cache fields. This tests capacity only, not endorsement.
    for(let i=1;i<=501;i++){
      const scalar=new Uint8Array(32);new DataView(scalar.buffer).setUint32(28,i)
      const p=contactFixtureKey(scalar),row=JSON.parse(raw);row.p=p;row.boxes=[];records.set(CONTACT_PREFIX+p,JSON.stringify(row));scalar.fill(0)
    }
    expect(()=>validate(records,false,browser)).toThrow(OrdinaryStateHold)
  })
  it('wipes the owned scalar validation copy on success and invalid-scalar failure',()=>{
    const f=contactFixture();scalarCopies.length=0
    try{
      validate(f.records,false,browser);expect(scalarCopies).toHaveLength(1);expect([...scalarCopies[0]!]).toEqual(Array(32).fill(0))
      scalarCopies.length=0;f.records.set(RENDEZVOUS_KEY,'0'.repeat(64))
      expect(()=>validate(f.records,false,browser)).toThrow(OrdinaryStateHold);expect(scalarCopies).toHaveLength(1);expect([...scalarCopies[0]!]).toEqual(Array(32).fill(0))
      expect(f.records.get(RENDEZVOUS_KEY)).toBe('0'.repeat(64))
    }finally{scalarCopies.length=0}
  })
  it('does not return cached names, reachability hints, rendezvous scalars or a Contact authority object',()=>{
    const f=contactFixture(),result=validate(f.records,true,browser)
    expect(Object.keys(result.contacts[0]!)).toEqual(['participant','retainedBoxCards'])
    expect(Object.keys(result.observations.find(item=>!item.observer)!)).toEqual(['participant'])
  })
})
