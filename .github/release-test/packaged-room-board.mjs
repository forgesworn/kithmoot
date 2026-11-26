import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
import { encodeRoomLink } from '@forgesworn/fold-kit'
import { stopIsolatedApp } from './isolated-app.mjs'

const [executable, version, relayScript] = process.argv.slice(2)
assert.ok(executable && version && relayScript)
const origin = 'https://kithmoot.forgesworn.dev'
const relay = 'wss://room-board-fixture.invalid'
const roomName = 'Packaged room board fixture'
const title = 'A card shared from the room header'
const link = encodeRoomLink(origin + '/j/', {
  secret: randomBytes(32), name: roomName, relays: [relay], iceUrls: [],
})
const reserve = createServer()
await new Promise((resolve, reject) => reserve.listen(0, '127.0.0.1', resolve).once('error', reject))
const port = reserve.address().port
await new Promise((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()))
const server = spawn(process.execPath, [relayScript], {
  env: { ...process.env, RELAY_PORT: String(port), RELAY_HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const participants = []
const sockets = new Set()
const pageErrors = []

async function openBoard(page) {
  const room = page.locator('#roomArea')
  await page.getByRole('button', { name: 'Room board', exact: true }).click()
  await expect(room.getByRole('heading', { name: 'Board · ' + roomName, exact: true })).toBeVisible()
  await expect(page.locator('#workspaceWorkPanel')).toBeHidden()
  return page.frameLocator('#roomBoardView iframe')
}

async function joinRoom(name) {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-room-board-'))
  const participant = { profile }
  participants.push(participant)
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`, ...(process.env.KITHMOOT_LAB_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    timeout: 45_000,
  })
  participant.app = app
  assert.deepEqual(
    await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') })),
    { packaged: true, version, profile },
  )
  const page = await app.firstWindow()
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === origin && url.pathname.startsWith('/j/') ? route.continue() : route.abort()
  })
  await page.context().routeWebSocket(/.*/, route => {
    if (route.url().replace(/\/$/, '') !== relay) {
      route.close({ code: 1008, reason: 'Only the isolated room relay is allowed' })
      return
    }
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.add(socket)
    const pending = []
    socket.onopen = () => { for (const data of pending.splice(0)) socket.send(data) }
    socket.onmessage = event => route.send(event.data)
    socket.onerror = () => route.close()
    socket.onclose = () => { sockets.delete(socket); route.close() }
    route.onMessage(data => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(data)
    })
    route.onClose(() => { if (socket.readyState <= WebSocket.OPEN) socket.close() })
  })
  await page.goto(link, { waitUntil: 'domcontentloaded' })
  const joinButton = page.locator('#join')
  const room = page.locator('#roomArea')
  await expect.poll(async () => await joinButton.isVisible() || await room.isVisible(), { timeout: 30_000 }).toBe(true)
  if (await joinButton.isVisible()) {
    await page.locator('#displayName').fill(name)
    await joinButton.click()
  }
  await expect(room).toBeVisible({ timeout: 30_000 })
  return page
}

try {
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/`)).ok } catch { return false }
  }, { timeout: 10_000 }).toBe(true)
  const first = await joinRoom('Board fixture one')
  const second = await joinRoom('Board fixture two')
  const firstBoard = await openBoard(first)
  const secondBoard = await openBoard(second)
  const composer = firstBoard.getByRole('textbox', { name: 'Add a card to To do', exact: true })
  await composer.fill(title)
  await composer.press('Enter')
  await expect(first.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  await expect(secondBoard.getByRole('link', { name: title, exact: true })).toBeVisible({ timeout: 20_000 })
  await first.getByRole('button', { name: 'Back to chat', exact: true }).click()
  await expect(first.locator('#chatInput')).toBeVisible()
  await expect(first.getByRole('button', { name: 'Room board', exact: true })).toBeFocused()
  const reopened = await openBoard(first)
  await expect(reopened.getByRole('link', { name: title, exact: true })).toBeVisible()
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({
    platform: process.platform, architecture: process.arch, version, packaged: true,
    twoIsolatedProfiles: true, directHeaderEntry: true, cardDelivered: true, returnToSameChat: true, cardRetained: true,
  }))
} finally {
  for (const { app, profile } of participants.reverse()) {
    await stopIsolatedApp(app, profile)
    await rm(profile, { recursive: true, force: true, maxRetries: 4 })
  }
  for (const socket of sockets) socket.close()
  server.kill()
}
