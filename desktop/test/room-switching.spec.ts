import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveRoom, generateRoomSecret } from '../../src/room.js'
import { encodeRoomLink } from '../../src/link.js'
import { openRoomUrl } from '../../test/relays.js'
import { HOME } from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const relay = 'ws://127.0.0.1:17777'

test('room switching keeps the desktop steady and does not wait for old-room farewell or TURN', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-switch-'))
  const app = await electron.launch({ executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [desktop], env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })
  let holdFarewell = false
  let farewellId: string | undefined
  let farewellAckHeld = false
  const rooms = ['Studio', 'Workshop'].map(name => {
    const secret = generateRoomSecret()
    return { name, roomId: deriveRoom(secret).roomId, link: encodeRoomLink(HOME, { secret, name, relays: [relay], iceUrls: [] }), openedAt: Date.now() / 1000, readAt: 0 }
  })
  try {
    const context = app.context()
    await context.routeWebSocket(url => url.href !== relay + '/', socket => socket.close())
    await context.routeWebSocket(relay, socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        const data = JSON.parse(String(message))
        if (holdFarewell && !farewellId && data[0] === 'EVENT') farewellId = data[1].id
        server.send(message)
      })
      server.onMessage(message => {
        const data = JSON.parse(String(message))
        if (data[0] === 'OK' && data[1] === farewellId) { farewellAckHeld = true; return }
        socket.send(message)
      })
    })
    const page = await app.firstWindow()
    await page.addInitScript(({ rooms, relay }) => {
      const originalFetch = window.fetch.bind(window)
      ;(window as any).holdTurn = false
      ;(window as any).delayedTurnRequests = 0
      window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href)
        if (url.pathname !== '/turn') return originalFetch(input, init)
        if ((window as any).holdTurn) {
          ;(window as any).delayedTurnRequests++
          await new Promise(resolve => setTimeout(resolve, 4500))
        }
        return new Response('', { status: 503 })
      }
      for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room))
      localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }))
    }, { rooms, relay })
    await openRoomUrl(page, rooms[0]!.link)
    await page.locator('#displayName').fill('Desktop switch test')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Studio draft stays in Studio')
    await page.evaluate(() => {
      const marker = window as unknown as { switchFlashes: string[]; visitMarker: string }
      marker.switchFlashes = []; marker.visitMarker = 'same document'
      const observer = new MutationObserver(() => {
        const room = document.getElementById('roomArea')!
        if (room.hidden) marker.switchFlashes.push('room disappeared')
        if (document.getElementById('identity')!.getBoundingClientRect().height > 0) marker.switchFlashes.push('entry screen appeared')
      })
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] })
    })
    holdFarewell = true
    await page.evaluate(() => { (window as any).holdTurn = true })
    const started = Date.now()
    await page.locator('#workspaceRooms .workspaceRoomLink', { hasText: 'Workshop' }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Workshop', { timeout: 1800 })
    await expect(page.locator('#chatInput')).toBeEditable({ timeout: 1800 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(1800)
    expect(farewellAckHeld).toBe(true)
    expect(await page.evaluate(() => (window as any).delayedTurnRequests)).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as any).switchFlashes)).toEqual([])
    expect(await page.evaluate(() => (window as any).visitMarker)).toBe('same document')
    await expect(page.locator('#chatInput')).toHaveValue('')
    await page.locator('#chatInput').fill('Workshop has its own draft')
    await page.locator('#workspaceRooms .workspaceRoomLink', { hasText: 'Studio' }).click()
    await expect(page.locator('#chatInput')).toHaveValue('Studio draft stays in Studio')
    await page.locator('#workspaceRooms .workspaceRoomLink', { hasText: 'Workshop' }).click()
    await expect(page.locator('#chatInput')).toHaveValue('Workshop has its own draft')
    await page.screenshot({ path: join(desktop, 'artifacts/room-switching.png') })
    console.log(`Room ready in ${elapsed} ms with farewell ACK withheld and TURN delayed 4.5 seconds; drafts and document retained`)
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(profile, { recursive: true, force: true })
  }
})

test('relay-only joining still waits for TURN and never falls back to direct media', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-relay-only-'))
  const app = await electron.launch({ executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [desktop], env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })
  try {
    await app.context().routeWebSocket(url => url.href !== relay + '/', socket => socket.close())
    const page = await app.firstWindow()
    await page.addInitScript(() => {
      const fetchOriginal = window.fetch.bind(window)
      ;(window as any).turnRequested = false
      window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href)
        if (url.pathname !== '/turn') return fetchOriginal(input, init)
        ;(window as any).turnRequested = true
        await new Promise<void>(resolve => { (window as any).releaseTurn = resolve })
        return new Response('', { status: 503 })
      }
      const Native = RTCPeerConnection
      ;(window as any).peerCount = 0
      window.RTCPeerConnection = class extends Native {
        constructor(config?: RTCConfiguration) { super(config); (window as any).peerCount++ }
      }
    })
    await openRoomUrl(page, encodeRoomLink(HOME, { secret: generateRoomSecret(), name: 'Private network check', relays: [relay], iceUrls: [] }))
    await page.locator('#displayName').fill('Synthetic privacy check')
    await page.locator('#joinNetworkPrivacy').evaluate((element: HTMLDetailsElement) => { element.open = true })
    await page.locator('#joinRelayOnly').check()
    await page.locator('#join').click()
    await expect.poll(() => page.evaluate(() => (window as any).turnRequested)).toBe(true)
    await expect(page.locator('#roomArea')).toBeHidden()
    expect(await page.evaluate(() => (window as any).peerCount)).toBe(0)
    await page.evaluate(() => (window as any).releaseTurn())
    await expect(page.locator('#status')).toContainText('Could not join')
    await expect(page.locator('#roomArea')).toBeHidden()
    expect(await page.evaluate(() => (window as any).peerCount)).toBe(0)
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(profile, { recursive: true, force: true })
  }
})
