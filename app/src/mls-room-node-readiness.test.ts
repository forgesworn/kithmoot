import { expect, test } from 'vitest'
import { nodeAuthenticationHeld } from './mls-room-node-readiness.js'
test('unavailable transport preserves its state without advising device re-enrolment', () => {
  const held = nodeAuthenticationHeld({ state: 'unavailable' })
  expect(held.nodeAuthentication).toEqual({ state: 'unavailable' })
  expect(held.reason).toContain('connection')
  expect(held.reason).not.toMatch(/enrol/i)
})
test('unsupported node capabilities remain distinct from transport failure', () => {
  expect(nodeAuthenticationHeld({ state: 'malformed' })).toMatchObject({ nodeAuthentication: { state: 'malformed' }, reason: expect.stringContaining('supported version') })
})
test('node refusal retains validated status and code without blaming the device', () => {
  const held = nodeAuthenticationHeld({ state: 'refused', status: 403, code: 'authority', serverTime: 100 })
  expect(held.nodeAuthentication).toEqual({ state: 'refused', status: 403, code: 'authority' })
  expect(held.reason).toContain('keeper')
  expect(held.reason).not.toMatch(/enrol/i)
})
test('declined local scope and witnessed signing readiness are separately actionable', () => {
  const denied = nodeAuthenticationHeld({ state: 'not-signed', reason: 'denied' })
  const pending = nodeAuthenticationHeld({ state: 'not-signed', reason: 'witness-pending' })
  expect(denied.nodeAuthentication).toEqual({ state: 'not-signed', refusal: 'denied' })
  expect(denied.reason).toContain('not approved')
  expect(pending.nodeAuthentication).toEqual({ state: 'not-signed', refusal: 'witness-pending' })
  expect(pending.reason).toContain('witness settings')
})

test.each([
  { state: 'unavailable' as const, expected: 'connection' },
  { state: 'malformed' as const, expected: 'unsupported MLS capability reply' },
  { state: 'refused' as const, status: 403, code: 'authority', serverTime: 100, expected: 'keeper' },
  { state: 'not-signed' as const, reason: 'denied' as const, expected: 'not approved' },
  { state: 'not-signed' as const, reason: 'witness-pending' as const, expected: 'witness settings' },
])('normal invitation failure advice is static, held and safe to display: $state', ({ expected, ...answer }) => {
  const opaque = 'private-payload-identifier-must-not-enter-status'
  const input = Object.freeze({ ...answer, body: opaque, error: opaque, identifier: opaque })
  const held = nodeAuthenticationHeld(input)
  expect(held.state).toBe('held')
  expect(held.nodeAuthentication.state).toBe(answer.state)
  expect(held.reason).toContain(expected)
  expect(held.reason).not.toContain(opaque)
  expect(held.reason).not.toMatch(/create.*room|enrol|approved automatically|permission granted/i)
  expect(input).toEqual({ ...answer, body: opaque, error: opaque, identifier: opaque })
})
