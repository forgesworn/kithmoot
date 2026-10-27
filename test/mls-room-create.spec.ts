import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://mls-room-create.kithmoot.test'
let bundle: string
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['test/mls-room-create.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'C',
    define: { 'import.meta.env.BASE_URL': '"/"' }, plugins: [{ name: 'fixture-link-transport', setup(builder) {
      builder.onLoad({ filter: /browser-link-runtime\.ts$/ }, () => ({ contents: 'export const startBrowserLink = config => globalThis.__startRoomCreateLink(config)', loader: 'ts' }))
    } }] })).outputFiles[0].text
})
const run = (page: Page, expression: string): Promise<any> => page.evaluate(expression)
async function fixture(context: BrowserContext, lifetime = 7 * 86400, childLifetime = 600) {
  const key = new Uint8Array(32).fill(91), witness = { seq: 0n, digest: new Uint8Array(32) }
  await context.exposeBinding('witnessExchange', async (_, method: string, input: number[]) => {
    const request = new Uint8Array(input)
    expect(request.length).toBe(method === 'read' ? 73 : 145)
    let status = 0
    if (method === 'advance') {
      // Bounded test journal stays below the one-byte CBOR integer boundary.
      const expected = BigInt(request[39])
      if (witness.seq === expected && bytesToHex(witness.digest) === bytesToHex(request.subarray(43, 75))) { witness.seq++; witness.digest = request.slice(78, 110) }
      else status = 1
    }
    const signed = new Uint8Array(106)
    signed[0] = 1; signed[1] = status; signed.set(request.subarray(6, 38), 2)
    new DataView(signed.buffer).setBigUint64(34, witness.seq)
    signed.set(witness.digest, 42); signed.set(request.subarray(request.length - 32), 74)
    const digest = sha256(concatBytes(new TextEncoder().encode('VMLS/1 witness receipt'), signed))
    return { status: status ? 409 : 200, bytes: Array.from(concatBytes(signed, ed25519.sign(digest, key))) }
  })
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" }, body: '<script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (path === '/vmls-wasm/vmls_wasm.js' || path === '/vmls-wasm/vmls_wasm_bg.wasm') return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.abort()
  })
  const page = await context.newPage(); await page.goto(origin)
  const ids = await page.evaluate(route => (window as any).C.prepare(route), pairingFixture(key).route)
  witness.digest = new Uint8Array(hexToBytes(ids.digest))
  expect(await page.evaluate(lifetime => (window as any).C.enrol(lifetime), lifetime)).toBe(true)
  const child = await page.evaluate(lifetime => (window as any).C.provision(lifetime), childLifetime), box = pairingFixture(new Uint8Array(32).fill(76))
  expect(await page.evaluate(box => (window as any).C.pair(box.uri, box.witness), box)).toMatchObject({ state: 'done' })
  await run(page, 'C.configure()')
  return { page, child, box: box.witness }
}
async function approve(page: Page) { await expect(page.locator('#mlsRoomConsent')).toBeVisible(); await page.locator('#mlsRoomConsent [data-approve]').click() }
async function start(page: Page, mode = '', lifetime = 86400) {
  await page.evaluate(({ mode, lifetime }) => { (window as any).C.configure(mode); (window as any).C.start(lifetime) }, { mode, lifetime })
  await approve(page); await approve(page)
}
test('private owner creates with actual device authentication and untruncated child-bound lifetime', async ({ context }) => {
  const { page, child, box } = await fixture(context)
  await start(page)
  const result = await run(page, 'C.finish()')
  expect(result, JSON.stringify({ result, status: await run(page, "C.status()") })).toMatchObject({ state: 'done', value: { state: 'saved', session: expect.any(String), generation: expect.any(String) } })
  expect(Object.keys(result.value).sort()).toEqual(['generation', 'session', 'state'])
  const local = await run(page, 'C.local()')
  expect(local.state).toBe('active'); expect(local.value).toHaveLength(1)
  expect(local.value[0]).toMatchObject({ id: result.value.session, box, installation: '79'.repeat(32), rz: child.rendezvousPubkey })
  const members = await page.evaluate(id => (window as any).C.members(id), result.value.session)
  expect(members.state).toBe('active')
  expect(members.value[0].bindingExpiresAt).toBeGreaterThan(child.expiresAt + 80_000)
  expect(await run(page, 'C.status()')).toMatchObject({ calls: 2 })
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
for (const mode of ['changed', 'unavailable', 'malformed', 'stop-failure']) test(`private owner retains one room after ${mode} and withholds saved confirmation`, async ({ context }) => {
  const { page } = await fixture(context); await start(page, mode)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'pending', session: expect.any(String) } })
  expect((await run(page, 'C.local()')).value).toHaveLength(1)
  expect(await run(page, 'C.status()')).toMatchObject({ calls: 2 })
  expect(await run(page, 'C.lockAvailable()')).toBe(mode !== 'stop-failure')
})
for (const mode of ['confirm-generation', 'confirm-installation', 'post-confirm-generation', 'post-confirm-installation']) test(`fresh exact-room confirmation rejects ${mode}`, async ({ context }) => {
  const { page } = await fixture(context); await start(page, mode)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'pending', session: expect.any(String) } })
  expect((await run(page, 'C.local()')).value).toHaveLength(1)
  expect(await run(page, 'C.status()')).toMatchObject({ calls: mode.startsWith('post-') ? 2 : 1 })
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
for (const at of ['pre', 'post', 'stop']) test(`actual private owner keeps the native lock until ${at} settlement`, async ({ context }) => {
  const { page } = await fixture(context)
  await page.evaluate(at => { (window as any).C.configure('hold-' + at); (window as any).C.start() }, at)
  await approve(page)
  if (at !== 'pre') await approve(page)
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: at, settled: false })
  expect(await run(page, 'C.lockAvailable()')).toBe(false)
  await run(page, 'C.release()')
  if (at === 'pre') await approve(page)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'saved' } })
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
for (const kind of ['owner', 'generation', 'mode', 'key', 'rollback', 'deadline', 'hidden', 'pause']) test(`private owner withholds saved confirmation on ${kind} during cleanup`, async ({ context }) => {
  const { page } = await fixture(context); await start(page, 'hold-stop')
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: 'stop', settled: false })
  await page.evaluate(kind => (window as any).C.interrupt(kind), kind)
  expect(await run(page, 'C.lockAvailable()')).toBe(false)
  await run(page, 'C.release()')
  const result = await run(page, 'C.finish()')
  if (kind === 'key') expect(result).toMatchObject({ state: 'done', value: { state: 'pending' } })
  else expect(result).toEqual({ state: 'interrupted' })
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
test('room lifetime beyond actual credential is held before child signing or saving', async ({ context }) => {
  const { page } = await fixture(context, 7200)
  await run(page, 'C.start(86400)'); await approve(page)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'held', reason: expect.stringContaining('credential') } })
  expect(await run(page, 'C.status()')).toMatchObject({ calls: 1 })
  expect((await run(page, 'C.local()')).value).toEqual([])
})
test('missing saved route is held before any box request and saves no room', async ({ context }) => {
  const { page } = await fixture(context)
  await run(page, 'C.start(86400, "missing")')
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'pending' } })
  expect(await run(page, 'C.status()')).toMatchObject({ calls: 0 })
  expect((await run(page, 'C.local()')).value).toEqual([])
})
test('post readback withholds confirmation when the actual child is cleared and retains its local room', async ({ context }) => {
  const { page, child } = await fixture(context, 7 * 86400, 60); await start(page, 'hold-post')
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: 'post', settled: false })
  await run(page, 'C.clearChild()'); await run(page, 'C.release()')
  const result = await run(page, 'C.finish()')
  expect(result).toMatchObject({ state: 'done', value: { state: 'pending', session: expect.any(String) } })
  const local = await run(page, 'C.local()')
  expect(local.state).toBe('active'); expect(local.value).toHaveLength(1)
  expect(local.value[0]).toMatchObject({ id: result.value.session, rz: child.rendezvousPubkey })
})
test('post readback confirms its retained local room after the accepted handoff deadline', async ({ context }) => {
  const { page, child } = await fixture(context, 7 * 86400, 60); await start(page, 'hold-post')
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: 'post', settled: false })
  await run(page, 'C.advanceClock(61)')
  expect(await run(page, 'Math.floor(Date.now() / 1000)')).toBeGreaterThan(child.expiresAt)
  await run(page, 'C.release()')
  const result = await run(page, 'C.finish()')
  expect(result).toMatchObject({ state: 'done', value: { state: 'saved', session: expect.any(String), generation: expect.any(String) } })
  const local = await run(page, 'C.local()')
  expect(local.state).toBe('active'); expect(local.value).toHaveLength(1)
  expect(local.value[0]).toMatchObject({ id: result.value.session, rz: child.rendezvousPubkey })
  expect(await run(page, 'C.status()')).toMatchObject({ calls: 2 })
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
for (const kind of ['rollback', 'deadline']) test(`cached permissions cannot bypass the whole creation clock: ${kind}`, async ({ context }) => {
  const { page } = await fixture(context); await start(page)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'saved' } })
  await run(page, "C.configure('hold-post'); C.start()")
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: 'post', settled: false })
  await expect(page.locator('#mlsRoomConsent')).toHaveCount(0)
  await page.evaluate(kind => (window as any).C.interrupt(kind), kind); await run(page, 'C.release()')
  expect(await run(page, 'C.finish()')).toEqual({ state: 'interrupted' })
})
for (const kind of ['deny', 'pause']) test(`actual leaf permission ${kind} releases no saved room`, async ({ context }) => {
  const { page } = await fixture(context)
  await run(page, 'C.start()'); await approve(page)
  await expect(page.locator('#mlsRoomConsent')).toBeVisible()
  if (kind === 'deny') await page.locator('#mlsRoomConsent [data-deny]').click()
  else await run(page, "C.interrupt('pause')")
  const result = await run(page, 'C.finish()')
  if (kind === 'deny') expect(result).toMatchObject({ state: 'done', value: { state: 'held' } })
  else expect(result).toEqual({ state: 'interrupted' })
  expect((await run(page, 'C.local()')).value).toEqual([])
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
