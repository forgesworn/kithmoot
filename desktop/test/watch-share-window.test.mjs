import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as later } from 'node:timers/promises'
import { watchShareWindow } from '../watch-share-window.mjs'

test('watcher accepts only a native capture id and never an executable from the renderer', () => {
  for (const id of ['', undefined, 'window:0:0', 'screen:123:0', 'window:123:0;bad', '../../bin/sh']) {
    const reports = []
    const dispose = watchShareWindow(id, rect => reports.push(rect), { launch: () => assert.fail('invalid id spawned') })
    dispose(); assert.deepEqual(reports, [null])
  }
})
test('watcher drops malformed geometry, hides when stale and survives minimisation', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { child.killed = true }
  const reports = []
  const dispose = watchShareWindow('window:123:0', rect => reports.push(rect), {
    packaged: true, platform: 'win32', resources: '/trusted/resources',
    launch: (file, args, options) => {
      assert.equal(file, '/trusted/resources/window-helper/share-window.exe')
      assert.deepEqual(args, ['123']); assert.equal(options.windowsHide, true)
      return child
    },
  })
  const bounds = { x: -1600, y: 30, width: 800, height: 450 }
  child.stdout.write(JSON.stringify(bounds) + '\nnull\n{"width":-1}\nnot json\n')
  await later(5)
  assert.deepEqual(reports, [bounds, null, null, null])
  child.stdout.write(JSON.stringify(bounds) + '\n')
  await later(500)
  assert.equal(reports.at(-1), null, 'hung helper hides the overlay')
  child.stdout.write(JSON.stringify(bounds) + '\n')
  await later(5)
  assert.deepEqual(reports.at(-1), bounds, 'restoring the selected window returns bounds')
  dispose()
  const count = reports.length
  child.emit('error', new Error('late spawn error after teardown'))
  child.stdout.write(JSON.stringify(bounds) + '\n')
  assert.equal(child.killed, true)
  assert.equal(reports.length, count, 'stopped watcher cannot revive an overlay')
  child.stdout.destroy()
})
