import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

/**
 * A minimal NIP-07 device: enough to reach a signed-in account without a
 * real signer or public relay traffic. Trimmed from nostr-rooms.spec.ts's
 * `device()` - this spec never joins a room or exercises NIP-44, so it
 * skips both.
 */
async function device(browser: Browser, baseURL: string, secret = generateSecretKey()): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  const pubkey = getPublicKey(secret)
  await context.exposeFunction('testPublicKey', () => pubkey)
  await context.exposeFunction('testSign', (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret))
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(({ relay }) => {
    const testWindow = window as typeof window & { testPublicKey(): Promise<string>; testSign(template: unknown): Promise<unknown> }
    Object.defineProperty(window, 'nostr', { configurable: true, value: {
      getPublicKey: () => testWindow.testPublicKey(),
      signEvent: (event: unknown) => testWindow.testSign(event),
    } })
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by acceptance test')
        super(defaults.includes(String(url).replace(/\/$/, '')) ? relay : url, protocols)
      }
    }
  }, { relay: relay.href })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

// signet-login's own storage keys (node_modules/signet-login/src/types.ts,
// STORAGE_KEYS). Not re-exported from the package's main entry, so named
// literally here - the same way app/src/main.ts already reads
// 'signet:login.pubkey' and 'signet:login.method' directly.
const SIGNET_LOGIN_KEYS = [
  'signet:login.pubkey',
  'signet:login.method',
  'signet:login.authEvent',
  'signet:login.bunkerUri',
  'signet:login.bunkerClientSk',
  'signet:login.clientSk',
  'signet:login.expiresAt',
  'signet:login.displayName',
]

test('signing out forgets this browser\'s persistent bunker client key and bunker URI', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#signOut')).toBeVisible()

    // Stand in for a browser that, at some earlier login, paired with a
    // bunker: signet-login's logout() keeps these by design (its own
    // comment near storage.ts:187) unless told otherwise, so seed them
    // here rather than driving a full nostrconnect handshake just to prove
    // the same clearing behaviour.
    await page.evaluate(() => {
      localStorage.setItem('signet:login.bunkerUri', 'bunker://' + '11'.repeat(32) + '?relay=wss%3A%2F%2Frelay.example')
      localStorage.setItem('signet:login.bunkerClientSk', '22'.repeat(32))
      localStorage.setItem('signet:login.clientSk', '33'.repeat(32))
    })

    await page.locator('#signOut').click()
    await expect(page.locator('#signIn')).toBeVisible()
    await expect(page.locator('#status')).toContainText('forgets this browser')

    const remaining = await page.evaluate(
      keys => keys.filter(key => localStorage.getItem(key) !== null),
      SIGNET_LOGIN_KEYS,
    )
    expect(remaining, 'signet-login keys survived sign-out').toEqual([])
  } finally { await context.close() }
})
