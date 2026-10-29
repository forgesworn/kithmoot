import { expect, it } from 'vitest'
import { DEPARTURE_GRACE_MS, PresenceAnnouncements } from './presence-announcements.js'

const tally = { participant: 'tally', name: 'Tally', agent: true }
const chip = { participant: 'chip', name: 'Chip', agent: true }

it('keeps short simultaneous reconnects out of chat without delaying the live roster', () => {
  const notices = new PresenceAnnouncements()
  expect(notices.update([tally, chip], 0, false)).toEqual([])
  expect(notices.update([], 30_000, true)).toEqual([])
  expect(notices.nextCheck).toBe(30_000 + DEPARTURE_GRACE_MS)
  expect(notices.update([tally, chip], 40_000, true)).toEqual([])
  expect(notices.nextCheck).toBeUndefined()
  expect(notices.update([tally, chip], 90_000, true)).toEqual([])
})

it('announces a sustained departure once and a later return once', () => {
  const notices = new PresenceAnnouncements()
  notices.update([tally], 0, false)
  notices.update([], 30_000, true)
  expect(notices.update([], 60_000, true)).toEqual([{ person: tally, arrived: false }])
  expect(notices.update([], 90_000, true)).toEqual([])
  expect(notices.update([tally], 100_000, true)).toEqual([{ person: tally, arrived: true }])
})

it('suppresses replay population and preserves independent departures and name changes', () => {
  const notices = new PresenceAnnouncements()
  notices.update([], 0, false)
  expect(notices.update([tally], 10_000, false)).toEqual([])
  const renamed = { ...tally, name: 'Tally updated' }
  expect(notices.update([renamed, chip], 30_000, true)).toEqual([{ person: chip, arrived: true }])
  notices.update([chip], 40_000, true)
  notices.update([], 50_000, true)
  expect(notices.update([], 70_000, true)).toEqual([{ person: renamed, arrived: false }])
  expect(notices.nextCheck).toBe(80_000)
  expect(notices.update([chip], 75_000, true)).toEqual([])
})

it('announces the first guest when a creator first hears a roster containing that guest', () => {
  const notices = new PresenceAnnouncements(true)
  expect(notices.update([chip], 1_000, true)).toEqual([{ person: chip, arrived: true }])
  expect(notices.update([chip], 2_000, true)).toEqual([])
})

it('still treats an established room’s first settled roster as replay', () => {
  const notices = new PresenceAnnouncements()
  expect(notices.update([chip], 1_000, true)).toEqual([])
  expect(notices.update([chip, tally], 2_000, true)).toEqual([{ person: tally, arrived: true }])
})
