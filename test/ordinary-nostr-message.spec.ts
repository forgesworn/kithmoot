import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { npubEncode } from 'nostr-tools/nip19'
import { NostrRelayPool } from '../src/relay-pool.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { TEST_RELAY_WS } from './browser.js'

// Built KithMoot UI against the existing synthetic relay/provider fixture.
// This is not actual external Coracle receipt or the complete C04 matrix.
async function showComposer(page: Page) {
  await page.locator('#openAppSettings').click()
  await page.getByRole('button', { name: 'Start public message', exact: true }).click()
  await expect(page.locator('#nostrMessageDialog')).toBeVisible()
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
test('public message requires review and visible downgrade, then sends ordinary text and an encrypted sender copy', async ({ browser, baseURL }) => {
  const sender = generateSecretKey(), recipient = generateSecretKey(), context = await accountDevice(browser, baseURL!, sender)
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await inbox(pool, sender, baseURL!); await inbox(pool, recipient, baseURL!)
    const page = await context.newPage(), events = publishedWraps(page)
    await signInAccount(page, baseURL!); await showComposer(page)
    await expect(page.locator('#nostrMessageLane')).toHaveText('○ public')
    await expect(page.locator('#nostrMessageWarning')).toContainText('takes nothing from this one')
    await page.locator('#nostrMessageRecipient').fill(npubEncode(getPublicKey(recipient)))
    await page.locator('#nostrMessageText').fill('An ordinary Nostr message, without a room invitation')
    await page.getByRole('button', { name: 'Review public message', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send public', exact: true })).toBeVisible()
    await expect(page.locator('#nostrMessageSummary')).toContainText(npubEncode(getPublicKey(recipient)))
    expect(events).toEqual([])
    await page.screenshot({ path: test.info().outputPath('public-warning-before-send.png') })
    await page.getByRole('button', { name: 'Send public', exact: true }).click()
    await expect(page.locator('#nostrMessageStatus')).toContainText('does not confirm that the person received or read it')
    const unique = [...new Map(events.map(event => [event.id, event])).values()]
    expect(unique).toHaveLength(2); expect(unique.every(event => event.kind === 1059)).toBe(true)
    const received = unique.find(event => event.tags[0]?.[1] === getPublicKey(recipient))!
    const copy = unique.find(event => event.tags[0]?.[1] === getPublicKey(sender))!
    expect(unwrapEvent(received, recipient)).toEqual(unwrapEvent(copy, sender))
    expect(unwrapEvent(received, recipient)).toMatchObject({ kind: 14, pubkey: getPublicKey(sender),
      tags: [['p', getPublicKey(recipient)]], content: 'An ordinary Nostr message, without a room invitation' })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.locator('#nostrMessageText')).toHaveValue('')
    await expect(page.locator('#openAppSettings')).toBeFocused()
  } finally { pool.close(); await context.close() }
})
test('missing recipient inbox holds the message and editing a reviewed draft removes Send', async ({ browser, baseURL }) => {
  const sender = generateSecretKey(), recipient = generateSecretKey(), context = await accountDevice(browser, baseURL!, sender)
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await inbox(pool, sender, baseURL!)
    const page = await context.newPage(), events = publishedWraps(page)
    await signInAccount(page, baseURL!); await showComposer(page)
    await page.locator('#nostrMessageRecipient').fill(npubEncode(getPublicKey(recipient)))
    await page.locator('#nostrMessageText').fill('Held for inbox configuration')
    await page.getByRole('button', { name: 'Review public message', exact: true }).click()
    await expect(page.locator('#nostrMessageStatus')).toContainText('No usable published NIP-17 inbox')
    await expect(page.locator('#nostrMessageSend')).toBeHidden(); expect(events).toEqual([])
    await inbox(pool, recipient, baseURL!)
    await page.getByRole('button', { name: 'Review public message', exact: true }).click()
    await expect(page.locator('#nostrMessageSend')).toBeVisible()
    await page.locator('#nostrMessageText').fill('A changed draft needs a new review')
    await expect(page.locator('#nostrMessageSend')).toBeHidden(); expect(events).toEqual([])
  } finally { pool.close(); await context.close() }
})
test('a closed public draft stays cleared after sign-out without publishing', async ({ browser, baseURL }) => {
  const context = await accountDevice(browser, baseURL!), recipient = generateSecretKey()
  try {
    const page = await context.newPage(), events = publishedWraps(page)
    await signInAccount(page, baseURL!); await showComposer(page)
    await page.locator('#nostrMessageRecipient').fill(npubEncode(getPublicKey(recipient)))
    await page.locator('#nostrMessageText').fill('Only on this device')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.locator('#openAppSettings').click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.locator('#nostrMessageDialog')).not.toBeVisible()
    await expect(page.locator('#nostrMessageText')).toHaveValue(''); expect(events).toEqual([])
  } finally { await context.close() }
})

for (const stage of ['encrypt', 'seal'] as const) for (const boundary of ['close', 'sign-out', 'home-departure'] as const) {
  test(`an actual pending ${stage} provider cannot send or restore the public draft after ${boundary}`, async ({ browser, baseURL }) => {
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
      await signInAccount(page, baseURL!); await showComposer(page)
      await page.locator('#nostrMessageRecipient').fill(npubEncode(getPublicKey(recipient)))
      await page.locator('#nostrMessageText').fill(text); await page.locator('#nostrMessageReview').click()
      await expect(page.locator('#nostrMessageSend')).toBeVisible()
      await page.locator('#nostrMessageSend').click(); await expect.poll(() => entered).toBe(true)
      expect(events).toEqual([]); await expect(page.locator('#nostrMessageText')).toBeDisabled()
      if (boundary === 'close') await page.locator('#nostrMessageClose').click()
      // These two controls exercise the actual root handlers while the modal
      // is open. As in legacy acceptance, programmatic activation deliberately
      // bypasses pointer modal blocking; no account/state/app API is replaced.
      else if (boundary === 'sign-out') await page.locator('#signOut').evaluate(button => (button as HTMLButtonElement).click())
      else await page.locator('#createRoomForm').evaluate(form => (form as HTMLFormElement).requestSubmit())
      await expect(page.locator('#nostrMessageDialog')).not.toBeVisible()
      await expect(page.locator('#nostrMessageText')).toHaveValue('')
      if (boundary === 'sign-out') {
        await expect(page.locator('#nostrMessageEntry')).toHaveJSProperty('hidden', true)
        await expect(page.locator('#status')).toContainText("Signed out. This forgets this browser's connection to your signer")
        expect(await page.evaluate(() => ['signet:login.pubkey', 'signet:login.method', 'signet:login.authEvent'].map(key => localStorage.getItem(key)))).toEqual([null, null, null])
      } else if (boundary === 'close') {
        await showComposer(page)
        await page.locator('#nostrMessageText').fill('A new draft must survive the old provider result')
      }
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
      // A home departure may legitimately publish room traffic. Only ordinary
      // envelopes for this fresh non-member recipient can be this draft.
      expect(events.filter(event => event.kind === 1059 && event.tags.some(tag => tag[0] === 'p' && tag[1] === getPublicKey(recipient)))).toEqual([])
      expect(seals).toBe(stage === 'seal' ? 1 : 0)
      if (boundary === 'close') {
        await expect(page.locator('#nostrMessageText')).toHaveValue('A new draft must survive the old provider result')
        await expect(page.locator('#nostrMessageSend')).toBeHidden()
      } else {
        await expect(page.locator('#nostrMessageDialog')).not.toBeVisible()
        await expect(page.locator('#nostrMessageText')).toHaveValue('')
      }
    } finally { release(); pool.close(); await context.close() }
  })
}
