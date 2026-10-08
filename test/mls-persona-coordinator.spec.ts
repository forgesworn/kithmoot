import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
const origin = 'https://browser-mls-host.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-persona-coordinator.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
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
  const ids = await page.evaluate(key => (window as any).M.prepare(key), bytesToHex(ed25519.getPublicKey(key)))
  witness.digest = new Uint8Array(hexToBytes(ids.digest))
  return { page, witness, ids }
}
const local = (page: Page) => page.evaluate('M.local()')
async function accepted(f: Fixture, generation = '1', value = 8) {
  expect(await f.page.evaluate('M.read()')).toEqual({ state: 'active', value: { vault: [value], snapshot: [value, 7], generation }, marks: { [f.ids.session]: generation }, openedWiped: true })
}
for (const fault of ['after-stage', 'abort-promotion', 'after-promotion'] as const) test(`recovers ${fault} without releasing the interrupted effect`, async ({ context }) => {
  const f = await fixture(context)
  const result = await f.page.evaluate(fault => (window as any).M.commit(8, 1, fault), fault)
  expect(result.injected).toBe(true); expect(result.error).toBeTruthy(); expect(result.value).toBeUndefined()
  expect(f.witness.advances).toBe(fault === 'after-stage' ? 0 : 1)
  expect(await local(f.page)).toEqual(fault === 'after-promotion' ? { active: ['1'], staged: null, fence: null } : { active: [], staged: ['1'], fence: null })
  await f.page.reload()
  await accepted(f)
  expect(f.witness.seq).toBe(1n)
  expect(await local(f.page)).toEqual({ active: ['1'], staged: null, fence: null })
})
test('a lost committed response retains the exact candidate and reconciles before another mutation', async ({ context }) => {
  const f = await fixture(context); f.witness.loseAdvance = true
  expect(await f.page.evaluate('M.commit(8, 1)')).toEqual({ state: 'pending', reason: 'witness-unavailable', refused: false, injected: false })
  expect(await local(f.page)).toEqual({ active: [], staged: ['1'], fence: null })
  await f.page.reload(); await accepted(f)
  expect(f.witness.advances).toBe(1)
})
for (const mode of ['offline', 'wrongKey', 'replay'] as const) test(`fresh witness ${mode} holds edits and effects`, async ({ context }) => {
  const f = await fixture(context)
  expect((await f.page.evaluate('M.status()') as any).state).toBe('active')
  f.witness[mode] = true
  expect(await f.page.evaluate('M.commit(8, 1)')).toEqual({ state: 'pending', reason: 'witness-unavailable', refused: false, injected: false })
  expect(f.witness.advances).toBe(0)
  expect(await local(f.page)).toEqual({ active: [], staged: null, fence: null })
})
test('restoring the persona database including its keys fences against the retained witness and stays fenced after reload', async ({ context }) => {
  const f = await fixture(context)
  await f.page.evaluate('M.saveProfile()'); await f.page.evaluate('M.commit(8, 1)'); await f.page.evaluate('M.restoreProfile()')
  const expected = { state: 'fenced', reason: 'witness-mismatch', subject: f.ids.subject, retiring: false }
  expect(await f.page.evaluate('M.status()')).toEqual(expected)
  await f.page.reload(); expect(await f.page.evaluate('M.status()')).toEqual(expected)
})
test('missing staged objects fence even when the witness has already committed them', async ({ context }) => {
  const f = await fixture(context); f.witness.loseAdvance = true
  await f.page.evaluate('M.commit(8, 1)'); await f.page.evaluate('M.damage("stage")')
  expect(await f.page.evaluate('M.status()')).toEqual({ state: 'fenced', reason: 'stage-corrupt', subject: f.ids.subject, retiring: false })
})
for (const kind of ['record', 'inner-key'] as const) test(`a missing ${kind} persists a fence even if the missing data is restored`, async ({ context }) => {
  const f = await fixture(context)
  await f.page.evaluate('M.commit(8, 1)'); await f.page.evaluate('M.saveProfile()')
  await f.page.evaluate(kind => (window as any).M.damage(kind), kind)
  const expected = { state: 'fenced', reason: kind === 'record' ? 'missing-record' : 'seal-lost', subject: f.ids.subject, retiring: false }
  expect(await f.page.evaluate('M.status()')).toEqual(expected)
  await f.page.evaluate(kind => (window as any).M.restoreProfile(kind === 'record' ? 'personas' : 'keys'), kind)
  await f.page.reload(); expect(await f.page.evaluate('M.status()')).toEqual(expected)
})
test('a witness restored behind the client is retired and its duty stays retained until replacement', async ({ context }) => {
  const f = await fixture(context), initial = f.witness.digest.slice()
  await f.page.evaluate('M.commit(8, 1)')
  f.witness.seq = 0n; f.witness.digest = initial
  const expected = { state: 'fenced', reason: 'witness-behind', subject: f.ids.subject, retiring: true }
  expect(await f.page.evaluate('M.status()')).toEqual(expected)
  expect(f.witness.retired).toBe(true); expect(f.witness.advances).toBe(2)
  await f.page.reload(); expect(await f.page.evaluate('M.status()')).toEqual(expected)
  expect(f.witness.advances).toBe(2)
})
test('a fence arriving during encryption cannot be overwritten by the delayed seal', async ({ context }) => {
  const f = await fixture(context)
  expect(await f.page.evaluate('M.fenceRace()')).toEqual({ writing: 'conflict', reason: 'missing-record' })
})
for (const boundary of ['stale', 'stale-exit']) test(`an account context becoming obsolete at ${boundary} releases no committed effect`, async ({ context }) => {
  const f = await fixture(context)
  expect(await f.page.evaluate(boundary => (window as any).M.commit(8, 1, boundary), boundary)).toEqual({ state: 'pending', reason: 'stale', refused: false, injected: false })
  expect(await local(f.page)).toEqual({ active: ['1'], staged: null, fence: null })
  await accepted(f)
})
test('concurrent seal calls preserve invocation order and increasing session generation', async ({ context }) => {
  const f = await fixture(context)
  await f.page.evaluate('M.commit(8, 1)')
  expect(await f.page.evaluate('M.concurrentSteps()')).toEqual({ state: 'active', value: 'effect:3', marks: { [f.ids.session]: '3' } })
  expect(await local(f.page)).toEqual({ active: ['3'], staged: null, fence: null })
})
test('a refused witness is held visibly and can recover without implicit enrolment', async ({ context }) => {
  const f = await fixture(context); f.witness.refused = true
  expect(await f.page.evaluate('M.status()')).toEqual({ state: 'pending', reason: 'witness-unavailable', refused: true })
  await f.page.reload(); expect(await f.page.evaluate('M.status()')).toEqual({ state: 'pending', reason: 'witness-unavailable', refused: true })
  f.witness.refused = false
  expect((await f.page.evaluate('M.status()') as any).state).toBe('active')
  expect(f.witness.advances).toBe(0)
})
test('a caller attempting an older generation cannot stage it or falsely fence healthy state', async ({ context }) => {
  const f = await fixture(context)
  await f.page.evaluate('M.commit(8, 1)')
  expect((await f.page.evaluate('M.commit(9, 1)') as any).error).toBeTruthy()
  await accepted(f)
  expect(f.witness.advances).toBe(1)
})
test('an account context that is already obsolete sends no witness request', async ({ context }) => {
  const f = await fixture(context)
  expect(await f.page.evaluate('M.commit(8, 1, "stale-initial")')).toEqual({ state: 'pending', reason: 'stale', refused: false, injected: false })
  expect(f.witness.reads).toBe(0); expect(f.witness.advances).toBe(0)
  expect(await local(f.page)).toEqual({ active: [], staged: null, fence: null })
})
