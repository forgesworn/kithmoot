import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { generateRoomSecret, encodeJoinUrl } from '../src/room.js'
import { allowTestFileStorage } from './browser.js'
import { routeTestBlossom } from './blossom.js'

/**
 * Attachment safety, as a reader meets it: one person sends the director's
 * set of files (a photo, a PDF, text, a real program, a program named like
 * a PDF with a right-to-left override, a program named like a picture, a
 * macro workbook, an archive, a web page, a shortcut, a document) and
 * another opens each. The decision is made on the decrypted bytes, so the
 * bytes here are real: a PE header declared as a PDF is a PE header.
 * Runs in `chromium` (the PWA) and `chromium-desktop` (the same code built
 * as the installed window).
 */

const RLO = '‮'
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

type Sample = { name: string; type: string; bytes: number[] | 'png' | string }
const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0))
const PE = [0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0, ...ascii('This program cannot be run in DOS mode.')]
const ZIP = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]
const NOTES = Array.from({ length: 14 }, (_, i) => `Leg ${i + 1}: meet at the car park at 9 and bring water.`).join('\n')

const SAMPLES: Sample[] = [
  { name: 'hilltop.png', type: 'image/png', bytes: 'png' },
  { name: 'minutes.pdf', type: 'application/pdf', bytes: ascii('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') },
  { name: 'route-notes.txt', type: 'text/plain', bytes: NOTES },
  { name: 'MapSetup.exe', type: 'application/x-msdownload', bytes: PE },
  { name: `invoice${RLO}fdp.exe`, type: 'application/pdf', bytes: PE },
  { name: 'cat.png', type: 'image/png', bytes: PE },
  { name: 'budget.xlsm', type: 'application/vnd.ms-excel.sheet.macroEnabled.12', bytes: ZIP },
  { name: 'album.zip', type: 'application/zip', bytes: ZIP },
  { name: 'page.html', type: 'text/html', bytes: '<h1>Hello</h1><script>window.pageRan = true</script>' },
  { name: 'Holiday.lnk', type: 'application/octet-stream', bytes: [0x4c, 0, 0, 0, 1, 0x14, 2, 0] },
  { name: 'budget.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: ZIP },
]

async function join(browser: Browser, url: string, name: string, viewport: { width: number; height: number }, colorScheme: 'light' | 'dark', extra: { forcedColors?: 'active' | 'none' } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport, colorScheme, ...extra })
  const origin = new URL(url).origin
  const relay = new URL('/__test-relay', url); relay.protocol = 'wss:'
  await context.routeWebSocket(u => u.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await routeTestBlossom(context, origin)
  const outside: string[] = []
  context.on('request', request => {
    const u = request.url()
    if (/^(?:blob|data|about):/.test(u)) return
    if (new URL(u).origin !== origin) outside.push(u)
  })
  const page = await context.newPage()
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { context, page, outside }
}

async function sendFile(page: Page, sample: Sample, expected: number): Promise<void> {
  await page.locator('#chatInput').evaluate((input, s) => {
    const bytes = s.bytes === 'png'
      ? Uint8Array.from(atob(s.png), c => c.charCodeAt(0))
      : typeof s.bytes === 'string' ? new TextEncoder().encode(s.bytes) : Uint8Array.from(s.bytes)
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], s.name, { type: s.type }))
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: clipboard })
    input.dispatchEvent(event)
  }, { ...sample, png: PNG_1X1 })
  await page.locator('#chatForm button[type="submit"]').click()
  await expect(page.locator('#chatLog .attachment')).toHaveCount(expected, { timeout: 30_000 })
}

const card = (page: Page, name: string): Locator => page.locator('#chatLog .attachment').filter({ has: page.locator('.attName', { hasText: name }) })
const open = async (page: Page, name: string): Promise<Locator> => {
  const c = card(page, name)
  const show = c.getByRole('button', { name: /^Show / })
  // A click can land on a card the log has just drawn again; press it again
  // until the card has opened.
  await expect(async () => {
    if (await show.count()) await show.click({ timeout: 2_000 })
    await expect(show).toHaveCount(0, { timeout: 8_000 })
  }).toPass({ timeout: 45_000 })
  return c
}

test.describe.serial('attachment safety', () => {
  const desktop = (): boolean => test.info().project.name === 'chromium-desktop'
  let sender: Awaited<ReturnType<typeof join>>
  let reader: Awaited<ReturnType<typeof join>>
  let readerUrl: string

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const base = test.info().project.use.baseURL!
    const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
    readerUrl = encodeJoinUrl(base, generateRoomSecret(), [relay.href])
    sender = await join(browser, readerUrl, 'Rowan', { width: 1280, height: 860 }, 'light')
    await allowTestFileStorage(sender.page, new URL(base).origin)
    for (const [i, sample] of SAMPLES.entries()) await sendFile(sender.page, sample, i + 1)
    reader = await join(browser, readerUrl, 'Ada', { width: 1280, height: 860 }, 'light')
    await expect(reader.page.locator('#chatLog .attachment')).toHaveCount(SAMPLES.length, { timeout: 60_000 })
  })
  test.afterAll(async () => { await sender?.context.close(); await reader?.context.close() })

  test('closed cards say what they are and what the download costs, once', async () => {
    const p = reader.page
    await expect(card(p, 'hilltop.png').locator('.attMeta')).toHaveText(/^Image · \d/)
    await expect(card(p, 'MapSetup.exe').locator('.attMeta')).toHaveText(/^Windows program · /)
    await expect(card(p, 'budget.xlsm').locator('.attMeta')).toHaveText(/^Office file with macros · /)
    await expect(card(p, 'album.zip').locator('.attMeta')).toHaveText(/^Archive · /)
    // The name the message carried is already clean.
    await expect(card(p, 'invoicefdp.exe')).toHaveCount(1)
    await expect(p.locator('#chatLog .attachment a')).toHaveCount(0)
  })

  test('safe files open quietly: a photo, a PDF, text', async () => {
    const p = reader.page
    const photo = await open(p, 'hilltop.png')
    await expect(photo.locator('img')).toHaveCount(1)
    await expect(photo.locator('.say')).toHaveCount(0)
    await expect(photo.getByRole('link', { name: 'Save hilltop.png' })).toBeVisible()
    await expect(photo.locator('.attMeta')).toHaveText(/^Image · \d+ B$/)
    expect(await photo.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

    const pdf = await open(p, 'minutes.pdf')
    await expect(pdf.getByRole('link', { name: 'Save minutes.pdf' })).toBeVisible()
    if (desktop()) await expect(pdf.getByRole('link', { name: /^Open/ })).toHaveCount(0)
    else await expect(pdf.getByRole('link', { name: 'Open minutes.pdf' })).toBeVisible()
    await expect(pdf.locator('.say')).toHaveCount(0)

    const notes = await open(p, 'route-notes.txt')
    const pre = notes.locator('pre')
    await expect(pre).toContainText('Leg 1:')
    await expect(pre).toHaveAttribute('tabindex', '0')
    await expect(pre).toHaveAccessibleName('Preview of route-notes.txt')
    await expect(notes.getByRole('button', { name: 'Read more' })).toBeVisible()
    await notes.getByRole('button', { name: 'Read more' }).click()
    await expect(notes.locator('pre')).toContainText('Leg 14:')
    await expect(notes.getByRole('button', { name: 'Show less' })).toBeVisible()
    await expect(notes.getByRole('button', { name: 'Copy text' })).toBeVisible()
  })

  test('the invoice reads as what it is, and its name is clean everywhere', async () => {
    const c = await open(reader.page, 'invoicefdp.exe')
    await expect(c.locator('.attName')).toHaveText('invoicefdp.exe')
    await expect(c.locator('.attMeta')).toHaveText('Windows program · 216 B'.replace('216', String(PE.length)))
    await expect(c.locator('.say.warn')).toContainText('This file’s name had hidden characters that make it read differently. KithMoot removed them. It’s a Windows program, not a PDF.')
    await expect(c.getByRole('button', { name: 'Save invoicefdp.exe…' })).toBeVisible()
    const found = await c.evaluate(node => {
      const bad = /[‪-‮⁦-⁩]/
      const all = [node, ...node.querySelectorAll('*')]
      return {
        text: bad.test(node.textContent ?? ''),
        attributes: all.some(e => [...e.attributes].some(a => bad.test(a.value))),
      }
    })
    expect(found).toEqual({ text: false, attributes: false })
    // Confirmed, the saved name is the clean one.
    await c.getByRole('button', { name: 'Save invoicefdp.exe…' }).click()
    const go = c.getByRole('link', { name: 'Save anyway invoicefdp.exe' })
    await expect(go).toHaveAttribute('download', 'invoicefdp.exe')
    await c.getByRole('button', { name: /^Cancel/ }).click()
  })

  test('a program named like a picture is refused: no image, no Save', async () => {
    const c = await open(reader.page, 'cat.png')
    await expect(c.locator('.say.block')).toContainText('KithMoot won’t open or save this. It’s named like a picture, but it’s really a Windows program. That’s a common way to hide an attack.')
    await expect(c.locator('img')).toHaveCount(0)
    await expect(c.locator('a, button')).toHaveCount(0)
    await expect(c.locator('[data-question]')).toBeFocused()
  })

  test('a shortcut is refused', async () => {
    const c = await open(reader.page, 'Holiday.lnk')
    await expect(c.locator('.say.block')).toContainText('KithMoot won’t save shortcuts.')
    await expect(c.locator('a, button')).toHaveCount(0)
  })

  test('an honest program warns, asks inline, cancels with Escape and saves under its own name', async () => {
    const p = reader.page
    const c = await open(p, 'MapSetup.exe')
    await expect(c.locator('.say.warn')).toContainText('Programs can take over your computer. Only save this if you asked Rowan for it.')
    const saveEllipsis = c.getByRole('button', { name: 'Save MapSetup.exe…' })
    await expect(saveEllipsis).toBeFocused()
    await saveEllipsis.click()
    const question = c.locator('[data-question]')
    await expect(question).toBeFocused()
    await expect(question).toContainText('Save MapSetup.exe? It’s a Windows program. Programs can take over your computer. Only save it if you asked Rowan for it.')
    let downloaded = false
    p.once('download', () => { downloaded = true })
    await p.keyboard.press('Escape')
    await expect(c.getByRole('button', { name: 'Save MapSetup.exe…' })).toBeFocused()
    await expect(c.getByRole('link', { name: /Save anyway/ })).toHaveCount(0)
    expect(downloaded).toBe(false)
    await c.getByRole('button', { name: 'Save MapSetup.exe…' }).click()
    await p.keyboard.press('Tab')
    await expect(c.getByRole('button', { name: /^Cancel/ })).toBeFocused()
    const download = p.waitForEvent('download')
    await c.getByRole('link', { name: 'Save anyway MapSetup.exe' }).click()
    expect((await download).suggestedFilename()).toBe('MapSetup.exe')
  })

  test('macro workbook, archive and web page warn; a web page still reads as text; a document saves quietly', async () => {
    const p = reader.page
    const macros = await open(p, 'budget.xlsm')
    await expect(macros.locator('.say.warn')).toContainText('Macros are programs inside a document. Only save this if you asked Rowan for it, and don’t turn macros on.')
    await expect(macros.locator('img, pre, video, audio')).toHaveCount(0)
    const zip = await open(p, 'album.zip')
    await expect(zip.locator('.say.warn')).toContainText('An archive can hold programs. Only save this if you were expecting it.')
    const page = await open(p, 'page.html')
    await expect(page.locator('pre')).toContainText('<h1>Hello</h1>')
    await expect(page.locator('.say.warn')).toContainText('Opened from your computer, a web page can run code.')
    expect(await p.evaluate(() => (window as unknown as { pageRan?: boolean }).pageRan)).toBeUndefined()
    const docx = await open(p, 'budget.docx')
    await expect(docx.locator('.say')).toHaveCount(0)
    await expect(docx.getByRole('link', { name: 'Save budget.docx' })).toBeVisible()
    await expect(docx.locator('.attMeta')).toHaveText(/^Document · /)
  })

  test('every control is a button or a button-styled anchor at the control height, never a default link', async () => {
    const found = await reader.page.locator('#chatLog .attachment').evaluateAll(cards => {
      const controls = cards.flatMap(c => [...c.querySelectorAll<HTMLElement>('button, a')])
      const ctl = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ctl')) || 36
      return controls.filter(el => !el.classList.contains('attachmentImage')).map(el => ({
        tag: el.tagName, text: (el.textContent ?? '').trim(),
        underlined: getComputedStyle(el).textDecorationLine.includes('underline'),
        short: el.getBoundingClientRect().height + 0.5 < ctl,
        patch: getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)',
      }))
    })
    expect(found.length).toBeGreaterThan(10)
    expect(found.filter(f => f.underlined || f.short || !f.patch)).toEqual([])
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe finds nothing in the chat log with every card opened (${scheme})`, async ({ browser }) => {
      const view = await join(browser, readerUrl, 'Ada', { width: 1280, height: 860 }, scheme)
      try {
        await expect(view.page.locator('#chatLog .attachment')).toHaveCount(SAMPLES.length, { timeout: 60_000 })
        for (const sample of SAMPLES) await open(view.page, sample.name.replace(RLO, ''))
        const results = await new AxeBuilder({ page: view.page }).include('#chatLog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
        expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(' | ')}`)).toEqual([])
      } finally { await view.context.close() }
    })
  }

  for (const [label, viewport] of [['phone', { width: 390, height: 844 }], ['320', { width: 320, height: 640 }]] as const) {
    test(`at ${label} every card fits, and at 320 the actions sit under the meta line`, async ({ browser }) => {
      const view = await join(browser, readerUrl, 'Ada', viewport, 'light')
      try {
        await expect(view.page.locator('#chatLog .attachment')).toHaveCount(SAMPLES.length, { timeout: 60_000 })
        for (const sample of SAMPLES) await open(view.page, sample.name.replace(RLO, ''))
        expect(await view.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth])).toEqual([viewport.width, viewport.width])
        if (viewport.width === 320) {
          const c = card(view.page, 'MapSetup.exe')
          const meta = await c.locator('.attMeta').boundingBox()
          const actions = await c.locator('.attActions').boundingBox()
          expect(actions!.y).toBeGreaterThanOrEqual(meta!.y + meta!.height - 1)
        }
      } finally { await view.context.close() }
    })
  }

  test('with huge text, names wrap and nothing clips', async ({ browser }) => {
    const view = await join(browser, readerUrl, 'Ada', { width: 1280, height: 860 }, 'light')
    try {
      await expect(view.page.locator('#chatLog .attachment')).toHaveCount(SAMPLES.length, { timeout: 60_000 })
      await view.page.addStyleTag({ content: 'html { font-size: 200% !important }' })
      for (const sample of SAMPLES) await open(view.page, sample.name.replace(RLO, ''))
      const clipped = await view.page.locator('#chatLog .attachment').evaluateAll(cards =>
        cards.flatMap(c => [...c.querySelectorAll<HTMLElement>('.attName, .attMeta, .say p')]).filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className))
      expect(clipped).toEqual([])
    } finally { await view.context.close() }
  })

  test('in forced colours the warning and block boxes keep a border and their icon', async ({ browser }) => {
    const view = await join(browser, readerUrl, 'Ada', { width: 390, height: 844 }, 'light', { forcedColors: 'active' })
    try {
      await expect(view.page.locator('#chatLog .attachment')).toHaveCount(SAMPLES.length, { timeout: 60_000 })
      await open(view.page, 'MapSetup.exe'); await open(view.page, 'cat.png')
      const boxes = await view.page.locator('#chatLog .say').evaluateAll(list => list.map(e => ({
        border: parseFloat(getComputedStyle(e).borderTopWidth), icon: e.querySelector('svg')!.getBoundingClientRect().width,
      })))
      expect(boxes.length).toBe(2)
      for (const b of boxes) { expect(b.border).toBeGreaterThanOrEqual(2); expect(b.icon).toBeGreaterThan(0) }
    } finally { await view.context.close() }
  })

  test('nothing left the app origin except to the test Blossom endpoint', async () => {
    expect(sender.outside).toEqual([])
    expect(reader.outside).toEqual([])
  })
})
