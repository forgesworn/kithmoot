import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { instrumentBrowserLinkOwnership } from './browser-link-ownership-diagnostic.js'
const run = (page: Page, code: string) => page.evaluate(`(${code})()`)
const origin = 'https://browser-link.kithmoot.test'
let bundle: string
const target = 'one tab owns the engine; a second can resume after release without changing the seed'
let phase = 'not-started', observed: unknown[] | undefined
async function capture(pages: Page[], queryAfterRejection: boolean): Promise<unknown[]> {
  return Promise.all(pages.map(async (page, index) => {
    try {
      return { page: index === 0 ? 'a' : 'b', ...await page.evaluate(async query => {
        const events = ((globalThis as any).__vennelLinkOwnershipTrace as string[] | undefined)?.slice(0, 64) ?? []
        if (!query) return { events, locks: null }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const locks = await Promise.race([
            navigator.locks.query().then(state => {
              const exact = (value: { name?: string }) => value.name === 'kithmoot-browser-link-v1'
              const held = state.held?.filter(exact) ?? [], pending = state.pending?.filter(exact) ?? []
              return { held: held.length, pending: pending.length,
                heldModes: held.map(value => value.mode).slice(0, 4), pendingModes: pending.map(value => value.mode).slice(0, 4) }
            }),
            new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 500) }),
          ])
          return { events, locks }
        } catch { return { events, locks: { unavailable: true } } }
        finally { if (timer !== undefined) clearTimeout(timer) }
      }, queryAfterRejection) }
    } catch { return { page: index === 0 ? 'a' : 'b', unavailable: true } }
  }))
}
test.afterEach(({}, info) => {
  if (info.title === target) console.log('LINK_RELEASE_DIAGNOSTIC ' + JSON.stringify({ phase, status: info.status,
    observed: observed ?? [], causeEstablished: false, historicalFailureWaived: false }))
})
test.beforeAll(async () => {
  const out = await build({ entryPoints: ['test/browser-link.browser-entry.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'L', target: 'es2022', define: { 'import.meta.env.BASE_URL': '"/"' },
    plugins: [{ name: 'bounded-ownership-observer', setup(plugin) {
      plugin.onLoad({ filter: /app\/src\/browser-link\.ts$/ }, async args => ({
        contents: instrumentBrowserLinkOwnership(await readFile(args.path, 'utf8')), loader: 'ts',
      }))
    } }] })
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
  phase = 'first-a-resumed'
  const blocked = await run(b, `async () => { try { await link.resume('${'a'.repeat(64)}'); return false } catch (e) { return e.message.includes('another tab') } }`)
  phase = 'first-b-returned'
  expect(blocked).toBe(true)
  await run(a, '() => link.stop()')
  phase = 'a-stop-resolved-second-b-resume'
  try { await run(b, `() => link.resume('${'a'.repeat(64)}')`) }
  catch (error) {
    // The original second resume has already rejected. These read-only queries
    // cannot make that attempt succeed; preserve and rethrow its exact error.
    try { observed = await capture([a, b], true) }
    catch { observed = [{ unavailable: true }] }
    throw error
  }
  phase = 'second-b-resumed'
  expect(await run(b, '() => starts[0]')).toEqual(await run(a, '() => starts[0]'))
  expect(await run(b, '() => Object.keys(localStorage)')).toEqual([])
  await run(b, '() => link.stop()')
  observed = await capture([a, b], false)
  await context.close()
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
