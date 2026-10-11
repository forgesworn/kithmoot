import { test, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

test('the app exposes witness preparation only in development preview and retains it safely on sign-out', async ({ context, page, baseURL }, info) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const secret = generateSecretKey(), pubkey = getPublicKey(secret), production = info.project.name === 'production'
  await context.exposeFunction('mlsTestPublicKey', () => pubkey)
  await context.exposeFunction('mlsTestSign', (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret))
  await context.addInitScript(() => {
    const host = window as typeof window & { mlsTestPublicKey(): Promise<string>; mlsTestSign(template: unknown): Promise<unknown> }
    Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => host.mlsTestPublicKey(), signEvent: (event: unknown) => host.mlsTestSign(event) } })
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const text = String(url), local = `wss://${location.host}`
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        const target = defaults.includes(text.replace(/\/$/, '')) ? `${local}/__test-relay` : text
        if (!target.startsWith(`${local}/`)) throw new Error('External relay blocked by acceptance test')
        super(target, protocols)
      }
    }
  })
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin ? route.continue() : route.abort())
  const mlsRequests: string[] = []
  page.on('request', request => { if (request.url().includes('/vmls-wasm/')) mlsRequests.push(request.url()) })
  await page.goto(baseURL! + '?signin=nostr')
  await page.getByRole('button', { name: /Browser extension/ }).click()
  await expect(page.locator('#homeSignIn')).toBeHidden()
  await page.locator('#openAppSettings').click(); await page.locator('#appConnections > summary').click()
  if (production) {
    await expect(page.locator('#mlsRoomDevelopmentOpen')).toHaveCount(0)
    await expect(page.locator('#mlsRoomDevelopment')).toHaveCount(0)
    await expect(page.locator('#mlsGrantDevelopmentOpen')).toHaveCount(0)
    await expect(page.locator('#mlsGrantDevelopment')).toHaveCount(0)
    await expect(page.locator('#mlsWitnessSettingsOpen')).toBeHidden()
    await expect(page.locator('#mlsWitnessSettings')).toHaveCount(0)
    expect(mlsRequests).toEqual([])
    expect(pageErrors).toEqual([])
    return
  }
  const initialDatabases = await page.evaluate(() => indexedDB.databases())
  await page.locator('#mlsRoomDevelopmentOpen').click()
  await expect(page.locator('#mlsRoomDevelopment')).toBeVisible()
  await expect(page.locator('#mlsRoomDevelopment [data-account]')).toHaveText(pubkey)
  await expect(page.locator('#mlsRoomDevelopment')).toContainText('Room creation, authenticated invitation joining and message delivery are still held.')
  expect(await page.evaluate(() => indexedDB.databases())).toEqual(initialDatabases)
  expect(mlsRequests).toEqual([])
  await page.locator('#mlsRoomDevelopment [data-close]').click()
  await page.locator('#openAppSettings').click()
  await page.locator('#mlsGrantDevelopmentOpen').click()
  await expect(page.locator('#mlsGrantDevelopment')).toBeVisible()
  await expect(page.locator('#mlsGrantDevelopment [data-account]')).toHaveText(`${pubkey.slice(0, 12)}…`)
  expect((await page.evaluate(() => indexedDB.databases())).some(database => database.name === 'kithmoot-vmls-grants-v1')).toBe(false)
  expect(mlsRequests).toEqual([])
  await page.locator('#mlsGrantDevelopment [data-close]').click()
  await page.locator('#openAppSettings').click()
  await page.locator('#mlsWitnessSettingsOpen').click()
  await expect(page.locator('#mlsWitnessAccount')).toHaveText(pubkey)
  await expect(page.locator('#mlsWitnessPrepare')).toBeVisible()
  expect(mlsRequests).toEqual([])
  await page.locator('#mlsWitnessPrepare').click()
  await expect(page.locator('#mlsWitnessPair')).toBeEnabled()
  expect(mlsRequests).toEqual([])
  await page.locator('#mlsWitnessClose').click(); await page.locator('#openAppSettings').click()
  await page.locator('#forgetBrowser').click()
  await expect(page.locator('#status')).toContainText('Clear MLS keys and complete retirement for every account')
  await expect(page.locator('#actionDialog')).toHaveCount(0)
  await page.locator('#mlsGrantDevelopmentOpen').click()
  await expect(page.locator('#mlsGrantDevelopment')).toBeVisible()
  // Exercise the actual app's external account invalidation while the modal
  // is open; a native click from elsewhere cannot bypass showModal's focus.
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('#signOut')!.click())
  await expect(page.locator('#mlsGrantDevelopment')).not.toBeVisible()
  await expect(page.locator('#mlsGrantDevelopment [data-account]')).toHaveText('')
  await expect(page.locator('#mlsGrantDevelopment [data-status]')).toHaveText('')
  await expect(page.locator('#mlsRoomDevelopment [data-account]')).toHaveText('')
  await expect(page.locator('#mlsRoomDevelopment [data-status]')).toHaveText('')
  await expect(page.locator('#headerSignIn')).toBeVisible()
  await expect(page.locator('#status')).toContainText('Signed out.')
  expect(await page.locator('#mlsWitnessAccount').textContent()).toBe('')
  await page.goto(baseURL! + '?signin=nostr'); await page.getByRole('button', { name: /Browser extension/ }).click()
  await expect(page.locator('#homeSignIn')).toBeHidden()
  await page.locator('#openAppSettings').click(); await page.locator('#appConnections > summary').click(); await page.locator('#mlsRoomDevelopmentOpen').click()
  await page.locator('#mlsRoomDevelopment [data-code]').fill('unsent-private-code')
  await page.locator('#mlsRoomDevelopment [data-relays]').fill('wss://fixture.invalid/link')
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('#signOut')!.click())
  await expect(page.locator('#mlsRoomDevelopment')).not.toBeVisible()
  await expect(page.locator('#mlsRoomDevelopment [data-account]')).toHaveText('')
  await expect(page.locator('#mlsRoomDevelopment [data-status]')).toHaveText('')
  await expect(page.locator('#mlsRoomDevelopment [data-code]')).toHaveValue('')
  await expect(page.locator('#mlsRoomDevelopment [data-relays]')).toHaveValue('')
  expect((await page.evaluate(() => indexedDB.databases())).some(db => db.name?.startsWith('kithmoot-vmls-room-link-v1'))).toBe(false)
  await page.goto(baseURL! + '?signin=nostr'); await page.getByRole('button', { name: /Browser extension/ }).click()
  await expect(page.locator('#homeSignIn')).toBeHidden()
  await page.locator('#openAppSettings').click(); await page.locator('#appConnections > summary').click(); await page.locator('#mlsWitnessSettingsOpen').click()
  await expect(page.locator('#mlsWitnessLocalStatus')).toContainText('Installation prepared locally')
  expect(mlsRequests).toEqual([])
  await page.locator('#mlsWitnessRecovery summary').click(); await page.locator('#mlsWitnessClear').click(); await page.locator('#actionConfirm').click()
  await expect(page.locator('#mlsWitnessPrepare')).toBeVisible()
  await page.locator('#mlsWitnessClose').click(); await page.locator('#openAppSettings').click(); await page.locator('#forgetBrowser').click()
  await expect(page.locator('#actionDialog')).toBeVisible(); await page.locator('#actionConfirm').click()
  await expect(page.locator('#signOut')).toBeHidden()
  expect(pageErrors).toEqual([])
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.') || k.startsWith('signet:login.')))).toEqual([])
})

test('production and preview both refuse forgetting retained room custody', async ({ context, page, baseURL }) => {
  await context.addInitScript(() => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(_url: string | URL, protocols?: string | string[]) { super(`wss://${location.host}/__test-relay`, protocols) }
    }
  })
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin ? route.continue() : route.abort())
  await page.goto(baseURL!)
  await page.evaluate(async () => {
    const open = indexedDB.open('kithmoot-vmls-room-link-v1:names', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
    // Even interrupted naming creation, without a well-formed key, is held.
    db.close()
  })
  await page.locator('#openAppSettings').click()
  await page.locator('#forgetBrowser').click()
  await expect(page.locator('#status')).toContainText('Retained MLS room connection data prevents forgetting this browser')
  await expect(page.locator('#actionDialog')).toHaveCount(0)
  expect((await page.evaluate(() => indexedDB.databases())).some(db => db.name === 'kithmoot-vmls-room-link-v1:names')).toBe(true)
})
