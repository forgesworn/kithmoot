import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname } from 'node:path'

const site = fileURLToPath(new URL('../site/', import.meta.url))
const caddy = await readFile(new URL('../deploy/Caddyfile.kithmoot', import.meta.url), 'utf8')
const csp = caddy.match(/header @notApp \{[^}]*Content-Security-Policy "([^"]+)"/)?.[1]
if (!csp) throw new Error('The website acceptance test needs its production Content-Security-Policy')
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }

for (const colour of ['light', 'dark'] as const) {
  test(`website works without JavaScript, under its production CSP, in ${colour} mode`, async ({ browser }, info) => {
    const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: colour })
    const failed: string[] = []
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
    const page = await context.newPage()
    try {
      await page.goto('https://site.kithmoot.test/')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('A town hall nobody owns.')
      await expect(page.locator('.hero .primary')).toHaveAttribute('href', 'j/')
      await expect(page.getByRole('link', { name: 'Sign in with Nostr' })).toHaveAttribute('href', 'j/?signin=nostr')
      await expect(page.locator('#android')).toContainText('Debug-signed preview')
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}px`).toBe(true)
        const images = await page.locator('img').evaluateAll(images => images.every(img => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0))
        expect(images, 'all website images must load').toBe(true)
        await page.screenshot({ path: info.outputPath(`site-${colour}-${width}.png`), fullPage: width === 1440 })
      }
      await page.goto('https://site.kithmoot.test/')
      await page.keyboard.press('Tab')
      await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
      await page.keyboard.press('Enter')
      const help = page.locator('summary', { hasText: "Why won't my invitation open?" })
      await help.focus()
      await page.keyboard.press('Enter')
      await expect(help.locator('..')).toHaveAttribute('open', '')
      await expect(help.locator('..')).toContainText('current link')
      const missingAnchors = await page.locator('a[href^="#"]').evaluateAll(links => links
        .map(link => link.getAttribute('href')!.slice(1)).filter(id => !document.getElementById(id)))
      expect(missingAnchors).toEqual([])
      // Large text must reflow instead of clipping calls to action.
      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(() => document.documentElement.style.fontSize = '200%')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(failed).toEqual([])
    } finally { await context.close() }
  })
}
