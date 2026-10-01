// Render the approved sculptural artwork at platform sizes. No design edits.
// The site/ root icons are the app's (it loads them from the site root); the
// website's own identity is scripts/build-site-brand.mjs.
import { chromium } from '@playwright/test'
import { copyFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const master = resolve(root, 'art/brand/2026-09-09')
const artwork = `data:image/png;base64,${(await readFile(resolve(master, 'artwork.png'))).toString('base64')}`
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const target of ['app/public', 'site']) {
    const out = resolve(root, target)
    await copyFile(resolve(master, 'icon.svg'), resolve(out, 'favicon.svg'))
    for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['pwa-192x192.png', 192], ['pwa-512x512.png', 512], ['maskable-icon-512x512.png', 512]]) {
      await page.setViewportSize({ width: size, height: size })
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101114}img{width:100%;height:100%;display:block}</style><img src="${artwork}">`)
      await page.locator('img').evaluate(image => image.decode())
      await page.screenshot({ path: resolve(out, name) })
    }
  }
} finally {
  await browser.close()
}
console.log('Updated sculptural app icons and launch artwork from the approved masters.')
