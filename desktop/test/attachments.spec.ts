import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopIsolatedApp } from './isolated-app.mjs'
import { createRoom, openSettings, closeSettings } from '../../test/browser.js'
import { routeTestBlossom } from '../../test/blossom.js'
import { HOME, ORIGIN } from '../policy.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const STORAGE_KEY = 'goal4-attachment-storage-canary'

type AttachmentBridge = {
  beginAttachment(metadata: { name: string; type: string; kind: string; size: number }): Promise<string | null>
  writeAttachment(id: string, chunk: Uint8Array, finish: boolean): Promise<boolean>
  closeAttachment(id: string): Promise<void>
  closeAttachments(): Promise<void>
}

const executable = process.env.DESKTOP_EXECUTABLE ?? process.env.ELECTRON_EXECUTABLE ?? join(desktop, process.platform === 'linux'
  ? 'node_modules/electron/dist/electron'
  : process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

async function launch(profile: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: executable,
    args: [...(process.env.DESKTOP_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${profile}`],
    env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile },
    timeout: 30_000,
  })
}

async function streamAttachment(page: Page, metadata: { name: string; type: string; kind: string; size: number }, bytes: Buffer): Promise<string> {
  return page.evaluate(async ({ metadata, encoded }) => {
    const bridge = (window as unknown as { kithmootDesktop: AttachmentBridge }).kithmootDesktop
    const id = await bridge.beginAttachment(metadata)
    if (!id) throw new Error('The attachment bridge refused valid media')
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    for (let offset = 0; offset < bytes.length; offset += 17) {
      const end = Math.min(offset + 17, bytes.length)
      if (!await bridge.writeAttachment(id, bytes.subarray(offset, end), end === bytes.length)) {
        await bridge.closeAttachment(id)
        throw new Error('The attachment bridge refused a streamed chunk')
      }
    }
    return id
  }, { metadata, encoded: bytes.toString('base64') })
}

async function attachmentWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter(window => window.webContents.getURL().includes('/j/attachment-frame.html')).length)
}

async function viewerFor(app: ElectronApplication, id: string): Promise<Page> {
  await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()
    .filter(window => window.webContents.getURL().includes('/j/attachment-frame.html') && window.webContents.getURL().includes(id)).length, id)).toBe(1)
  await expect.poll(() => app.windows().filter(page => page.url().includes('/j/attachment-frame.html') && page.url().includes(id)).length).toBe(1)
  return app.windows().find(page => page.url().includes('/j/attachment-frame.html') && page.url().includes(id))!
}

async function closeAttachment(page: Page, id: string): Promise<void> {
  await page.evaluate(id => { void (window as unknown as { kithmootDesktop: AttachmentBridge }).kithmootDesktop.closeAttachment(id) }, id)
}

test('native attachment windows render streamed PNG bytes in an isolated session and clean up every close path', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-attachments-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    const main = await app.firstWindow()
    await expect(main.getByRole('button', { name: 'Start a room', exact: true })).toBeVisible({ timeout: 30_000 })
    await main.evaluate(key => localStorage.setItem(key, 'workspace-only'), STORAGE_KEY)
    await app.evaluate(({ app, BrowserWindow }) => {
      const owner = BrowserWindow.getAllWindows()[0]!.webContents
      ;(globalThis as unknown as { attachmentOwnerEvents: unknown[] }).attachmentOwnerEvents = []
      for (const name of ['did-start-navigation', 'render-process-gone', 'destroyed']) owner.on(name, (...args) => {
        (globalThis as unknown as { attachmentOwnerEvents: unknown[] }).attachmentOwnerEvents.push([name, ...args.slice(1)])
      })
      app.on('web-contents-created', (_event, contents) => {
        contents.on('render-process-gone', (_event, details) => {
          (globalThis as unknown as { attachmentOwnerEvents: unknown[] }).attachmentOwnerEvents.push(['viewer-gone', contents.getURL(), details])
        })
        contents.on('destroyed', () => {
          (globalThis as unknown as { attachmentOwnerEvents: unknown[] }).attachmentOwnerEvents.push(['viewer-destroyed'])
        })
      })
    })

    const firstId = await streamAttachment(main, { name: 'first.png', type: 'image/png', kind: 'image', size: PNG.length }, PNG)
    expect(firstId).toMatch(/^[a-f0-9]{64}$/)
    const first = await viewerFor(app, firstId)
    await expect(first).toHaveTitle('first.png')
    const image = first.locator('#attachment-surface img')
    await expect(image).toHaveAttribute('src', `kithmoot-attachment://media/${firstId}`)
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1)
    await expect(first.locator('#attachment-status')).toHaveText('')

    const nativeState = await app.evaluate(({ BrowserWindow }, id) => {
      const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('/j/attachment-frame.html'))!
      const viewer = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(id))!
      return {
        dedicatedWindow: viewer.id !== main.id && viewer.webContents.id !== main.webContents.id,
        dedicatedProcess: viewer.webContents.getOSProcessId() !== main.webContents.getOSProcessId(),
        separateSession: viewer.webContents.session !== main.webContents.session,
        persistent: viewer.webContents.session.isPersistent(),
        mainPersistent: main.webContents.session.isPersistent(),
        url: viewer.webContents.getURL(),
      }
    }, firstId)
    expect(nativeState.dedicatedWindow).toBe(true)
    expect(nativeState.dedicatedProcess).toBe(true)
    expect(nativeState.separateSession).toBe(true)
    expect(nativeState.persistent).toBe(false)
    expect(nativeState.mainPersistent).toBe(true)
    expect(nativeState.url).toContain('/j/attachment-frame.html#')
    expect(nativeState.url).toContain(`id=${firstId}`)

    const isolated = await first.evaluate(async key => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      bridge: typeof (window as unknown as { kithmootDesktop?: unknown }).kithmootDesktop,
      workers: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0,
      controlled: !!navigator.serviceWorker?.controller,
      appStorage: localStorage.getItem(key),
    }), STORAGE_KEY)
    expect(isolated).toEqual({ require: 'undefined', process: 'undefined', bridge: 'undefined', workers: 0, controlled: false, appStorage: null })
    await first.evaluate(key => localStorage.setItem(key, 'viewer-only'), STORAGE_KEY)
    expect(await main.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('workspace-only')
    await expect.poll(() => attachmentWindowCount(app)).toBe(1)
    expect(await app.evaluate(() => (globalThis as unknown as { attachmentOwnerEvents: unknown[] }).attachmentOwnerEvents)).toEqual([])

    await closeAttachment(main, firstId)
    await expect.poll(() => first.isClosed()).toBe(true)
    await expect.poll(() => attachmentWindowCount(app)).toBe(0)
    expect(await main.evaluate(id => (window as unknown as { kithmootDesktop: AttachmentBridge }).kithmootDesktop.writeAttachment(id, new Uint8Array(), true), firstId)).toBe(false)

    const replacementId = await streamAttachment(main, { name: 'replacement.png', type: 'image/png', kind: 'image', size: PNG.length }, PNG)
    const replacement = await viewerFor(app, replacementId)
    expect(replacementId).not.toBe(firstId)
    await expect.poll(() => replacement.locator('#attachment-surface img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1)
    expect(await replacement.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull()
    await closeAttachment(main, replacementId)
    await expect.poll(() => attachmentWindowCount(app)).toBe(0)

    expect(await app.evaluate(() => (globalThis as unknown as { attachmentOwnerEvents: unknown[][] }).attachmentOwnerEvents.filter(event => event[0] === 'viewer-gone'))).toEqual([])
    await main.evaluate(() => { void (window as unknown as { kithmootDesktop: AttachmentBridge }).kithmootDesktop.closeAttachments() })
    await expect.poll(() => attachmentWindowCount(app)).toBe(0)
    await main.evaluate(() => { void (window as unknown as { kithmootDesktop: AttachmentBridge }).kithmootDesktop.closeAttachments() })
    await closeAttachment(main, replacementId)
    expect(await main.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('workspace-only')
  } finally {
    await stopIsolatedApp(app, profile)
    await rm(profile, { recursive: true, force: true })
  }
})

test('hostile SVG stays inert and the attachment window cannot navigate, open popups or reach the network', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '/')
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' })
    response.end('<svg xmlns="http://www.w3.org/2000/svg"/>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The local canary did not bind')
  const canary = `http://127.0.0.1:${address.port}`
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-attachment-svg-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    const main = await app.firstWindow()
    await expect(main.getByRole('button', { name: 'Start a room', exact: true })).toBeVisible({ timeout: 30_000 })
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" onload="fetch('${canary}/onload')">
      <script>fetch('${canary}/script'); window.open('${canary}/svg-popup')</script>
      <image href="${canary}/image" width="24" height="24"/>
      <rect width="24" height="24" fill="#087f5b"/>
    </svg>`)
    const id = await streamAttachment(main, { name: 'hostile.svg', type: 'image/svg+xml', kind: 'image', size: svg.length }, svg)
    const viewer = await viewerFor(app, id)
    const image = viewer.locator('#attachment-surface img')
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(24)
    const originalUrl = viewer.url()

    await app.evaluate(({ BrowserWindow }, id) => {
      const viewer = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(id))!
      const probe = { navigations: [] as string[], popups: 0, sent: [] as string[] }
      ;(globalThis as unknown as { attachmentProbe: typeof probe }).attachmentProbe = probe
      viewer.webContents.on('did-navigate', (_event, url) => probe.navigations.push(url))
      viewer.webContents.on('did-navigate-in-page', (_event, url) => probe.navigations.push(url))
      viewer.webContents.on('did-create-window', () => { probe.popups++ })
      viewer.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        probe.sent.push(details.url)
        callback({ requestHeaders: details.requestHeaders })
      })
    }, id)

    const attempts = await viewer.evaluate(async canary => {
      const popup = window.open(`${canary}/popup`, '_blank')
      let fetchError = ''
      try { await fetch(`${canary}/fetch`) } catch (error) { fetchError = String(error) }
      const external = new Image()
      const settled = new Promise<void>(resolve => {
        external.onload = () => resolve()
        external.onerror = () => resolve()
        setTimeout(resolve, 1_000)
      })
      external.src = `${canary}/image-element`
      document.body.append(external)
      await settled
      location.assign(`${canary}/navigate`)
      return { popup: popup === null, fetchError, externalLoaded: external.complete && external.naturalWidth > 0 }
    }, canary)
    expect(attempts.popup).toBe(true)
    expect(attempts.fetchError).not.toBe('')
    expect(attempts.externalLoaded).toBe(false)
    await viewer.waitForTimeout(750)

    expect(viewer.isClosed() || viewer.url() === originalUrl).toBe(true)
    expect(requests).toEqual([])
    await expect.poll(() => attachmentWindowCount(app)).toBeLessThanOrEqual(1)
    expect(await app.evaluate(() => (globalThis as unknown as { attachmentProbe: { navigations: string[]; popups: number; sent: string[] } }).attachmentProbe)).toEqual({ navigations: [], popups: 0, sent: [] })
    await main.evaluate(() => { void (window as unknown as { kithmootDesktop: AttachmentBridge }).kithmootDesktop.closeAttachments() })
    await expect.poll(() => attachmentWindowCount(app)).toBe(0)
  } finally {
    await stopIsolatedApp(app, profile)
    await rm(profile, { recursive: true, force: true })
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('a real attachment opens natively and retraction closes its viewer', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-attachment-ui-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    const main = await app.firstWindow()
    const relay = 'ws://127.0.0.1:17777'
    await main.context().routeWebSocket(url => url.href !== `${relay}/`, socket => socket.close())
    await routeTestBlossom(main.context(), ORIGIN)
    await createRoom(main, HOME, [relay])
    await openSettings(main, 'Privacy')
    await main.locator('#settingsPane .infoRow', { has: main.locator('.infoRowTitle', { hasText: /^Where files go$/ }) }).click()
    await main.getByRole('radio', { name: 'My own server' }).check()
    await main.locator('#attachServer').fill(ORIGIN)
    await main.locator('#saveFileStorage').click()
    await closeSettings(main)

    await main.locator('#chatInput').evaluate((input, encoded) => {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([bytes], 'ui.png', { type: 'image/png' }))
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboard })
      input.dispatchEvent(event)
    }, PNG.toString('base64'))
    await main.locator('#chatForm button[type="submit"]').click()
    const card = main.locator('#chatLog .attachment').filter({ has: main.locator('.attName', { hasText: 'ui.png' }) })
    await expect(card).toHaveCount(1)
    const message = card.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " msg ")]')
    await card.getByRole('button', { name: 'Show ui.png' }).click()
    const open = card.getByRole('button', { name: 'Open ui.png' })
    await expect(open).toBeVisible()
    await expect(card.locator('img, audio, video, iframe, object, embed')).toHaveCount(0)
    await open.click()
    await expect.poll(() => app.windows().filter(page => page.url().includes('/j/attachment-frame.html')).length).toBe(1)
    const viewer = app.windows().find(page => page.url().includes('/j/attachment-frame.html'))!
    await expect(viewer).toHaveTitle('ui.png')
    await expect.poll(() => viewer.locator('#attachment-surface img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1)

    await message.locator('.messageMore').click()
    await main.locator('#messageActionPanel').getByRole('button', { name: 'Retract this message' }).click()
    await main.locator('#actionConfirm').click()
    await expect(main.locator('#actionDialog')).toBeHidden()
    await main.waitForTimeout(2_000)
    await expect(card).toHaveCount(0, { timeout: 60_000 })
    await expect.poll(() => viewer.isClosed()).toBe(true)
    await expect.poll(() => attachmentWindowCount(app)).toBe(0)
  } finally {
    await stopIsolatedApp(app, profile)
    await rm(profile, { recursive: true, force: true })
  }
})
