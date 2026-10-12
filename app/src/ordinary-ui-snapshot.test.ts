import { expect, it, vi } from 'vitest'
import { validateOrdinaryUiSnapshot as validate } from './ordinary-ui-snapshot.js'
import { OrdinaryStateHold, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'
import { UI_MODES, UI_FAULTS, UI_TAB_FAULTS, uiFixture, damageUiFixture } from '../../test/ordinary-ui-fixture.js'

it.each(UI_MODES)('retains %s writer-cut bytes without clock, catalogue or identity output', mode => {
  const f = uiFixture(mode), before = [...f.records]
  const clock = vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('No custody clock')})
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No custody fetch')})
  try {
    const result = validate(f.records,false,{kind:f.kind})
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.values(result).every(v=>Number.isSafeInteger(v)&&v>=0)).toBe(true)
    expect(validate(f.records,true,{kind:f.kind})).toEqual(result); expect([...f.records]).toEqual(before)
    expect(clock).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    if (mode==='browser-all') expect(result).toEqual({booleans:6,names:1,accountHints:1,methodHints:1,profileCaches:1,profileNames:1,
      roomNames:1,folds:1,sendDelays:1,nudges:1,headsUps:1,tombstoneLists:1,tombstones:1,skinTones:1,recentLists:1,recents:1,
      wayBacks:0,roomSwitches:0,notices:0})
    if (mode.startsWith('tab-')) expect([result.wayBacks,result.roomSwitches,result.notices]).toEqual([1,1,1])
    if (mode==='profile-opaque') expect(result.profileNames).toBe(3)
    if (mode==='profile-cap') expect(result.profileNames).toBe(500)
    if (mode==='recents-duplicate') expect(result.recents).toBe(3)
    if (mode==='recents-cap') expect(result.recents).toBe(36)
    if (mode==='tombstone-duplicate') expect(result.tombstones).toBe(2)
    if (mode==='tombstone-cap') expect(result.tombstones).toBe(50)
    if (mode!=='legacy-desktop-bell') expect(f.provenance.length).toBeGreaterThan(0)
    for(const p of f.provenance) { expect(p.fileSha256).toMatch(/^[0-9a-f]{64}$/); expect(p.snippetSha256).toMatch(/^[0-9a-f]{64}$/) }
  } finally { clock.mockRestore(); fetcher.mockRestore() }
})
for (const [kind,faults,mode] of [['browser',UI_FAULTS,'browser-all'],['tab',UI_TAB_FAULTS,'tab-all']] as const)
  it.each(faults)(`${kind} holds %s intact in raw and completed images`, fault => {
    const f = uiFixture(mode); damageUiFixture(f.records,fault); const before=[...f.records]
    for(const migrated of [false,true]) expect(()=>validate(f.records,migrated,{kind})).toThrow(OrdinaryStateHold)
    expect([...f.records]).toEqual(before)
  })
it.each(['browser-all','tab-all'] as const)('refuses %s in the wrong physical owner', mode => {
  const f=uiFixture(mode)
  for(const migrated of [false,true]) expect(()=>validate(f.records,migrated,{kind:f.kind==='browser'?'tab':'browser'})).toThrow(OrdinaryStateHold)
})
it('bounds UTF8 before parse, rejects unknown owner kinds, and leaves textSize for classification', () => {
  const records = new Map([['kithmoot:emoji:recents','😀'.repeat(Math.floor(ORDINARY_VALUE_BYTES/4)+1)]])
  const parse = vi.spyOn(JSON,'parse').mockImplementation(()=>{throw Error('Must not parse')})
  try { expect(()=>validate(records,false,{kind:'browser'})).toThrow(OrdinaryStateHold); expect(parse).not.toHaveBeenCalled() }
  finally { parse.mockRestore() }
  expect(()=>validate(new Map(),false,{kind:'account' as 'browser'})).toThrow(OrdinaryStateHold)
  expect(Object.values(validate(new Map([['kithmoot.textSize','large']]),false,{kind:'browser'})).every(v=>v===0)).toBe(true)
})
