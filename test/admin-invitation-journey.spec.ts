import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const origin = 'https://admin-invitation-journey.kithmoot.test'
let bundle: string
 test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['test/admin-invitation-journey.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'J',
    define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_BROWSER_MLS_INVITATION_PREVIEW': '"false"',
      'import.meta.env.VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW': '"true"', 'import.meta.env.VITE_MIXED_INVITATION_LAB': '"false"' } })).outputFiles[0].text
})
async function fixture(context: BrowserContext) {
  const external: string[] = [], sockets: string[] = []
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'self'" }, body: '<script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (/^\/vmls-wasm-admin-invitation\/(?:manifest\.json|vmls_wasm\.js|vmls_wasm_bg\.wasm)$/.test(path)) return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.json') ? 'application/json' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.abort()
  })
  const page = await context.newPage()
  page.on('request', request => { if (!request.url().startsWith(origin + '/') && !request.url().startsWith('blob:')) external.push(request.url()) })
  page.on('websocket', socket => sockets.push(socket.url()))
  await page.goto(origin); return { page, external, sockets }
}
test('actual protected Admin2 journey uses native device roles, typed policy consent and snapshot5 restart', async ({ context }) => {
  const f = await fixture(context), result = await f.page.evaluate('J.lifecycle()') as Awaited<ReturnType<typeof import('./admin-invitation-journey.browser-entry.js').lifecycle>>
  expect(result).toMatchObject({ memberInviteRefused: true, memberRemoveRefused: true, lastRemoveRefused: true, lastDemoteRefused: true, staleRefused: true,
    demotedInviteRefused: true, snapshotVersion: 5, removedPhase: 'Removed', ordinaryDelivered: true, typedPolicyConsents: 2 })
  expect(result.keeperActors.every((actor: string) => actor === 'alice')).toBe(true)
  expect(f.external).toEqual([]); expect(f.sockets).toEqual([])
})
test('Admin2 panel explains per-device authority and requires a reviewed policy for role controls', async ({ context }) => {
  const f = await fixture(context); await f.page.evaluate('J.openPanel()')
  await expect(f.page.locator('[data-admin-invitation-toggle]')).toBeVisible()
  await expect(f.page.locator('[data-invitation-toggle]')).toBeHidden()
  await expect(f.page.locator('[data-admin-explanation]')).toContainText('one current device leaf')
  await f.page.locator('[data-promote-admin]').click()
  await expect(f.page.locator('[data-status]')).toContainText('Read this room’s current device roles')
  expect(f.external).toEqual([]); expect(f.sockets).toEqual([])
})
