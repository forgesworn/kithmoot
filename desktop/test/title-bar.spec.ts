import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveRoom, generateRoomSecret } from '../../src/room.js'
import { encodeRoomLink } from '../../src/link.js'
import { openRoomUrl } from '../../test/relays.js'
import { HOME } from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))
const relay = 'ws://127.0.0.1:17777'
const executablePath = join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

const launch = (profile: string) => electron.launch({ executablePath, args: [desktop], env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })

const room = () => {
  const secret = generateRoomSecret()
  const name = 'Studio'
  return { name, roomId: deriveRoom(secret).roomId, link: encodeRoomLink(HOME, { secret, name, relays: [relay], iceUrls: [] }), openedAt: Date.now() / 1000, readAt: 0 }
}

test.describe('macOS hidden title bar', () => {
  test.skip(process.platform !== 'darwin', 'the inset title bar is macOS only')

  test('the main window swaps its title bar for a tinted strip, marks the page and starts the app below it', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'kithmoot-titlebar-'))
    const app = await launch(profile)
    const studio = room()
    try {
      await app.context().routeWebSocket(url => url.href !== relay + '/', socket => socket.close())
      await app.context().routeWebSocket(relay, socket => { socket.connectToServer() })
      const position = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition())
      expect(position).toEqual({ x: 14, y: 13 })

      const page = await app.firstWindow()
      await page.addInitScript(({ studio, relay }) => {
        localStorage.setItem('kithmoot.room.' + studio.roomId, JSON.stringify(studio))
        localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }))
      }, { studio, relay })
      await openRoomUrl(page, studio.link)
      await page.locator('#displayName').fill('Title bar test')
      await page.locator('#join').click()
      await expect(page.locator('#roomArea')).toBeVisible()

      expect(await page.evaluate(() => document.documentElement.dataset.titleBar)).toBe('inset')
      expect(await page.evaluate(() => (window as any).kithmootDesktop.titleBar)).toBe('inset')

      // The strip is the drag region, a shade apart from the panes so it reads
      // as one; every control that can sit in a drag region is a hole.
      const band = await page.evaluate(() => {
        const style = getComputedStyle(document.body, '::before')
        return { region: style.getPropertyValue('-webkit-app-region'), height: style.height, background: style.backgroundColor, rail: getComputedStyle(document.getElementById('rail')!).backgroundColor }
      })
      expect({ region: band.region, height: band.height }).toEqual({ region: 'drag', height: '40px' })
      expect(band.background).not.toBe(band.rail)
      await page.locator('#roomMenu').click()
      for (const selector of ['#appHome', '#railChats', '#openAppSettings', '#newMenuButton', '#homeRoomQuery', '#roomIdentity', '#callToggle', '#chatSearch', '#roomMenu', '#roomMoreMenu', '#ringBanner']) {
        const region = await page.locator(selector).first().evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))
        expect(region, selector).toBe('no-drag')
      }
      await page.keyboard.press('Escape')

      // The whole app starts below the strip, each part where it was within it.
      const tops = async () => page.evaluate(() => {
        const top = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().top)
        return { logo: top('#appHome'), listHead: top('#rooms .listHead'), roomBar: top('.roomBar'), query: top('#homeRoomQuery') }
      })
      const inset = await tops()

      // Full screen hides the lights, so the strip goes and everything moves up by its height.
      expect(await page.evaluate(() => getComputedStyle(document.body).paddingTop)).toBe('40px')
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.emit('enter-full-screen') })
      await expect(page.locator('html')).toHaveAttribute('data-window-full-screen', '')
      expect(await page.evaluate(() => getComputedStyle(document.body).paddingTop)).toBe('0px')
      const full = await tops()
      expect(inset).toEqual({ logo: full.logo + 40, listHead: full.listHead + 40, roomBar: full.roomBar + 40, query: full.query + 40 })
      expect(full).toEqual({ logo: 12, listHead: 12, roomBar: 8, query: 60 })
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.emit('leave-full-screen') })
      await expect(page.locator('html')).not.toHaveAttribute('data-window-full-screen', '')
      expect(await page.evaluate(() => getComputedStyle(document.body).paddingTop)).toBe('40px')
    } finally {
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
      await app.close().catch(() => {})
      await rm(profile, { recursive: true, force: true })
    }
  })

  test('the rail still fits at the smallest window with Huge text', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'kithmoot-titlebar-small-'))
    const app = await launch(profile)
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(900, 640) })
      await page.addInitScript(() => localStorage.setItem('kithmoot.textSize', 'huge'))
      await page.reload()
      await expect(page.locator('#rail')).toBeVisible()
      const bottom = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#rail > *')].filter(element => element.getBoundingClientRect().height > 0)
        return Math.max(...items.map(element => element.getBoundingClientRect().bottom))
      })
      expect(bottom).toBeLessThanOrEqual(640)
    } finally {
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
      await app.close().catch(() => {})
      await rm(profile, { recursive: true, force: true })
    }
  })
})

test('size and position come back on the next launch', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-window-state-'))
  try {
    const first = await launch(profile)
    await first.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setBounds({ x: 120, y: 120, width: 1000, height: 700 }) })
    const wanted = await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
    await first.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close() })
    await first.close().catch(() => {})
    const saved = JSON.parse(await readFile(join(profile, 'window-state.json'), 'utf8'))
    expect(saved.maximized).toBe(false)

    const second = await launch(profile)
    try {
      const bounds = await second.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(bounds[key] - wanted[key])).toBeLessThanOrEqual(1)
    } finally {
      await second.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
      await second.close().catch(() => {})
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})
