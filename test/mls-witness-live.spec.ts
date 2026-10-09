import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { witnessDaemon } from './mls-witness-daemon.js'
import { browserProcess } from './mls-witness-browser-process.js'

// Loopback is a secure context and may reach the loopback TLS relay without
// bypassing the browser's local-network permission boundary.
let origin: string, server: Server
const binary = process.env.BOTHYD, relay = process.env.LAB_RELAY
let bundle: string
test.skip(!binary || !relay, 'Set BOTHYD and LAB_RELAY to run the disposable real-daemon lab.')
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['test/mls-witness-live.browser-entry.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'W', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text
  server = createServer((request, response) => {
    const path = new URL(request.url!, origin).pathname
    response.setHeader('Cache-Control', 'no-store')
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${relay}`)
      response.end('<!doctype html><script src="/fixture.js"></script><body></body>')
    } else if (path === '/fixture.js') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(bundle)
    } else if (/^\/(vmls-wasm\/vmls_wasm|link-web\/link_web)(_bg\.wasm|\.js)$/.test(path)) {
      response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
      response.end(readFileSync('app/public' + path))
    } else response.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())) })

test('a restored real witness leaves a retirement duty through offline clear and reload', async ({ context }) => {
  const daemon = await witnessDaemon(binary!, relay!)
  try {
    const page = await fixture(context)
    const prepared = await call(page, 'prepare')
    await call(page, 'pair', await daemon.pair(), relay)
    const genesis = await call(page, 'genesis'); await daemon.enrol(genesis.command)
    await daemon.backupWitness()
    expect((await call(page, 'commit', 1, 1)).state).toBe('active')
    await daemon.restoreWitness()
    expect(await call(page, 'status')).toMatchObject({ state: 'fenced', reason: 'witness-behind', retiring: true })
    await daemon.stop()
    expect(await call(page, 'clear')).toMatchObject({ state: 'fenced', retiring: true })
    expect(await call(page, 'retired', genesis.subject)).toBe(false)
    await call(page, 'close'); await page.reload()
    expect((await call(page, 'prepare')).state).toBe('fenced')
    await daemon.restart()
    expect(await call(page, 'status')).toMatchObject({ state: 'pending', reason: 'not-enrolled' })
    const replacement = await call(page, 'prepare')
    expect(replacement.state).toBe('prepared')
    expect(replacement.installation).not.toBe(prepared.installation)
    expect(replacement.writer).not.toBe(prepared.writer)
    await call(page, 'close')
  } finally { await daemon.cleanup() }
})

test('replayed or damaged real witness receipts release no new browser state', async ({ context }) => {
  const daemon = await witnessDaemon(binary!, relay!)
  try {
    const page = await fixture(context)
    await call(page, 'prepare'); await call(page, 'pair', await daemon.pair(), relay)
    await daemon.enrol((await call(page, 'genesis')).command)
    expect((await call(page, 'commit', 1, 1)).state).toBe('active')
    await call(page, 'readFault', 'remember')
    expect((await call(page, 'status')).state).toBe('active')
    for (const mode of ['replay', 'bad-signature']) {
      await call(page, 'readFault', mode)
      expect(await call(page, 'commit', 2, 2)).toMatchObject({ state: 'pending', refused: false })
    }
    await call(page, 'readFault', 'normal')
    expect(await call(page, 'read')).toEqual({ state: 'active', value: { vault: [1], session: [1, 7], generation: '1' } })
    await call(page, 'close')
  } finally { await daemon.cleanup() }
})

for (const missing of ['stage', 'inner-key']) test(`real witness cannot authorise a browser with a lost ${missing}`, async ({ context }) => {
  const daemon = await witnessDaemon(binary!, relay!)
  try {
    const page = await fixture(context)
    await call(page, 'prepare'); await call(page, 'pair', await daemon.pair(), relay)
    const genesis = await call(page, 'genesis'); await daemon.enrol(genesis.command)
    expect((await call(page, 'commit', 1, 1)).state).toBe('active')
    if (missing === 'stage') {
      await call(page, 'stopAt', 'lost-reply')
      expect((await call(page, 'commit', 2, 2)).state).toBe('pending')
    }
    await call(page, 'lose', missing)
    await call(page, 'close'); await page.reload()
    expect((await call(page, 'read')).state).toBe('fenced')
    expect((await call(page, 'commit', 3, 3)).state).toBe('fenced')
    expect((await call(page, 'genesis')).state).toBe('fenced')
    await call(page, 'close')
  } finally { await daemon.cleanup() }
})

test('two cloned browser profiles stage different successors and only one survives the real witness CAS', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'OS process/profile harness currently covers Chromium.')
  const daemon = await witnessDaemon(binary!, relay!)
  const work = await mkdtemp(join(tmpdir(), 'browser-witness-clones-'))
  const profiles = [join(work, 'first'), join(work, 'second')]
  const processes: Awaited<ReturnType<typeof browserProcess>>[] = []
  try {
    const original = await browserProcess(profiles[0]); processes.push(original)
    const page = await fixture(original.context)
    await call(page, 'prepare'); await call(page, 'pair', await daemon.pair(), relay)
    await daemon.enrol((await call(page, 'genesis')).command)
    expect((await call(page, 'commit', 1, 1)).state).toBe('active')
    await call(page, 'close'); await original.stop()
    await cp(profiles[0], profiles[1], { recursive: true })
    const pages: Page[] = []
    for (let i = 0; i < 2; i++) {
      const browser = await browserProcess(profiles[i]); processes.push(browser)
      const clone = await fixture(browser.context)
      await call(clone, 'stopAt', 'stage')
      // Each clone fresh-reads the same predecessor before either can advance.
      const attempt = call(clone, 'commit', i + 2, 2).catch(() => undefined)
      await expect(clone.locator('body')).toHaveAttribute('data-boundary', 'stage', { timeout: 60_000 })
      // End this Link session before preparing the other clone. Neither has
      // sent an advance; both durable candidates have the same predecessor.
      await browser.kill(); await attempt
    }
    for (const profile of profiles) {
      const browser = await browserProcess(profile); processes.push(browser)
      pages.push(await fixture(browser.context))
    }
    const immediate = await Promise.all(pages.map(page => call(page, 'read')))
    expect(immediate.filter(r => r.state === 'active').length).toBeLessThanOrEqual(1)
    // The two clones share one Link node id. A superseded connection can be
    // pending; a fresh connection must reconcile it against the actual winner.
    const final = []
    for (const page of pages) final.push(await call(page, 'read'))
    expect(final.map(r => r.state).sort()).toEqual(['active', 'fenced'])
    const winner = final.findIndex(r => r.state === 'active')
    expect(final[winner].value).toEqual({ vault: [winner + 2], session: [winner + 2, 7], generation: '2' })
    expect((await call(pages[1 - winner], 'prepare')).state).toBe('fenced')
    for (const page of pages) await call(page, 'close')
  } finally {
    await Promise.all(processes.map(p => p.stop()))
    await daemon.cleanup(); await rm(work, { recursive: true, force: true })
  }
})

test('real witness reconciles browser process kills and fences a whole-profile rollback', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'OS process/profile harness currently covers Chromium.')
  const daemon = await witnessDaemon(binary!, relay!)
  const work = await mkdtemp(join(tmpdir(), 'browser-witness-profile-'))
  const profile = join(work, 'profile'), backup = join(work, 'backup')
  let process: Awaited<ReturnType<typeof browserProcess>> | undefined
  try {
    process = await browserProcess(profile)
    let page = await fixture(process.context)
    await call(page, 'prepare'); await call(page, 'pair', await daemon.pair(), relay)
    const genesis = await call(page, 'genesis'); await daemon.enrol(genesis.command)
    expect((await call(page, 'commit', 1, 1)).state).toBe('active')
    await call(page, 'close'); await process.stop()
    await cp(profile, backup, { recursive: true })
    let generation = 1
    for (const boundary of ['stage', 'witness', 'promotion']) {
      await test.step(`SIGKILL after durable ${boundary}`, async () => {
        process = await browserProcess(profile); page = await fixture(process.context)
        await call(page, 'stopAt', boundary)
        let returned = false
        const pending = call(page, 'commit', ++generation, generation).then(() => { returned = true }, () => {})
        await expect(page.locator('body')).toHaveAttribute('data-boundary', boundary, { timeout: 60_000 })
        expect(returned).toBe(false)
        await process.kill(); await pending
        process = await browserProcess(profile); page = await fixture(process.context)
        expect(await call(page, 'read')).toEqual({ state: 'active', value: { vault: [generation], session: [generation, 7], generation: String(generation) } })
        await call(page, 'close'); await process.stop()
      })
    }
    process = await browserProcess(profile); page = await fixture(process.context)
    await call(page, 'stopAt', 'lost-reply')
    expect((await call(page, 'commit', ++generation, generation)).state).toBe('pending')
    await call(page, 'close'); await process.stop()
    process = await browserProcess(profile); page = await fixture(process.context)
    expect(await call(page, 'read')).toEqual({ state: 'active', value: { vault: [generation], session: [generation, 7], generation: String(generation) } })
    await call(page, 'close'); await process.stop()
    for (const restore of ['database', 'whole-profile']) {
      const target = restore === 'database' ? join(profile, 'Default/IndexedDB') : profile
      const source = restore === 'database' ? join(backup, 'Default/IndexedDB') : backup
      await rm(target, { recursive: true, force: true }); await cp(source, target, { recursive: true })
      process = await browserProcess(profile); page = await fixture(process.context)
      expect((await call(page, 'read')).state, restore).toBe('fenced')
      expect((await call(page, 'commit', 99, 99)).state, restore).toBe('fenced')
      expect((await call(page, 'prepare')).state, restore).toBe('fenced')
      await call(page, 'close'); await process.stop()
    }
  } finally { await process?.stop(); await daemon.cleanup(); await rm(work, { recursive: true, force: true }) }
})
async function fixture(context: BrowserContext) {
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage(); await page.goto(origin)
  return page
}
const call = (page: Page, action: string, ...args: unknown[]) => page.evaluate(([action, args]) => (window as any).W[action as string](...args as unknown[]), [action, args])

test('real witness-only pairing, keeper enrolment, advances, restart, outage and retirement', async ({ context }) => {
  const daemon = await witnessDaemon(binary!, relay!)
  try {
    const page = await fixture(context)
    await call(page, 'openPanel')
    await page.getByRole('button', { name: 'Prepare this browser' }).click()
    await expect(page.locator('#mlsWitnessLocalStatus')).toContainText('Installation prepared locally')
    const prepared = await call(page, 'prepare')
    expect(prepared.state).toBe('prepared')
    // Do not include the live URI in assertion values or Playwright traces.
    await call(page, 'enterPairing', await daemon.pair(), relay)
    await expect(page.locator('#mlsWitnessLocalStatus')).toContainText('Witness paired', { timeout: 70_000 })
    await expect(page.locator('#mlsWitnessCode')).toHaveValue('')
    await page.getByRole('button', { name: 'Prepare keeper enrolment' }).click()
    await expect(page.locator('#mlsWitnessCommand')).toHaveValue(/^bothyd witness enrol /)
    const genesis = await call(page, 'genesis')
    expect(genesis.state).toBe('genesis')
    expect(await page.locator('#mlsWitnessCommand').inputValue()).toBe(genesis.command)
    await page.getByRole('button', { name: 'Check witness now' }).click()
    await expect(page.locator('#mlsWitnessNetworkStatus')).toContainText('The witness refused', { timeout: 30_000 })
    await daemon.enrol(genesis.command)
    await page.getByRole('button', { name: 'Check witness now' }).click()
    await expect(page.locator('#mlsWitnessNetworkStatus')).toContainText('The witness confirmed', { timeout: 30_000 })
    expect(await call(page, 'commit', 4, 1)).toMatchObject({ state: 'active', value: 'effect:4', marks: { ['67'.repeat(32)]: '1' } })
    await call(page, 'close'); await page.reload()
    expect(await call(page, 'genesis')).toEqual(genesis)
    expect(await call(page, 'read')).toEqual({ state: 'active', value: { vault: [4], session: [4, 7], generation: '1' } })
    await daemon.stop()
    expect(await call(page, 'commit', 5, 2)).toMatchObject({ state: 'pending', refused: false })
    await daemon.restart()
    expect(await call(page, 'read')).toEqual({ state: 'active', value: { vault: [4], session: [4, 7], generation: '1' } })
    await daemon.retire(genesis.subject)
    expect((await call(page, 'status')).state).toBe('fenced')
    await call(page, 'clear')
    expect(await call(page, 'retired', genesis.subject)).toBe(true)
    const replacement = await call(page, 'prepare')
    expect(replacement.state).toBe('prepared')
    expect(replacement.installation).not.toBe(prepared.installation)
    expect(replacement.writer).not.toBe(prepared.writer)
    await call(page, 'close')
  } finally { await daemon.cleanup() }
})
