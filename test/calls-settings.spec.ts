import { test, expect, type Page } from '@playwright/test'
import { newDeviceContext, openCallSettings, openSettings } from './browser.js'
import { testRelays } from './relays.js'

/**
 * Settings › Calls and Settings › Relays (design-connections-calls, 12.1):
 * the list, the summary and the rows it explains, Back and its focus, the
 * relay server form, the STUN status, and the rule that only the Public call
 * relays page asks any Nostr relay for adverts.
 */

const FRESH_BODY = 'Calls connect device to device. Some networks block that, so a call may not connect. Set up a relay below to carry those calls.'
const SERVER = { 'kithmoot.call-relay.v1': JSON.stringify({ urls: ['turn:relay.example.org:3478'], username: 'user', credential: 'password' }) }

async function visit(browser: Parameters<typeof newDeviceContext>[0], baseURL: string, storage: Record<string, string> = {}, viewport = { width: 1280, height: 860 }): Promise<{ close(): Promise<void>; page: Page }> {
  test.skip(!testRelays()?.length, 'needs the offline test relay')
  const context = await newDeviceContext(browser, baseURL, { viewport })
  await context.addInitScript(items => { for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value) }, storage)
  const page = await context.newPage()
  await page.goto(baseURL)
  await expect(page.locator('#openAppSettings')).toBeVisible({ timeout: 30_000 })
  return { page, close: () => context.close() }
}

test('the list has Calls after Messages and Relays where Connections was, and a fresh device says Direct only', async ({ browser, baseURL }) => {
  const { page, close } = await visit(browser, baseURL!)
  try {
    await openSettings(page)
    await expect(page.locator('#settingsPane [data-settings-page="main"] .infoRowTitle')).toHaveText(['Account', 'Profile', 'Notifications', 'Messages', 'Calls', 'Display', 'Privacy', 'Relays', 'Keyboard shortcuts', 'About and help'])
    await expect(page.getByRole('button', { name: /Connections/ })).toHaveCount(0)
    await expect(page.locator('#settingsSubcalls')).toHaveText('Direct only')
    await openSettings(page, 'Calls')
    await expect(page.locator('#callsHead')).toHaveText('Direct only')
    await expect(page.locator('#callsBody')).toHaveText(FRESH_BODY)
    // A browser has no built-in relay: three rows, in order.
    const rows = page.locator('[data-settings-page="calls"] .infoRows > button:not([hidden]) .infoRowTitle')
    await expect(rows).toHaveText(['Your Spry node', 'Relay server', 'Public call relays', 'Advanced'])
    await expect(page.locator('#callsSubSpry')).toHaveText('Not paired')
    await expect(page.locator('#callsSubServer')).toHaveText('Not set up')
    await expect(page.locator('#callsSubPublic')).toHaveText('Off')
    await expect(page.locator('#callsSubAdvanced')).toHaveText('STUN server: Cloudflare')
    await expect(page.locator('#callsHead')).toHaveAttribute('aria-live', 'polite')
    // No bordered boxes from the old page: the only fieldsets are Display's and Where files go.
    const fieldsets = await page.evaluate(() => ({
      all: document.querySelectorAll('#settingsPane fieldset').length,
      others: document.querySelectorAll('#settingsPane [data-settings-page="display"] fieldset, #settingsPane [data-settings-page="files"] fieldset').length,
    }))
    expect(fieldsets.all).toBe(fieldsets.others)
  } finally { await close() }
})

test('the same three rows on a phone', async ({ browser, baseURL }) => {
  const { page, close } = await visit(browser, baseURL!, {}, { width: 390, height: 844 })
  try {
    await openSettings(page, 'Calls')
    await expect(page.locator('[data-settings-page="calls"] .infoRows > button:not([hidden]) .infoRowTitle')).toHaveText(['Your Spry node', 'Relay server', 'Public call relays', 'Advanced'])
    await expect(page.locator('#settingsRowCallRelay')).toBeHidden()
  } finally { await close() }
})

test('a saved relay server names itself, outranks public relays, and is removed only after asking', async ({ browser, baseURL }) => {
  const { page, close } = await visit(browser, baseURL!)
  try {
    await openCallSettings(page, 'Relay server')
    const urls = page.getByLabel('Addresses', { exact: true })
    await expect(urls).not.toHaveAttribute('placeholder', /.+/)
    await expect(page.locator('#callRelayRemove')).toBeHidden()
    // An invalid address is marked and the parser's words sit beside the field.
    await urls.fill('relay.example.org')
    await page.getByLabel('Username', { exact: true }).fill('user')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(urls).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#callRelayFieldError')).toContainText('Use turn:host:3478 or turns:host:5349')
    await expect(urls).toHaveAccessibleDescription(/They start with turn: or turns:\./)
    await urls.fill('turn:relay.example.org:3478')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(urls).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#callRelayStatus')).toHaveText('Saved. Leave and reopen a room to use it.')
    await expect(page.locator('#callRelayHead')).toHaveText('Set up: relay.example.org')

    await page.locator('#settingsBack').click()
    await expect(page.locator('#callsHead')).toHaveText('Direct, or through your relay server')
    await expect(page.locator('#callsSubServer')).toHaveText('Set up · relay.example.org')
    await expect(page.locator('#settingsSubcalls')).toHaveText('Direct, or through your relay server')

    // Public relays on, with a relay of your own: not used.
    await page.locator('#callsRowPublic').click()
    await page.getByLabel('Find public call relays on my Nostr relays').check()
    await expect(page.locator('#publicRelaysBlocked')).toHaveText("You have your own relay, so public call relays aren't looked up.")
    await page.locator('#settingsBack').click()
    await expect(page.locator('#callsSubPublic')).toHaveText('On · not used: you have your own relay')

    await page.locator('#callsRowServer').click()
    await page.getByRole('button', { name: 'Remove…', exact: true }).click()
    await expect(page.locator('#actionDialog')).toContainText('Remove this relay server?')
    await page.locator('#actionCancel').click()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.call-relay.v1'))).not.toBeNull()
    await page.getByRole('button', { name: 'Remove…', exact: true }).click()
    await page.locator('#actionConfirm').click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('kithmoot.call-relay.v1'))).toBeNull()
    await page.locator('#settingsBack').click()
    await expect(page.locator('#callsSubServer')).toHaveText('Not set up')
  } finally { await close() }
})

test('only the Public call relays page asks Nostr relays for adverts', async ({ browser, baseURL }) => {
  const { page, close } = await visit(browser, baseURL!, { 'kithmoot.public-call-relays.v1': JSON.stringify({ v: 1, on: true }) })
  try {
    let lookups = 0
    page.on('websocket', socket => socket.on('framesent', frame => {
      const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString()
      if (text.startsWith('["REQ"') && text.includes('31478')) lookups++
    }))
    await openSettings(page, 'Calls')
    await expect(page.locator('#callsSubPublic')).toHaveText('On · none chosen')
    await page.waitForTimeout(3000)
    expect(lookups).toBe(0)
    await page.locator('#callsRowPublic').click()
    await expect.poll(() => lookups, { timeout: 10_000 }).toBe(1)
    await page.waitForTimeout(1500)
    expect(lookups).toBe(1)
  } finally { await close() }
})

test('Back from each page under Calls lands on Calls with focus on the row, and Back from Calls on the list', async ({ browser, baseURL }) => {
  const { page, close } = await visit(browser, baseURL!)
  try {
    for (const [row, title] of [['callsRowSpry', 'Your Spry node'], ['callsRowServer', 'Relay server'], ['callsRowPublic', 'Public call relays'], ['callsRowAdvanced', 'Advanced']] as const) {
      await openSettings(page, 'Calls')
      await page.locator(`#${row}`).click()
      await expect(page.locator('#settingsTitle')).toHaveText(title)
      await expect(page.locator('#settingsTitle')).toBeFocused()
      await page.locator('#settingsBack').click()
      await expect(page.locator('#settingsTitle')).toHaveText('Calls')
      await expect(page.locator(`#${row}`)).toBeFocused()
    }
    await page.locator('#settingsBack').click()
    await expect(page.locator('#settingsTitle')).toHaveText('Settings')
    await expect(page.locator('#settingsRowcalls')).toBeFocused()
  } finally { await close() }
})

test('Advanced reports which STUN server is used, and the Calls row follows', async ({ browser, baseURL }) => {
  const { page, close } = await visit(browser, baseURL!)
  try {
    await openCallSettings(page, 'Advanced')
    await expect(page.locator('#callStunStatus')).toHaveText("Using Cloudflare's public STUN server.")
    const field = page.getByLabel('Your STUN server')
    await field.fill('stun:stun.example.org:3478')
    await field.press('Enter')
    await expect(page.locator('#callStunStatus')).toHaveText('Using your STUN server: stun.example.org.')
    await page.locator('#settingsBack').click()
    await expect(page.locator('#callsSubAdvanced')).toHaveText('STUN server: stun.example.org')
  } finally { await close() }
})

test('Privacy keeps a row for Hide my IP that opens Calls with the checkbox focused', async ({ browser, baseURL }) => {
  const { page, close } = await visit(browser, baseURL!, SERVER)
  try {
    await openSettings(page, 'Privacy')
    await expect(page.locator('#privacyHideIpState')).toHaveText('Off')
    await page.locator('#privacyHideIpRow').click()
    await expect(page.locator('#settingsTitle')).toHaveText('Calls')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('privacyHideIp')
    await page.locator('#privacyHideIp').check()
    await expect(page.locator('#callsHead')).toHaveText('Always through your relay server')
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.hide-ip.v1'))).toBe('1')
  } finally { await close() }
})
