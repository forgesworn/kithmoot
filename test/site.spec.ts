import { test, expect, type BrowserContext } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname } from 'node:path'

const site = fileURLToPath(new URL('../site/', import.meta.url))
const caddy = await readFile(new URL('../deploy/Caddyfile.kithmoot', import.meta.url), 'utf8')
const csp = caddy.match(/header @notApp \{[^}]*Content-Security-Policy "([^"]+)"/)?.[1]
if (!csp) throw new Error('The website acceptance test needs its production Content-Security-Policy')
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' }

async function website(context: BrowserContext, failed: string[] = []): Promise<void> {
  await context.route('https://site.kithmoot.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    const file = resolve(site, '.' + (path === '/' ? '/index.html' : path))
    if (!file.startsWith(site)) throw new Error('Site request escaped its root')
    try {
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)], headers: { 'content-security-policy': csp! } })
    } catch {
      failed.push(path)
      await route.fulfill({ status: 404, body: 'Missing website asset' })
    }
  })
}

// The public homepage is a placeholder while the product is in development.
// Existing installers remain available at their direct URLs.
test('the homepage does not promote downloads or open the app', async () => {
  const home = await readFile(new URL('../site/index.html', import.meta.url), 'utf8')
  expect(home).not.toMatch(/<a\b|<form\b|<script\b/i)
})

test('the home page no longer offers a room-code form, since meeting codes are gone', async () => {
  const home = await readFile(new URL('../site/index.html', import.meta.url), 'utf8')
  expect(home).not.toContain('id="room-code"')
  expect(home).not.toContain('Room code')
})

for (const colour of ['light', 'dark'] as const) {
  test(`website works without JavaScript, under its production CSP, in ${colour} mode`, async ({ browser }, info) => {
    const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: colour })
    const failed: string[] = []
    await website(context, failed)
    const page = await context.newPage()
    try {
      await page.goto('https://site.kithmoot.test/')
      await expect(page).toHaveTitle('KithMoot — Coming soon')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Coming soon')
      await expect(page.getByRole('main')).toContainText("We're getting things ready.")
      await expect(page.getByRole('img', { name: 'KithMoot', exact: true })).toBeVisible()
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}px`).toBe(true)
        // Resizing can select a new <picture> source after goto's load event.
        // Wait for that request/decoding too; a broken image still times out.
        await expect.poll(() => page.locator('img').evaluateAll(images => images
          .filter(img => !(img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0))
          .map(img => img.getAttribute('src'))), { message: 'all website images must load after resizing' }).toEqual([])
        await page.screenshot({ path: info.outputPath(`site-${colour}-${width}.png`), fullPage: width === 1440 })
      }
      // Large text must reflow instead of clipping the placeholder.
      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(() => document.documentElement.style.fontSize = '200%')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const name of ['privacy', 'terms']) {
        await page.goto(`https://site.kithmoot.test/${name}/index.html`)
        await expect(page.getByRole('heading', { name: /Optional hosted node/ })).toBeVisible()
        for (const width of [320, 390, 1440]) {
          await page.setViewportSize({ width, height: 900 })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflow at ${width}px`).toBe(true)
        }
      }
      expect(failed).toEqual([])
    } finally { await context.close() }
  })
}
