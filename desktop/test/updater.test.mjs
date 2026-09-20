import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopUpdater, UPDATE_FEED } from '../updater.mjs'

function fixture(overrides = {}) {
  const native = new EventEmitter()
  const calls = { feed: [], checks: 0, installs: 0, logged: [], notified: [] }
  native.setFeedURL = value => calls.feed.push(value)
  native.checkForUpdates = () => { calls.checks++; return Promise.resolve() }
  native.quitAndInstall = () => { calls.installs++ }
  const timeouts = new Map(); const intervals = new Map(); let timer = 0
  const updater = createDesktopUpdater({
    autoUpdater: native, platform: 'darwin', arch: 'arm64', packaged: true,
    notify: value => calls.notified.push(value), log: error => calls.logged.push(error),
    setTimeoutFn: callback => { const id = ++timer; timeouts.set(id, callback); return id },
    clearTimeoutFn: id => timeouts.delete(id),
    setIntervalFn: callback => { const id = ++timer; intervals.set(id, callback); return id },
    clearIntervalFn: id => intervals.delete(id),
    ...overrides,
  })
  const fireInitial = () => {
    const [id, callback] = timeouts.entries().next().value
    timeouts.delete(id); callback()
  }
  return { updater, native, calls, timeouts, intervals, fireInitial }
}

test('only a packaged Apple Silicon Mac configures the signed update feed', () => {
  for (const override of [{ packaged: false }, { platform: 'linux' }, { arch: 'x64' }]) {
    const { updater, calls, timeouts } = fixture(override)
    assert.equal(updater.start(), false); assert.equal(updater.state().phase, 'disabled')
    assert.deepEqual(calls.feed, []); assert.equal(timeouts.size, 0)
  }
  const { updater, calls, timeouts } = fixture()
  assert.equal(updater.start(), true); assert.equal(updater.start(), false)
  assert.deepEqual(calls.feed, [{ url: UPDATE_FEED, serverType: 'json' }])
  assert.equal(timeouts.size, 1)
})

test('checks once after the delay then schedules one non-overlapping interval', () => {
  const { updater, calls, intervals, fireInitial } = fixture()
  updater.start(); fireInitial()
  assert.equal(calls.checks, 1); assert.equal(intervals.size, 1)
  assert.equal(updater.check(), false)
  updater.state().phase = 'idle'
  assert.equal(updater.state().phase, 'checking', 'state snapshots cannot mutate coordinator state')
})

test('native events expose fresh, bounded states and ready stops checks', () => {
  const { updater, native, calls, timeouts, intervals, fireInitial } = fixture()
  updater.start(); fireInitial()
  native.emit('update-available')
  assert.equal(updater.state().phase, 'downloading')
  native.emit('update-downloaded', {}, 'notes', '0.1.11')
  assert.deepEqual(updater.state(), { phase: 'ready', version: '0.1.11' })
  assert.equal(timeouts.size, 0); assert.equal(intervals.size, 0)
  assert.equal(updater.check(), false)
  native.emit('update-not-available')
  assert.equal(updater.state().phase, 'ready')
  calls.notified.at(-1).phase = 'tampered'
  assert.equal(updater.state().phase, 'ready')
})

test('feed setup failure leaves the app running with a retryable error state', () => {
  const { updater, native, calls, timeouts } = fixture()
  native.setFeedURL = () => { throw new Error('configuration failed') }
  assert.equal(updater.start(), false)
  assert.equal(updater.state().phase, 'error')
  assert.equal(calls.logged.length, 1); assert.equal(timeouts.size, 0)
  native.setFeedURL = value => calls.feed.push(value)
  assert.equal(updater.start(), true); assert.equal(timeouts.size, 1)
})

test('a rejected check becomes retryable without exposing its error', async () => {
  const { updater, native, calls } = fixture()
  native.checkForUpdates = () => { calls.checks++; return Promise.reject(new Error('private path')) }
  updater.start(); assert.equal(updater.check(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(updater.state(), { phase: 'error', message: 'Could not check for updates. KithMoot will try again.' })
  assert.equal(calls.logged.length, 1)
  native.checkForUpdates = () => { calls.checks++; return Promise.resolve() }
  assert.equal(updater.check(), true); native.emit('update-not-available')
  assert.deepEqual(updater.state(), { phase: 'idle' })
})

test('a downloaded update installs once and only after it is ready', () => {
  const { updater, native, calls } = fixture()
  updater.start(); assert.equal(updater.install(), false)
  native.emit('update-downloaded', {}, '', '')
  assert.equal(updater.install(), true); assert.equal(updater.install(), false)
  assert.equal(calls.installs, 1)
})
