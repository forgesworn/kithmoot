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
    if(mode==='all')expect(result).toEqual({discoveries:1,statusFloors:1,claimFloors:1,uploadJournals:1,uploadCandidates:2,pendingDeletes:1,histories:1,windows:2,sharedFileConsent:1,legacyFileSuggestions:1,logos:1,grantJournals:0,groupDeleteMarks:0})
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
const CONSENT = 'kithmoot.file-storage.v1'
const snapshot = (raw: string) => validate(new Map([[CONSENT, raw]]), false, { kind: 'browser' })
it.each([
  ['{"mode":"shared","disclosure":3,"origin":"https://blossom.yakihonne.com","via":"default"}', 1],
  ['{"mode":"shared","disclosure":3,"origin":"https://files.example","via":"typed"}', 1],
  ['{"mode":"shared","disclosure":3,"origin":"https://files.example","via":"wildbloom"}', 1],
  ['{"mode":"shared","disclosure":2,"origin":"https://files.example"}', 1],
  ['{"mode":"off","disclosure":3}', 0],
  ['{"mode":"off"}', 0],
])('keeps the file consent %s', (raw, shared) => {
  expect(snapshot(raw).sharedFileConsent).toBe(shared)
})
it.each([
  '{"mode":"shared","disclosure":3,"origin":"https://files.example"}',
  '{"mode":"shared","disclosure":3,"origin":"https://files.example","via":"elsewhere"}',
  '{"mode":"shared","disclosure":2,"origin":"https://files.example","via":"typed"}',
  '{"mode":"shared","disclosure":4,"origin":"https://files.example","via":"typed"}',
  '{"mode":"off","disclosure":2}',
  '{"mode":"off","origin":"https://files.example"}',
])('holds the malformed file consent %s', raw => {
  expect(() => snapshot(raw)).toThrow(OrdinaryStateHold)
})
it('keeps an upload record that says which key signed it, and holds a bad one', () => {
  const name = 'kithmoot.uploads.v1.' + 'a'.repeat(64), url = 'https://files.example/' + 'ab'.repeat(32)
  const record = (key: unknown) => new Map([[name, JSON.stringify([{ url, sha256: 'ab'.repeat(32), ...(key === undefined ? {} : { key }) }])]])
  for (const key of [undefined, 'device', 'file']) expect(validate(record(key), false, { kind: 'browser' }).uploadCandidates).toBe(1)
  expect(() => validate(record('other'), false, { kind: 'browser' })).toThrow(OrdinaryStateHold)
})
