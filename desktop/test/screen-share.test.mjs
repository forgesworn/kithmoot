import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerDisplayRequest, screenAccessGranted, refuse } from '../screen-share.mjs'

const source = { id: 'screen:1', name: 'Entire screen' }
const recorder = () => {
  const calls = []
  const callback = (...args) => {
    calls.push(args)
    // What Electron 44 does with an empty selection.
    if (args.length && !args[0].video) throw new TypeError('Video was requested, but no video stream was provided')
  }
  return { calls, callback }
}
const deps = overrides => ({ allowed: () => true, screenAccessGranted: async () => true, listSources: async () => [source], choose: (_s, chosen) => chosen(source), ...overrides })

test('a chosen source is shared', async () => {
  const { calls, callback } = recorder()
  await answerDisplayRequest({}, callback, deps())
  assert.deepEqual(calls, [[{ video: source }]])
})

test('every refusal answers once, without an empty selection', async () => {
  for (const override of [
    { allowed: () => false },
    { screenAccessGranted: async () => false },
    { listSources: async () => [] },
    { listSources: async () => { throw new Error('capturer failed') } },
    { choose: (_s, chosen) => { chosen(); chosen(source) } },
  ]) {
    const { calls, callback } = recorder()
    await answerDisplayRequest({}, callback, deps(override))
    assert.deepEqual(calls, [[]])
  }
})

test('refuse swallows a callback that was already answered', () => {
  assert.doesNotThrow(() => refuse(() => { throw new Error('already answered') }))
})

test('macOS without Screen Recording permission explains, and only opens Settings when asked', async () => {
  const seen = []
  const base = {
    platform: 'darwin', status: () => 'denied',
    listSources: async () => { seen.push('sources'); return [] },
    openSettings: async () => { seen.push('settings') },
  }
  assert.equal(await screenAccessGranted({ ...base, askToOpenSettings: async () => false }), false)
  assert.deepEqual(seen, [])
  assert.equal(await screenAccessGranted({ ...base, askToOpenSettings: async () => true }), false)
  assert.deepEqual(seen, ['sources', 'settings'])
})

test('granted macOS and other platforms go straight to the picker', async () => {
  const never = async () => { throw new Error('should not ask') }
  assert.equal(await screenAccessGranted({ platform: 'darwin', status: () => 'granted', askToOpenSettings: never }), true)
  assert.equal(await screenAccessGranted({ platform: 'linux', status: () => 'denied', askToOpenSettings: never }), true)
})
