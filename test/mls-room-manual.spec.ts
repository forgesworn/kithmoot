import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://mls-room-manual.kithmoot.test'
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
async function saved(context: BrowserContext) {
  const f = await fixture(context)
  await start(f.page)
  const created = await run(f.page, 'C.finish()')
  expect(created).toMatchObject({ state: 'done', value: { state: 'saved' } })
  return { ...f, session: created.value.session }
}
test('private owner runs one exact saved room and private route then releases ownership', async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(session => { (window as any).C.configure('manual'); (window as any).C.manual(session) }, session)
  const result = await run(page, 'C.finish()')
  expect(result, JSON.stringify(await run(page, 'C.status()'))).toMatchObject({ state: 'done', value: { state: 'done', session, resolved: 0, processed: 0, stalled: false } })
  expect(Object.keys(result.value).sort()).toEqual(['generation','held','leafHeld','limited','processed','resolved','session','stalled','state'])
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
  expect((await run(page, 'C.local()')).value).toHaveLength(1)
})

test('manual round deposits actual witnessed outgoing bytes and clears only confirmed outbox records', async ({ context }) => {
  const { page, session } = await saved(context)
  expect(await page.evaluate(id => (window as any).C.queue(id), session)).toMatchObject({ outbox: 1 })
  await page.evaluate(session => { (window as any).C.configure('manual'); (window as any).C.manual(session) }, session)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'done', resolved: 1, stalled: false } })
  expect((await page.evaluate(id => (window as any).C.roomState(id), session)).value.outbox).toEqual([])
})
test('lost deposit answer retains the exact witnessed outbox without automatic retry', async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(id => (window as any).C.queue(id), session)
  const before = (await page.evaluate(id => (window as any).C.roomState(id), session)).value.outbox
  await page.evaluate(session => { (window as any).C.configure('manual-unavailable'); (window as any).C.manual(session) }, session)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'done', resolved: 0, stalled: true } })
  expect((await page.evaluate(id => (window as any).C.roomState(id), session)).value.outbox).toEqual(before)
  const calls = (await run(page, 'C.status()')).calls
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)))
  expect((await run(page, 'C.status()')).calls).toBe(calls)
})
test('resolved count includes witnessed obsolete commit clearance without deposition', async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(id => (window as any).C.queue(id), session)
  expect(await page.evaluate(id => (window as any).C.observeQueuedCommit(id), session)).toEqual({ outbox: 1, obsolete: true })
  await page.evaluate(id => { (window as any).C.configure('manual'); (window as any).C.manual(id) }, session)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'done', resolved: 1 } })
  expect(await run(page, 'C.status()')).toMatchObject({ deposits: 0 })
  expect((await page.evaluate(id => (window as any).C.roomState(id), session)).value.outbox).toEqual([])
})
test('authenticated installation replacement holds the room before fetching', async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(session => { (window as any).C.configure('manual-changed'); (window as any).C.manual(session) }, session)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'held' } })
  expect(await run(page, 'C.status()')).toMatchObject({ calls: 1 })
  expect((await run(page, 'C.local()')).value).toHaveLength(1)
})
for (const at of ['pre', 'fetch', 'stop']) test(`manual owner retains actual native ownership until ${at} settles`, async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(({ at, session }) => { (window as any).C.configure('manual-hold-' + at); (window as any).C.manual(session) }, { at, session })
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: at, settled: false })
  expect(await run(page, 'C.lockAvailable()')).toBe(false)
  if (at !== 'stop') expect(await page.evaluate(id => (window as any).C.driverLockAvailable(id), session)).toBe(false)
  await run(page, 'C.release()')
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'done' } })
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
  expect(await page.evaluate(id => (window as any).C.driverLockAvailable(id), session)).toBe(true)
})
for (const kind of ['owner','generation','mode','key','rollback','deadline','hidden','pause']) test(`manual owner withholds counts after ${kind} during real cleanup`, async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(session => { (window as any).C.configure('manual-hold-stop'); (window as any).C.manual(session) }, session)
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: 'stop', settled: false })
  await page.evaluate(kind => (window as any).C.interrupt(kind), kind)
  expect(await run(page, 'C.lockAvailable()')).toBe(false)
  await run(page, 'C.release()')
  expect(await run(page, 'C.finish()')).toEqual({ state: 'interrupted' })
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
test('fresh generation written during cleanup cannot inherit an earlier round result', async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(session => { (window as any).C.configure('manual-hold-stop'); (window as any).C.manual(session) }, session)
  await expect.poll(() => run(page, 'C.status()')).toMatchObject({ phase: 'stop', settled: false })
  await page.evaluate(id => (window as any).C.queue(id), session)
  await run(page, 'C.release()')
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'pending' } })
  expect((await page.evaluate(id => (window as any).C.roomState(id), session)).value.outbox).toHaveLength(1)
})
test('failed native stop withholds counts and retains ownership', async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(session => { (window as any).C.configure('manual-stop-failure'); (window as any).C.manual(session) }, session)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'pending', reason: expect.stringContaining('Cleanup') } })
  expect(await run(page, 'C.lockAvailable()')).toBe(false)
})
test('coherent device and room binding replacement cannot inherit completed counts', async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(session => { (window as any).C.configure('manual-confirm-device'); (window as any).C.manual(session) }, session)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'pending' } })
  expect((await run(page, 'C.local()')).value).toHaveLength(1)
  expect(await run(page, 'C.lockAvailable()')).toBe(true)
})
test('manual delivery authority is independent of the short creation child receipt', async ({ context }) => {
  const { page, session } = await saved(context)
  await run(page, 'C.clearChild()')
  await page.evaluate(session => { (window as any).C.configure('manual'); (window as any).C.manual(session) }, session)
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: 'done', stalled: false } })
})
for (const target of ['missing-route','missing-room']) test(`unknown ${target} causes no box RPC or persona fence`, async ({ context }) => {
  const { page, session } = await saved(context)
  await page.evaluate(({ session, target }) => { (window as any).C.configure('manual'); (window as any).C.manual(target === 'missing-room' ? 'ff'.repeat(32) : session, target === 'missing-route' ? 'missing' : undefined) }, { session, target })
  expect(await run(page, 'C.finish()')).toMatchObject({ state: 'done', value: { state: target === 'missing-room' ? 'held' : 'pending' } })
  expect(await run(page, 'C.status()')).toMatchObject({ calls: 0 })
  expect((await run(page, 'C.local()')).value).toHaveLength(1)
})
