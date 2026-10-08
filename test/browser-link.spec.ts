import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
const run = (page: Page, code: string) => page.evaluate(`(${code})()`)
const origin = 'https://browser-link.kithmoot.test'
let bundle: string
test.beforeAll(async () => {
  const out = await build({ entryPoints: ['test/browser-link.browser-entry.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'L', target: 'es2022', define: { 'import.meta.env.BASE_URL': '"/"' } })
  bundle = out.outputFiles[0].text
})
test('one tab owns the engine; a second can resume after release without changing the seed', async ({ browser }) => {
  const context = await browser.newContext()
  await context.route(`${origin}/**`, r => r.fulfill({ contentType: 'text/html', body: `<script>${bundle}</script>` }))
  const a = await context.newPage(), b = await context.newPage()
  for (const page of [a, b]) {
    await page.goto(origin)
    await run(page, `() => {
      window.starts = [];
      window.link = new L.BrowserLink(async config => {
        starts.push([...config.transportSeed]);
        return { stop: async () => {} };
      });
    }`)
  }
  await run(a, `() => link.resume('${'a'.repeat(64)}', ['wss://relay.example/link'])`)
  const blocked = await run(b, `async () => { try { await link.resume('${'a'.repeat(64)}'); return false } catch (e) { return e.message.includes('another tab') } }`)
  expect(blocked).toBe(true)
  await run(a, '() => link.stop()')
  await run(b, `() => link.resume('${'a'.repeat(64)}')`)
  expect(await run(b, '() => starts[0]')).toEqual(await run(a, '() => starts[0]'))
  expect(await run(b, '() => Object.keys(localStorage)')).toEqual([])
  await run(b, '() => link.stop()'); await context.close()
})

test('page closure releases ownership and the encrypted record survives a new page', async ({ browser }) => {
  const context = await browser.newContext()
  await context.route(`${origin}/**`, r => r.fulfill({ contentType: 'text/html', body: `<script>${bundle}</script>` }))
  let page = await context.newPage(); await page.goto(origin)
  await run(page, `async () => { window.link = new L.BrowserLink(async () => ({stop: async () => {}})); await link.resume('${'a'.repeat(64)}', ['wss://relay.example/link']); }`)
  await page.close(); page = await context.newPage(); await page.goto(origin)
  expect(await run(page, `async () => { window.link = new L.BrowserLink(async () => ({stop: async () => {}})); return await link.resume('${'a'.repeat(64)}'); }`)).toEqual([])
  await run(page, '() => link.forget()')
  expect(await run(page, 'async () => (await new L.BrowserLinkVault().read()) === undefined')).toBe(true)
  await context.close()
})
