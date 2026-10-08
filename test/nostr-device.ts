import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
/** A test NIP-07 provider: signing keys stay in Node, never in the app. */
export async function nostrTestDevice(browser: Browser, baseURL: string, secret = generateSecretKey(), nip44 = true, beforePublicKey = async () => {}): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const pubkey = getPublicKey(secret)
  await context.exposeFunction('testPublicKey', async () => { await beforePublicKey(); return pubkey })
  await context.exposeFunction('testSign', (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret))
  await context.exposeFunction('testEncrypt', (peer: string, plaintext: string) => encrypt(plaintext, getConversationKey(secret, peer)))
  await context.exposeFunction('testDecrypt', (peer: string, ciphertext: string) => decrypt(ciphertext, getConversationKey(secret, peer)))
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(({ relay, nip44 }) => {
    const testWindow = window as typeof window & {
      testPublicKey(): Promise<string>; testSign(template: unknown): Promise<unknown>;
      testEncrypt(peer: string, text: string): Promise<string>; testDecrypt(peer: string, text: string): Promise<string>;
    }
    Object.defineProperty(window, 'nostr', { configurable: true, value: {
      getPublicKey: () => testWindow.testPublicKey(),
      signEvent: (event: unknown) => testWindow.testSign(event),
      ...(nip44 ? { nip44: {
        encrypt: (peer: string, text: string) => testWindow.testEncrypt(peer, text),
        decrypt: (peer: string, text: string) => testWindow.testDecrypt(peer, text),
      } } : {}),
    } })
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by acceptance test')
        super(defaults.includes(String(url).replace(/\/$/, '')) ? relay : url, protocols)
      }
    }
  }, { relay: relay.href, nip44 })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

export async function signInNostrTestDevice(page: Page, baseURL: string) {
  await page.goto(baseURL + '?signin=nostr')
  await page.getByRole('button', { name: /Browser extension/ }).click()
  // Signed in and nothing found yet: the "Already on Nostr?" line is gone
  // now that signing in is done, and Settings is where Sign out lives now.
  await expect(page.locator('#homeSignIn')).toBeHidden()
  await page.locator('#openAppSettings').click()
  await expect(page.locator('#signOut')).toBeVisible()
  await page.locator('#appSettingsClose').click()
}

