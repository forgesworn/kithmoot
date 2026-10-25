import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { LOCAL_TEST_RELAY } from './relays.js'

async function releaseServer(options: { beforeWorkerResponse?: () => Promise<void> } = {}) {
  let revision = 1
  let delayActivation = 0
  let closed = false
  const root = resolve('app/dist')
  const requests: string[] = []
  const mime: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }
  const server = createServer(async (req, res) => {
    try {
      const requestURL = new URL(req.url!, 'http://localhost')
      requests.push(`${req.method ?? 'GET'} ${requestURL.pathname}${requestURL.search}`)
      const pathname = requestURL.pathname
      const relative = pathname.replace(/^\/j\//, '') || 'index.html'
      if (relative === 'blank.html') {
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        res.end('<!doctype html><title>Artwork cache setup</title>')
        return
      }
      if (relative === 'legacy-artwork-sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
        res.end(`self.addEventListener('install', event => event.waitUntil((async () => {
          const cache = await caches.open('workbox-precache-v2-' + self.registration.scope);
          for (const path of ['chat-art/coffee.gif', 'chat-art/laugh.gif', 'emoji/happy.png']) {
            const url = new URL(path, self.registration.scope);
            await cache.put(url.href + '?__WB_REVISION__=legacy', await fetch(url));
          }
        })()));`)
        return
      }
      const file = resolve(root, relative)
      if (!file.startsWith(root + '/')) { res.writeHead(404).end(); return }
      // A request already in flight belongs to the release it started on.
      // Publishing while readFile is pending must not change that response.
      const workerRelease = { revision, delayActivation }
      let body: Buffer | string = await readFile(file)
      if (relative === 'sw.js') {
        await options.beforeWorkerResponse?.()
        body = `/* release ${workerRelease.revision} */\n${body.toString()}`
        if (workerRelease.delayActivation) {
          // A worker that receives the request but cannot finish promptly.
          // Keep the real browser lifecycle; only delay the activation call.
          if (!body.includes('self.skipWaiting()')) throw new Error('Missing activation handler')
          body = body.replace('self.skipWaiting()', `setTimeout(() => self.skipWaiting(), ${workerRelease.delayActivation})`)
        }
      }
      res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch { res.writeHead(404).end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  return {
    base: `http://127.0.0.1:${address.port}/j/`,
    requests,
    clearRequests: () => { requests.length = 0 },
    publish: (options: { delayActivation?: number } = {}) => {
      revision++
      delayActivation = options.delayActivation ?? 0
    },
    close: async () => {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((r, reject) => server.close(err => err ? reject(err) : r()))
    },
  }
}

test('publishing during a worker read keeps that response on its original release', async ({ request }) => {
  let received!: () => void
  let resume!: () => void
  const reading = new Promise<void>(resolve => { received = resolve })
  const paused = new Promise<void>(resolve => { resume = resolve })
  const release = await releaseServer({ beforeWorkerResponse: async () => { received(); await paused } })
  try {
    const response = request.get(new URL('sw.js', release.base).href)
    await reading
    release.publish()
    resume()
    expect(await (await response).text()).toMatch(/^\/\* release 1 \*\//)
    expect(await (await request.get(new URL('sw.js', release.base).href)).text()).toMatch(/^\/\* release 2 \*\//)
  } finally {
    resume()
    await release.close()
  }
})

test('an update on the first visit completes without an existing controller', async ({ browser }) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.routeWebSocket(/.*/, ws => ws.close())
  try {
    const page = await context.newPage()
    page.on('dialog', dialog => { throw new Error(`Unexpected browser dialog: ${dialog.message()}`) })
    await page.goto(release.base)
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    // A newly installed worker does not control the already-open first visit.
    // This is also possible when the PWA is installed without being reopened.
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    release.publish()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateNotice')).toBeVisible()
    await Promise.all([
      page.waitForEvent('load', { timeout: 5_000 }),
      page.locator('#updateApp').click(),
    ])
    await expect(page.locator('#updateNotice')).toBeHidden()
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  } finally {
    await context.close()
    await release.close()
  }
})

test('a stalled update offers a retry and late activation still needs consent', async ({ browser }) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.routeWebSocket(/wss:\/\/.*/, ws => ws.close())
  try {
    const page = await context.newPage()
    page.on('dialog', dialog => { throw new Error(`Unexpected browser dialog: ${dialog.message()}`) })
    await page.goto(encodeJoinUrl(release.base, generateRoomSecret(), [LOCAL_TEST_RELAY]))
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await page.locator('#displayName').fill('Update retry reader')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    release.publish({ delayActivation: 15000 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateNotice')).toBeVisible()
    await page.locator('#updateApp').click()
    await expect(page.locator('#updateApp')).toHaveText('Updating…')
    await page.locator('#chatInput').fill('Keep this while an update is stuck')
    await expect(page.locator('#updateApp')).toHaveText('Try updating again', { timeout: 12_000 })
    await expect(page.locator('#updateApp')).toBeEnabled()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this while an update is stuck')
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting === null)).toBe(true)
    // The timed-out approval cannot authorise a late background reload.
    await expect(page.locator('#chatInput')).toHaveValue('Keep this while an update is stuck')
    await page.locator('#updateApp').click()
    await expect(page.locator('#updateNotice')).toContainText('Send or discard')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this while an update is stuck')
    await page.locator('#chatInput').fill('')
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#updateNotice')).toBeHidden()
  } finally {
    await context.close()
    await release.close()
  }
})

test('work started during activation cancels the reload until a fresh click', async ({ browser }) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.routeWebSocket(/wss:\/\/.*/, ws => ws.close())
  try {
    const page = await context.newPage()
    page.on('dialog', dialog => { throw new Error(`Unexpected browser dialog: ${dialog.message()}`) })
    await page.goto(encodeJoinUrl(release.base, generateRoomSecret(), [LOCAL_TEST_RELAY]))
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await page.locator('#displayName').fill('Activation reader')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    release.publish({ delayActivation: 2000 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateNotice')).toBeVisible()
    await page.locator('#updateApp').click()
    await expect(page.locator('#updateApp')).toHaveText('Updating…')
    await page.locator('#chatInput').fill('Started while updating')
    await expect(page.locator('#updateNotice')).toContainText('Send or discard')
    await expect(page.locator('#updateApp')).toBeEnabled()
    await expect(page.locator('#chatInput')).toHaveValue('Started while updating')
    await page.locator('#chatInput').fill('')
    await expect(page.locator('#roomArea')).toBeVisible()
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#updateNotice')).toBeHidden()
  } finally {
    await context.close()
    await release.close()
  }
})

test('an update waits for drafts and calls, then returns to the room without a popup', async ({ browser }, testInfo) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  // Chromium is launched with a synthetic microphone in this suite. CI's
  // WebKit has no capture device, but joining the call exercises the same
  // update blocker and leave-call path without pretending hardware exists.
  const canUseSyntheticMic = testInfo.project.name === 'chromium'
  await context.routeWebSocket(/wss:\/\/.*/, ws => ws.close())
  try {
    const page = await context.newPage()
    page.on('dialog', dialog => { throw new Error(`Unexpected browser dialog: ${dialog.message()}`) })
    await page.goto(encodeJoinUrl(release.base, generateRoomSecret(), [LOCAL_TEST_RELAY]))
    // A first installation controls the next navigation. Establish that
    // normal returning-visitor state before testing an update during a room.
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await page.locator('#displayName').fill('Update reader')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#callToggle').click()
    if (canUseSyntheticMic) {
      await page.locator('#toggleMic').click()
      await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    }
    await expect(page.locator('#callToggle')).toHaveAttribute('data-live', 'true')
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    await page.locator('#chatInput').fill('Keep this unfinished message')
    release.publish()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateNotice')).toBeVisible()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    await expect(page.locator('#roomArea')).toBeVisible()
    if (canUseSyntheticMic) await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 740 })
      await expect(page.locator('#updateApp')).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`update-in-room-${width}.png`) })
    }
    await page.locator('#updateApp').click()
    await expect(page.locator('#updateNotice')).toContainText('Send or discard')
    await expect(page.locator('#actionDialog')).toBeHidden()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    // Simulate another tab accepting: activation must still not reload us.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      reg.waiting!.postMessage({ type: 'SKIP_WAITING' })
    })
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting === null)).toBe(true)
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('')
    await page.locator('#updateApp').click()
    await expect(page.locator('#updateNotice')).toContainText('Updating will turn off this device\'s microphone')
    await expect(page.locator('#updateApp')).toHaveText('Leave call and update')
    if (canUseSyntheticMic) await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#updateNotice')).toBeHidden()
    await expect(page.locator('#toggleMic')).not.toHaveAttribute('data-on', 'true')
    // A later update discovered while already on a call must paint the
    // truthful one-step action immediately, including on a narrow phone
    // using enlarged text. This is the physical iPhone trap which prompted
    // the recoverable call blocker: the media controls can be far below the
    // notice and must not be a prerequisite for updating.
    if (await page.locator('#callToggle').getAttribute('data-live') !== 'true') await page.locator('#callToggle').click()
    await expect(page.locator('#callToggle')).toHaveAttribute('data-live', 'true')
    if (canUseSyntheticMic) await page.locator('#toggleMic').click()
    release.publish()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateApp')).toHaveText('Leave call and update')
    await page.setViewportSize({ width: 320, height: 740 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect(page.locator('#updateApp')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('update-active-call-large-text.png') })
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#updateNotice')).toBeHidden()
    // An idle room also updates directly and resumes without the join form.
    release.publish()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateNotice')).toBeVisible()
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#updateNotice')).toBeHidden()
  } finally {
    await context.close()
    await release.close()
  }
})

test('an open PWA finds updates automatically and checks again after reconnecting', async ({ browser }, testInfo) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.routeWebSocket(/.*/, ws => ws.close())
  try {
    const page = await context.newPage()
    page.on('dialog', dialog => { throw new Error(`Unexpected browser dialog: ${dialog.message()}`) })
    await page.clock.install()
    await page.goto(release.base)
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    await expect(page.locator('#updateNotice')).toBeHidden()

    release.publish()
    await page.clock.fastForward(60_000)
    await expect(page.getByRole('status').filter({ hasText: 'Update ready' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeVisible()
    const returning = await context.newPage()
    await returning.goto(release.base)
    await expect(returning.locator('#updateNotice')).toBeVisible()
    await returning.close()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 740 })
        await expect(page.locator('#updateNotice')).toBeInViewport()
        await expect(page.locator('#updateApp')).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`update-${colorScheme}-${width}.png`) })
      }
    }
    await page.setViewportSize({ width: 320, height: 740 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; window.scrollTo(0, document.body.scrollHeight) })
    await expect(page.locator('#updateApp')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('update-large-text.png') })
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#updateNotice')).toBeHidden()
    // load precedes completion of the app's lazy startup imports. Do not
    // interrupt those requests when testing the subsequent reconnect.
    await expect(page.locator('#home')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await context.setOffline(true)
    release.publish()
    await page.clock.fastForward(60_000)
    await expect(page.locator('#updateNotice')).toBeHidden()
    await context.setOffline(false)
    await expect(page.locator('#updateNotice')).toBeVisible()
  } finally {
    await context.close()
    await release.close()
  }
})

test('an upgrade migrates cached originals without network before old precache cleanup', async ({ browser }) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.routeWebSocket(/.*/, socket => socket.close())
  const originalRequests = () => release.requests.filter(request => /\/(?:chat-art|emoji)\/[^ ?]+\.(?:png|gif)(?:\?|$)/.test(request))
  try {
    const page = await context.newPage()
    await page.goto(new URL('blank.html', release.base).href)
    // Seed through an installed worker, as the previous PWA did, rather
    // than synthesising its CacheStorage from a page process.
    await page.evaluate(async scope => {
      await navigator.serviceWorker.register(new URL('legacy-artwork-sw.js', scope), { scope })
      await navigator.serviceWorker.ready
    }, release.base)
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe('activated')
    release.clearRequests()
    await page.goto(release.base)
    await expect(page.locator('#updateNotice')).toBeVisible()
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated')
    expect(originalRequests()).toEqual([])
    const cacheState = () => page.evaluate(async scope => {
      const old = await caches.open(`workbox-precache-v2-${scope}`)
      const runtime = await caches.open('kithmoot-original-artwork-v1')
      const original = (requests: readonly Request[]) => requests.map(request => request.url).filter(url => /\/(?:chat-art|emoji)\/[^/]+\.(?:png|gif)(?:\?|$)/.test(url))
      return { precache: original(await old.keys()).sort(), runtime: original(await runtime.keys()).sort() }
    }, release.base)
    await expect.poll(cacheState).toEqual({
      precache: [],
      runtime: [
        new URL('chat-art/coffee.gif', release.base).href,
        new URL('chat-art/laugh.gif', release.base).href,
        new URL('emoji/happy.png', release.base).href,
      ],
    })
    expect(originalRequests()).toEqual([])
    await release.close()
    await expect(fetch(release.base)).rejects.toThrow()
    const offline = await page.evaluate(async scope => {
      const responses = []
      for (const path of ['chat-art/coffee.gif', 'chat-art/laugh.gif', 'emoji/happy.png']) {
        const response = await fetch(new URL(path, scope))
        responses.push({ status: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength })
      }
      return responses
    }, release.base)
    expect(offline).toEqual([
      { status: 200, type: 'image/gif', bytes: 5924981 },
      { status: 200, type: 'image/gif', bytes: 181899 },
      { status: 200, type: 'image/png', bytes: 45269 },
    ])
  } finally {
    await context.close()
    await release.close()
  }
})

test('a fresh profile installs without downloading original chat-art or emoji', async ({ browser }) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.routeWebSocket(/.*/, socket => socket.close())
  try {
    const page = await context.newPage(); await page.goto(release.base)
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    const originalRequests = release.requests.filter(request => /\/(?:chat-art|emoji)\/[^ ?]+\.(?:png|gif)(?:\?|$)/.test(request))
    expect(originalRequests).toEqual([])
    const precachedOriginals = await page.evaluate(async scope => {
      const cache = await caches.open(`workbox-precache-v2-${scope}`)
      return (await cache.keys()).map(request => request.url).filter(url => /\/(?:chat-art|emoji)\/[^/]+\.(?:png|gif)(?:\?|$)/.test(url))
    }, release.base)
    expect(precachedOriginals).toEqual([])
  } finally {
    await context.close()
    await release.close()
  }
})
