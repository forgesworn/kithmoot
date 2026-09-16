import { test, expect, type Browser } from '@playwright/test'
import { openRoomDetails } from './browser.js'

/** A visitor device: no signer, no Nostr account, only what a name-only
 *  join and a kept room leave in this browser. Trimmed from home.spec.ts's
 *  `device()` - this spec never signs in with Nostr. */
async function device(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by test')
        super(target, protocols)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

test('Forget this browser removes the visitor identity, kept rooms and signer connection, and lands on a fresh front page', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await page.locator('#roomName').fill('A room to forget')
    await page.locator('#roomName').press('Enter')
    await expect(page.locator('#arrivalTitle')).toHaveText('A room to forget')
    await page.locator('#displayName').fill('Ada')
    await page.locator('#displayName').press('Enter')
    await expect(page.locator('#roomArea')).toBeVisible()

    // Stand in for a browser that at some point paired with a bunker: the
    // saved connection is a signet-login key, separate from anything this
    // app writes itself, and Forget this browser has to reach it too.
    await page.evaluate(() => localStorage.setItem('signet:login.clientSk', '11'.repeat(32)))

    const before = await page.evaluate(() => ({
      participant: localStorage.getItem('kithmoot.participant'),
      rooms: Object.keys(localStorage).filter(key => key.startsWith('kithmoot.room.')),
    }))
    expect(before.participant, 'no visitor identity was created').not.toBeNull()
    expect(before.rooms.length, 'the room was never kept').toBeGreaterThan(0)

    // Back to the front page - accountHome, and Forget this browser with it,
    // only ever shows outside a live room.
    await page.goto(baseURL!)
    await expect(page.locator('#forgetBrowser')).toBeVisible()
    await page.locator('#forgetBrowser').click()
    const dialog = page.getByRole('alertdialog', { name: 'Forget this browser?', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Forget this browser', exact: true }).click()

    await expect(page.locator('#home')).toBeVisible()
    // A brand new visitor with nothing kept and no account gets no rooms
    // section at all, not an empty one - see showRoomsList/renderRooms.
    await expect(page.locator('#rooms')).toBeHidden()
    await expect(page.locator('#signIn')).toBeVisible()
    await expect(page.locator('#displayName')).toBeHidden()

    const remaining = await page.evaluate(() => [
      ...Object.keys(localStorage).filter(key => key.startsWith('kithmoot.') || key.startsWith('signet:login.')),
      ...Object.keys(sessionStorage).filter(key => key.startsWith('kithmoot.') || key.startsWith('signet:login.')),
    ])
    expect(remaining, 'kithmoot. or signet-login keys survived Forget this browser').toEqual([])
  } finally { await context.close() }
})

test('Forget this browser, offered from Room details too, refuses while on a call', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await page.locator('#roomName').fill('A room mid-call')
    await page.locator('#roomName').press('Enter')
    await page.locator('#displayName').fill('Ada')
    await page.locator('#displayName').press('Enter')
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#callToggle:visible, #mobileCall:visible').click()
    await expect(page.locator('#deviceControls')).toBeVisible()
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')

    // Room details stays reachable through a live call - that is exactly
    // where this has to refuse rather than silently dropping it.
    await openRoomDetails(page)
    await page.locator('#forgetBrowserRoom').click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('#status')).toContainText('Leave the call before forgetting this browser.')
    await expect(page.locator('#roomArea')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.participant'))).not.toBeNull()
  } finally { await context.close() }
})
