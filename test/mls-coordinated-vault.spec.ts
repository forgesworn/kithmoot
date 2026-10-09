import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://browser-mls-vault.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-coordinated-vault.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
type Fixture = Awaited<ReturnType<typeof fixture>>
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
async function enrolled(context: BrowserContext) {
  const f = await fixture(context)
  expect((await run(f.page, 'M.enrol()')).ok).toBe(true)
  await run(f.page, 'M.request()')
  return f
}
test('device enrolment and leaf decisions commit before release; identical retry replays', async ({ context }) => {
  const f = await enrolled(context)
  expect(f.witness.advances).toBe(1)
  const first = await run(f.page, 'M.sign()')
  expect(first.answer.ok).toBe(true); expect(first.asked).toBe(1)
  expect(await run(f.page, 'M.accept()')).toEqual(first.answer)
  expect(await run(f.page, 'M.localRecord()')).toMatchObject({ active: 1, staged: null, journal: 1, approved: 1 })
  expect(f.witness.advances).toBe(2)
  expect(await run(f.page, 'M.sign()')).toEqual({ answer: first.answer, asked: 0 })
  expect(f.witness.advances).toBe(2)
})
test('a lost signing advance returns no signature; retry reconciles the exact journal', async ({ context }) => {
  const f = await enrolled(context); f.witness.loseAdvance = true
  expect((await run(f.page, 'M.sign()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
  expect(await run(f.page, 'M.localRecord()')).toMatchObject({ staged: 1, journal: 0, approved: 0 })
  const retried = await run(f.page, 'M.sign()')
  expect(retried.answer.ok).toBe(true); expect(retried.asked).toBe(0)
  expect(f.witness.advances).toBe(2)
})
for (const mode of ['stage', 'promotion'] as const) test(`interrupted ${mode} releases nothing and recovers the staged signature`, async ({ context }) => {
  const f = await enrolled(context)
  expect(await run(f.page, `M.faultSign('${mode}')`)).toMatchObject({ error: 'fixture interruption', injected: true })
  expect((await run(f.page, 'M.sign()')).answer.ok).toBe(true)
  expect(f.witness.advances).toBe(2)
})
test('restart makes a previous operation stale and clears local box confirmation', async ({ context }) => {
  const f = await enrolled(context)
  expect((await run(f.page, 'M.sign()')).answer.ok).toBe(true)
  await run(f.page, 'M.restart()')
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
  expect((await run(f.page, 'M.sign()')).answer).toEqual({ ok: false, refusal: 'stale' })
  await run(f.page, 'M.request()')
  expect((await run(f.page, 'M.sign()')).answer.ok).toBe(true)
})
test('denial is witnessed and replayed without another prompt', async ({ context }) => {
  const f = await enrolled(context)
  expect(await run(f.page, "M.sign(undefined, 'deny')")).toEqual({ answer: { ok: false, refusal: 'denied' }, asked: 1 })
  expect(await run(f.page, 'M.sign()')).toEqual({ answer: { ok: false, refusal: 'denied' }, asked: 0 })
  expect(f.witness.advances).toBe(2)
})
for (const action of ['replace', 'account', 'withdraw'] as const) test(`consent cannot outlive ${action}`, async ({ context }) => {
  const f = await enrolled(context)
  expect(await run(f.page, `M.consentRace('${action}')`)).toEqual({ ok: false, refusal: 'stale' })
})
test('old device keys remain tombstoned after replacement and old replies are stale', async ({ context }) => {
  const f = await enrolled(context), before = await run(f.page, 'M.device()')
  await run(f.page, 'M.sign()')
  expect((await run(f.page, 'M.enrol(true)')).ok).toBe(true)
  expect(await run(f.page, 'M.accept()')).toEqual({ ok: false, refusal: 'stale' })
  expect((await run(f.page, 'M.localRecord()')).retired).toEqual([before.value.device])
})
test('typed box headers use the MLS device and exact URL; only approval advances', async ({ context }) => {
  const f = await enrolled(context), before = f.witness.reads
  const first = await run(f.page, 'M.box()')
  expect(first.answer.ok).toBe(true); expect(first.asked).toBe(1)
  expect(first.event).toMatchObject({ kind: 27235, content: '', pubkey: first.answer.value.device })
  expect(first.event.tags).toEqual([
    ['u', 'http://pb4hq6dypb4hq6dypb4hq6dypb4hq6dypb4hq6dypb4hq6dypb4a/vmls/v1/fetch'],
    ['method', 'POST'], ['payload', '12'.repeat(32)],
  ])
  expect(first.accepted.ok).toBe(true); expect(first.substituted).toEqual({ ok: false, refusal: 'replay' })
  expect(f.witness.advances).toBe(2); expect(f.witness.reads).toBe(before + 1)
  const second = await run(f.page, 'M.box()')
  expect(second.asked).toBe(0); expect(second.event.created_at).toBe(first.event.created_at + 1)
  expect(f.witness.reads).toBe(before + 1); expect(f.witness.advances).toBe(2)
})
test('box duplicate timestamps are bounded; no live id is reused', async ({ context }) => {
  const f = await enrolled(context)
  const burst = await run(f.page, 'M.boxBurst()')
  expect(new Set(burst.slice(0, 31)).size).toBe(31); expect(burst[31]).toBe('busy')
  await run(f.page, 'M.advanceClock(60)')
  expect((await run(f.page, 'M.box()')).answer.ok).toBe(true)
})
test('a pending witness check cancels prior confirmation; quiet signing does not fresh-read', async ({ context }) => {
  const f = await enrolled(context)
  expect((await run(f.page, 'M.box()')).answer.ok).toBe(true)
  f.witness.offline = true
  expect((await run(f.page, 'M.box()')).answer.ok).toBe(true) // Already approved, unchanged confirmed record.
  expect(await run(f.page, 'M.status()')).toBe('pending')
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
})
test('revoked and expired devices sign neither leaves nor box requests', async ({ context }) => {
  const f = await enrolled(context)
  await run(f.page, 'M.box()')
  expect((await run(f.page, "M.policy('revoke')")).ok).toBe(true)
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'revoked' })
  expect((await run(f.page, 'M.sign()')).answer).toEqual({ ok: false, refusal: 'revoked' })
})
test('rolling back a whole persona fences before any signature leaves', async ({ context }) => {
  const f = await enrolled(context)
  await run(f.page, 'M.saveProfile()'); await run(f.page, 'M.sign()'); await run(f.page, 'M.restoreProfile()')
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
  expect((await run(f.page, 'M.sign()')).answer).toEqual({ ok: false, refusal: 'restore-fenced' })
})
test('legacy transfer freezes the source and preserves device, approvals and stale journal', async ({ context }) => {
  const f = await fixture(context)
  const before = await run(f.page, 'M.legacyEnrol()'); await run(f.page, 'M.request()'); await run(f.page, 'M.legacySign()')
  expect(await run(f.page, 'M.migrate()')).toEqual(before)
  expect(await run(f.page, 'M.legacyAfterMigration()')).toEqual({ error: 'This MLS vault has moved to coordinated storage.' })
  expect(await run(f.page, 'M.localRecord()')).toMatchObject({ migrated: true, journal: 1, approved: 1, device: before.value.device })
  expect((await run(f.page, 'M.sign()')).answer).toEqual({ ok: false, refusal: 'stale' })
  await run(f.page, 'M.request()'); expect((await run(f.page, 'M.sign()')).answer.ok).toBe(true)
  expect(await run(f.page, 'M.migrate()')).toEqual(before)
  expect((await run(f.page, 'M.localRecord()')).journal).toBe(2)
})
test('interrupted legacy transfer stays frozen and resumes the exact destination', async ({ context }) => {
  const f = await fixture(context)
  await run(f.page, 'M.legacyEnrol()'); f.witness.loseAdvance = true
  expect(await run(f.page, 'M.migrate()')).toEqual({ ok: false, refusal: 'witness-pending' })
  expect((await run(f.page, 'M.legacyAfterMigration()')).error).toContain('moved')
  await run(f.page, 'M.restart()')
  expect((await run(f.page, 'M.migrate()')).ok).toBe(true)
  expect(f.witness.advances).toBe(1)
})
test('missing legacy keys are not replaced or imported as an empty vault', async ({ context }) => {
  const f = await fixture(context)
  await expect(run(f.page, 'M.migrate()')).rejects.toThrow('legacy MLS vault keys are missing')
  expect(f.witness.advances).toBe(0)
})
test('a full live journal refuses without retaining a partial consent approval', async ({ context }) => {
  const f = await enrolled(context)
  expect(await run(f.page, 'M.fillJournal()')).toBe('active')
  const advances = f.witness.advances
  expect((await run(f.page, 'M.sign()')).answer).toEqual({ ok: false, refusal: 'busy' })
  expect(await run(f.page, 'M.localRecord()')).toMatchObject({ journal: 1024, approved: 0 })
  expect(f.witness.advances).toBe(advances)
})
test('readable unsupported typed state fences rather than minting an empty record', async ({ context }) => {
  const f = await enrolled(context)
  await run(f.page, 'M.malformedRecord()')
  expect(await run(f.page, 'M.device()')).toEqual({ ok: false, refusal: 'restore-fenced' })
  expect(await run(f.page, 'M.enrol(true)')).toEqual({ ok: false, refusal: 'restore-fenced' })
})
test('another tab sees durable changes and synchronously invalidates old replies', async ({ context }) => {
  const f = await enrolled(context)
  await run(f.page, 'M.sign()'); await run(f.page, 'M.box()')
  const second = await context.newPage(); await second.goto(origin)
  expect((await run(second, 'M.loadExisting()')).ok).toBe(true)
  expect((await run(second, "M.policy('withdraw')")).ok).toBe(true)
  expect(await run(f.page, 'M.accept()')).toEqual({ ok: false, refusal: 'stale' })
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
})
test('actual page reload cancels the previous journal operation', async ({ context }) => {
  const f = await enrolled(context), req = await run(f.page, 'M.request()')
  await run(f.page, 'M.sign()'); await f.page.reload()
  const reply = await f.page.evaluate(req => (window as any).M.sign(req), req)
  expect(reply.answer).toEqual({ ok: false, refusal: 'stale' })
})
test('expiry and account changes invalidate confirmed box signing', async ({ context }) => {
  const f = await enrolled(context)
  await run(f.page, 'M.box()'); await run(f.page, 'M.changeAccount()')
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
  await run(f.page, 'M.device()'); await run(f.page, 'M.advanceClock(8 * 86400)')
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'expired' })
})
test('clear invalidates previously returned signatures and retains the retirement fence', async ({ context }) => {
  const f = await enrolled(context)
  await run(f.page, 'M.sign()'); await run(f.page, 'M.typedClear()')
  expect(await run(f.page, 'M.accept()')).toEqual({ ok: false, refusal: 'stale' })
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
  expect(await run(f.page, 'M.enrol()')).toEqual({ ok: false, refusal: 'restore-fenced' })
})
test('a missing inner key returns no header or implicit new device', async ({ context }) => {
  const f = await enrolled(context)
  await run(f.page, 'M.box()'); await run(f.page, "M.damage('inner-key')")
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'restore-fenced' })
  expect(await run(f.page, 'M.enrol(true)')).toEqual({ ok: false, refusal: 'restore-fenced' })
})
test('failed box approval advances release no authentication header', async ({ context }) => {
  const f = await enrolled(context); f.witness.loseAdvance = true
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
  expect((await run(f.page, 'M.box()')).answer).toEqual({ ok: false, refusal: 'witness-pending' })
  await run(f.page, 'M.device()')
  const retried = await run(f.page, 'M.box()')
  expect(retried.answer.ok).toBe(true); expect(retried.asked).toBe(0)
})
test('substituted leaf digest, unsupported version and expired requests refuse', async ({ context }) => {
  const f = await enrolled(context), req = await run(f.page, 'M.request()')
  for (const [changed, refusal] of [[{ ...req, digest: '00'.repeat(32) }, 'malformed'], [{ ...req, v: 2 }, 'unsupported'], [{ ...req, expires_at: 1 }, 'expired']] as const) {
    expect((await f.page.evaluate(r => (window as any).M.sign(r), changed)).answer).toEqual({ ok: false, refusal })
  }
  expect(f.witness.advances).toBe(1)
})
