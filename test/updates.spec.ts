import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { LOCAL_TEST_RELAY } from './relays.js'

async function releaseServer() {
  let revision = 1
  let delayActivation = 0
  const root = resolve('app/dist')
  const mime: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' }
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, 'http://localhost').pathname
      const relative = pathname.replace(/^\/j\//, '') || 'index.html'
      const file = resolve(root, relative)
      if (!file.startsWith(root + '/')) { res.writeHead(404).end(); return }
      let body: Buffer | string = await readFile(file)
      if (relative === 'sw.js') {
        body = `/* release ${revision} */\n${body.toString()}`
        if (delayActivation) {
          // A worker that receives the request but cannot finish promptly.
          // Keep the real browser lifecycle; only delay the activation call.
          if (!body.includes('self.skipWaiting()')) throw new Error('Missing activation handler')
          body = body.replace('self.skipWaiting()', `setTimeout(() => self.skipWaiting(), ${delayActivation})`)
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
    publish: (options: { delayActivation?: number } = {}) => {
      revision++
      delayActivation = options.delayActivation ?? 0
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((r, reject) => server.close(err => err ? reject(err) : r()))
    },
  }
}

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
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    await page.locator('#chatInput').fill('Keep this unfinished message')
    release.publish()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateNotice')).toBeVisible()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
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
    await expect(page.locator('#updateNotice')).toContainText('Turn off your microphone')
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await page.locator('#toggleMic').click()
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#updateNotice')).toBeHidden()
    await expect(page.locator('#toggleMic')).not.toHaveAttribute('data-on', 'true')
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
