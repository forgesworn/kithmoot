import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://browser-mls-driver.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-message-driver.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
async function fixture(context: BrowserContext) {
  const key = new Uint8Array(32).fill(91)
  const witness = { seq: 0n, digest: new Uint8Array(32), offline: false, refused: false, loseAdvance: false, wrongKey: false, replay: false, retired: false, advances: 0, reads: 0, last: undefined as number[] | undefined }
  await context.exposeBinding('loseNextWitnessAdvance', () => { witness.loseAdvance = true })
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

const boxRoute = pairingFixture(new Uint8Array(32).fill(76)).route
const drive = (page: Page, mode: string) => page.evaluate(({ route, mode }) => (window as any).M.driverScenario(route, mode), { route: boxRoute, mode })
test('driver authenticates each request and witnesses an Update through slot status', async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, 'update')
  expect(r.result).toMatchObject({ state: 'done', delivered: 1, processed: 1 })
  expect(r.after.value.phase.type).toBe('Active')
  expect(r.distinctEvents).toBe(r.calls.length)
  expect(r.calls[0].path).toBe('/vmls/v1/capabilities')
  expect(r.calls.some((c: any) => c.path.endsWith('/status'))).toBe(true)
})
test('uncertain deposit recovers exact bytes with fresh authentication', async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, 'lost-deposit')
  expect(r.result).toMatchObject({ state: 'done', stalled: true, delivered: 0 })
  expect(r.recovered).toMatchObject({ state: 'done', delivered: 1 })
  const puts = r.calls.filter((c: any) => c.path.startsWith('/vmls/v1/slots/') && !c.path.endsWith('/status'))
  expect(puts).toHaveLength(2); expect(puts[0].body).toBe(puts[1].body); expect(puts[0].event).not.toBe(puts[1].event)
})
for (const mode of ['inviter-welcome', 'inviter-welcome-lost-registration']) test(`driver ${mode} registers the exact Add route before Welcome delivery`, async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, mode)
  expect(r.result).toMatchObject({ state: 'done', delivered: 2 })
  const registrations = r.calls.filter((c: any) => c.path.startsWith('/vmls/v1/packages/'))
  const deposits = r.calls.filter((c: any) => c.path.startsWith('/vmls/v1/mailboxes/'))
  expect(registrations).toHaveLength(mode === 'inviter-welcome-lost-registration' ? 2 : 1)
  if (mode === 'inviter-welcome-lost-registration') {
    expect(registrations[0].body).toBe(registrations[1].body)
    expect(registrations[0].event).not.toBe(registrations[1].event)
  }
  expect(deposits).toHaveLength(1)
  expect(r.calls.indexOf(registrations.at(-1))).toBeLessThan(r.calls.indexOf(deposits[0]))
  expect(r.after.value.outbox.some((o: any) => o.destination.type === 'Welcome')).toBe(false)
  expect(r.driverAfter.value.packages).toEqual([])
})
for (const mode of ['inviter-welcome-expired', 'inviter-welcome-expired-lost-witness']) test(`driver witnesses exact expired Welcome cleanup: ${mode}`, async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, mode)
  expect(r.result).toMatchObject({ state: 'done', delivered: 1, held: 1 })
  expect(r.expiredBoundary.value.outbox.some((o: any) => o.destination.type === 'Welcome')).toBe(true)
  expect(r.expiredBoundary.value.packages).toHaveLength(1)
  if (mode.endsWith('lost-witness')) {
    expect(r.recovered).toMatchObject({ state: 'pending', reason: 'witness-unavailable' })
    expect(r.settled).toMatchObject({ state: 'done', held: 0 })
  } else expect(r.recovered).toMatchObject({ state: 'done', held: 0 })
  expect(r.after.value.outbox.some((o: any) => o.destination.type === 'Welcome')).toBe(false)
  expect(r.driverAfter.value.packages).toEqual([])
  expect(r.calls.filter((c: any) => c.path.startsWith('/vmls/v1/mailboxes/'))).toHaveLength(0)
})
test('expired cleanup retains a route that does not match the exact Welcome mailbox and pending leaf', async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, 'inviter-welcome-expired-route-mismatch')
  expect(r.result).toMatchObject({ state: 'done', delivered: 1, held: 1 })
  expect(r.recovered).toMatchObject({ state: 'done', delivered: 0, held: 1 })
  expect(r.after.value.outbox.some((o: any) => o.destination.type === 'Welcome')).toBe(true)
  expect(r.driverAfter.value.packages).toHaveLength(1)
  expect(r.calls.filter((c: any) => c.path.startsWith('/vmls/v1/mailboxes/'))).toHaveLength(0)
})
test('a permanent package-registration refusal never admits the guest', async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, 'inviter-welcome-registration-refused')
  expect(r.result).toMatchObject({ state: 'transport', answer: { state: 'refused', status: 403, code: 'authority' } })
  expect(r.calls.filter((c: any) => c.path.startsWith('/vmls/v1/packages/'))).toHaveLength(1)
  expect(r.calls.some((c: any) => c.path.startsWith('/vmls/v1/mailboxes/'))).toBe(false)
  expect(r.driverAfter.value.packages).toEqual([])
  expect(r.driverAfter.value.outbox.some((o: any) => o.destination.type === 'Welcome')).toBe(false)
})
test('driver refuses unverified slot signatures without clearing the commit', async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, 'bad-slot')
  expect(r.result).toMatchObject({ state: 'done', delivered: 0 })
  expect(r.after.value.outbox.some((o: any) => o.destination.type === 'CommitSlot')).toBe(true)
})
for (const mode of ['offline', 'replacement']) test(`driver ${mode} does no message transport`, async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, mode)
  expect(r.result).toMatchObject(mode === 'offline' ? { state: 'offline' } : { state: 'stopped', phase: 'NeedsRecovery', reason: 'RestoreFenced' })
  expect(r.calls).toHaveLength(1)
})
for (const mode of ['receive', 'lost-witness', 'stale-fetch', 'account-fetch']) test(`driver receive ${mode} keeps acknowledgement behind durable history`, async ({ context }) => {
  const { page } = await enrolled(context); expect(await run(page, 'M.addGuest()')).toBe('active')
  const r = await drive(page, mode)
  if (mode === 'receive' || mode === 'lost-witness') {
    expect(mode === 'receive' ? r.result : r.recovered).toMatchObject({ state: 'done' })
    expect(r.after.value.history.filter((m: any) => m.direction === 'received')).toHaveLength(1)
    expect(r.acked).toBe(1)
    if (mode === 'lost-witness') expect(r.firstAcked).toBe(0)
  } else {
    expect(r.result.state).not.toBe('done'); expect(r.acked).toBe(0)
    if (mode === 'stale-fetch') expect(r.after.value.history.filter((m: any) => m.direction === 'received')).toHaveLength(0)
  }
})
for (const mode of ['join-welcome', 'join-expired']) test(`driver ${mode}`, async ({ context }) => {
  const { page } = await enrolled(context, false)
  expect(await run(page, 'M.provisionJoin()')).toMatchObject({ ok: true })
  expect(await run(page, 'M.typedJoin()')).toMatchObject({ state: 'active' })
  if (mode === 'join-welcome') expect(await run(page, 'M.makeJoinWelcome()')).toBe(true)
  const r = await drive(page, mode)
  if (mode === 'join-welcome') {
    expect(r.result).toMatchObject({ state: 'done', delivered: 1 }); expect(r.acked).toBe(1)
    expect(r.after.value).toMatchObject({ phase: { type: 'Active' }, updateRequired: true })
  } else {
    expect(r.result).toEqual({ state: 'stopped', phase: 'Expired' }); expect(r.calls).toHaveLength(1)
  }
})
for (const mode of ['stale', 'bad-installation', 'query', 'bad-receipt', 'lost-query-witness']) test(`driver operation guard ${mode}`, async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await run(page, `M.driverGuardScenario('${mode}')`)
  if (mode === 'stale') expect(r).toMatchObject({ state: 'pending', reason: 'stale' })
  else if (mode === 'bad-installation') expect(r).toEqual({ state: 'refused', reason: 'wrong-installation' })
  else {
    expect(r.before).toHaveLength(1)
    expect(r.after.value.ordering).toHaveLength(mode === 'bad-receipt' ? 1 : 0)
    if (mode === 'bad-receipt') expect(r.result).toEqual({ state: 'refused', reason: 'engine:ReceiptUnverified' })
    if (mode === 'lost-query-witness') expect(r.result.state).toBe('pending')
  }
})
test('round lock serialises two tabs; a cancelled queued round never sends', async ({ context }) => {
  const { page } = await enrolled(context)
  await page.evaluate(route => (window as any).M.startDriver(route, 'wait'), boxRoute)
  await expect.poll(() => run(page, 'M.driverWaiting()')).toBe(true)
  const second = await context.newPage(); await second.goto(origin)
  await run(second, 'M.discover()')
  await second.evaluate(route => (window as any).M.startDriver(route, 'receive'), boxRoute)
  await expect.poll(() => run(second, 'M.driverReady()')).toBe(true)
  await run(second, 'M.stopDriver()')
  expect((await run(second, 'M.finishDriver()')).calls).toHaveLength(0)
  await run(page, 'M.releaseDriver()')
  expect((await run(page, 'M.finishDriver()')).result.state).toBe('done')
})

test('same-second restart handles a replay refusal through authenticated slot status', async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await drive(page, 'restart-replay')
  expect(r.result).toMatchObject({ stalled: true, delivered: 0 })
  expect(r.recovered).toMatchObject({ state: 'done', processed: 1 })
  const puts = r.calls.filter((c: any) => c.path.startsWith('/vmls/v1/slots/') && !c.path.endsWith('/status'))
  expect(puts).toHaveLength(2); expect(puts[0].event).toBe(puts[1].event)
  expect(r.after.value.phase.type).toBe('Active')
})
test('ordering capacity refuses the whole candidate and leaves the persona usable', async ({ context }) => {
  const { page } = await enrolled(context)
  const r = await run(page, 'M.orderingCapacityScenario()')
  expect(r.refused).toEqual({ state: 'refused', reason: 'ordering-full' })
  expect(r.unchanged).toEqual(r.before)
  expect(r.retried.state).toBe('active')
  expect(r.after.value.ordering).toHaveLength(1024)
})
