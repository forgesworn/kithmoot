import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const origin = 'https://bark-protected-handoff.kithmoot.test'
let bundle: string
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['test/mls-bark-rendezvous.browser-entry.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'B', define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'true',
      'import.meta.env.VITE_BROWSER_MLS_INVITATION_PREVIEW': '"true"' } })).outputFiles[0].text
})
test.beforeEach(async ({ page }) => {
  await page.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (/^\/vmls-wasm(?:-invitation)?\/(?:manifest\.json|vmls_wasm\.js|vmls_wasm_bg\.wasm)$/.test(path))
      return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.json') ? 'application/json' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.abort()
  })
  await page.goto(origin)
})
test('actual child-to-protected-target encryption installs custody and creates a real invitation room', async ({ page }) => {
  const result = await page.evaluate('B.provision("success")') as any
  expect(result).toMatchObject({ calls: 1, requestKeys: 'expectedPersona,expiresAt,index,nonce,targetDevice,v', publicKeys: 'device,persona',
    forgedCurrent: false, installed: true, restartSame: true, roomState: 'active', custodyCurrent: true, targetBound: true, approvedIndex: 7, error: '' })
})
for (const mode of ['provider-change', 'callable-change', 'account-change', 'expiry', 'nonce', 'inner-index', 'offline']) {
  test('protected Bark handoff refuses ' + mode, async ({ page }) => {
    const result = await page.evaluate(mode => (globalThis as any).B.provision(mode), mode)
    expect(result.installed).toBe(false); expect(result.roomState).toBe(''); expect(result.error).not.toBe('')
    expect(result.calls).toBe(mode === 'offline' ? 0 : 1)
  })
}
test('lost target acknowledgement exposes nothing and a fresh host recovers the same protected target', async ({ page }) => {
  const result = await page.evaluate('B.provision("lost-target-ack")') as any
  expect(result).toMatchObject({ calls: 1, installed: true, restartSame: true, roomState: 'active', forgedCurrent: false })
})
test('legacy and invitation rooms coexist in one actual development WASM module', async ({ page }) => {
  expect(await page.evaluate('B.coexistence()')).toEqual({ legacy: 'active', invitation: 'active', legacyRead: 'active', invitationRead: 'active', oneModule: true })
})

test('accepted protected child reopens past the handoff deadline and creates both room profiles while signer is offline', async ({ page }) => {
  expect(await page.evaluate('B.provision("retained-offline")')).toMatchObject({ calls: 1, installed: true, restartSame: true,
    pastHandoff: true, legacyState: 'active', roomState: 'active', custodyCurrent: true, error: '' })
})
test('fresh protected runtimes use retained children for actual invitation ECDH after both handoff deadlines', async ({ page }) => {
  expect(await page.evaluate('B.retainedInvitation()')).toEqual({ issued: 'active', accepted: 'active', reopened: 'active' })
})
for (const mode of ['clear', 'rotation', 'account']) test('retained child still holds actual invitation use after ' + mode, async ({ page }) => {
  expect(await page.evaluate(mode => (globalThis as any).B.retainedInvitation(mode), mode)).toMatchObject({ held: true })
})
