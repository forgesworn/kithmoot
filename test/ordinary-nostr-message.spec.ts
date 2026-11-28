import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { npubEncode } from 'nostr-tools/nip19'
import { NostrRelayPool } from '../src/relay-pool.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { TEST_RELAY_WS, openSettings } from './browser.js'
import { openNpubThread } from './people-scenario.js'

// Built KithMoot UI against the existing synthetic relay/provider fixture.
// Ordinary Nostr messages are written in People's thread. This is not actual
// external Coracle receipt or the complete C04 matrix.
const composer = (page: Page, name?: string) => page.getByRole('textbox', { name: name ?? /^Message .* on Nostr$/ })
async function showComposer(page: Page, pubkey: string) {
  await openNpubThread(page, npubEncode(pubkey), pubkey)
  await expect(composer(page)).toBeVisible()
}
function publishedWraps(page: Page) {
  const events: Event[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    try {
      const value = JSON.parse(String(frame.payload))
      if (value[0] === 'EVENT' && [4, 1059].includes(value[1]?.kind)) events.push(value[1])
    } catch { /* Other frames are not message publications. */ }
  }))
  return events
}
async function inbox(pool: NostrRelayPool, key: Uint8Array, baseURL: string) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await pool.publish(finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000), content: '',
    tags: [['relay', relay.href]] }, key))
}
test('People sends an ordinary Nostr message to a pasted key, with a copy for the account', async ({ browser, baseURL }) => {
  const sender = generateSecretKey(), recipient = generateSecretKey(), context = await accountDevice(browser, baseURL!, sender)
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await inbox(pool, sender, baseURL!); await inbox(pool, recipient, baseURL!)
    const page = await context.newPage(), events = publishedWraps(page)
    await signInAccount(page, baseURL!); await showComposer(page, getPublicKey(recipient))
    await composer(page).fill('An ordinary Nostr message, without a room invitation')
    expect(events).toEqual([])
    await composer(page).press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    const unique = [...new Map(events.map(event => [event.id, event])).values()]
    expect(unique).toHaveLength(2); expect(unique.every(event => event.kind === 1059)).toBe(true)
    const received = unique.find(event => event.tags[0]?.[1] === getPublicKey(recipient))!
    const copy = unique.find(event => event.tags[0]?.[1] === getPublicKey(sender))!
    expect(unwrapEvent(received, recipient)).toEqual(unwrapEvent(copy, sender))
    expect(unwrapEvent(received, recipient)).toMatchObject({ kind: 14, pubkey: getPublicKey(sender),
      tags: [['p', getPublicKey(recipient)]], content: 'An ordinary Nostr message, without a room invitation' })
    await expect(composer(page)).toHaveValue('')
  } finally { pool.close(); await context.close() }
})
test('a missing recipient inbox holds the message until the person publishes one', async ({ browser, baseURL }) => {
  const sender = generateSecretKey(), recipient = generateSecretKey(), context = await accountDevice(browser, baseURL!, sender)
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await inbox(pool, sender, baseURL!)
    const page = await context.newPage(), events = publishedWraps(page)
    await signInAccount(page, baseURL!); await showComposer(page, getPublicKey(recipient))
    await composer(page).fill('Held for inbox configuration'); await composer(page).press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Not sent')
    await expect(page.locator('#peopleThread')).toContainText('This person needs usable inbox relays')
    expect(events).toEqual([])
    await inbox(pool, recipient, baseURL!)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    expect(events.filter(event => event.tags[0]?.[1] === getPublicKey(recipient)).length).toBeGreaterThan(0)
  } finally { pool.close(); await context.close() }
})
test('signing out with a typed message publishes nothing and keeps nothing', async ({ browser, baseURL }) => {
  const sender = generateSecretKey(), context = await accountDevice(browser, baseURL!, sender), recipient = generateSecretKey()
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await inbox(pool, sender, baseURL!)
    const page = await context.newPage(), events = publishedWraps(page)
    await signInAccount(page, baseURL!); await showComposer(page, getPublicKey(recipient))
    await composer(page).fill('Only on this device')
    await openSettings(page, 'Account'); await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.locator('#peopleThread')).not.toBeVisible()
    expect(events).toEqual([])
  } finally { pool.close(); await context.close() }
})

for (const stage of ['encrypt', 'seal'] as const) for (const boundary of ['sign-out', 'leave-people', 'settings'] as const) {
  test(`an actual pending ${stage} provider cannot send the message after ${boundary}`, async ({ browser, baseURL }) => {
    const sender = generateSecretKey(), recipient = generateSecretKey(), text = 'Never publish this cancelled ordinary message'
    let release!: () => void, entered = false, encrypts = 0, seals = 0, providerResult: string | undefined
    const ciphertexts = new Set<string>()
    const pending = new Promise<void>(resolve => { release = resolve })
    const context = await accountDevice(browser, baseURL!, sender, true, async () => {}, undefined, {
      encrypt: async (peer, plaintext) => {
        let ordinary = false
        try { const rumor = JSON.parse(plaintext); ordinary = rumor.kind === 14 && rumor.content === text } catch { /* Other app crypto is not this draft. */ }
        if (ordinary && ++encrypts === 1 && stage === 'encrypt') { entered = true; await pending }
        const ciphertext = encrypt(plaintext, getConversationKey(sender, peer))
        if (ordinary) { ciphertexts.add(ciphertext); if (stage === 'encrypt' && encrypts === 1) providerResult = ciphertext }
        return ciphertext
      },
      sign: async template => {
        const ordinary = template.kind === 13 && ciphertexts.has(template.content)
        if (ordinary && ++seals === 1 && stage === 'seal') { entered = true; await pending }
        const event = finalizeEvent(template, sender)
        if (ordinary && stage === 'seal' && seals === 1) providerResult = event.id
        return event
      },
    })
    const pool = new NostrRelayPool([TEST_RELAY_WS])
    try {
      await inbox(pool, sender, baseURL!); await inbox(pool, recipient, baseURL!)
      const page = await context.newPage(), events = publishedWraps(page)
      await signInAccount(page, baseURL!); await showComposer(page, getPublicKey(recipient))
      await composer(page).fill(text); await composer(page).press('Enter')
      await expect.poll(() => entered).toBe(true)
      expect(events).toEqual([])
      // The real root handlers run while the provider is still waiting.
      if (boundary === 'sign-out') await page.locator('#signOut').evaluate(button => (button as HTMLButtonElement).click())
      else if (boundary === 'leave-people') await page.locator('#railChats').evaluate(button => (button as HTMLButtonElement).click())
      else await openSettings(page, 'Account')
      release()
      // Observe the browser-side provider promise completion, not merely the
      // Node callback returning. Let its SDK handoff/microtasks settle too.
      await expect.poll(() => providerResult).toBeTruthy()
      await expect.poll(() => page.evaluate(({ stage, result }) => {
        const w = window as typeof window & { testMessageEncryptResults?: string[]; testMessageSealResults?: string[] }
        return (stage === 'encrypt' ? w.testMessageEncryptResults : w.testMessageSealResults)?.includes(result!) ?? false
      }, { stage, result: providerResult })).toBe(true)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(events.filter(event => event.kind === 4)).toEqual([])
      expect(events.filter(event => event.kind === 1059 && event.tags.some(tag => tag[0] === 'p' && tag[1] === getPublicKey(recipient)))).toEqual([])
      expect(seals).toBe(stage === 'seal' ? 1 : 0)
    } finally { release(); pool.close(); await context.close() }
  })
}
