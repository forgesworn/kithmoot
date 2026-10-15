import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
let server: Server, origin = ''
const output = resolve('app/dist')
test.beforeAll(async () => {
  await readFile(resolve(output, 'index.html'))
  server = createServer(async (request, response) => {
    if (request.url === '/probe') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><p>Probe</p>'); return }
    try {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (!path.startsWith('/j/')) { response.writeHead(404); response.end(); return }
      const file = resolve(output, path.slice(3) || 'index.html')
      if (!file.startsWith(output + '/')) throw new Error('invalid fixture path')
      const body = await readFile(file)
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' }
      response.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream'); response.end(body)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('built fixture missing')
  origin = `http://127.0.0.1:${address.port}`
})
test.afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
async function available(page: Page, lock: string): Promise<boolean> {
  return page.evaluate(name => navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, held => !!held), lock)
}
const locks = ['kithmoot-ordinary-state-v1:migration', 'kithmoot-ordinary-state-v1:write']
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === origin ? route.continue() : route.abort()
  })
  await context.routeWebSocket('**', socket => socket.close())
})

test('actual Vite app opens an empty profile behind both lifetime leases', async ({ page }) => {
  await page.goto(origin + '/j/')
  await page.waitForFunction("document.documentElement.dataset.ordinaryStartup === 'ready'")
  await expect(page.locator('#ordinaryStartupNotice')).toBeHidden()
  const probe = await page.context().newPage(); await probe.goto(origin + '/probe')
  for (const lock of locks) expect(await available(probe, lock)).toBe(false)
  await page.close()
  for (const lock of locks) await expect.poll(() => available(probe, lock)).toBe(true)
})

test('actual built protected profile imports no SDK, legacy storage or provider', async ({ page, context }) => {
  await page.goto(origin + '/probe')
  await page.evaluate(async () => {
    localStorage.setItem('kithmoot.name', 'Retained synthetic name')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kithmoot-ordinary-state-v1', 7)
      request.onupgradeneeded = () => request.result.createObjectStore('unexpected-private-schema')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => { request.result.close(); resolve() }
    })
  })
  await context.addInitScript(() => {
    const w = window as any
    w.early = { storage: 0, entropy: 0, provider: 0, sockets: 0 }
    const get = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) { w.early.storage++; return get.call(this, key) }
    const random = crypto.getRandomValues.bind(crypto)
    crypto.getRandomValues = (...args) => { w.early.entropy++; return random(...args) }
    Object.defineProperty(window, 'nostr', { get() { w.early.provider++; throw new Error('held provider access') } })
    const NativeSocket = WebSocket
    window.WebSocket = class extends NativeSocket { constructor(url: string | URL, protocols?: string | string[]) { w.early.sockets++; super(url, protocols) } }
  })
  const requests: string[] = []
  page.on('request', request => { if (/\/(main|text-size|call-folds)-[^/]+\.js/.test(request.url())) requests.push(request.url()) })
  await page.goto(origin + '/j/')
  await page.waitForFunction("document.documentElement.dataset.ordinaryStartup === 'held'")
  expect(await page.evaluate('early')).toEqual({ storage: 0, entropy: 0, provider: 0, sockets: 0 })
  expect(requests).toEqual([])
  expect(await page.evaluate(() => localStorage.getItem('kithmoot.name'))).toBe('Retained synthetic name')
  for (const lock of locks) await expect.poll(() => available(page, lock)).toBe(true)
})

for (const module of ['text-size', 'call-folds', 'main']) {
  test(`delayed real ${module} evaluation remains fenced after pagehide`, async ({ page, context }) => {
    let arrived!: () => void, release!: () => void
    const arriving = new Promise<void>(resolve => { arrived = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const requested: string[] = []
    page.on('request', request => {
      for (const name of ['text-size', 'call-folds', 'main']) if (new RegExp('/' + name + '-[^/]+\\.js').test(request.url())) requested.push(name)
    })
    await context.route(new RegExp('/' + module + '-[^/]+\\.js'), async route => {
      const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response })
    })
    await page.goto(origin + '/j/', { waitUntil: 'domcontentloaded' })
    await arriving
    const probe = await context.newPage(); await probe.goto(origin + '/probe')
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    for (const lock of locks) expect(await available(probe, lock)).toBe(false)
    release()
    await page.waitForFunction("document.documentElement.dataset.ordinaryStartup === 'held'")
    expect(requested).toEqual(['text-size', 'call-folds', 'main'].slice(0, ['text-size', 'call-folds', 'main'].indexOf(module) + 1))
    for (const lock of locks) expect(await available(probe, lock)).toBe(false)
    await page.close()
    for (const lock of locks) await expect.poll(() => available(probe, lock)).toBe(true)
  })
}
