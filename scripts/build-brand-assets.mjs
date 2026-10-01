// Render the app, desktop and Android icons from the September 2026 vector
// masters. The site/ root icons are the app's (it loads them from the site
// root); the website's own identity is scripts/build-site-brand.mjs.
//
// Ordinary icons use the gradient mark on white, because the guide keeps the
// deep-blue arms off dark grounds. Anything drawn at 32 px or less uses the
// small flat mark, whose wider gaps survive the downscale.
import { chromium } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const master = resolve(root, 'art/brand/2026-09-29')
const android = resolve(root, '../kithmoot-android')
const svg = async name => `data:image/svg+xml;base64,${(await readFile(resolve(master, `kithmoot-${name}.svg`))).toString('base64')}`
const exists = path => stat(path).then(() => true, () => false)

// The macOS icon grid: an 824 px rounded square on a 1024 px canvas, with a
// soft shadow beneath (left off small sizes, where it only blurs the edge).
// Windows and Linux use the same tile.
const tile = (size, mark) => `<div style="position:absolute;inset:${size * 100 / 1024}px;border-radius:${size * 185 / 1024}px;background:#fff;${size >= 64 ? `box-shadow:0 ${size * 10 / 1024}px ${size * 24 / 1024}px rgba(8,25,35,.28);` : 'outline:1px solid rgba(8,25,35,.14);outline-offset:-1px;'}display:grid;place-items:center"><img src="${mark}" style="width:${size * 640 / 1024}px;height:${size * 640 / 1024}px"></div>`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const render = async (size, html, path) => {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;position:relative}img{display:block}</style>${html}`)
    await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())))
    await page.screenshot({ path, omitBackground: true })
  }
  const appIcon = await svg('app-icon-light')
  const small = await svg('symbol-small-flat')
  const gradient = await svg('symbol-gradient')

  for (const target of ['app/public', 'site']) {
    const out = resolve(root, target)
    await copyFile(resolve(master, 'kithmoot-symbol-small-flat.svg'), resolve(out, 'favicon.svg'))
    await render(32, `<img src="${small}" style="width:32px;height:32px">`, resolve(out, 'favicon-32.png'))
    // The vortex reaches 34% of the width from the centre, inside the
    // maskable safe circle (40%), so the full-bleed icon doubles as maskable.
    for (const [name, size] of [['apple-touch-icon.png', 180], ['pwa-192x192.png', 192], ['pwa-512x512.png', 512], ['maskable-icon-512x512.png', 512]]) {
      await render(size, `<img src="${appIcon}" style="width:${size}px;height:${size}px">`, resolve(out, name))
    }
  }

  const icons = resolve(root, 'desktop/icons')
  await mkdir(icons, { recursive: true })
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await render(size, tile(size, size <= 32 ? small : gradient), resolve(icons, `kithmoot-${size}.png`))
  }
  const ico = spawnSync('magick', [16, 24, 32, 48, 64, 128, 256].map(size => resolve(icons, `kithmoot-${size}.png`)).concat(resolve(root, 'desktop/artifacts/KithMoot.ico')), { stdio: 'inherit' })
  if (ico.status !== 0) throw new Error('KithMoot.ico needs ImageMagick (brew install imagemagick)')

  // Android's adaptive foreground is this bitmap on a white background layer;
  // the XML wrappers and the themed monochrome mark come from its own
  // scripts/build-brand-icons.py.
  if (await exists(android)) {
    await render(512, `<img src="${gradient}" style="width:512px;height:512px">`, resolve(android, 'app/src/main/res/drawable-nodpi/brand_artwork.png'))
  }
} finally {
  await browser.close()
}
console.log('Updated the app, desktop and Android icons from art/brand/2026-09-29.')
