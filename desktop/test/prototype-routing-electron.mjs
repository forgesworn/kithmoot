// Offline integration check of the real desktop entry point, before its first
// page script creates a peer connection. No camera, microphone or VPN changes.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { _electron as electron, expect } from '@playwright/test'
import { stopIsolatedApp } from './isolated-app.mjs'
import { PROTOTYPE_IP_POLICY } from '../prototype-routing.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const executablePath = process.env.ELECTRON_EXECUTABLE
assert.ok(executablePath && isAbsolute(executablePath), 'Supply an Electron test executable')
const fixture = await mkdtemp(join(tmpdir(), 'kithmoot-routing-'))
const appDir = join(fixture, 'app')
const results = []
let app, appChild, profile, rejectedChild
async function stopCurrentApp() {
  if (!app) return
  // Playwright drops its process dispatcher after an expected native exit.
  const current = app
  await stopIsolatedApp({ process: () => appChild, close: () => current.close() }, profile)
  app = undefined
  appChild = undefined
}
try {
  await mkdir(join(appDir, 'web'), { recursive: true })
  for (const name of await readdir(desktop)) {
    if (/\.(mjs|cjs)$/.test(name) || name === 'package.json') await copyFile(join(desktop, name), join(appDir, name))
  }
  const pkg = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'))
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ ...pkg, main: 'routing-fixture.mjs' }))
  await writeFile(join(appDir, 'web/index.html'), '<!doctype html><title>Routing fixture</title><script src="/j/fixture.js"></script>')
  await writeFile(join(appDir, 'web/fixture.js'), 'window.fixturePeer = new RTCPeerConnection({ iceServers: [] }); window.fixtureReady = true;')
  await writeFile(join(appDir, 'routing-fixture.mjs'), `
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
globalThis.routingVisits = []
app.on('web-contents-created', (_event, contents) => {
  if (process.env.ROUTING_FIXTURE_REJECT === '1' || globalThis.routingRejectPolicy) contents.setWebRTCIPHandlingPolicy = () => { throw new Error('Fixture policy unavailable') }
  contents.on('did-start-navigation', (_event, url) => {
    globalThis.routingVisits.push({ url, policy: contents.getWebRTCIPHandlingPolicy() })
    writeFileSync(process.env.ROUTING_FIXTURE_VISITS, JSON.stringify(globalThis.routingVisits))
  })
})
await import('./main.mjs')
`)
  for (const requested of [undefined, 'true', '1']) {
    profile = join(fixture, `kithmoot-profile-${requested ?? 'unset'}`)
    const env = { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile, ROUTING_FIXTURE_VISITS: join(fixture, 'visits.json') }
    delete env.KITHMOOT_DESKTOP_PROTON_ROUTING
    delete env.KITHMOOT_DESKTOP_SPRY_CONFIG
    delete env.ROUTING_FIXTURE_REJECT
    if (requested !== undefined) env.KITHMOOT_DESKTOP_PROTON_ROUTING = requested
    const policy = requested === '1' ? PROTOTYPE_IP_POLICY : 'default'
    app = await electron.launch({ executablePath, args: [appDir], env, timeout: 30000 })
    appChild = app.process()
    let page = await app.firstWindow()
    const check = async () => {
      await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true)
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getWebRTCIPHandlingPolicy()), policy)
      const visits = await app.evaluate(() => globalThis.routingVisits)
      assert.ok(visits.length > 0)
      assert.ok(visits.every(visit => visit.policy === policy), 'Policy must be set before every navigation')
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    }
    await check()
    await page.reload()
    await check()
    await app.evaluate(({ app }) => app.emit('open-url', { preventDefault() {} }, 'kithmoot://join?prototype=1#synthetic'))
    await expect(page).toHaveURL(/prototype=1#synthetic$/)
    await check()
    if (process.platform === 'darwin') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy())
      const nextWindow = app.waitForEvent('window')
      await app.evaluate(({ app }) => app.emit('activate'))
      page = await nextWindow
      await check()
    }
    results.push({ requested: requested ?? 'unset', policy, reload: true, invitation: true, recreated: process.platform === 'darwin' })
    if (process.platform === 'darwin' && requested === '1') {
      const before = await app.evaluate(() => globalThis.routingVisits.length)
      await app.evaluate(({ app, BrowserWindow }) => {
        globalThis.routingRejectPolicy = true
        BrowserWindow.getAllWindows()[0].destroy()
        app.emit('activate')
      }).catch(() => {}) // The controlled exit can close the evaluation pipe.
      await expect.poll(() => appChild.exitCode).toBe(1)
      assert.equal(JSON.parse(await readFile(env.ROUTING_FIXTURE_VISITS, 'utf8')).length, before)
      results.push({ rejectedRecreatedWindow: true, exitCode: 1, navigationPrevented: true })
    }
    await stopCurrentApp()
  }
  // A requested policy that Electron cannot apply exits before navigation.
  profile = join(fixture, 'kithmoot-profile-rejected')
  const visitsFile = join(fixture, 'rejected-visits.json')
  rejectedChild = spawn(executablePath, [appDir], { env: {
    ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile, KITHMOOT_DESKTOP_PROTON_ROUTING: '1',
    KITHMOOT_DESKTOP_SPRY_CONFIG: '', ROUTING_FIXTURE_REJECT: '1', ROUTING_FIXTURE_VISITS: visitsFile,
  }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  rejectedChild.stderr.on('data', data => { stderr += data })
  let timer
  try {
    const exit = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Rejected policy did not stop the app')), 30000)
      rejectedChild.once('error', reject)
      rejectedChild.once('exit', (code, signal) => resolve({ code, signal }))
    })
    assert.deepEqual(exit, { code: 1, signal: null })
    assert.match(stderr, /Desktop startup failed: Fixture policy unavailable/)
  } finally {
    clearTimeout(timer)
  }
  await assert.rejects(readFile(visitsFile), { code: 'ENOENT' })
  results.push({ rejectedPolicy: true, navigationPrevented: true })
  console.log(JSON.stringify({ status: 'pass', scope: 'offline desktop policy lifecycle; no route or media claim', results }, null, 2))
} finally {
  if (rejectedChild && rejectedChild.exitCode === null && rejectedChild.signalCode === null) rejectedChild.kill('SIGKILL')
  await stopCurrentApp()
  await rm(fixture, { recursive: true, force: true })
}
