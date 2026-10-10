import { describe, expect, it } from 'vitest'
import { FOLDABLE, RECENT_SECONDS, avatarInitial, avatarSlot, groupRooms, pinnedFirst, sectionHeading, sectionOf, type SectionFacts } from './room-sections.js'

const now = 1_800_000_000
const facts = (overrides: Partial<SectionFacts> = {}): SectionFacts => ({ pinned: false, ended: false, unread: 0, activity: now, ...overrides })

describe('sectionOf', () => {
  it('keeps a pinned room pinned, even unread or ended', () => {
    expect(sectionOf(facts({ pinned: true, unread: 3 }), now)).toBe('pinned')
    expect(sectionOf(facts({ pinned: true, ended: true }), now)).toBe('pinned')
  })
  it('puts an ended room in Ended even with unread messages', () => {
    expect(sectionOf(facts({ ended: true, unread: 2 }), now)).toBe('ended')
  })
  it('puts unread before recent', () => {
    expect(sectionOf(facts({ unread: 1, activity: now - RECENT_SECONDS * 4 }), now)).toBe('unread')
  })
  it('splits recent from older at seven days', () => {
    expect(sectionOf(facts({ activity: now - RECENT_SECONDS }), now)).toBe('recent')
    expect(sectionOf(facts({ activity: now - RECENT_SECONDS - 1 }), now)).toBe('older')
  })
  it('keeps rooms without readable message times outside the default folds', () => {
    expect(sectionOf(facts({ activity: 0 }), now)).toBe('other')
    expect(FOLDABLE.other).toBeUndefined()
    const rooms = Array.from({ length: 12 }, (_, i) => i)
    expect(groupRooms(rooms, () => 'other', false)).toEqual([{ section: 'other', rooms }])
  })
})

describe('groupRooms', () => {
  const rooms = Array.from({ length: 12 }, (_, i) => ({ id: i, section: (['recent', 'older', 'pinned', 'unread', 'ended'] as const)[i % 5] }))

  it('groups in section order, keeping the given order inside each', () => {
    const groups = groupRooms(rooms, room => room.section, false)!
    expect(groups.map(g => g.section)).toEqual(['pinned', 'unread', 'recent', 'older', 'ended'])
    expect(groups.find(g => g.section === 'recent')!.rooms.map(r => r.id)).toEqual([0, 5, 10])
  })
  it('leaves out empty sections', () => {
    const groups = groupRooms(rooms.map(r => ({ ...r, section: 'recent' as const })), r => r.section, false)!
    expect(groups.map(g => g.section)).toEqual(['recent'])
  })
  it('has no headings for eight rooms or fewer', () => {
    expect(groupRooms(rooms.slice(0, 8), room => room.section, false)).toBeUndefined()
    expect(groupRooms(rooms.slice(0, 9), room => room.section, false)).toBeDefined()
  })
  it('has no headings while searching, however many match', () => {
    expect(groupRooms(rooms, room => room.section, true)).toBeUndefined()
  })
})

describe('pinnedFirst', () => {
  it('moves pinned rooms up and keeps both orders', () => {
    expect(pinnedFirst([1, 2, 3, 4, 5], n => n % 2 === 0)).toEqual([2, 4, 1, 3, 5])
  })
})

describe('headings and avatars', () => {
  it('counts a folded section', () => {
    expect(sectionHeading('older', 14, true)).toBe('Older · 14')
    expect(sectionHeading('older', 14, false)).toBe('Older')
  })
  it('picks one of eight colours from the room id', () => {
    expect(avatarSlot('0a' + '0'.repeat(62))).toBe(2)
    expect(avatarSlot('ff' + '0'.repeat(62))).toBe(7)
  })
  it('shows the first letter or digit, or # when there is none', () => {
    expect(avatarInitial('book club')).toBe('B')
    expect(avatarInitial('  2027 trip')).toBe('2')
    expect(avatarInitial('Élan')).toBe('É')
    expect(avatarInitial('🎉 —')).toBe('#')
  })
})
