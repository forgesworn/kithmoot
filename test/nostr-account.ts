import { openSettings, closeSettings } from './browser.js'
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'

/** A test NIP-07 provider: signing keys stay in Node, never in the app. */
export async function accountDevice(browser: Browser, baseURL: string, secret = generateSecretKey(), nip44 = true, beforePublicKey = async () => {},
  nip04?: { decrypt(peer: string, ciphertext: string): Promise<string>; encrypt(peer: string, text: string): Promise<string> },
  effects?: { encrypt(peer: string, text: string): Promise<string>; sign(template: EventTemplate): Promise<Event> },
  receiving?: { started?(peer: string, ciphertext: string): void; decrypt?(peer: string, ciphertext: string): Promise<string> }): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const pubkey = getPublicKey(secret)
  await context.exposeFunction('testPublicKey', async () => { await beforePublicKey(); return pubkey })
  await context.exposeFunction('testSign', (template: EventTemplate) => effects ? effects.sign(template) : finalizeEvent(template, secret))
  await context.exposeFunction('testEncrypt', (peer: string, plaintext: string) => effects ? effects.encrypt(peer, plaintext) : encrypt(plaintext, getConversationKey(secret, peer)))
  await context.exposeFunction('testDecrypt', (peer: string, ciphertext: string) => {
    // Observe invocation before key derivation/decryption, including refusals.
    // Optional delays substitute only this declared synthetic provider.
    receiving?.started?.(peer, ciphertext)
    return receiving?.decrypt ? receiving.decrypt(peer, ciphertext) : decrypt(ciphertext, getConversationKey(secret, peer))
  })
  if (nip04) {
    await context.exposeFunction('testLegacyDecrypt', (peer: string, ciphertext: string) => nip04.decrypt(peer, ciphertext))
    await context.exposeFunction('testLegacyEncrypt', (peer: string, text: string) => nip04.encrypt(peer, text))
  }
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(({ relay, nip44, nip04 }) => {
    const testWindow = window as typeof window & {
      testPublicKey(): Promise<string>; testSign(template: unknown): Promise<unknown>;
      testEncrypt(peer: string, text: string): Promise<string>; testDecrypt(peer: string, text: string): Promise<string>;
      testLegacyEncrypt(peer: string, text: string): Promise<string>; testLegacyDecrypt(peer: string, text: string): Promise<string>;
      testLegacyCompletions?: number;
      testMessageEncryptCompletions?: number; testMessageSealCompletions?: number;
      testMessageEncryptResults?: string[]; testMessageSealResults?: string[];
    }
    Object.defineProperty(window, 'nostr', { configurable: true, value: {
      getPublicKey: () => testWindow.testPublicKey(),
      signEvent: async (event: unknown) => {
        try {
          const result = await testWindow.testSign(event)
          if ((event as { kind?: number }).kind === 13) (testWindow.testMessageSealResults ??= []).push((result as { id: string }).id)
          return result
        }
        finally { if ((event as { kind?: number }).kind === 13) testWindow.testMessageSealCompletions = (testWindow.testMessageSealCompletions ?? 0) + 1 }
      },
      ...(nip04 ? { nip04: {
        encrypt: (peer: string, text: string) => testWindow.testLegacyEncrypt(peer, text),
        decrypt: async (peer: string, text: string) => {
          try { return await testWindow.testLegacyDecrypt(peer, text) }
          finally { testWindow.testLegacyCompletions = (testWindow.testLegacyCompletions ?? 0) + 1 }
        },
      } } : {}),
      ...(nip44 ? { nip44: {
        encrypt: async (peer: string, text: string) => {
          try {
            const result = await testWindow.testEncrypt(peer, text)
            ;(testWindow.testMessageEncryptResults ??= []).push(result)
            return result
          }
          finally { testWindow.testMessageEncryptCompletions = (testWindow.testMessageEncryptCompletions ?? 0) + 1 }
        },
        decrypt: (peer: string, text: string) => testWindow.testDecrypt(peer, text),
      } } : {}),
    } })
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev', 'wss://relay.ditto.pub']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by acceptance test')
        super(defaults.includes(String(url).replace(/\/$/, '')) ? relay : url, protocols)
      }
    }
  }, { relay: relay.href, nip44, nip04: !!nip04 })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

/** Choose the fixture through the real relay controls before signing in.
 *  A loopback-only run must not depend on public defaults being redirected. */
export async function configureAccountTestRelay(page: Page, baseURL: string): Promise<void> {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await page.goto(baseURL)
  await expect(page.locator('html[data-ordinary-startup=ready]')).toBeVisible()
  await openSettings(page, 'Connections')
  await page.locator('#defaultRelaySettings').click()
  await page.locator('#relayScope').selectOption('default')
  const remove = page.locator('#relayList button[aria-label^="Remove "]')
  for (let n = 0; n < 64 && await remove.count(); n++) await remove.first().click()
  await expect(remove).toHaveCount(0)
  await page.locator('#relayUrl').fill(relay.href)
  await page.locator('#relayAddForm button[type=submit]').click()
  await page.locator('#relaySave').click()
  await page.locator('#relaySettingsClose').click()
  await closeSettings(page)
}

export async function signInAccount(page: Page, baseURL: string) {
  await page.goto(baseURL + '?signin=nostr')
  await page.getByRole('button', { name: /Browser extension/ }).click()
  // Signed in and nothing found yet: the "Already on Nostr?" line is gone
  // now that signing in is done, and Settings is where Sign out lives now.
  await expect(page.locator('#homeSignIn')).toBeHidden()
  await openSettings(page, 'Account')
  await expect(page.locator('#signOut')).toBeVisible()
  await closeSettings(page)
}

