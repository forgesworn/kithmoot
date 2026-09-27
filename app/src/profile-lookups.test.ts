import { describe, expect, it } from 'vitest'
import { hasMemberList, lookupHosts, lookupsAllowed, memberRoomsPreference, saveMemberRoomsPreference } from './profile-lookups.js'
import type { RoomPolicy } from '../../src/index.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64)
const open: RoomPolicy = { tier: 'open' }
const direct: RoomPolicy = { tier: 'open', members: [A, B] }
const quiet: RoomPolicy = { tier: 'open', members: [A, B], quiet: true }

describe('hasMemberList', () => {
  it('is true only for a policy that names somebody', () => {
    expect(hasMemberList(undefined)).toBe(false)
    expect(hasMemberList(open)).toBe(false)
    expect(hasMemberList({ tier: 'open', members: [] })).toBe(false)
    expect(hasMemberList(direct)).toBe(true)
    expect(hasMemberList(quiet)).toBe(true)
  })
})

describe('lookupsAllowed', () => {
  it('follows the person’s switch in an open room and outside any room', () => {
    expect(lookupsAllowed({ enabled: true, inMemberRooms: false, policy: undefined })).toBe(true)
    expect(lookupsAllowed({ enabled: true, inMemberRooms: false, policy: open })).toBe(true)
    expect(lookupsAllowed({ enabled: false, inMemberRooms: false, policy: open })).toBe(false)
  })

  it('stays off in a direct message and a quiet conversation until the second switch is on', () => {
    expect(lookupsAllowed({ enabled: true, inMemberRooms: false, policy: direct })).toBe(false)
    expect(lookupsAllowed({ enabled: true, inMemberRooms: false, policy: quiet })).toBe(false)
    expect(lookupsAllowed({ enabled: true, inMemberRooms: true, policy: direct })).toBe(true)
    expect(lookupsAllowed({ enabled: true, inMemberRooms: true, policy: quiet })).toBe(true)
  })

  it('never lets the second switch turn on what the first turned off', () => {
    expect(lookupsAllowed({ enabled: false, inMemberRooms: true, policy: direct })).toBe(false)
    expect(lookupsAllowed({ enabled: false, inMemberRooms: true, policy: undefined })).toBe(false)
  })
})

describe('the saved choice', () => {
  it('starts off, and only the exact saved word turns it on', () => {
    const saved = new Map<string, string>()
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) } }
    expect(memberRoomsPreference(storage)).toBe(false)
    saveMemberRoomsPreference(storage, true)
    expect(memberRoomsPreference(storage)).toBe(true)
    saveMemberRoomsPreference(storage, false)
    expect(memberRoomsPreference(storage)).toBe(false)
    saved.set('kithmoot.profiles.memberRooms', 'yes')
    expect(memberRoomsPreference(storage)).toBe(false)
  })

  it('is off when storage cannot be read, and saving there does not throw', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(memberRoomsPreference(broken)).toBe(false)
    expect(() => saveMemberRoomsPreference(broken, true)).not.toThrow()
  })
})

describe('lookupHosts', () => {
  it('names each host once, in order, and leaves out what does not parse', () => {
    expect(lookupHosts(['wss://nos.lol', 'wss://nos.lol/', 'not a url', 'wss://purplepag.es', 'ws://127.0.0.1:7777/x']))
      .toEqual(['nos.lol', 'purplepag.es', '127.0.0.1:7777'])
    expect(lookupHosts([])).toEqual([])
  })
})
