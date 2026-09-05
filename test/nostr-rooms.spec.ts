import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'

/** A test NIP-07 provider: signing keys stay in Node, never in the app. */
async function device(browser: Browser, baseURL: string, secret = generateSecretKey(), nip44 = true): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const pubkey = getPublicKey(secret)
  await context.exposeFunction('testPublicKey', () => pubkey)
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
        const defaults = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by acceptance test')
        super(defaults.includes(String(url).replace(/\/$/, '')) ? relay : url, protocols)
      }
    }
  }, { relay: relay.href, nip44 })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

async function signIn(page: Page, baseURL: string) {
  await page.goto(baseURL + '?signin=nostr')
  await page.getByRole('button', { name: /Browser extension/ }).click()
  await expect(page.locator('#signOut')).toBeVisible()
  await expect(page.locator('#roomsEmpty')).toBeVisible()
}

test('Nostr rooms follow the identity across browsers; direct-link visitors need no sign-in', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const first = await device(browser, baseURL!, secret)
  const second = await device(browser, baseURL!, secret)
  const visitor = await device(browser, baseURL!)
  try {
    const owner = await first.newPage()
    await signIn(owner, baseURL!)
    await owner.locator('#roomName').fill('Standing town hall')
    await owner.locator('#create').click()
    await expect(owner.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    const link = await owner.locator('#shareUrl').inputValue()
    // Keep the inviter online while the other device opens its bookmark.
    const home = await first.newPage()
    await home.goto(baseURL!)
    await expect(home.locator('#roomList .roomName')).toHaveText('Standing town hall')
    await expect(home.locator('#signIn')).toBeHidden()
    await home.screenshot({ path: '/tmp/kithmoot-nostr-home.png', fullPage: true })

    const returning = await second.newPage()
    await returning.goto(baseURL! + '?signin=nostr')
    await returning.getByRole('button', { name: /Browser extension/ }).click()
    await expect(returning.locator('#roomList .roomName')).toHaveText('Standing town hall')
    await returning.locator('#roomList').getByRole('button', { name: 'Open Standing town hall', exact: true }).click()
    await expect(returning.locator('#join')).toBeVisible()
    await expect(returning.locator('#roomTitle')).toHaveText('Standing town hall')
    await expect(returning.locator('#whoami')).toContainText(getPublicKey(secret).slice(0, 8))

    const guest = await visitor.newPage()
    await guest.goto(link)
    await expect(guest.locator('#join')).toBeVisible()
    await expect(guest.locator('#signIn')).toBeHidden() // optional disclosure stays closed
    await guest.locator('#displayName').fill('Visiting Ada')
    await guest.locator('#join').click()
    await expect(guest.locator('#roomArea')).toBeVisible()
    await expect(guest.locator('#whoami')).toContainText('Visiting Ada')

    await returning.locator('#doorToRooms').click()
    await returning.locator('#roomSwitcherHome').click()
    await expect(returning.locator('#roomList .roomName')).toHaveText('Standing town hall')
    await returning.locator('#signOut').click()
    await expect(returning.locator('#roomList .roomRow')).toHaveCount(0)
    await expect(returning.locator('#backToRoom')).toBeHidden()
    await expect(returning.locator('#signIn')).toBeVisible()
  } finally { await first.close(); await second.close(); await visitor.close() }
})

test('forgetting an account bookmark removes it on the other signed-in device', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const a = await device(browser, baseURL!, secret)
  const b = await device(browser, baseURL!, secret)
  try {
    const creator = await a.newPage()
    await signIn(creator, baseURL!)
    await creator.locator('#roomName').fill('A room to forget')
    await creator.locator('#create').click()
    await expect(creator.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    await creator.locator('#doorToRooms').click()
    await creator.locator('#roomSwitcherHome').click()
    const other = await b.newPage()
    await other.goto(baseURL! + '?signin=nostr')
    await other.getByRole('button', { name: /Browser extension/ }).click()
    await expect(other.locator('#roomList .roomRow')).toHaveCount(1)
    creator.on('dialog', dialog => dialog.accept())
    await creator.locator('#roomList').getByRole('button', { name: 'Forget A room to forget', exact: true }).click()
    await expect(creator.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    await expect(other.locator('#roomList .roomRow')).toHaveCount(0)
    await other.reload()
    await expect(other.locator('#signOut')).toBeVisible()
    await expect(other.locator('#roomList .roomRow')).toHaveCount(0)
  } finally { await a.close(); await b.close() }
})

test('a signer without encryption gets honest local-only rooms, and no private-key input', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!, generateSecretKey(), false)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await page.locator('#signIn').click()
    await expect(page.getByText('Paste private key', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#roomSyncStatus')).toContainText('browser only')
    await page.locator('#roomName').fill('Local account room')
    await page.locator('#create').click()
    await expect(page.locator('#roomSyncStatus')).toContainText('browser only')
    await page.locator('#doorToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#roomList .roomName')).toHaveText('Local account room')
  } finally { await context.close() }
})

test('existing browser rooms are imported only after explicit confirmation', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const a = await device(browser, baseURL!, secret)
  const b = await device(browser, baseURL!, secret)
  try {
    const page = await a.newPage()
    await page.goto(baseURL!)
    await page.locator('#roomName').fill('A browser shortcut')
    await page.locator('#create').click()
    await page.locator('#doorToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#roomList .roomName')).toHaveText('A browser shortcut')
    await page.locator('#signIn').click()
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(0)
    await expect(page.locator('#importBrowserRooms')).toHaveText('Add 1 room from this browser')
    page.once('dialog', dialog => dialog.dismiss())
    await page.locator('#importBrowserRooms').click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(0)
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#importBrowserRooms').click()
    await expect(page.locator('#roomList .roomName')).toHaveText('A browser shortcut')
    await expect(page.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    const other = await b.newPage()
    await other.goto(baseURL! + '?signin=nostr')
    await other.getByRole('button', { name: /Browser extension/ }).click()
    await expect(other.locator('#roomList .roomName')).toHaveText('A browser shortcut')
  } finally { await a.close(); await b.close() }
})

test('switching conversations restores the same Nostr identity before entering', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const context = await device(browser, baseURL!, secret)
  try {
    const first = await context.newPage()
    await signIn(first, baseURL!)
    await first.locator('#roomName').fill('First account room')
    await first.locator('#create').click()
    await expect(first.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    const host = await context.newPage()
    await host.goto(baseURL!)
    await expect(host.locator('#signOut')).toBeVisible()
    await host.locator('#roomName').fill('Second account room')
    await host.locator('#create').click()
    await expect(host.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    await first.locator('#join').click()
    await expect(first.locator('#roomArea')).toBeVisible()
    await first.locator('#backToRooms').click()
    await first.locator('#roomSwitcherList').getByRole('button', { name: /Second account room/ }).click()
    await expect(first.locator('#roomTitle')).toHaveText('Second account room')
    await expect(first.locator('#roomArea')).toBeVisible()
    await expect(first.locator('#whoami')).toContainText(getPublicKey(secret).slice(0, 8))
  } finally { await context.close() }
})
