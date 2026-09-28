import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerDisplayRequest, displayChoice, screenAccessGranted, refuse } from '../screen-share.mjs'
import { captureOf } from '../redaction-geometry.mjs'

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

test('a successful share can add loopback audio to the final selection', async () => {
  const { calls, callback } = recorder()
  await answerDisplayRequest({ audioRequested: true }, callback, {
    ...deps(),
    selection: selected => ({ video: selected, audio: 'loopback' }),
  })
  assert.deepEqual(calls, [[{ video: source, audio: 'loopback' }]])
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

// The desktop chooser, driven with fake sources and a menu that clicks for us.
const displays = [{ id: 1 }, { id: 2 }]
const screens = [{ id: 'screen:1:0', display_id: '1', name: 'Screen 1' }, { id: 'screen:2:0', display_id: '2', name: 'Screen 2' }]
const windows = [{ id: 'window:77:0', display_id: '', name: 'Notes' }]
const fakeRedaction = on => ({ capture: 'untouched', anyOn: () => on, captured(chosen) { this.capture = captureOf(chosen, displays) } })
const chooser = (redaction, click) => {
  const shown = []
  const deps = displayChoice({
    request: {}, platform: 'darwin', areaMode: 'frame', redaction,
    screenAccessGranted: async () => true, listSources: async () => [...screens, ...windows],
    showMenu: (items, cancel) => { shown.push(...items); const item = click(items); if (item) item.click(); else cancel() },
  })
  return { deps, shown }
}

test('while a box is on, only whole screens are offered and the chosen display is recorded', async () => {
  const redaction = fakeRedaction(true)
  const { deps, shown } = chooser(redaction, items => items.find(item => item.source?.id === 'screen:2:0'))
  const { calls, callback } = recorder()
  await answerDisplayRequest({}, callback, deps)
  assert.deepEqual(shown.filter(item => item.source).map(item => item.source.id), ['screen:1:0', 'screen:2:0'])
  // The windows left out are counted, so the list does not look complete.
  assert.ok(shown.some(item => item.enabled === false && item.label.startsWith('1 window is not listed')))
  assert.deepEqual(calls, [[{ video: screens[1] }]])
  assert.deepEqual(redaction.capture, { kind: 'screen', displayId: '2' })
})

test('with no box on, windows are offered, and a chosen window is recorded as a window', async () => {
  const redaction = fakeRedaction(false)
  const { deps, shown } = chooser(redaction, items => items.find(item => item.source?.id === 'window:77:0'))
  const { calls, callback } = recorder()
  await answerDisplayRequest({}, callback, deps)
  assert.ok(!shown.some(item => item.label.includes('not listed')))
  assert.deepEqual(calls, [[{ video: windows[0] }]])
  assert.deepEqual(redaction.capture, { kind: 'window' })
})

test('cancelling the chooser refuses and records nothing', async () => {
  const redaction = fakeRedaction(true)
  const { deps } = chooser(redaction, () => undefined)
  const { calls, callback } = recorder()
  await answerDisplayRequest({}, callback, deps)
  assert.deepEqual(calls, [[]])
  assert.equal(redaction.capture, 'untouched')
})
