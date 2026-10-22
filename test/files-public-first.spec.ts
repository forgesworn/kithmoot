import { test, expect, type Browser, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateRoomSecret, encodeJoinUrl } from '../src/room.js'
import { openSettings, closeSettings, allowTestFileStorage, leaveRoom } from './browser.js'
import { routeTestBlossom } from './blossom.js'

/**
 * Files, public first (stage A): the first file on a device shows a one-time
 * notice and Send is the act; later files upload on pick; Settings › Privacy ›
 * Where files go changes the destination. The default server is
 * blossom.yakihonne.com in the product and is answered here by the local test
 * Blossom store: nothing in this file reaches the real host.
 */

const DEFAULT = 'https://blossom.yakihonne.com'
const CONSENT = 'kithmoot.file-storage.v1'

/** What the stand-in for the default server does with a request. `block`
 *  fails the test's expectation by recording the hit; `serve` answers from the
 *  local test store; a number answers with that status. */
interface Gate { mode: 'block' | 'serve' | number; hits: string[]; uploads: number }

async function setup(browser: Browser, baseURL: string, viewport = { width: 390, height: 844 }, consent?: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport, hasTouch: viewport.width < 700, isMobile: viewport.width < 700 })
  // A choice this device made in an earlier version, there before the app starts.
  if (consent) await context.addInitScript(([key, value]) => { localStorage.setItem(key!, value!) }, [CONSENT, consent])
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  // Underneath: the local test store answering as the default server.
  await routeTestBlossom(context, DEFAULT)
  const gate: Gate = { mode: 'block', hits: [], uploads: 0 }
  await context.route(url => url.origin === DEFAULT, async route => {
    const request = route.request()
    gate.hits.push(`${request.method()} ${new URL(request.url()).pathname}`)
    if (request.method() === 'PUT') gate.uploads++
    if (gate.mode === 'block') return route.abort()
    if (typeof gate.mode === 'number') return route.fulfill({ status: gate.mode, body: '' })
    return route.fallback()
  })
  const page = await context.newPage()
  await page.goto(encodeJoinUrl(baseURL, generateRoomSecret(), [relay.href]))
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { page, context, gate }
}

/** + opens the system picker in one tap; this answers it. */
async function pick(page: Page, ...files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  const chooser = page.waitForEvent('filechooser')
  await page.locator('#attachToggle').click()
  await (await chooser).setFiles(files)
}

const JPEG = (name: string) => ({ name, mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, (_, i) => i)]) })
const stored = (page: Page) => page.evaluate(key => localStorage.getItem(key), CONSENT)

const NOTICE_TITLE = 'Files you send are stored on blossom.yakihonne.com'
const NOTICE_BODY = 'It’s a public server run by Yakihonne. Files are encrypted on this device first, so the server can’t open them, but anyone in this chat can. The server sees your IP address, a key made for this device, when files are sent and opened, and how big they are. It decides how long to keep them.'

test('the first file is held with the one-time notice, and Send is the act', async ({ browser, baseURL }) => {
  const { page, context, gate } = await setup(browser, baseURL!)
  try {
    await pick(page, JPEG('IMG_2041.jpg'))
    const tray = page.getByRole('group', { name: 'Files to send' })
    await expect(tray).toBeVisible()
    await expect(tray.locator('.attachChip')).toContainText('IMG_2041.jpg')
    await expect(tray.locator('.attachChip .s')).toHaveText('Not uploaded')
    await expect(page.locator('#fileNoticeTitle')).toHaveText(NOTICE_TITLE)
    await expect(page.locator('#fileNoticeBody')).toHaveText(NOTICE_BODY)
    await expect(page.locator('#fileNoticeChoose')).toHaveText('Choose another server')
    await expect(page.locator('#chatForm button[type=submit]')).toHaveAttribute('aria-describedby', 'fileNoticeTitle fileNoticeBody')
    // Nothing has been asked of any file server, and nothing is stored.
    expect(gate.hits).toEqual([])
    expect(await stored(page)).toBeNull()

    gate.mode = 'serve'
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 30_000 })
    expect(gate.uploads).toBe(1)
    expect(JSON.parse((await stored(page))!)).toEqual({ mode: 'shared', disclosure: 3, origin: DEFAULT, via: 'default' })
    await expect(page.locator('#fileTray')).toBeHidden()

    // A second file uploads on pick with no notice.
    await pick(page, JPEG('hilltop.jpg'))
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText(/\d+ B|\d+ KB/, { timeout: 30_000 })
    await expect(page.locator('#fileNotice')).toBeHidden()
    expect(gate.uploads).toBe(2)
  } finally { await context.close() }
})

test('a device whose choice named ForgeSworn’s host meets the notice, which says that storage takes no new files', async ({ browser, baseURL }) => {
  const forgeSworn: string[] = []
  const { page, context, gate } = await setup(browser, baseURL!, undefined, JSON.stringify({ mode: 'shared', disclosure: 2, origin: 'https://kithmoot.forgesworn.dev' }))
  await context.route(url => url.hostname.endsWith('forgesworn.dev'), route => { forgeSworn.push(route.request().url()); return route.abort() })
  try {
    expect(await stored(page)).toBeNull()
    await pick(page, JPEG('IMG_2041.jpg'))
    await expect(page.locator('#fileNoticeClosed')).toHaveText('KithMoot no longer sends files to ForgeSworn’s storage.')
    await expect(page.locator('#fileNoticeTitle')).toHaveText(NOTICE_TITLE)
    gate.mode = 'serve'
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 30_000 })
    expect(gate.uploads).toBe(1)
    expect(forgeSworn).toEqual([])
  } finally { await context.close() }
})

test('a failed first upload keeps the text and the chip, writes the choice, and sends nothing', async ({ browser, baseURL }) => {
  const { page, context, gate } = await setup(browser, baseURL!)
  try {
    gate.mode = 503
    await page.locator('#chatInput').fill('the photo')
    await pick(page, JPEG('plan.jpg'))
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#fileTrayErrorText')).toHaveText('blossom.yakihonne.com didn’t take plan.jpg. Check your connection and try again.')
    await expect(page.locator('#fileTryAgain')).toBeVisible()
    await expect(page.locator('#fileChooseAnother')).toBeVisible()
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText('Not uploaded')
    await expect(page.locator('#chatInput')).toHaveValue('the photo')
    await expect(page.locator('#chatLog')).not.toContainText('the photo')
    expect(JSON.parse((await stored(page))!).via).toBe('default')
    expect(gate.uploads).toBe(1)
    // Try again asks the same server again, and no other.
    await page.locator('#fileTryAgain').click()
    await expect.poll(() => gate.uploads).toBe(2)
    expect(gate.hits.every(hit => hit.startsWith('PUT /upload'))).toBe(true)
  } finally { await context.close() }
})

test('a long paste becomes a held file with the notice, and nothing uploads until Send', async ({ browser, baseURL }) => {
  const { page, context, gate } = await setup(browser, baseURL!)
  try {
    const long = 'word '.repeat(2600)
    await page.locator('#chatInput').fill(long)
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#attachStaged .attachChip .n')).toContainText('message-')
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText('Not uploaded')
    await expect(page.locator('#fileNoticeTitle')).toHaveText(NOTICE_TITLE)
    expect(gate.hits).toEqual([])
    gate.mode = 'serve'
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Shared full text', { timeout: 30_000 })
    expect(gate.uploads).toBe(1)
  } finally { await context.close() }
})

test('removing every held chip hides the notice and stores nothing', async ({ browser, baseURL }) => {
  const { page, context, gate } = await setup(browser, baseURL!)
  try {
    await pick(page, JPEG('a.jpg'))
    await expect(page.locator('#fileNotice')).toBeVisible()
    await page.getByRole('button', { name: 'Remove a.jpg' }).click()
    await expect(page.locator('#fileTray')).toBeHidden()
    expect(await stored(page)).toBeNull()
    expect(gate.hits).toEqual([])
  } finally { await context.close() }
})

test('Nowhere holds the file with the 9.1 line, and Turn on file uploads opens the page', async ({ browser, baseURL }) => {
  const { page, context, gate } = await setup(browser, baseURL!)
  try {
    await openSettings(page, 'Privacy')
    await expect(page.locator('#privacyFilesState')).toHaveText('A public server · blossom.yakihonne.com')
    await page.locator('#privacyFiles').click()
    await page.getByRole('radio', { name: 'Nowhere' }).check()
    await expect(page.locator('#privacyFilesState')).toHaveText('Nowhere')
    expect(JSON.parse((await stored(page))!)).toEqual({ mode: 'off', disclosure: 3 })
    await closeSettings(page)
    await pick(page, JPEG('plan.jpg'))
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText('Not uploaded')
    await expect(page.locator('#fileTrayStateText')).toHaveText('File uploads are off on this device.')
    await expect(page.locator('#fileNotice')).toBeHidden()
    await expect(page.locator('#chatForm button[type=submit]')).toBeDisabled()
    expect(gate.hits).toEqual([])
    await page.getByRole('button', { name: 'Turn on file uploads' }).click()
    await expect(page.locator('#settingsTitle')).toHaveText('Where files go')
    // Back goes to Privacy, which is where this page sits.
    await page.locator('#settingsBack').click()
    await expect(page.locator('#settingsTitle')).toHaveText('Privacy')
    // Room info says the same.
    await closeSettings(page)
    await page.locator('#roomMenu').click()
    await page.getByRole('menuitem', { name: /Room info/ }).click()
    await page.locator('#infoRowPrivacy').click()
    await expect(page.locator('#roomFilesLine')).toHaveText('Files: you’ve turned uploads off on this device.')
  } finally { await context.close() }
})

test('a typed server is committed by Use this server, with no checkbox', async ({ browser, baseURL }) => {
  const own = new URL(baseURL!).origin
  const { page, context } = await setup(browser, baseURL!)
  try {
    await routeTestBlossom(context, own)
    await openSettings(page, 'Privacy')
    await page.locator('#privacyFiles').click()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await page.getByRole('radio', { name: 'My own server' }).check()
    await page.locator('#attachServer').fill('http://files.example')
    await page.locator('#saveFileStorage').click()
    await expect(page.locator('#fileOwnCheck')).toHaveText('Type an address that starts with https://.')
    expect(await stored(page)).toBeNull()
    await page.locator('#attachServer').fill(own)
    await page.locator('#saveFileStorage').click()
    await expect(page.locator('#fileOwnCheck')).toHaveText(`Files you send go to ${new URL(own).host}.`)
    expect(JSON.parse((await stored(page))!)).toEqual({ mode: 'shared', disclosure: 3, origin: own, via: 'typed' })
    await closeSettings(page)
    await page.locator('#attachFile').setInputFiles(JPEG('mine.jpg'))
    // Uploads on pick, no notice: a typed server is already a choice.
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText(/\d+ B|\d+ KB/, { timeout: 30_000 })
    await expect(page.locator('#fileNotice')).toBeHidden()
    // With their own server, + is a two-item menu.
    await page.locator('#attachToggle').click()
    await expect(page.getByRole('menuitem')).toHaveText(['Photo or file…', 'File already on Wildbloom…'])
  } finally { await context.close() }
})

test('a file over the server’s known limit is refused before upload, naming 200 MB', async ({ browser, baseURL }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kithmoot-files-'))
  const big = join(dir, 'huge.bin'); writeFileSync(big, ''); truncateSync(big, 210 * 1024 * 1024)
  const { page, context, gate } = await setup(browser, baseURL!)
  try {
    const chooser = page.waitForEvent('filechooser')
    await page.locator('#attachToggle').click()
    await (await chooser).setFiles(big)
    await expect(page.locator('#fileTrayErrorText')).toHaveText('blossom.yakihonne.com takes files up to 200 MB. huge.bin is 210.0 MB.')
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText('Too large')
    expect(gate.hits).toEqual([])
  } finally { await context.close() }
})

test('Settings shows the Where files go row, its radios take arrow keys, and axe is clean', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!, { width: 1280, height: 860 })
  try {
    await openSettings(page, 'Privacy')
    await expect(page.getByText('Where files go is chosen the first time')).toHaveCount(0)
    await page.locator('#privacyFiles').click()
    await expect(page.locator('#fileWherePublicDetail')).toHaveText('blossom.yakihonne.com, run by Yakihonne LLC. Files up to 200 MB.')
    await page.getByRole('radio', { name: 'A public server' }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('radio', { name: 'My own server' })).toBeChecked()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('radio', { name: 'Nowhere' })).toBeChecked()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('radio', { name: 'A public server' })).toBeChecked()
    expect(JSON.parse((await stored(page))!)).toMatchObject({ mode: 'shared', via: 'default' })
    const result = await new AxeBuilder({ page }).include('#settingsPane').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
    expect(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
  } finally { await context.close() }
})

test('phone landscape with the notice showing keeps the field and Send in view', async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === 'chromium-desktop', 'The desktop window is never shorter than 640 px (desktop/main.mjs minHeight).')
  const { page, context } = await setup(browser, baseURL!, { width: 844, height: 390 })
  try {
    await pick(page, JPEG('a.jpg'), JPEG('b.jpg'), JPEG('c.jpg'))
    await expect(page.locator('#fileNotice')).toBeVisible()
    for (const selector of ['#chatInput', '#chatForm button[type=submit]', '#attachToggle']) {
      const box = await page.locator(selector).boundingBox()
      expect(box, selector).not.toBeNull()
      expect(box!.y, `${selector} top`).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height, `${selector} bottom`).toBeLessThanOrEqual(390)
    }
    // Send agrees to the notice, so all of it is readable without scrolling
    // the tray, and the tray still leaves the field and Send in view.
    const tray = await page.locator('#fileTray').boundingBox()
    expect(tray!.height).toBeLessThanOrEqual(390 * 0.75 + 2)
    expect(await page.locator('#fileTray').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    const choose = await page.locator('#fileNotice').getByRole('button', { name: 'Choose another server' }).boundingBox()
    expect(choose!.y + choose!.height).toBeLessThanOrEqual(tray!.y + tray!.height + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await context.close() }
})

test('desktop empty room with the notice showing: the empty-room block overlaps nothing', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!, { width: 1280, height: 860 })
  try {
    await pick(page, JPEG('a.jpg'))
    await expect(page.locator('#fileNotice')).toBeVisible()
    // The block's own content, not its box (which covers the whole log).
    const boxes = await page.evaluate(() => {
      const rect = (el: Element | null) => { const r = el?.getBoundingClientRect(); return r && r.height > 0 ? { top: r.top, bottom: r.bottom } : undefined }
      const content = [...document.querySelectorAll('#emptyRoom > *')].map(rect).filter(Boolean) as { top: number; bottom: number }[]
      return { first: content[0], last: content.at(-1), intro: rect(document.querySelector('#chatLog .intro')), tray: rect(document.querySelector('#fileTray')) }
    })
    expect(boxes.first).toBeDefined()
    expect(boxes.intro).toBeDefined()
    expect(boxes.first!.top).toBeGreaterThanOrEqual(boxes.intro!.bottom)
    expect(boxes.last!.bottom).toBeLessThanOrEqual(boxes.tray!.top + 1)
  } finally { await context.close() }
})

test('leaving and tidying up after switching server once deletes from both origins the room used', async ({ browser, baseURL }) => {
  const own = new URL(baseURL!).origin
  const { page, context, gate } = await setup(browser, baseURL!)
  const deletes = new Set<string>()
  page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/blossom/')) deletes.add(new URL(request.url()).origin) })
  try {
    await routeTestBlossom(context, own)
    await allowTestFileStorage(page, own)
    await page.locator('#attachFile').setInputFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('First file') })
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText(/\d+ B$|\d+ KB$/, { timeout: 30_000 })
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatLog .attachment')).toHaveCount(1)
    // Switch to the public server (choosing it is the act), and send another.
    gate.mode = 'serve'
    await openSettings(page, 'Privacy')
    await page.locator('#privacyFiles').click()
    await page.getByRole('radio', { name: 'A public server' }).check()
    await closeSettings(page)
    await page.locator('#attachFile').setInputFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('Second file') })
    await expect(page.locator('#attachStaged .attachChip .s')).toHaveText(/\d+ B$|\d+ KB$/, { timeout: 30_000 })
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatLog .attachment')).toHaveCount(2)
    expect(gate.uploads).toBe(1)
    await leaveRoom(page, { tidy: true })
    await page.locator('#tidyUpRun').click()
    await expect.poll(() => [...deletes].sort(), { timeout: 60_000 }).toEqual([DEFAULT, own].sort())
  } finally { await context.close() }
})
