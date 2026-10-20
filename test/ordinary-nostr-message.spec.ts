import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'
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
