import { test, expect, type Browser, type Page } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { TEST_RELAY_WS, testRelaysFor } from './relays.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { localIdentity } from '../src/identity.js'
import { createDeviceCredential } from '../src/credential.js'
import { encodeChatEvent } from '../src/chat.js'

/**
 * The rooms list in sections, with pins: docs/2026-10-05-room-list-sections.md.
 *
 * Saved rooms carry signed conversation messages sent at spaced
 * times, so the list has a known shape without opening thirty rooms: a day
 * apart, the first seven are Recent and the rest Older.
 */

const PINS = 'kithmoot.pinned-rooms.v1'

async function homeWith(browser: Browser, baseURL: string, count: number, withHistory = true): Promise<{ page: Page; ids: string[]; names: string[] }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  const relays = testRelaysFor(baseURL)!
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  const participant = localIdentity(generateSecretKey())
  const now = Math.floor(Date.now() / 1000)
  const rooms = Array.from({ length: count }, (_, i) => {
    const secret = generateRoomSecret()
    const name = `Room ${String(i + 1).padStart(2, '0')}`
    return { secret, at: now - i * 86400 - 60, id: deriveRoom(secret).roomId, name, value: JSON.stringify({
      link: encodeJoinUrl(baseURL, secret, relays), openedAt: now, readAt: now, name,
    }) }
  })
  try {
    if (withHistory) for (const room of rooms) {
      const deviceSk = generateSecretKey(), device = getPublicKey(deviceSk)
      const credential = await createDeviceCredential({ identity: participant, devicePubkey: device, roomId: room.id, expiresAt: room.at + 3600, now: () => room.at })
      await pool.publish(encodeChatEvent({ id: 'fixture-message', participant: participant.pubkey, device, credential, sentAt: room.at, text: 'Signed history for ' + room.name }, {
        roomId: room.id, roomKey: deriveRoom(room.secret).roomKey, deviceSk,
      }))
    }
  } finally { pool.close() }
  await context.addInitScript(({ rooms, relays }) => {
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: relays.map(url => ({ url, read: true, write: true })) }))
    if (localStorage.getItem('test.seeded')) return
    localStorage.setItem('test.seeded', '1')
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.id, room.value)
  }, { rooms: rooms.map(({ id, name, value }) => ({ id, name, value })), relays })
  const page = await context.newPage()
  await page.goto(baseURL)
  await expect(page.locator('#roomList .roomRow').first()).toBeVisible()
  if (withHistory) {
    await expect(page.locator('#roomList .roomPreview', { hasText: 'Signed history' })).toHaveCount(count <= 8 ? count : 7)
    await expect(page.locator('#roomList .roomSection', { hasText: 'Other rooms' })).toHaveCount(0)
  }
  return { page, ids: rooms.map(r => r.id), names: rooms.map(r => r.name) }
}

const row = (page: Page, name: string) => page.locator('#roomList .roomRow', { has: page.locator('.roomName', { hasText: name }) })
const headings = (page: Page) => page.locator('#roomList .roomSection').allInnerTexts()

test('eight rooms are one list with no headings', async ({ browser, baseURL }) => {
  const { page } = await homeWith(browser, baseURL!, 8)
  try {
    await expect(page.locator('#roomList .roomRow')).toHaveCount(8)
    await expect(page.locator('#roomList .roomSection')).toHaveCount(0)
  } finally { await page.context().close() }
})

test('a long list is in sections, and Older folds away and stays folded', async ({ browser, baseURL }) => {
  const { page } = await homeWith(browser, baseURL!, 12)
  try {
    expect(await headings(page)).toEqual(['Recent', 'Older · 5'])
    await expect(page.locator('#roomList .roomRow')).toHaveCount(7)
    await expect(row(page, 'Room 12')).toHaveCount(0)

    await page.getByRole('button', { name: 'Older · 5' }).click()
    await expect(page.getByRole('button', { name: 'Older' })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(12)
    // The list deliberately holds sections while hovered. Leave it before
    // reloading, then wait for signed history to return before folding it.
    await page.mouse.move(0, 0)
    await page.reload()
    await expect(page.locator('#roomList .roomSection', { hasText: 'Other rooms' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Older$/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(12)

    await page.getByRole('button', { name: 'Older' }).click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(7)
  } finally { await page.context().close() }
})

test('a search finds a room in a closed fold, with no headings', async ({ browser, baseURL }) => {
  const { page } = await homeWith(browser, baseURL!, 12)
  try {
    await page.locator('#homeRoomQuery').fill('Room 12')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await expect(row(page, 'Room 12')).toBeVisible()
    await expect(page.locator('#roomList .roomSection')).toHaveCount(0)
  } finally { await page.context().close() }
})

test('a pin puts a room in Pinned, survives a reload, and goes when the room is forgotten', async ({ browser, baseURL }) => {
  const { page, ids } = await homeWith(browser, baseURL!, 12)
  try {
    await page.getByRole('button', { name: 'Older · 5' }).click()
    await row(page, 'Room 10').locator('.rowMenu').click()
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    expect((await headings(page))[0]).toBe('Pinned')
    await expect(page.locator('#roomList .roomRow').first().locator('.roomName')).toHaveText('Room 10')
    // Focus goes with the row it moved.
    await expect(row(page, 'Room 10').locator('.rowMenu')).toBeFocused()

    await page.reload()
    await expect(page.locator('#roomList .roomRow').first().locator('.roomName')).toHaveText('Room 10')
    expect(await page.evaluate(key => localStorage.getItem(key), PINS)).toContain(ids[9])

    await row(page, 'Room 10').locator('.rowMenu').click()
    await page.getByRole('menuitem', { name: 'Forget this room' }).click()
    await page.locator('#actionConfirm').click()
    await expect(row(page, 'Room 10')).toHaveCount(0)
    expect(await page.evaluate(key => localStorage.getItem(key), PINS)).not.toContain(ids[9])
  } finally { await page.context().close() }
})

test('Unpin puts the room back where its activity says', async ({ browser, baseURL }) => {
  const { page } = await homeWith(browser, baseURL!, 9)
  try {
    await row(page, 'Room 02').locator('.rowMenu').click()
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    expect(await headings(page)).toEqual(['Pinned', 'Recent', 'Older · 2'])
    await row(page, 'Room 02').locator('.rowMenu').click()
    await page.getByRole('menuitem', { name: 'Unpin' }).click()
    expect(await headings(page)).toEqual(['Recent', 'Older · 2'])
    await expect(page.locator('#roomList .roomRow').nth(1).locator('.roomName')).toHaveText('Room 02')
  } finally { await page.context().close() }
})


test('a long list of rooms without readable history stays visible without invented times', async ({ browser, baseURL }) => {
  const { page } = await homeWith(browser, baseURL!, 12, false)
  try {
    await expect(page.locator('#roomList .roomRow')).toHaveCount(12)
    expect(await headings(page)).toEqual(['Other rooms'])
    await expect(page.locator('#roomList .roomTime')).toHaveText(Array(12).fill(''))
    await expect(page.getByRole('button', { name: /^Older/ })).toHaveCount(0)
    await page.reload()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(12)
  } finally { await page.context().close() }
})
