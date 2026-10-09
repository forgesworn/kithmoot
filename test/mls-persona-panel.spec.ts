import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { pairingFixture } from './mls-pairing-fixture.js'
const origin = 'https://browser-mls-panel.kithmoot.test'
let bundle: string
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/mls-persona-panel.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'P', define: { 'import.meta.env.BASE_URL': '"/"' } })).outputFiles[0].text })
async function fixture(context: BrowserContext) {
  const key = new Uint8Array(32).fill(91), pairing = pairingFixture(key)
  const witness = { reads: 0, enrolled: false, offline: false, digest: new Uint8Array(32) }
  await context.exposeBinding('panelWitness', async (_, input: number[]) => {
    witness.reads++
    if (witness.offline) return { status: 503, body: [], witnessRefused: false }
    if (!witness.enrolled) return { status: 403, body: [], witnessRefused: true }
    const request = new Uint8Array(input), signed = new Uint8Array(106)
    expect(request.length).toBe(73)
    signed[0] = 1; signed.set(request.subarray(6, 38), 2); signed.set(witness.digest, 42); signed.set(request.subarray(request.length - 32), 74)
    const hash = sha256(concatBytes(new TextEncoder().encode('VMLS/1 witness receipt'), signed))
    return { status: 200, body: Array.from(concatBytes(signed, ed25519.sign(hash, key))), witnessRefused: false }
  })
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'" }, body: '<link rel="stylesheet" href="/style.css"><script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (path === '/style.css') return route.fulfill({ contentType: 'text/css', body: readFileSync('app/src/style.css') })
    if (path === '/vmls-wasm/vmls_wasm.js' || path === '/vmls-wasm/vmls_wasm_bg.wasm') return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.abort()
  })
  const page = await context.newPage(); await page.goto(origin)
  await page.evaluate(route => (window as any).P.start(route), pairing.route)
  const open = () => page.evaluate('P.open()')
  const button = (name: string) => page.locator(`#mlsWitness${name}`)
  const prepare = async () => { await button('Prepare').click(); await expect(button('Pair')).toBeEnabled() }
  const pair = async () => {
    await page.locator('#mlsWitnessRelays').fill(pairing.route.relayUrls.join(' ')); await page.locator('#mlsWitnessCode').fill(pairing.uri)
    await button('Pair').click(); await expect(button('Genesis')).toBeEnabled()
  }
  const genesis = async () => {
    await button('Genesis').click(); await expect(button('Check')).toBeEnabled()
    const command = await page.locator('#mlsWitnessCommand').inputValue()
    witness.digest = new Uint8Array(hexToBytes(command.match(/--initial-digest ([a-f0-9]{64})/)![1]))
    return command
  }
  return { page, open, button, prepare, pair, genesis, witness, pairing }
}
test('opening is local only; enrolment and witness confirmation are separate explicit actions', async ({ context }) => {
  const f = await fixture(context); await f.open()
  expect(await f.page.evaluate('P.seen()')).toEqual({ events: [], writers: [] })
  expect(await f.page.evaluate('P.canForget()')).toBe(true)
  await f.prepare(); expect(await f.page.evaluate('P.canForget()')).toBe(false)
  await f.pair(); expect(await f.page.locator('#mlsWitnessCode').inputValue()).toBe('')
  expect((await f.page.evaluate('P.seen()') as any).events).toEqual(['start', 'pair', 'stop'])
  const command = await f.genesis()
  expect(command).toMatch(/^bothyd witness enrol --subject [a-f0-9]{64} --installation [a-f0-9]{64} --writer [a-f0-9]{64} --initial-digest [a-f0-9]{64}$/)
  expect(f.witness.reads).toBe(0)
  await f.button('Check').click(); await expect(f.page.locator('#mlsWitnessNetworkStatus')).toContainText('refused')
  f.witness.enrolled = true
  await f.button('Check').click(); await expect(f.page.locator('#mlsWitnessNetworkStatus')).toContainText('confirmed this stored state')
  expect(f.witness.reads).toBe(2)
  await f.button('Close').click(); await f.open()
  expect(await f.page.locator('#mlsWitnessCommand').inputValue()).toBe(command)
  expect(f.witness.reads).toBe(2)
  await expect(f.page.locator('#mlsWitnessNetworkStatus')).toContainText('Local state shown')
})
test('an outage holds state without resetting enrolment', async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare(); await f.pair(); const command = await f.genesis()
  f.witness.offline = true
  await f.button('Check').click(); await expect(f.page.locator('#mlsWitnessNetworkStatus')).toContainText('remains held')
  expect(await f.page.locator('#mlsWitnessCommand').inputValue()).toBe(command)
  await expect(f.button('Prepare')).toBeDisabled()
})
for (const mode of ['quiet', 'tor-only']) test(`${mode} keeps local settings available but prevents connections`, async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare(); await f.pair(); await f.genesis()
  const before = await f.page.evaluate('P.seen().events.length')
  await f.page.evaluate(mode => (window as any).P.change({ persona: '21'.repeat(32), generation: '1', mode }), mode)
  await f.open(); await expect(f.button('Check')).toBeDisabled(); await expect(f.button('Pair')).toBeDisabled()
  await expect(f.page.locator('#mlsWitnessNetworkStatus')).toContainText('connections are held')
  expect(await f.page.evaluate('P.seen().events.length')).toBe(before)
})
test('account changes clear commands and capabilities before a late pairing reply returns', async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare(); await f.page.evaluate('P.holdPair()')
  await f.page.locator('#mlsWitnessRelays').fill(f.pairing.route.relayUrls.join(' ')); await f.page.locator('#mlsWitnessCode').fill(f.pairing.uri)
  await f.button('Pair').click(); await expect.poll(() => f.page.evaluate('P.seen().events.includes("pair")')).toBe(true)
  await f.page.evaluate('P.change({ persona: "22".repeat(32), generation: "1", mode: "normal" })')
  await expect(f.page.locator('#mlsWitnessSettings')).not.toBeVisible()
  expect(await f.page.locator('#mlsWitnessCode').inputValue()).toBe('')
  expect(await f.page.locator('#mlsWitnessCommand').inputValue()).toBe('')
  await f.page.evaluate('P.releasePair()')
  await expect.poll(async () => { await f.open(); return f.button('Prepare').isEnabled() }).toBe(true)
  await expect(f.page.locator('#mlsWitnessAccount')).toHaveText('22'.repeat(32))
  await f.page.evaluate('P.change({ persona: "21".repeat(32), generation: "2", mode: "normal" })'); await f.open()
  await expect(f.page.locator('#mlsWitnessLocalStatus')).toContainText('Pair a witness')
})
test('clear and keeper retirement require distinct explicit confirmations', async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare(); await f.pair(); const command = await f.genesis()
  const subject = command.match(/--subject ([a-f0-9]{64})/)![1]
  await f.page.locator('#mlsWitnessRecovery summary').click(); await f.button('Clear').click()
  await f.page.locator('#actionCancel').click(); await expect(f.button('Clear')).toBeEnabled()
  expect(await f.page.locator('#mlsWitnessCommand').inputValue()).toBe(command)
  await f.button('Clear').click(); await f.page.locator('#actionConfirm').click()
  await expect(f.page.locator('#mlsWitnessLocalStatus')).toContainText('fenced')
  await expect(f.page.locator('#mlsWitnessRetirement')).toContainText('seal is unavailable')
  expect(await f.page.evaluate('P.canForget()')).toBe(false)
  await f.page.locator('#mlsWitnessRetiredSubject').fill(subject); await f.page.locator('#mlsWitnessRetiredAcknowledged').check()
  await f.button('ConfirmRetired').click(); await f.page.locator('#actionConfirm').click()
  await expect(f.button('Prepare')).toBeEnabled()
  expect(await f.page.evaluate('P.canForget()')).toBe(true)
})
test('a changed account cannot approve an already open destructive confirmation', async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare(); await f.pair(); const command = await f.genesis()
  await f.page.locator('#mlsWitnessRecovery summary').click(); await f.button('Clear').click()
  await f.page.evaluate('P.change({ persona: "22".repeat(32), generation: "1", mode: "normal" })')
  await f.page.locator('#actionConfirm').click()
  await f.page.evaluate('P.change({ persona: "21".repeat(32), generation: "2", mode: "normal" })')
  await expect.poll(async () => { await f.open(); return f.page.locator('#mlsWitnessCommand').inputValue() }).toBe(command)
})
test('another tab invalidates displayed commands with an identity-free notification', async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare(); await f.pair(); await f.genesis()
  await f.page.evaluate(() => {
    const channel = new BroadcastChannel('kithmoot-mls-persona-changed-v1')
    ;(window as any).changes = []
    channel.onmessage = event => (window as any).changes.push(event.data)
  })
  const other = await context.newPage(); await other.goto(origin)
  await other.evaluate(route => (window as any).P.start(route), f.pairing.route); await other.evaluate('P.open()')
  await other.locator('#mlsWitnessRecovery summary').click(); await other.locator('#mlsWitnessClear').click(); await other.locator('#actionConfirm').click()
  await expect(f.page.locator('#mlsWitnessSettings')).not.toBeVisible()
  expect(await f.page.locator('#mlsWitnessCommand').inputValue()).toBe('')
  expect(await f.page.evaluate('window.changes')).toEqual([{ type: 'changed' }])
  await f.open(); await expect(f.page.locator('#mlsWitnessLocalStatus')).toContainText('fenced')
})
test('a clear confirmation cannot erase a replacement installation even without a tab notification', async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare()
  await f.page.locator('#mlsWitnessRecovery summary').click(); await f.button('Clear').click()
  const replacement = await f.page.evaluate('P.replacePreparation()')
  await f.page.locator('#actionConfirm').click()
  await expect(f.page.locator('#mlsWitnessNetworkStatus')).toContainText('could not be confirmed')
  expect((await f.page.evaluate('P.inspect()') as any).enrolment).toMatchObject({ state: 'prepared', installation: replacement })
})
test('an unregistered preparation with a lost inner key can still be explicitly cleared', async ({ context }) => {
  const f = await fixture(context); await f.open(); await f.prepare(); await f.button('Close').click()
  await f.page.evaluate('P.loseInnerKey()'); await f.open()
  await expect(f.page.locator('#mlsWitnessLocalStatus')).toContainText('fenced')
  await f.page.locator('#mlsWitnessRecovery summary').click(); await f.button('Clear').click(); await f.page.locator('#actionConfirm').click()
  await expect(f.button('Prepare')).toBeVisible()
  expect((await f.page.evaluate('P.seen()') as any).events).toEqual([])
})
test('the enrolment command fits a narrow screen without horizontal overflow', async ({ context }) => {
  const f = await fixture(context); await f.page.setViewportSize({ width: 390, height: 844 })
  await f.open(); await f.prepare(); await f.pair(); await f.genesis()
  expect(await f.page.locator('#mlsWitnessSettings').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  await f.page.screenshot({ path: '/tmp/vennel-mls-panel-mobile.png', fullPage: true })
})
