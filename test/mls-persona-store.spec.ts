import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const origin = 'https://browser-mls-store.kithmoot.test'
let bundle: string
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['test/mls-persona-store.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text
})
async function fixture(context: BrowserContext) {
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/vmls-wasm/vmls_wasm.js' || path === '/vmls-wasm/vmls_wasm_bg.wasm') return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.fulfill(path === '/' ? { contentType: 'text/html', body: '<script src="/fixture.js"></script>' } : { contentType: 'text/javascript', body: bundle })
  })
  const page = await context.newPage()
  await page.goto(origin)
  expect(await page.evaluate('M.prepare()')).toEqual({ active: '1', staged: '2', mismatch: 'seal-lost' })
  return page
}
test('sealed staged objects survive reload; promotion is atomic and revision CAS refuses stale writes', async ({ context }) => {
  const page = await fixture(context)
  expect(await page.evaluate('M.metadata()')).toEqual({ nonextractable: true, noPersona: true, sealedOnly: ['revision', 'sealed'] })
  await page.reload()
  expect(await page.evaluate('M.reopenAndPromote()')).toEqual({ read: [6, 7], active: '2', staged: null, conflict: 'conflict', unchangedVault: true, escaped: 'closed' })
  expect(await page.evaluate('M.raceAndAbort()')).toEqual({ winners: 1, losers: ['conflict'], injected: true, failure: 'unavailable', identical: true })
})
for (const kind of ['record', 'keys', 'names', 'tamper'] as const) test(`lost or altered ${kind} cannot create a fresh persona over retained state`, async ({ context }) => {
  const page = await fixture(context)
  const result = await page.evaluate(kind => (window as any).M.loss(kind), kind)
  expect(result.reading).toBe(kind === 'record' ? 'missing-record' : 'seal-lost')
  expect(result.replacing).not.toBe('unexpected-success')
})
test('one tab retains the persona lock across an awaited witness trip', async ({ context }) => {
  const a = await fixture(context), b = await context.newPage()
  await b.goto(origin)
  const held = a.evaluate('M.hold()')
  await expect.poll(() => a.evaluate('M.held')).toBe(true)
  await b.evaluate('window.readFinished = false; window.reading = M.readState().then(state => { window.readFinished = true; return state }); void 0')
  // Query the real lock manager instead of inferring ownership from a delay.
  await expect.poll(() => b.evaluate(async () => (await navigator.locks.query()).pending?.some(x => x.name?.includes(':persona:')))).toBe(true)
  expect(await b.evaluate('window.readFinished')).toBe(false)
  await a.evaluate('M.unlock()'); await held
  expect(await b.evaluate('window.reading')).toBe('09')
})
test('the shared coordinator detects changed sealed objects from a freshly computed manifest', async ({ context }) => {
  const page = await fixture(context)
  expect(await page.evaluate('M.manifestIntegrity()')).toEqual({ initial: null, altered: 'local-state-mismatch' })
})
