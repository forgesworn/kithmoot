import { describe, expect, it } from 'vitest'
import { DESTRUCT_AUTO_ATTEMPTS, DESTRUCT_RETRY_MAX_MS, DestructSchedule } from './destruct-schedule.js'

const MINUTE = 60_000

describe('DestructSchedule', () => {
  it('lets a room that never failed go at once', () => {
    expect(new DestructSchedule(() => 0).ready('r')).toBe(true)
  })

  it('waits 1 minute after a failure, doubling, and only the person after eight', () => {
    let now = 0
    const schedule = new DestructSchedule(() => now)
    const waits: number[] = []
    for (let i = 0; i < DESTRUCT_AUTO_ATTEMPTS; i++) {
      expect(schedule.ready('r')).toBe(true)
      schedule.failed('r')
      expect(schedule.ready('r')).toBe(false)
      waits.push((schedule.nextAt('r') - now) / MINUTE)
      now = schedule.nextAt('r')
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128])
    expect(schedule.manualOnly('r')).toBe(true)
    now += DESTRUCT_RETRY_MAX_MS * 10
    expect(schedule.ready('r')).toBe(false)
    // Opening the room or reloading starts again.
    schedule.reset('r')
    expect(schedule.ready('r')).toBe(true)
    expect(schedule.manualOnly('r')).toBe(false)
  })

  it('never waits more than 6 hours, and keeps rooms apart', () => {
    let now = 0
    const schedule = new DestructSchedule(() => now)
    for (let i = 0; i < 20; i++) schedule.failed('r')
    expect(schedule.nextAt('r') - now).toBe(DESTRUCT_RETRY_MAX_MS)
    expect(schedule.ready('other')).toBe(true)
  })
})
