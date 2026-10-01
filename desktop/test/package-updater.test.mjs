import test from 'node:test'
import assert from 'node:assert/strict'
import { createPackageUpdater, readPackageVersion, packageVersionFile } from '../package-updater.mjs'

function fixture(versions) {
  const calls = { notified: [], relaunches: 0, intervals: new Map() }
  let installed = versions
  const updater = createPackageUpdater({
    currentVersion: '0.1.32',
    installedVersion: () => installed,
    relaunch: () => { calls.relaunches++ },
    notify: value => calls.notified.push(value),
    setIntervalFn: callback => { calls.intervals.set(1, callback); return 1 },
    clearIntervalFn: id => calls.intervals.delete(id),
  })
  return { updater, calls, upgrade: version => { installed = version } }
}

test('a package upgraded under the running app offers a restart', () => {
  const { updater, calls, upgrade } = fixture('0.1.32')
  assert.equal(updater.start(), true)
  assert.equal(updater.state().phase, 'idle')
  assert.equal(calls.intervals.size, 1)
  upgrade('0.1.33')
  calls.intervals.get(1)()
  assert.deepEqual(updater.state(), { phase: 'ready', version: '0.1.33' })
  assert.deepEqual(calls.notified, [{ phase: 'ready', version: '0.1.33' }])
  assert.equal(calls.intervals.size, 0, 'stops looking once an update is waiting')
  assert.equal(updater.install(), true)
  assert.equal(updater.install(), false, 'one restart only')
  assert.equal(calls.relaunches, 1)
})

test('nothing is offered while the installed version is the running one, or unreadable', () => {
  for (const installed of ['0.1.32', undefined]) {
    const { updater, calls } = fixture(installed)
    updater.start()
    assert.equal(updater.check(), false)
    assert.equal(updater.install(), false)
    assert.deepEqual(calls.notified, [])
  }
})

test('the version stamp is read from beside the app and trimmed', () => {
  assert.equal(packageVersionFile('/opt/KithMoot/resources'), '/opt/KithMoot/resources/kithmoot-version')
  assert.equal(readPackageVersion('x', () => '0.1.33\n'), '0.1.33')
  assert.equal(readPackageVersion('x', () => { throw new Error('ENOENT') }), undefined)
  assert.equal(readPackageVersion('x', () => '  \n'), undefined)
})
