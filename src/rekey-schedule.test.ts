import { describe, expect, it } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import {
  REKEY_JITTER_SECONDS,
  capRecipients,
  eventFrameBytes,
  orderRecipients,
  rekeyDue,
  rekeyDueAt,
  rekeyJitter,
  spokeSince,
} from './rekey-schedule.js'

const DAY = 86_400
const WEEK = 7 * DAY
const keeper = 'aa'.repeat(32)
const ada = 'bb'.repeat(32)
const epochId = 'cd'.repeat(32)
const epochAt = 1_800_000_000

describe('rekey schedule', () => {
  it('is not due after seven days with nobody speaking', () => {
    const now = epochAt + WEEK + REKEY_JITTER_SECONDS
    expect(rekeyDue({ now, epochAt, periodSeconds: WEEK, epochId, keeper, messages: [] })).toBe(false)
    // What was said before the epoch began is not speech since.
    expect(rekeyDue({ now, epochAt, periodSeconds: WEEK, epochId, keeper, messages: [{ participant: ada, sentAt: epochAt }] })).toBe(false)
  })

  it('is not due when only the keeper has spoken', () => {
    const now = epochAt + WEEK + REKEY_JITTER_SECONDS
    const messages = [{ participant: keeper, sentAt: epochAt + 10 }, { participant: keeper.toUpperCase(), sentAt: epochAt + 20 }]
    expect(rekeyDue({ now, epochAt, periodSeconds: WEEK, epochId, keeper, messages })).toBe(false)
    expect(spokeSince(messages, epochAt, keeper)).toBe(false)
  })

  it('is due once the period and its jitter are up and somebody else has spoken, and not a second sooner', () => {
    const messages = [{ participant: ada, sentAt: epochAt + 10 }]
    const due = rekeyDueAt(epochAt, WEEK, epochId)
    expect(due).toBe(epochAt + WEEK + rekeyJitter(epochId))
    expect(rekeyDue({ now: due - 1, epochAt, periodSeconds: WEEK, epochId, keeper, messages })).toBe(false)
    expect(rekeyDue({ now: due, epochAt, periodSeconds: WEEK, epochId, keeper, messages })).toBe(true)
    // Long overdue is still one rekey's worth: due, not due several times.
    expect(rekeyDue({ now: due + 10 * WEEK, epochAt, periodSeconds: WEEK, epochId, keeper, messages })).toBe(true)
  })

  it('is never due with the cadence off', () => {
    const messages = [{ participant: ada, sentAt: epochAt + 10 }]
    for (const periodSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rekeyDue({ now: epochAt + 100 * WEEK, epochAt, periodSeconds, epochId, keeper, messages })).toBe(false)
    }
  })

  it('jitters by a hash of the epoch id: deterministic, under six hours, and spread', () => {
    expect(rekeyJitter(epochId)).toBe(rekeyJitter(epochId))
    expect(rekeyJitter(epochId)).toBe(rekeyJitter(epochId.toUpperCase()))
    const jitters = new Set<number>()
    for (let i = 0; i < 64; i++) {
      const j = rekeyJitter(i.toString(16).padStart(64, '0'))
      expect(Number.isInteger(j)).toBe(true)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThan(REKEY_JITTER_SECONDS)
      jitters.add(j)
    }
    expect(jitters.size).toBeGreaterThan(60)
  })

  it('orders the roster first, then the window most recently seen first, each device once', () => {
    const online = [{ device: 'd1' }, { device: 'd2' }, { device: 'D1' }]
    const recent = [
      { device: 'd3', seen: 100 },
      { device: 'd2', seen: 900 },
      { device: 'd4', seen: 500 },
    ]
    expect(orderRecipients(online, recent).map((r) => r.device)).toEqual(['d1', 'd2', 'd4', 'd3'])
  })

  it('cuts recipients from the back until the event fits, and cuts nothing that already does', () => {
    const fake = (n: number): Event => ({ id: '', pubkey: '', sig: '', kind: 1462, created_at: 0, tags: [], content: 'x'.repeat(200 + n * 370) })
    const ordered = Array.from({ length: 300 }, (_, i) => i)
    let encodes = 0
    const encode = (r: readonly number[]) => {
      encodes++
      return fake(r.length)
    }
    const { event, kept } = capRecipients(ordered, encode, 64 * 1024)
    expect(eventFrameBytes(event)).toBeLessThanOrEqual(64 * 1024)
    expect(eventFrameBytes(fake(kept + 1))).toBeGreaterThan(64 * 1024)
    expect(encodes).toBeLessThan(8)
    expect(capRecipients(ordered.slice(0, 10), encode, 64 * 1024).kept).toBe(10)
    // A member list too long on its own: cutting copies would not help.
    const huge = (r: readonly number[]): Event => ({ ...fake(r.length), content: 'x'.repeat(70_000 + r.length) })
    expect(capRecipients(ordered, huge, 64 * 1024).kept).toBe(300)
  })
})
