import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPrototypeRouting, PROTOTYPE_IP_POLICY } from '../prototype-routing.mjs'

test('only an exact development opt-in applies the routing prototype', () => {
  for (const packaged of [true, false]) {
    for (const requested of [undefined, '', '0', 'true', '1', 'default']) {
      const calls = []
      const enabled = !packaged && requested === '1'
      const contents = {
        setWebRTCIPHandlingPolicy: value => calls.push(value),
        getWebRTCIPHandlingPolicy: () => { calls.push('read'); return PROTOTYPE_IP_POLICY },
      }
      assert.equal(applyPrototypeRouting(contents, { packaged, requested }), enabled)
      assert.deepEqual(calls, enabled ? [PROTOTYPE_IP_POLICY, 'read'] : [])
    }
  }
})

test('a requested prototype refuses an unconfirmed or unsupported policy', () => {
  const options = { packaged: false, requested: '1' }
  for (const contents of [
    {},
    { setWebRTCIPHandlingPolicy() {} },
    { setWebRTCIPHandlingPolicy() { throw new Error('unsupported') } },
    { setWebRTCIPHandlingPolicy() {}, getWebRTCIPHandlingPolicy() { throw new Error('unavailable') } },
    { setWebRTCIPHandlingPolicy() {}, getWebRTCIPHandlingPolicy() { return 'default' } },
  ]) assert.throws(() => applyPrototypeRouting(contents, options))
})
