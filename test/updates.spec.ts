import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { LOCAL_TEST_RELAY } from './relays.js'

async function releaseServer() {
  let revision = 1
  const root = resolve('app/dist')
  const mime: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' }
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, 'http://localhost').pathname
      const relative = pathname.replace(/^\/j\//, '') || 'index.html'
      const file = resolve(root, relative)
      if (!file.startsWith(root + '/')) { res.writeHead(404).end(); return }
      let body: Buffer | string = await readFile(file)
      if (relative === 'sw.js') body = `/* release ${revision} */\n${body.toString()}`
      res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch { res.writeHead(404).end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  return {
    base: `http://127.0.0.1:${address.port}/j/`,
    publish: () => { revision++ },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((r, reject) => server.close(err => err ? reject(err) : r()))
    },
  }
}

test('a real service-worker update preserves the room and draft until the reader accepts', async ({ browser }, testInfo) => {
  const release = await releaseServer()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.routeWebSocket(/wss:\/\/.*/, ws => ws.close())
  try {
    const page = await context.newPage()
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
    page.once('dialog', dialog => dialog.dismiss())
    await page.locator('#updateApp').click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    // Simulate another tab accepting: activation must still not reload us.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      reg.waiting!.postMessage({ type: 'SKIP_WAITING' })
    })
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting === null)).toBe(true)
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    await expect(page.locator('#roomArea')).toBeVisible()
    page.once('dialog', dialog => dialog.accept())
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#join')).toBeVisible()
    await expect(page.locator('#updateNotice')).toBeHidden()
    // Also exercise accepting a waiting worker through the button itself.
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    release.publish()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('#updateNotice')).toBeVisible()
    page.once('dialog', dialog => dialog.accept())
    await Promise.all([page.waitForEvent('load'), page.locator('#updateApp').click()])
    await expect(page.locator('#join')).toBeVisible()
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
    await page.clock.install()
    await page.goto(release.base)
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    await expect(page.locator('#updateNotice')).toBeHidden()

    release.publish()
    await page.clock.fastForward(60_000)
    await expect(page.getByRole('status').filter({ hasText: 'Update ready' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reload to update', exact: true })).toBeVisible()
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
