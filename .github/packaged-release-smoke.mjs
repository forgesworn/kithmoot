import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import WebSocket from 'ws'

const [file, expectedPlatform, expectedArch, expectedVersion] = process.argv.slice(2)
assert.ok(file && expectedPlatform && expectedArch && expectedVersion)
const profile = await mkdtemp(join(tmpdir(), 'km-packaged-'))
const backendPort = Number(process.env.RELAY_PORT ?? 4591)
const backendAddress = 'ws://127.0.0.1:' + backendPort
const home = 'https://kithmoot.forgesworn.dev/j/'
const relay = 'wss://local-fixture.example/'
const relayServer = spawn(process.execPath, [resolve('ws-relay.mjs')], {
  env: { ...process.env, RELAY_PORT: String(backendPort), RELAY_HOST: '127.0.0.1' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
let app
const sockets = new Set()
try {
  let healthy = false
  for (let attempt = 0; attempt < 50 && !healthy; attempt++) {
    healthy = await fetch('http://127.0.0.1:' + backendPort).then(response => response.ok).catch(() => false)
    if (!healthy) await delay(100)
  }
  assert.ok(healthy, 'The loopback relay did not start')
  app = await electron.launch({
    executablePath: resolve(file),
    args: ['--disable-gpu', '--user-data-dir=' + profile, ...(process.env.SMOKE_NO_SANDBOX ? ['--no-sandbox'] : [])],
    timeout: 30000,
  })
  const platform = await app.evaluate(({ app }) => ({
    platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged,
  }))
  assert.deepEqual(platform, { platform: expectedPlatform, arch: expectedArch, version: expectedVersion, packaged: true })
  const page = await app.firstWindow()
  const context = app.context()
  await context.routeWebSocket(url => url.href !== relay, socket => socket.close())
  let acknowledgements = 0
  await context.routeWebSocket(relay, socket => {
    const backend = new WebSocket(backendAddress)
    sockets.add(backend)
    const queued = []
    socket.onMessage(message => {
      if (backend.readyState === WebSocket.OPEN) backend.send(message)
      else queued.push(message)
    })
    backend.on('open', () => { for (const message of queued.splice(0)) backend.send(message) })
    backend.on('message', message => {
      const frame = JSON.parse(message.toString())
      if (frame[0] === 'OK' && frame[2] === true) acknowledgements++
      socket.send(message.toString())
    })
    backend.on('close', () => { sockets.delete(backend); socket.close() })
    backend.on('error', () => socket.close())
    socket.onClose(() => backend.close())
  })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === new URL(home).origin ? route.continue() : route.abort()
  })
  const key = generateSecretKey()
  await context.exposeFunction('smokePublicKey', () => getPublicKey(key))
  await context.exposeFunction('smokeSignEvent', template => finalizeEvent(template, key))
  await context.addInitScript(relay => {
    Object.defineProperty(window, 'nostr', { value: { getPublicKey: window.smokePublicKey, signEvent: window.smokeSignEvent } })
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }))
  }, relay)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 640))
  await page.goto(home + '?signin=nostr', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.getByRole('button', { name: /Browser extension/ }).click({ timeout: 30000 })
  const avatar = page.getByRole('button', { name: /^Account menu for / })
  await expect(avatar).toBeVisible({ timeout: 15000 })
  await avatar.hover()
  await expect(page.locator('#railPersonaTip')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#railPersonaTip')).toBeHidden()
  await avatar.click()
  const dialog = page.getByRole('dialog', { name: 'Personas' })
  await expect(dialog.getByText('Current persona')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  if (await page.locator('#newRoom').isVisible()) await page.locator('#newRoom').click()
  else {
    await page.locator('#newMenuButton').click()
    await page.locator('#newMenuRoom').click()
  }
  await page.locator('#roomName').fill('Platform review')
  if (await page.locator('#newRoomYourName').isVisible()) await page.locator('#newRoomYourName').fill('Release check')
  await page.locator('#create').click()
  await expect(page.locator('#roomArea')).toBeVisible({ timeout: 25000 })
  const before = acknowledgements
  await page.locator('#chatInput').fill('Message from the packaged desktop')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('#chatLog')).toContainText('Message from the packaged desktop')
  await expect(page.locator('#chatLog').getByText('Sending…', { exact: true })).toBeHidden({ timeout: 15000 })
  await expect.poll(() => acknowledgements, { timeout: 15000 }).toBeGreaterThan(before)
  const renderer = await page.evaluate(() => performance.getEntriesByType('resource').find(entry => /assets\/main-.*\.js$/.test(entry.name))?.name)
  assert.ok(renderer, 'The renderer build asset was not observed')
  console.log(JSON.stringify({ ...platform, renderer, avatar: true, keyboardDismissal: true, chatRelayAcknowledged: true }))
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy() }).catch(() => {})
    await app.close().catch(() => {})
  }
  for (const socket of sockets) socket.terminate()
  relayServer.kill()
}
