import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLocalAddressPolicy, LOCAL_ADDRESS_POLICY } from '../local-address-policy.mjs'

test('every window gets the policy and it is read back, with no opt-in', () => {
  const calls = []
  const contents = {
    setWebRTCIPHandlingPolicy: value => calls.push(value),
    getWebRTCIPHandlingPolicy: () => { calls.push('read'); return LOCAL_ADDRESS_POLICY },
  }
  assert.equal(LOCAL_ADDRESS_POLICY, 'default_public_interface_only')
  assert.equal(applyLocalAddressPolicy(contents), undefined)
  assert.deepEqual(calls, [LOCAL_ADDRESS_POLICY, 'read'])
})

test('an unconfirmed or unsupported policy is refused', () => {
  for (const contents of [
    {},
    { setWebRTCIPHandlingPolicy() {} },
    { setWebRTCIPHandlingPolicy() { throw new Error('unsupported') } },
    { setWebRTCIPHandlingPolicy() {}, getWebRTCIPHandlingPolicy() { throw new Error('unavailable') } },
    { setWebRTCIPHandlingPolicy() {}, getWebRTCIPHandlingPolicy() { return 'default' } },
  ]) assert.throws(() => applyLocalAddressPolicy(contents))
})
