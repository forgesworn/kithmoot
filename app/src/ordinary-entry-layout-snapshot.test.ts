import { expect,it,vi } from 'vitest'
import { validateOrdinaryEntryLayoutSnapshot as validate } from './ordinary-entry-layout-snapshot.js'
import { OrdinaryStateHold, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'
import { loadRailWidth } from './desktop-projects-rail.js'
import { loadChatDividerFraction } from './call-focus-model.js'
import { ENTRY_MODES,ENTRY_FAULTS,ENTRY_TAB_FAULTS,entryLayoutFixture,damageEntryLayoutFixture } from '../../test/ordinary-entry-layout-fixture.js'

it.each(ENTRY_MODES)('preserves %s primary writer cuts without effects or authority output',mode=>{
  const f=entryLayoutFixture(mode),before=[...f.records]
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('No custody clock')})
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No custody fetch')})
  try {
    const c=validate(f.records,false,{kind:f.kind});expect(Object.isFrozen(c)).toBe(true)
    expect(Object.values(c).every(v=>Number.isSafeInteger(v)&&v>=0)).toBe(true)
    expect(validate(f.records,true,{kind:f.kind})).toEqual(c);expect([...f.records]).toEqual(before)
    expect(clock).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(f.provenance.length).toBeGreaterThan(0)
    if(mode==='browser-all') expect(c).toEqual({notifications:2,knocks:1,invitedLists:1,invitedEntries:1,conversations:0,unboundConversations:0,layouts:9,numericLayouts:2})
    if(mode==='notification-first-cut')expect(c.notifications).toBe(1)
    if(mode==='invited-opaque')expect(c.invitedEntries).toBe(3)
    if(mode==='invited-cap')expect(c.invitedEntries).toBe(200)
    if(mode==='invited-scrub-empty')expect([c.invitedLists,c.invitedEntries]).toEqual([1,0])
    if(mode==='tab-unbound')expect([c.conversations,c.unboundConversations]).toEqual([1,1])
    if(mode==='layout-reader-ignored'||mode==='layout-nonfinite') {
      const storage={getItem:(k:string)=>f.records.get(k)??null}
      expect(loadRailWidth(storage)).toBeUndefined();expect(loadChatDividerFraction(storage)).toBeUndefined()
    }
    if(mode==='layout-clamped-callers')expect(f.records.get('kithmoot.call-chat-divider')).toBe('1.8')
  } finally {clock.mockRestore();fetcher.mockRestore()}
})
for(const [kind,mode,faults] of [['browser','browser-all',ENTRY_FAULTS],['tab','tab-account',ENTRY_TAB_FAULTS]] as const)
  it.each(faults)(`${kind} holds %s before changing raw or completed records`,fault=>{
    const f=entryLayoutFixture(mode);damageEntryLayoutFixture(f.records,fault);const before=[...f.records]
    for(const migrated of [false,true])expect(()=>validate(f.records,migrated,{kind})).toThrow(OrdinaryStateHold)
    expect([...f.records]).toEqual(before)
  })
it.each(['browser-all','tab-account'] as const)('holds %s in the other physical owner',mode=>{
  const f=entryLayoutFixture(mode)
  for(const migrated of [false,true])expect(()=>validate(f.records,migrated,{kind:f.kind==='browser'?'tab':'browser'})).toThrow(OrdinaryStateHold)
})
it('bounds UTF8 before parsing and leaves adjacent namespaces for full classification',()=>{
  const parse=vi.spyOn(JSON,'parse').mockImplementation(()=>{throw Error('Must not parse')})
  try {expect(()=>validate(new Map([['kithmoot.invited.v1.'+'a'.repeat(64),'😀'.repeat(ORDINARY_VALUE_BYTES/4+1)]]),false,{kind:'browser'})).toThrow(OrdinaryStateHold);expect(parse).not.toHaveBeenCalled()} finally {parse.mockRestore()}
  expect(()=>validate(new Map(),false,{kind:'account' as 'browser'})).toThrow(OrdinaryStateHold)
  expect(Object.values(validate(new Map([['kithmoot.call-tab-lock.msg','{}']]),false,{kind:'browser'})).every(v=>v===0)).toBe(true)
})
