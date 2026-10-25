import { test, expect, type BrowserContext } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const origin = 'https://invitation-profile-journey.kithmoot.test'
let bundle: string
test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['test/invitation-profile-journey.browser-entry.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'J', define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'true',
      'import.meta.env.VITE_BROWSER_MLS_INVITATION_PREVIEW': '"true"',
      'import.meta.env.VITE_MIXED_INVITATION_LAB': '"false"' } })).outputFiles[0].text
})
async function fixture(context: BrowserContext) {
  const publicRequests: string[] = []
  const webSockets: string[] = []
  await context.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html',
      headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'self' wss://positive-observer.kithmoot.test" },
      body: '<script src="/fixture.js"></script>' })
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (/^\/vmls-wasm(?:-invitation)?\/(?:manifest\.json|vmls_wasm\.js|vmls_wasm_bg\.wasm)$/.test(path))
      return route.fulfill({ contentType: path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.json') ? 'application/json' : 'text/javascript', body: readFileSync('app/public' + path) })
    return route.abort()
  })
  await context.routeWebSocket('wss://positive-observer.kithmoot.test/**', socket => socket.close())
  const page = await context.newPage()
  page.on('request', request => { if (!request.url().startsWith(origin + '/') && !request.url().startsWith('blob:')) publicRequests.push(request.url()) })
  page.on('websocket', socket => webSockets.push(socket.url()))
  await page.goto(origin)
  await page.evaluate(() => {
    const calls: string[] = []
    ;(globalThis as any).__invitationSocketAttempts = calls
    globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
      construct(target, args, receiver) { calls.push(String(args[0])); return Reflect.construct(target, args, receiver) },
    })
  })
  return { page, publicRequests, webSockets, socketAttempts: () => page.evaluate('globalThis.__invitationSocketAttempts.slice()') as Promise<string[]> }
}
test('actual protected app/WASM journey supports trusted restart, exact response and guest removal of creator', async ({ context }) => {
  const f = await fixture(context)
  const result = await f.page.evaluate('J.lifecycle()') as any
  expect(result).toMatchObject({ forward: true, backward: true, exactRetry: true, removedPhase: 'Removed', survivorPhase: 'Active', survivorReceived: true })
  expect(result.stats.packagesBy.length).toBeGreaterThanOrEqual(2)
  expect(result.stats.packagesBy.every((actor: string) => actor === 'alice')).toBe(true)
  expect(f.publicRequests).toEqual([]); expect(await f.socketAttempts()).toEqual([])
  await f.page.evaluate("new WebSocket('wss://positive-observer.kithmoot.test/check')")
  await expect.poll(async () => (await f.socketAttempts()).length).toBe(1)
})
test('retained pending Add blocks reuse of its package after removal and issuer restart', async ({ context }) => {
  const f = await fixture(context)
  const result = await f.page.evaluate('J.retainedPendingAddReplay()') as any
  expect(result).toMatchObject({ replayState: 'refused', before: 1, after: 1, snapshotVersion: 4, bobPhase: 'Removed' })
  expect(result.replayReason).toBe('pending-add-full')
  expect(f.publicRequests).toEqual([]); expect(await f.socketAttempts()).toEqual([])
})
test('independent trusted inviter mismatch refuses before adopting a second session', async ({ context }) => {
  const f = await fixture(context)
  const result = await f.page.evaluate('J.wrongInviter()') as any
  expect(result).toMatchObject({ sameSession: true, sameProtectedSessionCount: true })
  expect(result.state).not.toBe('active')
  expect(f.publicRequests).toEqual([]); expect(await f.socketAttempts()).toEqual([])
})
test('actual loss of the local continuity marker holds the surviving protected room', async ({ context }) => {
  const f = await fixture(context)
  expect((await f.page.evaluate('J.lostLocalContinuity()') as any).state).not.toBe('active')
  expect(f.publicRequests).toEqual([]); expect(await f.socketAttempts()).toEqual([])
})

test('missing or forged node registration cannot mutate membership; a verified receipt enables member Add', async ({ context }) => {
  const f = await fixture(context)
  const result = await f.page.evaluate('J.missingAndForgedRegistration()') as any
  expect(result.unsignedState).not.toBe('ok')
  expect(result).toMatchObject({ missingState: 'refused', forgedState: 'refused', membersBeforeValid: 1, validState: 'active' })
  expect(f.publicRequests).toEqual([]); expect(await f.socketAttempts()).toEqual([])
})

test('lost reply at the exact durable adoption boundary recovers one session and its unchanged response', async ({ context }) => {
  const f = await fixture(context)
  const result = await f.page.evaluate('J.adoptionReplyLoss()') as any
  expect(result).toMatchObject({ injected: true, witnessAdvanced: true, sameCandidateSession: true, sessions: 1, exactResponse: true })
  expect(result.firstState).not.toBe('active')
  expect(f.publicRequests).toEqual([]); expect(await f.socketAttempts()).toEqual([])
})
test('actual development panel keeps trusted inviter independent, guards accountless actions and clears private fields', async ({ context }) => {
  const f = await fixture(context); await f.page.evaluate('J.openRealPanel()')
  await expect(f.page.locator('[data-invitation-controls]')).toBeVisible()
  for (const key of ['private-invitation','private-response','private-registration','registration-receipt'])
    await f.page.locator('[data-' + key + ']').fill('AA==')
  await expect(f.page.locator('[data-expected-inviter]')).toHaveValue('')
  await f.page.evaluate(() => {
    for (const key of ['invite-route','invite-room']) {
      const select = document.querySelector('[data-' + key + ']') as HTMLSelectElement
      select.add(new Option('Synthetic fixture selection', key === 'invite-route' ? 'fixture-route' : '11'.repeat(32))); select.selectedIndex = 1
    }
    for (const key of ['target-persona','target-device','target-rz','target-home','remove-leaf'])
      (document.querySelector('[data-' + key + ']') as HTMLInputElement).value = '22'.repeat(32)
  })
  await expect(f.page.locator('[data-invite-hours]')).toHaveValue('6')
  await expect(f.page.locator('[data-invite-hours]')).toHaveAttribute('min', '2')
  await f.page.locator('[data-invite-hours]').fill('1')
  await f.page.locator('[data-issue-invitation]').click()
  await expect(f.page.locator('[data-status]')).toContainText('Joining needs more than one hour remaining')
  await f.page.locator('[data-invite-hours]').fill('6')
  for (const key of ['read-invitation-room','issue-invitation','export-invitation','recover-response','update-invitation-room','send-invitation-room','remove-invitation-member']) {
    await f.page.locator('[data-' + key + ']').click()
    await expect(f.page.locator('[data-status]')).toContainText('Reopen')
  }
  await f.page.evaluate('J.clearRealPanel()')
  for (const key of ['private-invitation','private-response','private-registration','registration-receipt'])
    await expect(f.page.locator('[data-' + key + ']')).toHaveValue('')
  expect(f.publicRequests).toEqual([]); expect(await f.socketAttempts()).toEqual([])
})
