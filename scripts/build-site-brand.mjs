// Website identity from the September 2026 vector masters: copies the lockups
// the pages load, and renders the favicon, touch icon and social card. The
// app's own icons are left to build-brand-assets.mjs.
import { chromium } from '@playwright/test'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const master = resolve(root, 'art/brand/2026-09-29')
const site = resolve(root, 'site')
const lockups = ['horizontal-gradient', 'horizontal-white', 'symbol-gradient', 'symbol-flat', 'symbol-small-flat', 'symbol-white', 'stacked-gradient', 'app-icon-light']

await mkdir(resolve(site, 'img/brand'), { recursive: true })
for (const name of lockups) await copyFile(resolve(master, `kithmoot-${name}.svg`), resolve(site, `img/brand/kithmoot-${name}.svg`))
await copyFile(resolve(master, 'kithmoot-symbol-small-flat.svg'), resolve(site, 'icon.svg'))

const svg = async name => `data:image/svg+xml;base64,${(await readFile(resolve(master, `kithmoot-${name}.svg`))).toString('base64')}`
const font = `data:font/woff2;base64,${(await readFile(resolve(site, 'fonts/inter-var-latin.woff2'))).toString('base64')}`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const render = async (width, height, html, path) => {
    await page.setViewportSize({ width, height })
    await page.setContent(`<style>@font-face{font-family:Inter;src:url(${font}) format('woff2');font-weight:100 900}html,body{margin:0;width:100%;height:100%;overflow:hidden}img{display:block}</style>${html}`)
    await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(image => image.decode())]))
    await page.screenshot({ path })
  }
  await render(32, 32, `<img src="${await svg('symbol-small-flat')}" style="width:32px;height:32px">`, resolve(site, 'icon-32.png'))
  await render(180, 180, `<img src="${await svg('app-icon-light')}" style="width:180px;height:180px">`, resolve(site, 'icon-180.png'))
  await render(1200, 630, `
    <div style="box-sizing:border-box;width:1200px;height:630px;padding:96px 104px;background:#F3F8FA;font-family:Inter;color:#102A43;display:flex;flex-direction:column;justify-content:center">
      <img src="${await svg('horizontal-gradient')}" style="width:520px;height:auto;margin-bottom:56px">
      <div style="font-size:68px;font-weight:700;letter-spacing:-0.02em;line-height:1.1">A workspace nobody owns.</div>
      <div style="font-size:32px;line-height:1.4;margin-top:24px;color:#3E5469">Chat, calls and files for your people, encrypted end to end.</div>
    </div>`, resolve(site, 'img/og-card.png'))
} finally {
  await browser.close()
}
console.log('Updated the website lockups, icons and social card from art/brand/2026-09-29.')
