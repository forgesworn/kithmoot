import { test, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { openSettings } from './browser.js'
import { TEST_RELAY_WS } from './relays.js'

function pairingHash() {
  return '#spry=' + Buffer.from(JSON.stringify({ v: 1, endpoint: 'https://relay.example:3744', code: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 180 })).toString('base64url')
}

test('a browser retains an unclaimed native pairing and offers a local phone QR', async ({ page, context, baseURL, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard inspection is a Chromium fixture; the device chooser is covered separately in Safari.')
  const hash = pairingHash()
  let claims = 0
  await page.route('https://relay.example:3744/**', route => { claims++; return route.abort() })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(baseURL! + hash)
  const dialog = page.getByRole('dialog', { name: 'Where do you want to pair Spry?' })
  await expect(dialog).toBeVisible()
  await expect(page).not.toHaveURL(/#spry=/)
  await expect(dialog.getByRole('button', { name: 'Open KithMoot app', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Pair Android phone', exact: true }).click()
  const canvas = dialog.getByLabel('Spry pairing QR code for Android')
  await expect(canvas).toBeVisible()
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0)
  await dialog.getByRole('button', { name: 'Copy phone pairing link', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('kithmoot://join' + hash)
  expect(await page.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeNull()
  expect(claims).toBe(0)
  await page.setViewportSize({ width: 360, height: 800 })
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(claims).toBe(0)
})

test('the device chooser offers an app and phone QR without claiming in the browser', async ({ page, baseURL }) => {
  let claims = 0
  await page.route('https://relay.example:3744/**', route => { claims++; return route.abort() })
  await page.goto(baseURL! + pairingHash())
  const dialog = page.getByRole('dialog', { name: 'Where do you want to pair Spry?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Open KithMoot app', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Pair Android phone', exact: true }).click()
  await expect(dialog.getByLabel('Spry pairing QR code for Android')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(claims).toBe(0)
})

test('pairing one signed-in browser follows the account and unpairing reaches another device', async ({ browser, baseURL }) => {
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  const contexts = []
  async function device() {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    contexts.push(context)
    await context.exposeFunction('__sprySign', (event: EventTemplate) => finalizeEvent(event, secret))
    await context.exposeFunction('__spryEncrypt', (peer: string, text: string) => encrypt(text, getConversationKey(secret, peer)))
    await context.exposeFunction('__spryDecrypt', (peer: string, text: string) => decrypt(text, getConversationKey(secret, peer)))
    await context.addInitScript(({ pubkey, relay }) => {
      localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }))
      const fixture = window as unknown as { nostr: unknown; __sprySign: (event: unknown) => Promise<unknown>; __spryEncrypt: (peer: string, text: string) => Promise<string>; __spryDecrypt: (peer: string, text: string) => Promise<string> }
      fixture.nostr = { getPublicKey: async () => pubkey, getRelays: async () => ({ [relay]: { read: true, write: true } }),
        signEvent: (event: unknown) => fixture.__sprySign(event), nip44: { encrypt: fixture.__spryEncrypt, decrypt: fixture.__spryDecrypt } }
    }, { pubkey, relay: TEST_RELAY_WS })
    await context.routeWebSocket('**', socket => {
      if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(socket.url()).hostname)) socket.connectToServer()
      else socket.close()
    })
    return context
  }
  try {
    const a = await (await device()).newPage()
    let claims = 0, revocations = 0
    await a.route('https://relay.example:3744/**', async route => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization,content-type' }
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
      if (route.request().url().endsWith('/v1/pairings/claim')) {
        claims++
        return route.fulfill({ headers, json: { version: 1, endpoint: 'https://relay.example:3744', id: 'b'.repeat(43) } })
      }
      if (route.request().url().endsWith('/v1/pairings/remove-self')) {
        revocations++
        return route.fulfill({ headers, json: { removed: true } })
      }
      throw new Error('Unexpected fixture request')
    })
    await a.goto(baseURL! + '?signin=nostr' + pairingHash())
    await a.getByRole('button', { name: 'Pair this Nostr account', exact: true }).click()
    await expect.poll(() => a.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeTruthy()
    const b = await (await device()).newPage()
    await b.goto(baseURL! + '?signin=nostr')
    await expect.poll(() => b.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeTruthy()
    const [first, second] = await Promise.all([a, b].map(page => page.evaluate(() => JSON.parse(localStorage.getItem('kithmoot.spry-pairing.v1')!))))
    expect(second).toEqual(first)
    expect(second.participant).toBe(pubkey)
    expect(claims).toBe(1)
    await openSettings(a, 'Connections')
    await a.locator('#spryPairingRemove').click()
    await a.getByRole('alertdialog', { name: 'Unpair Spry for your account?' }).getByRole('button', { name: 'Unpair Spry', exact: true }).click()
    await expect.poll(() => b.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeNull()
    expect(revocations).toBe(1)
  } finally { for (const context of contexts) await context.close() }
})

test('pairing this browser requires the explicit browser choice', async ({ page, baseURL }) => {
  let claims = 0
  await page.route('https://relay.example:3744/**', async route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization,content-type' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    expect(route.request().postDataJSON().code).toBe('a'.repeat(43))
    claims++
    await route.fulfill({ headers, json: { version: 1, endpoint: 'https://relay.example:3744', id: 'b'.repeat(43) } })
  })
  await page.goto(baseURL! + pairingHash())
  const dialog = page.getByRole('dialog', { name: 'Where do you want to pair Spry?' })
  await expect(dialog).toBeVisible()
  expect(claims).toBe(0)
  await dialog.getByRole('button', { name: 'Pair this browser', exact: true }).click()
  await expect.poll(() => claims).toBe(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeTruthy()
})
