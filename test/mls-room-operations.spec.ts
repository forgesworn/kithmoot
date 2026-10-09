import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://browser-mls-rooms.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-room-operations.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
async function fixture(context: BrowserContext) {
  const key = new Uint8Array(32).fill(91)
  const witness = { seq: 0n, digest: new Uint8Array(32), offline: false, refused: false, loseAdvance: false, wrongKey: false, replay: false, retired: false, advances: 0, reads: 0, last: undefined as number[] | undefined }
  await context.exposeBinding('witnessExchange', async (_, method: string, input: number[]) => {
    if (witness.offline) return { type: 'unavailable' }
    if (witness.refused) return { type: 'refused' }
    const request = new Uint8Array(input)
    expect(request.length).toBe(method === 'read' ? 73 : 145)
    let status = witness.retired ? 2 : 0
    if (method === 'advance') {
      witness.advances++
      // These bounded fixtures stay below the one-byte CBOR integer boundary.
      const expected = BigInt(request[39])
      if (!witness.retired && witness.seq === expected && bytesToHex(witness.digest) === bytesToHex(request.subarray(43, 75))) { witness.seq++; witness.digest = request.slice(78, 110) }
      else if (!witness.retired && witness.seq < expected) { witness.retired = true; status = 2 }
      else if (!witness.retired) status = 1
      if (witness.loseAdvance) { witness.loseAdvance = false; return { type: 'unavailable' } }
    } else {
      witness.reads++
      if (witness.replay && witness.last) return { type: 'receipt', bytes: witness.last }
    }
    const signed = new Uint8Array(106)
    signed[0] = 1; signed[1] = status; signed.set(request.subarray(6, 38), 2)
    new DataView(signed.buffer).setBigUint64(34, witness.seq)
    signed.set(witness.digest, 42); signed.set(request.subarray(request.length - 32), 74)
    const digest = sha256(concatBytes(new TextEncoder().encode('VMLS/1 witness receipt'), signed))
    const bytes = Array.from(concatBytes(signed, ed25519.sign(digest, witness.wrongKey ? new Uint8Array(32).fill(92) : key)))
    if (method === 'read') witness.last = bytes
    return { type: 'receipt', bytes }
  })
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" }, body: '<script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (path === '/vmls-wasm/vmls_wasm.js' || path === '/vmls-wasm/vmls_wasm_bg.wasm') return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.abort()
  })
  const page = await context.newPage()
  await page.goto(origin)
  const ids = await page.evaluate(route => (window as any).M.prepare(route), pairingFixture(key).route)
  witness.digest = new Uint8Array(hexToBytes(ids.digest))
  return { page, witness, ids }
}
const run = (page: Page, code: string): Promise<any> => page.evaluate(code)
async function enrolled(context: BrowserContext, room = true) {
  const f = await fixture(context)
  expect(await run(f.page, 'M.enrol()')).toMatchObject({ ok: true })
  if (room) { const created = await run(f.page, 'M.create()'); expect(created).toMatchObject({ state: 'active' }) }
  return f
}
test('typed creation, idempotent send and rename persist with the session', async ({ context }) => {
  const { page } = await enrolled(context)
  expect(await run(page, 'M.read()')).toMatchObject({ state: 'active', value: { name: 'Witnessed room', history: [], generation: '1' } })
  expect(await run(page, 'M.send()')).toMatchObject({ state: 'active' })
  const before = await run(page, 'M.read()')
  expect(before.value.history).toHaveLength(1)
  expect(await run(page, 'M.send()')).toMatchObject({ state: 'active', value: { outcome: { type: 'Duplicate' } } })
  expect(await run(page, 'M.read()')).toEqual(before)
  expect(await run(page, `M.send('${'01'.repeat(32)}', 'substituted')`)).toEqual({ state: 'refused', reason: 'replay' })
  expect(await run(page, 'M.rename()')).toEqual({ state: 'active', value: undefined })
  await run(page, 'M.restart()'); await run(page, 'M.discover()')
  expect(await run(page, 'M.read()')).toMatchObject({ state: 'active', value: { name: 'New name', generation: '2' } })
})
test('typed Update creates a witnessed commit outbox', async ({ context }) => {
  const { page } = await enrolled(context)
  const result = await run(page, 'M.update()')
  expect(result.state).toBe('active')
  expect(result.value.outbound.some((r: any) => r.destination.type === 'CommitSlot')).toBe(true)
  await run(page, 'M.restart()')
  const room = await run(page, 'M.read()')
  expect(room.value.outbox).toEqual(result.value.outbound)
  expect(room.value.generation).toBe('2')
})
for (const action of ['send', 'parallel', 'replace', 'revoke', 'withdraw', 'account', 'expire', 'invalidate'] as const) test(`pending Update refuses after ${action}`, async ({ context }) => {
  const { page } = await enrolled(context)
  const answer = await run(page, `M.race('${action}')`)
  expect(answer.result.state).not.toBe('active')
  if (action === 'send' || action === 'parallel') expect(answer.nested.state).toBe('active')
})
test('a concurrent room-only rename is preserved by Update', async ({ context }) => {
  const { page } = await enrolled(context)
  expect(await run(page, "M.race('rename')")).toMatchObject({ result: { state: 'active' }, nested: { state: 'active' } })
  expect(await run(page, 'M.read()')).toMatchObject({ state: 'active', value: { name: 'Concurrent name', generation: '2' } })
})
for (const operation of ['create', 'send', 'update'] as const) for (const at of ['stage', 'promotion', 'stale-close'] as const) test(`${operation} recovers atomic state after ${at}`, async ({ context }) => {
  const { page } = await enrolled(context, operation !== 'create')
  const r = await run(page, `M.fault('${operation}', '${at}')`)
  expect(r.injected).toBe(true)
  expect(r.result?.state).not.toBe('active')
  await run(page, 'M.restart()'); await run(page, 'M.discover()')
  const reopened = await run(page, 'M.read()')
  expect(reopened.state).toBe('active')
  expect(reopened.value.generation).toBe(operation === 'create' ? '1' : '2')
  expect(reopened.value.history.length).toBe(operation === 'send' ? 1 : 0)
  if (operation === 'send') expect(await run(page, 'M.send()')).toMatchObject({ state: 'active', value: { outcome: { type: 'Duplicate' } } })
})
test('an Update expiring during shutdown releases no result but retains its committed outbox', async ({ context }) => {
  const { page } = await enrolled(context)
  expect(await run(page, "M.fault('update', 'expiry-close')")).toMatchObject({ injected: true, result: { state: 'pending' } })
  await run(page, 'M.restart()')
  expect(await run(page, 'M.read()')).toMatchObject({ state: 'active', value: { generation: '2' } })
})
test('Update binding expiry during cleanup withholds effects before the RPC deadline', async ({ context }) => {
  const { page } = await enrolled(context)
  expect(await run(page, "M.fault('update', 'binding-expiry-close')")).toMatchObject({ injected: true, result: { state: 'pending', reason: 'stale' } })
})
for (const operation of ['create', 'update'] as const) for (const end of ['invalidate', 'expiry'] as const) test(`never-resolving ${operation} consent is bounded by ${end}`, async ({ context }) => {
  const { page } = await enrolled(context, operation !== 'create')
  expect(await run(page, `M.pendingNever('${operation}', '${end}')`)).toMatchObject({ state: 'pending' })
  expect((await run(page, 'M.local()')).generation).toBe(operation === 'create' ? null : '1')
})
test('denied creation stores no session; offline operations release nothing', async ({ context }) => {
  const { page, witness } = await enrolled(context, false)
  expect(await run(page, "M.create('deny')")).toEqual({ state: 'refused', reason: 'denied' })
  expect((await run(page, 'M.local()')).generation).toBeNull()
  expect(await run(page, 'M.create()')).toMatchObject({ state: 'active' })
  witness.offline = true
  expect(await run(page, 'M.send()')).toEqual({ state: 'refused', reason: 'witness-pending' })
  expect((await run(page, 'M.local()')).generation).toBe('1')
})
test('history limits abort the ratchet and missing metadata fences', async ({ context }) => {
  const { page } = await enrolled(context)
  expect(await run(page, 'M.historyFull()')).toBe('active')
  const before = await run(page, 'M.local()')
  expect(await run(page, 'M.send()')).toEqual({ state: 'refused', reason: 'history-full' })
  expect(await run(page, 'M.local()')).toEqual(before)
  await run(page, 'M.damageRoom()')
  expect(await run(page, 'M.read()')).toMatchObject({ state: 'fenced' })
})
test('accepted remote plaintext is witnessed with the receive ratchet and duplicate records add no history', async ({ context }) => {
  const { page } = await enrolled(context)
  expect(await run(page, 'M.addGuest()')).toBe('active')
  const first = await run(page, 'M.receive()')
  expect(first).toMatchObject({ state: 'active', value: { outcome: { type: 'Accepted' }, ack: { type: 'AfterCommitAck' } } })
  expect(first.value.events.find((e: any) => e.type === 'Message').body).toBeDefined()
  const before = await run(page, 'M.read()')
  expect(before.value.history).toHaveLength(1)
  expect(await run(page, 'M.receive()')).toMatchObject({ state: 'active', value: { outcome: { type: 'Duplicate' } } })
  expect(await run(page, 'M.read()')).toEqual(before)
  await run(page, 'M.forgetGuest()')
})
for (const at of ['stage', 'promotion', 'stale-close'] as const) test(`remote plaintext survives ${at} without early acknowledgement`, async ({ context }) => {
  const { page } = await enrolled(context)
  await run(page, 'M.addGuest()')
  const result = await run(page, `M.fault('receive', '${at}')`)
  expect(result.injected).toBe(true)
  expect(result.result?.state).not.toBe('active')
  await run(page, 'M.restart()')
  const saved = await run(page, 'M.read()')
  expect(saved.value.history).toHaveLength(1)
  expect(await run(page, 'M.receive()')).toMatchObject({ state: 'active', value: { outcome: { type: 'Duplicate' } } })
  expect(await run(page, 'M.read()')).toEqual(saved)
  await run(page, 'M.forgetGuest()')
})
test('accepted witness reply loss retains history and send idempotency across restart', async ({ context }) => {
  const { page, witness } = await enrolled(context)
  witness.loseAdvance = true
  expect(await run(page, 'M.send()')).toMatchObject({ state: 'pending' })
  await run(page, 'M.restart()')
  expect((await run(page, 'M.read()')).value.history).toHaveLength(1)
  expect(await run(page, 'M.send()')).toMatchObject({ state: 'active', value: { outcome: { type: 'Duplicate' } } })
})

for (const operation of ['create', 'update'] as const) for (const end of ['invalidate', 'expiry'] as const) test(`${operation} cancellation cleans up both operations after free throws on ${end}`, async ({ context }) => {
  const { page } = await enrolled(context, operation !== 'create')
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const result = await run(page, `M.cancelledCleanup('${operation}', '${end}')`)
  expect(result.freed).toBe(2)
  expect(result.results).toEqual([{ error: 'fixture free failure' }, { state: 'pending', reason: 'stale', refused: false }])
  expect(errors).toEqual([])
})
test('completed creation cleanup failure releases no effects and preserves witnessed state', async ({ context }) => {
  const { page } = await enrolled(context, false)
  expect(await run(page, 'M.completedCleanup()')).toEqual({ error: 'fixture completed free failure' })
  expect((await run(page, 'M.local()')).generation).toBe('1')
  await run(page, 'M.restart()'); await run(page, 'M.discover()')
  expect(await run(page, 'M.read()')).toMatchObject({ state: 'active', value: { generation: '1' } })
})

for (const mode of ['routes', 'caps-invalid', 'denied', 'stale-consent', 'late-reply', 'lost-reply', 'bad-receipt', 'cancel-consent', 'timeout-consent']) test(`strict box client with real vault and WASM: ${mode}`, async ({ context }) => {
  const { page } = await enrolled(context, false)
  const result = await page.evaluate(({ route, mode }) => (window as any).M.boxClientScenario(route, mode), { route: pairingFixture(new Uint8Array(32).fill(76)).route, mode })
  if (mode === 'routes') {
    expect(result.results.map((r: any) => r.state)).toEqual(new Array(6).fill('ok'))
    expect(result.calls).toHaveLength(6); expect(result.distinctEvents).toBe(6)
    expect(result.results[0].value.installation).toBe('79'.repeat(32))
  } else if (mode === 'lost-reply') {
    expect(result.results.map((r: any) => r.state)).toEqual(['unavailable', 'ok']); expect(result.distinctEvents).toBe(2)
  } else if (mode === 'bad-receipt') expect(result.results.map((r: any) => r.state)).toEqual(['ok', 'malformed'])
  else if (mode === 'caps-invalid') expect(result.results[0].state).toBe('malformed')
  else if (mode === 'denied') { expect(result.results[0]).toEqual({ state: 'not-signed', reason: 'denied' }); expect(result.calls).toHaveLength(0) }
  else if (mode === 'cancel-consent' || mode === 'timeout-consent') {
    expect(result.results[0].state).toBe('unavailable'); expect(result.calls).toHaveLength(0); expect(result.approved).toEqual([])
  } else { expect(result.results[0].state).toBe('unavailable'); expect(result.calls).toHaveLength(mode === 'stale-consent' ? 0 : 1) }
})
