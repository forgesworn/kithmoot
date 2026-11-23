import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createTcpServer, connect } from 'node:net'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { enterRoom } from './browser-room-entry.mjs'

const external = 'wss://relay.example.org/events'
const dist = resolve('app/dist')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.webp': 'image/webp', '.gif': 'image/gif' }
const appServer = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const file = resolve(dist, pathname.replace(/^\/j\//, '') || 'index.html')
  if (!file.startsWith(`${dist}/`) || !existsSync(file)) { response.writeHead(404); response.end(); return }
  response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream')
  response.end(readFileSync(file))
})
await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve))
const app = `http://127.0.0.1:${appServer.address().port}/j/`
const relayPort = await new Promise(resolve => {
  const listener = createTcpServer()
  listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)) })
})
const publicRelay = `ws://127.0.0.1:${relayPort}`
const relay = spawn(process.execPath, ['test/ws-relay.mjs'], { env: { ...process.env, RELAY_PORT: String(relayPort), RELAY_HOST: '127.0.0.1' }, stdio: 'ignore' })
for (let attempt = 0; attempt < 100; attempt++) {
  try { await new Promise((resolve, reject) => { const socket = connect(relayPort, '127.0.0.1', () => { socket.end(); resolve() }); socket.on('error', reject) }); break }
  catch { await new Promise(resolve => setTimeout(resolve, 50)) }
}
const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors', '--host-resolver-rules=MAP relay.example.org 127.0.0.1'] })
const contexts = [], errors = []
const stop = async code => {
  clearTimeout(deadline)
  relay.kill('SIGTERM')
  await Promise.allSettled(contexts.map(context => context.close()))
  await browser.close()
  appServer.close()
  process.exit(code)
}
const deadline = setTimeout(() => { void stop(124) }, 180_000)
const ownerKey = new Uint8Array(32).fill(1), guestKey = generateSecretKey()
async function device(key) {
  const context = await browser.newContext()
  contexts.push(context)
  await context.exposeFunction('fixturePublicKey', () => getPublicKey(key))
  await context.exposeFunction('fixtureSign', event => finalizeEvent(event, key))
  await context.addInitScript(publicRelay => {
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: publicRelay, read: true, write: true }] }))
    window.nostr = { getPublicKey: () => window.fixturePublicKey(), signEvent: event => window.fixtureSign(event) }
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        if (!['127.0.0.1', 'localhost', 'relay.example.org'].includes(new URL(url).hostname)) throw new Error('External signalling is disabled')
        super(url, protocols)
      }
    }
  }, publicRelay)
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${app}?signin=nostr`)
  await page.getByRole('button', { name: /Browser extension/ }).click()
  await page.locator('#openAppSettings').click()
  await page.locator('#settingsRowrelays').click()
  await page.locator('#bothySettingsOpen').click()
  await page.locator('#wokRelayUrl').fill(external)
  await page.locator('#wokRelaySave').click()
  await page.locator('#wokRelayStatus').filter({ hasText: 'Standalone relay saved' }).waitFor()
  await page.locator('#bothyClose').click()
  return page
}
async function openRouting(page) {
  await page.locator('#roomIdentity').click()
  await page.locator('#infoRowPrivacy').click()
  await page.locator('#roomBothySettings').click()
  await page.locator('#bothyRoomRoute option[value="standalone-wok"]').waitFor({ state: 'attached' })
  await page.locator('#bothyRoomRoute').selectOption('standalone-wok')
}
try {
  const owner = await device(ownerKey)
  await owner.locator('#newRoom:visible, #newMenuButton:visible').first().waitFor({ state: 'visible' })
  if (await owner.locator('#newRoom').isVisible()) await owner.locator('#newRoom').click()
  else { await owner.locator('#newMenuButton').click(); await owner.locator('#newMenuRoom').click() }
  await owner.locator('#roomName').fill('Standalone Wok fixture')
  if (await owner.locator('#newRoomYourName').isVisible()) await owner.locator('#newRoomYourName').fill('Standalone owner')
  await owner.locator('#create').click()
  await owner.locator('#roomArea').waitFor({ state: 'visible', timeout: 60_000 })
  const join = await owner.locator('#shareUrl').inputValue()
  const guest = await device(guestKey)
  await guest.goto(join)
  await guest.reload()
  await guest.locator('#displayName').fill('Standalone guest')
  await enterRoom(guest)
  await owner.locator('#chatInput').fill('Public control')
  await owner.locator('#chatInput').press('Enter')
  await guest.locator('#chatLog').filter({ hasText: 'Public control' }).waitFor()
  for (const page of [owner, guest]) {
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await enterRoom(page)
  }
  await openRouting(owner)
  await owner.locator('#bothyRoomKeeper').check()
  await owner.locator('#bothyRoomActivate').click()
  await owner.locator('#bothyRoomStatus').filter({ hasText: 'This room now uses its selected private relay' }).waitFor({ timeout: 120_000 })
  await owner.locator('#bothyRoomClose').click()
  await openRouting(guest)
  await guest.locator('#bothyRoomActivate').click()
  await guest.locator('#bothyRoomStatus').filter({ hasText: 'This room now uses its selected private relay' }).waitFor({ timeout: 120_000 })
  await guest.locator('#bothyRoomClose').click()
  for (const page of [owner, guest]) {
    await page.goto(join)
    await page.reload()
    await enterRoom(page)
  }
  await owner.locator('#chatInput').fill('Standalone Wok accepted')
  await owner.locator('#chatInput').press('Enter')
  await guest.locator('#chatLog').filter({ hasText: 'Standalone Wok accepted' }).waitFor({ timeout: 30_000 })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, configuredThroughSettings: true, activatedInBothBrowsers: true, privateMessage: true, pageErrors: 0 }))
  await stop(0)
} catch (error) {
  console.error(error)
  if (errors.length) console.error(errors)
  for (const context of contexts) for (const page of context.pages()) {
    console.error('Entry diagnostics', await page.locator('#status,#newRoomStatus,#joinStatus,#bothyRoomStatus').allTextContents(), await page.locator('dialog[open] button').allTextContents(),
      await page.evaluate(() => Object.fromEntries(['roomArea', 'chatForm', 'chatViewport', 'settingsPane', 'callBay', 'callSurface'].map(id => {
        const element = document.getElementById(id)
        return [id, element ? { hidden: element.hidden, display: getComputedStyle(element).display, view: element.dataset.mobileView } : null]
      }))))
  }
  await stop(1)
}
