import { test, expect, type Browser, type Frame, type Locator, type Page } from '@playwright/test'
import { generateRoomSecret, encodeJoinUrl } from '../src/room.js'
import { allowTestFileStorage } from './browser.js'
import { routeTestBlossom } from './blossom.js'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PE = [0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]

type Sample = { name: string; type: string; bytes: number[] | 'png' | string }
type ObjectUrlEvent = { action: 'created' | 'revoked'; url: string; frame?: string }

const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0))

function hostileSvg(origin: string): string {
  const script = `
    window.__svgScriptRan = true;
    try { parent.document.documentElement.dataset.svgOwned = 'true' } catch {}
    try { localStorage.setItem('kithmoot.attachment-attack', 'ran') } catch {}
    try { parent.postMessage({ type: 'attachment-attack' }, '*') } catch {}
    try { fetch('${origin}/__attachment-attack-same-origin') } catch {}
    try { fetch('https://example.invalid/__attachment-attack-cross-origin') } catch {}
    try { top.location.href = 'https://example.invalid/__attachment-attack-navigation' } catch {}
    try { window.open('https://example.invalid/__attachment-attack-popup') } catch {}
  `
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="${script.replace(/"/g, '&quot;')}">
    <script><![CDATA[${script}]]></script>
    <image href="${origin}/__attachment-attack-image" width="1" height="1" />
    <a href="https://example.invalid/__attachment-attack-link" target="_blank"><rect width="1" height="1" fill="red" /></a>
  </svg>`
}

async function join(browser: Browser, url: string, name: string, objectUrls?: ObjectUrlEvent[]) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 860 } })
  const origin = new URL(url).origin
  const relay = new URL('/__test-relay', url); relay.protocol = 'wss:'
  await context.routeWebSocket(u => u.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await routeTestBlossom(context, origin)
  if (objectUrls) {
    await context.exposeBinding('__attachmentTestObjectUrl', (source, event: ObjectUrlEvent) => { objectUrls.push({ ...event, frame: source.frame.url() }) })
    await context.addInitScript(() => {
      const report = (window as unknown as { __attachmentTestObjectUrl(event: ObjectUrlEvent): Promise<void> }).__attachmentTestObjectUrl
      const create = URL.createObjectURL.bind(URL)
      const revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = object => {
        const url = create(object)
        void report({ action: 'created', url })
        return url
      }
      URL.revokeObjectURL = url => {
        revoke(url)
        void report({ action: 'revoked', url })
      }
    })
  }
  const page = await context.newPage()
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { context, page }
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

async function open(page: Page, name: string): Promise<Locator> {
  const c = card(page, name)
  const show = c.getByRole('button', { name: /^Show / })
  await expect(async () => {
    if (await show.count()) await show.click({ timeout: 2_000 })
    await expect(show).toHaveCount(0, { timeout: 8_000 })
  }).toPass({ timeout: 45_000 })
  return c
}

async function previewFrame(c: Locator): Promise<{ element: Locator; frame: Frame }> {
  const element = c.locator('iframe.attachmentPreviewFrame')
  await expect(element).toHaveCount(1)
  await expect(element).toHaveAttribute('sandbox', 'allow-scripts')
  const frame = await (await element.elementHandle())!.contentFrame()
  expect(frame).not.toBeNull()
  return { element, frame: frame! }
}

async function messageId(c: Locator): Promise<string> {
  return c.evaluate(element => element.closest('.msg')!.getAttribute('data-message-id')!)
}

async function retract(sender: Page, name: string): Promise<void> {
  const message = sender.locator('#chatLog .msg').filter({ has: sender.locator('.attName', { hasText: name }) })
  await message.locator('.messageMore').click()
  await sender.locator('#messageActionPanel').getByRole('button', { name: 'Retract this message' }).click()
  await sender.locator('#actionConfirm').click()
}

const revoked = (events: ObjectUrlEvent[], url: string): boolean => events.some(event => event.action === 'revoked' && event.url === url)

test.describe.serial('attachment web security', () => {
  const desktop = (): boolean => test.info().project.name === 'chromium-desktop'
  let sender: Awaited<ReturnType<typeof join>>
  let reader: Awaited<ReturnType<typeof join>>
  let samples: Sample[]
  const objectUrls: ObjectUrlEvent[] = []

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000)
    const base = test.info().project.use.baseURL!
    const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
    const readerUrl = encodeJoinUrl(base, generateRoomSecret(), [relay.href])
    samples = [
      { name: 'visible.png', type: 'image/png', bytes: 'png' },
      { name: 'hostile.svg', type: 'image/svg+xml', bytes: hostileSvg(new URL(base).origin) },
      { name: 'minutes.pdf', type: 'application/pdf', bytes: ascii('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') },
      { name: 'page.html', type: 'text/html', bytes: '<h1>Not a preview</h1><script>window.pageRan = true</script>' },
      { name: 'MapSetup.exe', type: 'application/x-msdownload', bytes: PE },
      { name: 'closing.png', type: 'image/png', bytes: 'png' },
      { name: 'flight.png', type: 'image/png', bytes: 'png' },
    ]
    sender = await join(browser, readerUrl, 'Rowan')
    await allowTestFileStorage(sender.page, new URL(base).origin)
    for (const [i, sample] of samples.entries()) await sendFile(sender.page, sample, i + 1)
    reader = await join(browser, readerUrl, 'Ada', objectUrls)
    await expect(reader.page.locator('#chatLog .attachment')).toHaveCount(samples.length, { timeout: 60_000 })
  })

  test.afterAll(async () => { await sender?.context.close(); await reader?.context.close() })

  test('an image is visible only in an opaque allow-scripts frame, isolated from the parent DOM and storage', async () => {
    const p = reader.page
    const photo = await open(p, 'visible.png')
    await expect(photo.locator('img')).toHaveCount(0)
    const { frame } = await previewFrame(photo)
    const image = frame.locator('img')
    await expect(image).toHaveCount(1)
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
    const isolated = await frame.evaluate(() => {
      let parentDom = false
      let storage = false
      try { void window.parent.document.body; parentDom = true } catch {}
      try { void window.localStorage; storage = true } catch {}
      return { parentDom, storage, url: document.querySelector('img')!.getAttribute('src')! }
    })
    expect(isolated).toEqual({ parentDom: false, storage: false, url: expect.stringMatching(/^blob:null\//) })
    const saveUrl = await photo.getByRole('link', { name: 'Save visible.png' }).getAttribute('href')
    expect(saveUrl).toMatch(/^blob:https:\/\//)
    expect(saveUrl).not.toBe(isolated.url)
  })

  test('hostile SVG cannot run, store data, request either origin, navigate, or open a popup', async () => {
    const p = reader.page
    const originalUrl = p.url()
    const attacks: string[] = []
    const popups: Page[] = []
    const request = (request: import('@playwright/test').Request): void => {
      if (request.url().includes('__attachment-attack')) attacks.push(request.url())
    }
    const popup = (page: Page): void => { popups.push(page) }
    p.context().on('request', request)
    p.context().on('page', popup)
    await p.evaluate(() => {
      const win = window as unknown as { __attachmentAttackMessages: unknown[] }
      win.__attachmentAttackMessages = []
      window.addEventListener('message', event => {
        if ((event.data as { type?: string } | null)?.type === 'attachment-attack') win.__attachmentAttackMessages.push(event.data)
      })
    })
    try {
      const svg = await open(p, 'hostile.svg')
      const { frame } = await previewFrame(svg)
      await expect.poll(() => frame.locator('img').evaluate((img: HTMLImageElement) => img.complete)).toBe(true)
      await p.waitForTimeout(500)
      expect(await frame.evaluate(() => (window as unknown as { __svgScriptRan?: boolean }).__svgScriptRan)).toBeUndefined()
      expect(await p.evaluate(() => ({
        messages: (window as unknown as { __attachmentAttackMessages: unknown[] }).__attachmentAttackMessages,
        owned: document.documentElement.dataset.svgOwned,
        stored: localStorage.getItem('kithmoot.attachment-attack'),
      }))).toEqual({ messages: [], owned: undefined, stored: null })
      expect(attacks).toEqual([])
      expect(popups).toEqual([])
      expect(p.url()).toBe(originalUrl)
    } finally {
      p.context().off('request', request)
      p.context().off('page', popup)
    }
  })

  test('PDF Open stays in a sandboxed dialog rather than a top-level blob document', async () => {
    test.skip(desktop(), 'the desktop web build deliberately offers Save only for PDFs')
    const p = reader.page
    const originalUrl = p.url()
    const pages = p.context().pages().length
    const pdf = await open(p, 'minutes.pdf')
    await expect(pdf.locator('iframe')).toHaveCount(0)
    await pdf.getByRole('button', { name: 'Open minutes.pdf' }).click()
    const dialog = p.locator('dialog.attachmentViewer[open]')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-label', 'minutes.pdf')
    const { frame } = await previewFrame(dialog)
    await expect(frame.locator('object[type="application/pdf"]')).toHaveAttribute('data', /^blob:null\//)
    expect(p.url()).toBe(originalUrl)
    expect(p.context().pages()).toHaveLength(pages)
    expect(p.context().pages().every(page => !page.url().startsWith('blob:'))).toBe(true)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('unsafe formats have no active preview frame or embedded document', async () => {
    for (const name of ['page.html', 'MapSetup.exe']) {
      const c = await open(reader.page, name)
      await expect(c.locator('iframe, object, embed, img, audio, video')).toHaveCount(0)
    }
    expect(await reader.page.evaluate(() => (window as unknown as { pageRan?: boolean }).pageRan)).toBeUndefined()
  })

  test('closing a dialog and retracting the message revoke their frame and Save URLs', async () => {
    const p = reader.page
    const photo = await open(p, 'closing.png')
    const id = await messageId(photo)
    const inline = await previewFrame(photo)
    const inlineUrl = (await inline.frame.locator('img').getAttribute('src'))!
    const saveUrl = (await photo.getByRole('link', { name: 'Save closing.png' }).getAttribute('href'))!
    await photo.getByRole('button', { name: 'Expand closing.png' }).click()
    const dialog = p.locator('dialog.attachmentViewer[open]')
    const expanded = await previewFrame(dialog)
    const expandedUrl = (await expanded.frame.locator('img').getAttribute('src'))!
    expect(new Set([inlineUrl, expandedUrl, saveUrl]).size).toBe(3)

    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => revoked(objectUrls, expandedUrl)).toBe(true)
    expect(revoked(objectUrls, inlineUrl)).toBe(false)
    expect(revoked(objectUrls, saveUrl)).toBe(false)

    await retract(sender.page, 'closing.png')
    await expect(p.locator(`#chatLog [data-message-id="${id}"]`)).toHaveClass(/retracted/)
    await expect(card(p, 'closing.png')).toHaveCount(0)
    await expect.poll(() => revoked(objectUrls, inlineUrl)).toBe(true)
    await expect.poll(() => revoked(objectUrls, saveUrl)).toBe(true)
  })

  test('retraction while a download is in flight leaves no frame or live object URL', async () => {
    const p = reader.page
    const origin = new URL(p.url()).origin
    let announceRequest!: () => void
    const requested = new Promise<void>(resolve => { announceRequest = resolve })
    let releaseRequest!: () => void
    const released = new Promise<void>(resolve => { releaseRequest = resolve })
    const held = (url: URL): boolean => url.origin === origin && url.pathname.startsWith('/blossom/')
    await p.context().route(held, async route => {
      if (route.request().method() === 'GET') {
        announceRequest()
        await released
      }
      await route.fallback()
    })
    try {
      const c = card(p, 'flight.png')
      const id = await messageId(c)
      // Binding calls from earlier preview frames arrive asynchronously.
      await p.waitForTimeout(1_000)
      const eventBaseline = objectUrls.length
      const framesBefore = await p.locator('iframe.attachmentPreviewFrame').count()
      await c.getByRole('button', { name: 'Show flight.png' }).click()
      await requested
      await retract(sender.page, 'flight.png')
      await expect(p.locator(`#chatLog [data-message-id="${id}"]`)).toHaveClass(/retracted/)
      const downloaded = p.waitForResponse(response => held(new URL(response.url())) && response.request().method() === 'GET')
      releaseRequest()
      await downloaded
      await expect(card(p, 'flight.png')).toHaveCount(0)
      await p.waitForTimeout(500)
      await expect(p.locator('iframe.attachmentPreviewFrame')).toHaveCount(framesBefore)
      const lateSaveUrls = objectUrls.slice(eventBaseline).filter(event => event.action === 'created' && event.url.startsWith(`blob:${origin}/`))
      expect(lateSaveUrls).toEqual([])
    } finally {
      releaseRequest()
      await p.context().unroute(held)
    }
  })
})
