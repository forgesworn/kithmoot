// Run inside the disposable Linux/Xvfb test container. --no-sandbox is confined
// to this root-owned container; shipped launchers never disable the sandbox.
const { _electron: electron } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const launch = () => electron.launch({ executablePath: '/tmp/kithmoot-linux-installed/kithmoot-desktop/kithmoot', args: ['--no-sandbox', '--user-data-dir=/tmp/kithmoot-smoke-profile'], timeout: 60000 })
let app = await launch()
try {
  const page = await app.firstWindow()
  await page.locator('#create').waitFor({ timeout: 30000 })
  const state = await page.evaluate(() => ({ secure: isSecureContext, node: typeof window.require, process: typeof window.process, bridge: Object.keys(window.kithmootDesktop ?? {}) }))
  assert.equal(state.secure, true)
  assert.equal(state.node, 'undefined')
  assert.equal(state.process, 'undefined')
  assert.deepEqual(state.bridge, ['supportsShareArea', 'armShareArea', 'shareAreaState', 'shareAreaAction', 'onShareAreaState', 'setUnread', 'notify', 'onOpenRoom', 'setCallActive', 'updateState', 'installUpdate', 'onUpdateState'])
  // --no-sandbox relaxes the preload's require; test/platform-features.test.mjs keeps it to electron.
  assert.equal(await page.evaluate(() => window.kithmootDesktop.supportsShareArea), true)
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), version)
  await page.evaluate(() => {
    window.kithmootDesktop.onOpenRoom(roomId => { window.testOpenedRoom = roomId })
    window.kithmootDesktop.setUnread(7)
    window.kithmootDesktop.notify({ title: 'Synthetic Workshop', body: 'Synthetic sender said something', tag: 'test-room', roomId: 'a'.repeat(64), silent: true })
  })
  const deadline = Date.now() + 10000
  let log = ''
  while (Date.now() < deadline) {
    log = await readFile('/tmp/kithmoot-dbus.log', 'utf8')
    if (log.includes('Synthetic Workshop') && log.includes('count-visible')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.match(log, /Synthetic Workshop/)
  assert.match(log, /Synthetic sender said something/)
  assert.match(log, /application:\/\/dev\.forgesworn\.kithmoot\.desktop/)
  assert.match(log, /int64 7/)
  assert.match(log, /count-visible/)
  await page.screenshot({ path: '/tmp/kithmoot-linux-home.png' })
  await page.evaluate(() => localStorage.setItem('linux-smoke-profile', 'synthetic'))
  const install = () => spawnSync('python3', ['/tmp/KithMoot-linux-arm64/install.py'], { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: '/tmp/kithmoot-linux-installed' } })
  const running = install()
  assert.notEqual(running.status, 0)
  assert.match(running.stderr, /Please quit KithMoot/)
  await app.close()
  const replaced = install()
  assert.equal(replaced.status, 0, replaced.stderr)
  app = await launch()
  const reopened = await app.firstWindow()
  await reopened.locator('#create').waitFor({ timeout: 30000 })
  assert.equal(await reopened.evaluate(() => localStorage.getItem('linux-smoke-profile')), 'synthetic')
  console.log('PASS Linux ARM64 packaged startup, version, secure renderer, restricted bridge, native notification D-Bus body and launcher badge count=7, running-app replacement refused and profile preserved after update')
} finally { await app.close() }
