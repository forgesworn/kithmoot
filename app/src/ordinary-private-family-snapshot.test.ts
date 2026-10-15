import { expect, it, vi } from 'vitest'
import { validateOrdinaryPrivateFamilySnapshot as validate } from './ordinary-private-family-snapshot.js'
import { OrdinaryStateHold, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'
import { PRIVATE_MODES, PRIVATE_FAULTS, privateFamilyFixture, damagePrivateFamilyFixture } from '../../test/ordinary-private-family-fixture.js'

it.each(PRIVATE_MODES)('preserves actual %s writer bytes without clock, effects, pruning or authority output', async mode => {
  const f = await privateFamilyFixture(mode), before = [...f.records]
  const clock = vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('No custody clock')})
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No custody fetch')})
  try {
    const result = validate(f.records,false,{kind:'browser'})
    expect(Object.isFrozen(result)).toBe(true);expect(Object.values(result).every(v=>Number.isSafeInteger(v)&&v>=0)).toBe(true)
    expect(validate(f.records,true,{kind:'browser'})).toEqual(result);expect([...f.records]).toEqual(before)
    expect(clock).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled()
    if(mode==='all')expect(result).toEqual({discoveries:1,statusFloors:1,claimFloors:1,uploadJournals:1,uploadCandidates:2,pendingDeletes:1,histories:1,windows:2,sharedFileConsent:1,legacyFileSuggestions:1,logos:1})
    if(mode==='discovery-retired-old-order')expect(JSON.parse(f.records.get(f.keys.discovery)!).claim.tags).toContainEqual(['status','retired'])
    if(mode==='discovery-node-change')expect(result).toMatchObject({claimFloors:1,statusFloors:0})
    if(mode==='legacy-only')expect(result).toMatchObject({legacyFileSuggestions:1,sharedFileConsent:0})
    if(mode==='pending-delete-t0')expect(result.pendingDeletes).toBe(1)
  } finally {clock.mockRestore();fetcher.mockRestore()}
})
it.each(PRIVATE_FAULTS)('holds %s bytes intact in raw and completed images',async fault=>{
  const f=await privateFamilyFixture(),records=new Map(f.records);damagePrivateFamilyFixture(f,records,fault);const before=[...records]
  for(const migrated of [false,true])expect(()=>validate(records,migrated,{kind:'browser'})).toThrow(OrdinaryStateHold)
  expect([...records]).toEqual(before)
})
it('refuses browser-private families in tab custody',async()=>{
 const f=await privateFamilyFixture();expect(()=>validate(f.records,false,{kind:'tab'})).toThrow(OrdinaryStateHold)
})
it('rejects an oversized value before parsing and retains it for recovery',()=>{
 const records=new Map([['kithmoot.uploads.v1.'+'a'.repeat(64),'x'.repeat(ORDINARY_VALUE_BYTES+1)]])
 const parse=vi.spyOn(JSON,'parse').mockImplementation(()=>{throw Error('Must not parse')})
 try{expect(()=>validate(records,false,{kind:'browser'})).toThrow(OrdinaryStateHold);expect(parse).not.toHaveBeenCalled()}finally{parse.mockRestore()}
})
it('leaves unrelated private families for the required complete composite',()=>{
 expect(validate(new Map([['kithmoot.device.private','opaque']]),false,{kind:'browser'}).discoveries).toBe(0)
})
