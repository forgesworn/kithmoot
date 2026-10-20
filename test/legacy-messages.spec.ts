import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encrypt, decrypt } from 'nostr-tools/nip04'
import { NostrRelayPool } from '../src/relay-pool.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { TEST_RELAY_WS } from './browser.js'

const warning = 'Legacy NIP-04 encryption. Relays can see the sender and recipient. Use a modern private conversation for sensitive messages.'

function observeWire(page: Page) {
  const frames: unknown[][] = []
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try { const value: unknown = JSON.parse(String(payload)); if (Array.isArray(value)) frames.push(value) } catch { /* Only Nostr JSON frames are relevant. */ }
  }))
  return {
    legacySubscriptions: () => frames.filter(frame => frame[0] === 'REQ' && frame.slice(2).some(filter =>
      filter && typeof filter === 'object' && Array.isArray((filter as { kinds?: unknown }).kinds) && (filter as { kinds: unknown[] }).kinds.includes(4))),
    assertReceiveOnly: () => expect(frames.filter(frame => frame[0] === 'EVENT' && (frame[1] as { kind?: number } | undefined)?.kind === 4)).toEqual([]),
    closed: (id: unknown) => frames.some(frame => frame[0] === 'CLOSE' && frame[1] === id),
  }
}
async function showLegacy(page: Page) {
  await page.locator('#openAppSettings').click()
  await page.getByRole('button', { name: 'Legacy messages', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Legacy messages', exact: true })).toBeVisible()
}
async function publishLegacy(publisher: NostrRelayPool, sender: Uint8Array, to: string, text: string) {
  const event = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [['p', to]],
    content: await encrypt(sender, to, text) }, sender)
  await publisher.publish(event)
  return event
}

test('legacy reception is explicit, literal, warned and receive-only without NIP-44', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), sender = generateSecretKey(), requests: string[] = []
  let decrypts = 0, encrypts = 0
  const context = await accountDevice(browser, baseURL!, account, false, async () => {}, {
    decrypt: async (peer, ciphertext) => { decrypts++; return decrypt(account, peer, ciphertext) },
    encrypt: async () => { encrypts++; throw Error('Legacy encryption must never be requested') },
  })
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  try {
    const text = '<img src="https://legacy-preview.invalid/pixel">\nhttps://legacy-preview.invalid/secret\n#invite-this-is-only-text'
    await publishLegacy(publisher, sender, getPublicKey(account), text)
    const page = await context.newPage(), wire = observeWire(page)
    page.on('request', request => { if (request.url().includes('legacy-preview.invalid')) requests.push(request.url()) })
    await signInAccount(page, baseURL!)
    await showLegacy(page)
    expect(wire.legacySubscriptions()).toEqual([])
    expect(decrypts).toBe(0)
    await expect(page.locator('#legacyMessagesList > li')).toHaveCount(0)
    await page.getByRole('button', { name: 'Load legacy messages', exact: true }).click()
    const row = page.locator('#legacyMessagesList > li')
    await expect(row).toHaveCount(1)
    await expect(row.locator('.legacyMessageWarning')).toBeVisible()
    await expect(row.locator('.legacyMessageWarning')).toHaveText(warning)
    expect(decrypts).toBe(0)
    expect(wire.legacySubscriptions().length).toBeGreaterThan(0)
    await row.getByRole('button', { name: 'Open message', exact: true }).click()
    await expect(row.locator('.legacyMessageText')).toHaveText(text)
    await expect(row.locator('.legacyMessageWarning')).toBeVisible()
    await expect(row.locator('img, a, video, audio, iframe')).toHaveCount(0)
    expect(decrypts).toBe(1); expect(encrypts).toBe(0); expect(requests).toEqual([])
    wire.assertReceiveOnly()
    await page.screenshot({ path: test.info().outputPath('legacy-message-phone.png') })
    const ids = wire.legacySubscriptions().map(frame => frame[1])
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.locator('#legacyMessagesDialog')).not.toBeVisible()
    await expect(page.locator('#legacyMessagesList')).toBeEmpty()
    await expect.poll(() => ids.every(id => wire.closed(id))).toBe(true)
    await expect(page.locator('#openAppSettings')).toBeFocused()
    await showLegacy(page)
    await expect(page.locator('#legacyMessagesList')).toBeEmpty()
    expect(decrypts).toBe(1)
  } finally { publisher.close(); await context.close() }
})

test('a sign-in without legacy decryption shows a warning and honest unavailability', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), sender = generateSecretKey()
  const context = await accountDevice(browser, baseURL!, account, false)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await publishLegacy(publisher, sender, getPublicKey(account), 'Unsupported signer plaintext')
    const page = await context.newPage(), wire = observeWire(page)
    await signInAccount(page, baseURL!); await showLegacy(page)
    await page.locator('#legacyMessagesLoad').click()
    const row = page.locator('#legacyMessagesList > li')
    await expect(row).toHaveCount(1)
    await expect(row.locator('.legacyMessageWarning')).toHaveText(warning)
    await expect(row).toContainText('This sign-in cannot open legacy messages here.')
    await expect(row.locator('.legacyMessageText')).toBeHidden()
    await expect(row.getByRole('button')).toHaveCount(0)
    await expect(page.locator('#legacyMessagesDialog')).not.toContainText('Unsupported signer plaintext')
    wire.assertReceiveOnly()
  } finally { publisher.close(); await context.close() }
})

test('signer refusal is fixed copy and only an explicit retry can open the message', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), sender = generateSecretKey()
  let calls = 0, refused = true
  const context = await accountDevice(browser, baseURL!, account, false, async () => {}, {
    decrypt: async (peer, ciphertext) => { calls++; if (refused) throw Error('raw-provider-secret-error'); return decrypt(account, peer, ciphertext) },
    encrypt: async () => { throw Error('Legacy encryption must never be requested') },
  })
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await publishLegacy(publisher, sender, getPublicKey(account), 'Only after explicit retry')
    const page = await context.newPage(), wire = observeWire(page)
    await signInAccount(page, baseURL!); await showLegacy(page); await page.locator('#legacyMessagesLoad').click()
    const row = page.locator('#legacyMessagesList > li')
    await row.getByRole('button', { name: 'Open message', exact: true }).click()
    await expect(row).toContainText('Your signer did not open this message.')
    await expect(page.locator('#legacyMessagesDialog')).not.toContainText('raw-provider-secret-error')
    await expect(row.locator('.legacyMessageWarning')).toBeVisible()
    expect(calls).toBe(1)
    refused = false
    await row.getByRole('button', { name: 'Try opening again', exact: true }).click()
    await expect(row.locator('.legacyMessageText')).toHaveText('Only after explicit retry')
    expect(calls).toBe(2); wire.assertReceiveOnly()
  } finally { publisher.close(); await context.close() }
})

for (const boundary of ['close', 'sign-out', 'home-departure'] as const) {
  test(`a provider result after ${boundary} cannot repopulate the view`, async ({ browser, baseURL }) => {
    const account = generateSecretKey(), sender = generateSecretKey()
    let calls = 0, returned = false, release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const context = await accountDevice(browser, baseURL!, account, false, async () => {}, {
      decrypt: async (peer, ciphertext) => { calls++; await pending; const text = await decrypt(account, peer, ciphertext); returned = true; return text },
      encrypt: async () => { throw Error('Legacy encryption must never be requested') },
    })
    const publisher = new NostrRelayPool([TEST_RELAY_WS])
    try {
      await publishLegacy(publisher, sender, getPublicKey(account), 'Never adopt this late plaintext')
      const page = await context.newPage(), wire = observeWire(page)
      await signInAccount(page, baseURL!); await showLegacy(page); await page.locator('#legacyMessagesLoad').click()
      await page.getByRole('button', { name: 'Open message', exact: true }).click()
      await expect.poll(() => calls).toBe(1)
      if (boundary === 'close') await page.locator('#legacyMessagesClose').click()
      // Exercise actual application transitions while a provider is pending.
      // The programmatic click intentionally bypasses modal pointer blocking,
      // not an account or lifetime gate in the application.
      else if (boundary === 'sign-out') await page.locator('#signOut').evaluate(button => (button as HTMLButtonElement).click())
      else await page.locator('#createRoomForm').evaluate(form => (form as HTMLFormElement).requestSubmit())
      await expect(page.locator('#legacyMessagesDialog')).not.toBeVisible()
      await expect(page.locator('#legacyMessagesList')).toBeEmpty()
      release()
      await expect.poll(() => returned).toBe(true)
      await expect.poll(() => page.evaluate(() => (window as typeof window & { testLegacyCompletions?: number }).testLegacyCompletions)).toBe(1)
      // Observe actual browser provider completion before settling the SDK's
      // return path, rather than assuming Node's return reached the browser.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(page.locator('#legacyMessagesList')).toBeEmpty()
      await expect(page.locator('body')).not.toContainText('Never adopt this late plaintext')
      expect(calls).toBe(1); wire.assertReceiveOnly()
    } finally { release(); publisher.close(); await context.close() }
  })
}
