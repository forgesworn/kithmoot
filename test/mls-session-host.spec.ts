import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://browser-mls-session.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-session-host.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'M', define: { 'import.meta.env.BASE_URL': '\"/\"' } })).outputFiles[0].text })
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

test('fresh sessions use their own witnessed generations and no-op keeps exact ciphertext', async ({ context }) => {
  const { page, witness } = await fixture(context)
  expect(await page.evaluate('M.unknown()')).toEqual({ state: 'unknown' })
  expect(await page.evaluate('M.create()')).toMatchObject({ state: 'active' })
  expect(await page.evaluate('M.create()')).toMatchObject({ state: 'active' })
  await page.evaluate('M.bumpVault()')
  const before = await page.evaluate('M.local()')
  expect(await page.evaluate('M.read(0)')).toMatchObject({ state: 'active', value: { generation: '1' } })
  expect(await page.evaluate('M.read(1)')).toMatchObject({ state: 'active', value: { generation: '1' } })
  expect(await page.evaluate('M.local()')).toEqual(before)
  expect(witness.seq).toBe(3n)
  expect(await page.evaluate('M.counters()')).toMatchObject({ snapshotsWiped: true, valuesWiped: true })
})

for (const kind of ['stage', 'promotion', 'ack-throw', 'close-throw', 'free-throw', 'stale-stage', 'stale-close', 'invalidated-close']) test(`withholds effects and recovers exact outbox after ${kind}`, async ({ context }) => {
  const { page } = await fixture(context)
  expect(await page.evaluate('M.create()')).toMatchObject({ state: 'active' })
  const before: any = await page.evaluate('M.counters()')
  const answer: any = await page.evaluate(kind => (window as any).M.fault(kind), kind)
  expect(answer.state, JSON.stringify(answer)).not.toBe('active')
  expect(answer.error ?? '', JSON.stringify(answer)).not.toMatch(/^(?!fixture).+/)
  const counts: any = await page.evaluate('M.counters()')
  expect(counts.opened).toBe(counts.freed)
  expect(counts.snapshotsWiped).toBe(true)
  expect(counts.valuesWiped).toBe(true)
  if (['stage', 'promotion', 'stale-stage'].includes(kind)) expect(counts.acks).toBe(before.acks)
  expect(counts.ackBeforePromotion).toBe(false)
  await page.evaluate('M.restart()')
  const recovered: any = await page.evaluate('M.read()')
  expect(recovered).toMatchObject({ state: 'active', value: { generation: '2' } })
  expect(recovered.value.outbox.length).toBeGreaterThan(0)
  await page.evaluate('M.restart()')
  expect(await page.evaluate('M.read()')).toEqual(recovered)
  expect(await page.evaluate('M.delivered()')).toMatchObject({ state: 'active' })
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { outbox: [], generation: '3' } })
})

test('lost accepted advance returns no effects, then promotes exact candidate before next send', async ({ context }) => {
  const { page, witness } = await fixture(context)
  await page.evaluate('M.create()')
  witness.loseAdvance = true
  expect(await page.evaluate('M.send()')).toMatchObject({ state: 'pending' })
  expect(witness.seq).toBe(2n)
  expect(await page.evaluate('M.counters()')).toMatchObject({ acks: 1, opened: 2, freed: 2, snapshotsWiped: true, valuesWiped: true })
  await page.evaluate('M.restart()')
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { generation: '2' } })
  expect(await page.evaluate('M.send()')).toMatchObject({ state: 'active' })
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { generation: '3' } })
})

for (const kind of ['id', 'generation', 'missing', 'throw']) test(`rejects ${kind} step and reopens the predecessor`, async ({ context }) => {
  const { page, witness } = await fixture(context)
  await page.evaluate('M.create()')
  const before = await page.evaluate('M.local()')
  expect(await page.evaluate(kind => (window as any).M.malformed(kind), kind)).toHaveProperty('error')
  expect(witness.seq).toBe(1n)
  expect(await page.evaluate('M.local()')).toEqual(before)
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { generation: '1', outbox: [] } })
  const counts: any = await page.evaluate('M.counters()')
  expect(counts.freed).toBe(counts.opened)
  expect(counts.snapshotsWiped).toBe(true)
})

test('offline and refused witness never run a new ratchet; restored profile fences', async ({ context }) => {
  const { page, witness } = await fixture(context)
  await page.evaluate('M.create()')
  await page.evaluate('M.saveProfile()')
  witness.offline = true
  expect(await page.evaluate('M.send()')).toMatchObject({ state: 'pending' })
  expect(await page.evaluate('M.counters()')).toMatchObject({ opened: 1, freed: 1, acks: 1 })
  witness.offline = false; witness.refused = true
  expect(await page.evaluate('M.send()')).toMatchObject({ state: 'pending', refused: true })
  witness.refused = false
  expect(await page.evaluate('M.send()')).toMatchObject({ state: 'active' })
  await page.evaluate('M.restoreProfile()')
  await page.evaluate('M.restart()')
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'fenced' })
})

test('drop is witnessed and old session ids remain unusable', async ({ context }) => {
  const { page, witness } = await fixture(context)
  await page.evaluate('M.create()')
  expect(await page.evaluate('M.readopt()')).toHaveProperty('error')
  witness.loseAdvance = true
  expect(await page.evaluate('M.drop()')).toMatchObject({ state: 'pending' })
  await page.evaluate('M.restart()')
  expect(await page.evaluate('M.read()')).toEqual({ state: 'unknown' })
  expect(await page.evaluate('M.readopt()')).toHaveProperty('error')
  expect(await page.evaluate('M.sessions()')).toEqual({ state: 'active', value: [] })
  expect(await page.evaluate('M.create()')).toMatchObject({ state: 'active' })
})

test('concurrent steps serialise generations; changed box installation becomes witnessed recovery', async ({ context }) => {
  const { page } = await fixture(context)
  await page.evaluate('M.create()')
  expect(await page.evaluate('M.concurrent()')).toMatchObject([{ state: 'active' }, { state: 'active' }])
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { generation: '3' } })
  expect(await page.evaluate('M.installationChanged()')).toMatchObject({ state: 'active' })
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { phase: { type: 'NeedsRecovery', reason: 'RestoreFenced' } } })
})

test('two tabs reopen and serialise the same session under the persona writer lock', async ({ context }) => {
  const { page } = await fixture(context)
  await page.evaluate('M.create()')
  const other = await context.newPage()
  await other.goto(origin)
  await other.evaluate('M.resume()')
  expect(await Promise.all([page.evaluate('M.send()'), other.evaluate('M.send()')])).toMatchObject([{ state: 'active' }, { state: 'active' }])
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { generation: '3' } })
  expect(await other.evaluate('M.read()')).toEqual(await page.evaluate('M.read()'))
})

test('uncertain creation is found by witnessed discovery after restart', async ({ context }) => {
  const { page, witness } = await fixture(context)
  witness.loseAdvance = true
  expect(await page.evaluate('M.create()')).toMatchObject({ state: 'pending' })
  await page.evaluate('M.restart()')
  const discovered: any = await page.evaluate('M.sessions()')
  expect(discovered.state).toBe('active')
  expect(discovered.value).toHaveLength(1)
  expect(discovered.value[0][1]).toBe('1')
  expect(await page.evaluate('M.read()')).toMatchObject({ state: 'active', value: { generation: '1' } })
  expect(await page.evaluate('M.readopt()')).toHaveProperty('error')
})

for (const invalid of ['wrongKey', 'replay'] as const) test(`untrusted witness ${invalid} cannot run a session`, async ({ context }) => {
  const { page, witness } = await fixture(context)
  await page.evaluate('M.create()')
  witness[invalid] = true
  expect(await page.evaluate('M.send()')).not.toMatchObject({ state: 'active' })
  expect(await page.evaluate('M.counters()')).toMatchObject({ opened: 1, freed: 1, acks: 1 })
})
