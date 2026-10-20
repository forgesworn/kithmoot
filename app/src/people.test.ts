// No DOM in this workspace's vitest (environment: 'node'); the contact page
// is proven in the browser by test/people.spec.ts. This covers its day words.
import { expect, it } from 'vitest'
import { dayWords } from './people.js'

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000)

it('says Today, Yesterday, a weekday, then a date, by the calendar day', () => {
  const now = new Date(2026, 9, 20, 9, 30).getTime()
  expect(dayWords(seconds(new Date(2026, 9, 20, 0, 5)), now)).toBe('Today')
  // A clock slightly ahead of ours is still today, never "in the future".
  expect(dayWords(seconds(new Date(2026, 9, 20, 9, 31)), now)).toBe('Today')
  expect(dayWords(seconds(new Date(2026, 9, 19, 23, 55)), now)).toBe('Yesterday')
  const fiveDays = new Date(2026, 9, 15, 12, 0)
  expect(dayWords(seconds(fiveDays), now)).toBe(fiveDays.toLocaleDateString(undefined, { weekday: 'short' }))
  const lastMonth = new Date(2026, 8, 19, 12, 0)
  expect(dayWords(seconds(lastMonth), now)).toBe(lastMonth.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))
  expect(dayWords(seconds(new Date(2025, 8, 19, 12, 0)), now)).toContain('2025')
})
