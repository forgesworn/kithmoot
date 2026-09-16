import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveRoom, generateRoomSecret } from '../../src/room.js'
import { encodeRoomLink } from '../../src/link.js'
import { RoomAgent } from '../../src/agent.js'
import { localIdentity } from '../../src/identity.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { openRoomUrl } from '../../test/relays.js'
import { HOME } from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const relay = 'ws://127.0.0.1:17777'

test('background saved room delivery, private notification clicks and unread badge track reading rather than focus', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-notify-'))
  const app = await electron.launch({ executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [desktop], env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })
  const rooms = ['Studio', 'Workshop'].map(name => {
    const secret = generateRoomSecret()
    return { name, roomId: deriveRoom(secret).roomId, link: encodeRoomLink(HOME, { secret, name, relays: [relay], iceUrls: [] }), openedAt: Date.now() / 1000, readAt: 0 }
  })
  let writer: RoomAgent | undefined
  try {
    // Capture native boundaries without showing banners or making sounds on the user's Mac.
    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as any).banners = []; (globalThis as any).badge = 0
      ipcMain.removeAllListeners('desktop:notify')
      ipcMain.on('desktop:notify', (_event, content) => (globalThis as any).banners.push(content))
      ipcMain.on('desktop:unread', (_event, count) => { (globalThis as any).badge = count })
    })
    // Proxy the synthetic relay through Playwright, avoiding macOS local-network
    // permission state in this isolated desktop test. Production sockets are unchanged.
    await app.context().routeWebSocket(relay, socket => { socket.connectToServer() })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => {
      // Playwright's routed WebSocket throws on send-after-close, whereas native
      // WebSocket discards sends in CLOSING/CLOSED. Room changes close subscriptions.
      // Keep this exact fixture-only exception separate from renderer errors.
      if (error.message !== 'WebSocket is already in CLOSING or CLOSED state.') errors.push(error.message)
    })
    await page.addInitScript(({ rooms, relay }) => {
      ;(window as any).testFocused = true
      document.hasFocus = () => (window as any).testFocused
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' })
      Object.defineProperty(document, 'hidden', { get: () => false })
      const fetchOriginal = window.fetch.bind(window)
      window.fetch = (input, init) => new URL(input instanceof Request ? input.url : String(input), location.href).pathname === '/turn' ? Promise.resolve(new Response('', { status: 503 })) : fetchOriginal(input, init)
      for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room))
      localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }))
      localStorage.setItem('kithmoot.notify', 'true')
      localStorage.setItem('kithmoot.desktop-bell', 'false')
    }, { rooms, relay })
    await openRoomUrl(page, rooms[0]!.link)
    await page.locator('#displayName').fill('Synthetic desktop reader')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    writer = await RoomAgent.join({ link: rooms[1]!.link, identity: localIdentity(generateSecretKey()), relays: [relay], name: 'Synthetic sender' })
    await writer.chat.send('Private content must stay out of the banner')
    await expect.poll(() => app.evaluate(() => (globalThis as any).badge)).toBe(1)
    await expect(page).toHaveTitle('(1) KithMoot')
    await expect.poll(() => app.evaluate(({ app }) => app.getBadgeCount())).toBe(1)
    await expect.poll(() => app.evaluate(({ app }) => app.dock?.getBadge())).toBe('1')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    expect(await app.evaluate(() => (globalThis as any).badge)).toBe(1)
    const banners = await app.evaluate(() => (globalThis as any).banners)
    expect(banners).toHaveLength(1)
    expect(banners[0].body).not.toContain('Private content')
    expect(banners[0].roomId).toBe(rooms[1]!.roomId)
    expect(banners[0]).not.toHaveProperty('url')
    await app.evaluate(({ BrowserWindow }, roomId) => BrowserWindow.getAllWindows()[0]!.webContents.send('desktop:open-room', roomId), rooms[1]!.roomId)
    await expect(page.locator('#roomTitle')).toHaveText('Workshop')
    await expect(page.locator('#chatLog')).toContainText('Private content')
    await expect.poll(() => app.evaluate(() => (globalThis as any).badge)).toBe(0)
    await page.evaluate(() => { (window as any).testFocused = false })
    await writer.chat.send('Second unread message')
    await writer.chat.send('Third unread message')
    await expect.poll(() => app.evaluate(() => (globalThis as any).badge)).toBe(2)
    await page.evaluate(() => { (window as any).testFocused = true; window.dispatchEvent(new Event('focus')) })
    await expect.poll(() => app.evaluate(() => (globalThis as any).badge)).toBe(0)
    await expect(page).toHaveTitle('KithMoot')
    await expect.poll(() => app.evaluate(({ app }) => app.getBadgeCount())).toBe(0)
    await expect.poll(() => app.evaluate(({ app }) => app.dock?.getBadge())).toBe('')
    expect(errors).toEqual([])
  } finally {
    await writer?.leave()
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(profile, { recursive: true, force: true })
  }
})

test('zen bell renders a soft decaying tone without clipping, through the preview control', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-bell-'))
  const app = await electron.launch({ executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [desktop], env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('#create')).toBeVisible()
    const tone = await page.evaluate(async () => {
      // Exercise the actual preview handler and oscillator envelope, entirely offline.
      const offline = new OfflineAudioContext(1, 48000 * 3, 48000)
      Object.defineProperty(offline, 'state', { get: () => 'running' })
      ;(window as any).AudioContext = class { constructor() { return offline } }
      document.getElementById('previewNotifyBell')!.click()
      await Promise.resolve()
      const buffer = await offline.startRendering()
      const samples = buffer.getChannelData(0)
      const rms = (start: number, end: number) => Math.sqrt(samples.slice(start, end).reduce((sum, value) => sum + value * value, 0) / (end - start))
      return { peak: samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0), early: rms(1000, 8000), late: rms(90000, 100000), end: rms(120000, 144000) }
    })
    expect(tone.peak).toBeGreaterThan(0.05)
    expect(tone.peak).toBeLessThan(0.2)
    expect(tone.early).toBeGreaterThan(tone.late * 20)
    expect(tone.end).toBe(0)
    console.log('Offline zen bell envelope:', tone)
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }) }
})
