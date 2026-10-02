import { expect, test } from 'vitest'
import { isSignerTimeout } from './signer-timeout.js'

test('a bunker that never answered is a signer timeout', () => {
  expect(isSignerTimeout(new Error('nip46-sign_event-timeout'))).toBe(true)
  expect(isSignerTimeout(new Error('Could not sign: nip46-nip44_decrypt-timeout.'))).toBe(true)
  expect(isSignerTimeout('nip46-connect-timeout')).toBe(true)
})

test('a relay refusing the request, or the room failing, is not', () => {
  expect(isSignerTimeout(new Error('nip46-sign_event-publish-failed'))).toBe(false)
  expect(isSignerTimeout(new Error('no relay could be reached in time'))).toBe(false)
  expect(isSignerTimeout(new Error('timeout'))).toBe(false)
  expect(isSignerTimeout(undefined)).toBe(false)
})
