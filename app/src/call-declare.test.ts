import { expect, test } from 'vitest'
import { callToDeclare } from './call-declare.js'

const fresh = () => 'fresh'

test('joins the call that is on, asked or not', () => {
  expect(callToDeclare('call-a', false, fresh)).toBe('call-a')
  expect(callToDeclare('call-a', true, fresh)).toBe('call-a')
})

test('starts a call only when the person asked for one', () => {
  expect(callToDeclare(undefined, true, fresh)).toBe('fresh')
})

test('never starts a call on its own', () => {
  expect(callToDeclare(undefined, false, fresh)).toBeUndefined()
})
