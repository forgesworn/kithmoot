import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const origin = 'https://admin-invitation-journey.kithmoot.test'
let bundle: string, consentBundle: string
test.beforeAll(async () => {
  const options = { bundle: true, write: false, format: 'iife' as const, globalName: 'J',
    define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_BROWSER_MLS_INVITATION_PREVIEW': '"false"',
      'import.meta.env.VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW': '"true"', 'import.meta.env.VITE_MIXED_INVITATION_LAB': '"false"' } }
  bundle = (await build({ entryPoints: ['test/admin-invitation-journey.browser-entry.ts'], ...options })).outputFiles![0]!.text
  consentBundle = (await build({ entryPoints: ['test/admin-invitation-consent.browser-entry.ts'], ...options })).outputFiles![0]!.text
})
async function fixture(context: BrowserContext) {
  const external: string[] = [], sockets: string[] = []
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'self'" }, body: '<script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (path === '/consent.js') return route.fulfill({ contentType: 'text/javascript', body: consentBundle })
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

async function openAdminConsent(context: BrowserContext) {
  const f = await fixture(context)
  await f.page.setViewportSize({ width: 390, height: 844 })
  await f.page.addScriptTag({ url: `${origin}/consent.js` })
  await f.page.evaluate('J.startAdminConsent()')
  const dialog = f.page.locator('#mlsRoomConsent')
  await expect(dialog).toBeVisible()
  expect(await f.page.evaluate('window.adminConsentPending')).toBe(true)
  expect(await f.page.evaluate('window.adminConsentDecision === undefined')).toBe(true)
  const contextJson = await f.page.evaluate('JSON.stringify(window.adminConsentContext, null, 2)') as string
  await expect(dialog.locator('p')).toContainText(contextJson)
  await expect(dialog.locator('p')).toContainText('Only designated admin devices can invite, remove members or change roles. Each role applies to one device leaf. This invitation pins the complete admin policy shown above.')
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(844)
  return { f, dialog }
}

test('real Admin2 consent displays complete scope and stays pending until explicit Deny', async ({ context }) => {
  const { f, dialog } = await openAdminConsent(context)
  await dialog.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await f.page.evaluate('window.adminConsentDecision')).toBe('deny')
  expect(await f.page.evaluate('window.adminConsentPending')).toBe(false)
  expect(f.external).toEqual([]); expect(f.sockets).toEqual([])
})

test('real Admin2 consent displays complete scope and approves only after explicit Allow', async ({ context }) => {
  const { f, dialog } = await openAdminConsent(context)
  await dialog.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await f.page.evaluate('window.adminConsentDecision')).toBe('approve')
  expect(await f.page.evaluate('window.adminConsentPending')).toBe(false)
  expect(f.external).toEqual([]); expect(f.sockets).toEqual([])
})
