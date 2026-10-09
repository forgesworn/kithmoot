import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://browser-mls-enrolment.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-persona-enrolment.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'E', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
async function fixture(context: BrowserContext) {
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" }, body: '<script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (path === '/vmls-wasm/vmls_wasm.js' || path === '/vmls-wasm/vmls_wasm_bg.wasm') return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.abort()
  })
  const page = await context.newPage(), pairing = pairingFixture()
  await page.goto(origin); await page.evaluate(pairing => (window as any).E.configure(pairing), pairing)
  const perform = (action: string, fault?: string) => page.evaluate(([action, fault]) => (window as any).E.perform(action, fault), [action, fault])
  const reload = async () => { await page.reload(); await page.evaluate(pairing => (window as any).E.configure(pairing), pairing) }
  return { page, pairing, perform, reload }
}
test('explicit preparation, dedicated pairing and durable genesis return no secrets and survive reload unchanged', async ({ context }) => {
  const f = await fixture(context)
  expect((await f.perform('status')).value.state).toBe('empty')
  expect((await f.perform('pair')).events).toEqual([])
  expect((await f.perform('genesis')).value.state).toBe('empty')
  const prepared = (await f.perform('prepare')).value
  expect(prepared.state).toBe('prepared'); expect(prepared.writer).toMatch(/^[0-9a-f]{64}$/)
  expect((await f.perform('genesis')).value).toEqual(prepared)
  const paired = await f.perform('pair')
  expect(paired.events).toEqual(['start', 'pair', 'stop']); expect(paired.writers).toEqual([prepared.writer])
  expect(paired.value).toEqual({ ...prepared, state: 'paired', witness: f.pairing.witness })
  const enrolled = (await f.perform('genesis')).value
  expect(enrolled).toMatchObject({ state: 'genesis', writer: prepared.writer, installation: prepared.installation, witness: f.pairing.witness })
  expect(enrolled.command).toBe(`bothyd witness enrol --subject ${enrolled.subject} --installation ${prepared.installation} --writer ${prepared.writer} --initial-digest ${enrolled.digest}`)
  expect(JSON.stringify(enrolled)).not.toMatch(/writerSeed|pairedRouteSecret|bothy:/)
  await f.reload(); expect((await f.perform('status')).value).toEqual(enrolled)
  expect((await f.perform('genesis')).value).toEqual(enrolled)
  expect((await f.perform('pair')).events).toEqual([])
})
for (const fault of ['after-genesis', 'abort-genesis']) test(`interrupted enrolment at ${fault} keeps a recoverable atomic record`, async ({ context }) => {
  const f = await fixture(context)
  await f.perform('prepare'); await f.perform('pair')
  const failed = await f.perform('genesis', fault)
  expect(failed.injected).toBe(true); expect(failed.error).toBeTruthy(); expect(failed.value).toBeUndefined()
  await f.reload()
  const saved = (await f.perform('status')).value
  expect(saved.state).toBe(fault === 'after-genesis' ? 'genesis' : 'paired')
  const recovered = (await f.perform('genesis')).value
  if (fault === 'after-genesis') expect(recovered).toEqual(saved)
  else expect(recovered.state).toBe('genesis')
})
test('unsealed marker substitution fences without showing a keeper command or resetting the installation', async ({ context }) => {
  const f = await fixture(context)
  await f.perform('prepare'); await f.perform('pair'); await f.perform('genesis')
  await f.page.evaluate('E.damage("marker")')
  for (const action of ['status', 'prepare', 'pair', 'genesis']) {
    const result = await f.perform(action)
    expect(result.value).toEqual({ state: 'fenced', reason: 'invalid' }); expect(result.events).toEqual([])
  }
})
for (const kind of ['inner-key', 'invalid-inner-key']) test(`${kind} prevents empty genesis from being enrolled`, async ({ context }) => {
  const f = await fixture(context)
  await f.perform('prepare'); await f.perform('pair'); await f.page.evaluate(kind => (window as any).E.damage(kind), kind)
  expect((await f.perform('genesis')).value).toEqual({ state: 'fenced', reason: 'seal-lost' })
})
test('a paired witness cannot change after genesis', async ({ context }) => {
  const f = await fixture(context)
  await f.perform('prepare'); await f.perform('pair'); await f.perform('genesis')
  expect(await f.page.evaluate(route => (window as any).E.substituteRoute(route), { ...f.pairing.route, relayUrls: ['wss://other.example'] })).toBe('conflict')
})
test('scope cleanup drains an enrolled write including its retained-identity check', async ({ context }) => {
  const f = await fixture(context)
  await f.perform('prepare'); await f.perform('pair')
  const genesis = (await f.perform('genesis')).value
  expect(await f.page.evaluate('E.drainedWrite()')).toEqual({ committed: true })
  expect((await f.perform('status')).value).toEqual(genesis)
})
test('stale contexts neither pair nor expose commands after cleanup', async ({ context }) => {
  const f = await fixture(context)
  expect((await f.perform('prepare', 'stale-initial')).value).toEqual({ state: 'stale' })
  expect((await f.perform('status')).value).toEqual({ state: 'empty' })
  await f.perform('prepare')
  expect((await f.perform('pair', 'stale-pair-close')).value).toEqual({ state: 'stale' })
  expect((await f.perform('status')).value.state).toBe('prepared')
  await f.perform('pair')
  expect((await f.perform('genesis', 'stale-exit')).value).toEqual({ state: 'stale' })
  expect((await f.perform('status')).value.state).toBe('genesis')
})
