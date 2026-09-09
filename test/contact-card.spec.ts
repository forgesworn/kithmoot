import { test, expect, type BrowserContext } from '@playwright/test'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { buildCard, buildLinkCard, cardLink, readCard } from 'nostr-contact-card'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { openRoomDetails } from './browser.js'

/**
 * A contact card, as a person meets it: pasted into Room details, or opened
 * as a link at the door. What it changes is visible in two places, and both
 * are checked: the person's row says a card is held for them, and a message
 * to their box shows as sheltered, because the box on a card is one of the
 * circle's relays and nothing else ever is (src/lane.ts). Forgetting the
 * card puts both back.
 */

async function device(context: BrowserContext) {
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
}

const now = () => Math.floor(Date.now() / 1000)

/** Rowan's card: his key, one box whose address is the test relay, seven days. */
function rowansCard(rowanSk: Uint8Array, boxRelay: string, base: string): string {
  const link = buildLinkCard({ nodeSecret: randomBytes(32), issuedAt: now() - 60, expiresAt: now() + 6 * 24 * 3600, serial: 1, relays: [boxRelay] })
  const box = { p: bytesToHex(schnorr.getPublicKey(randomBytes(32))), claim: 'c1'.repeat(32), card: Buffer.from(link).toString('base64url') }
  const card = buildCard({ identityPrivateKey: rowanSk, rz: bytesToHex(schnorr.getPublicKey(randomBytes(32))), ephemeralPrivateKey: randomBytes(32), name: 'Rowan', relays: [], boxes: [box], ttlSeconds: 7 * 24 * 3600 })
  return cardLink(base, card)
}

test('a contact card marks its holder and makes their box a sheltered relay, and forgetting it undoes both', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 900, height: 760 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await device(context)
  const rowanSk = generateSecretKey()
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
  const rowan = await RoomAgent.join({ link, identity: localIdentity(rowanSk), relays: ['ws://127.0.0.1:7777'], name: 'Rowan' })
  try {
    const page = await context.newPage(); await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    // The room's only relay is a public one, and the composer says so.
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/public/)

    await openRoomDetails(page)
    const rowanRow = page.locator('#sheetRoster .rosterRow', { hasText: 'Rowan' })
    await expect(rowanRow).toBeVisible()
    await expect(rowanRow.locator('.badge.card')).toHaveCount(0)

    // A card that is not one is refused with the step that failed.
    await page.locator('#contactCardIn').fill('https://kithmoot.test/j/#not-a-card')
    await page.locator('#contactCardAdd').click()
    await expect(page.locator('#contactCardStatus')).toContainText('not a contact card')
    await expect(page.locator('#contactList')).toContainText('No contact cards yet')

    // Rowan's card, whose box is the relay this room already uses.
    await page.locator('#contactCardIn').fill(rowansCard(rowanSk, relay.href, baseURL!))
    await page.locator('#contactCardAdd').click()
    await expect(page.locator('#contactCardStatus')).toContainText('Added Rowan: one box')
    await expect(page.locator('#contactList')).toContainText('Rowan')
    await expect(page.locator('#contactList')).toContainText("dialled on their card's endorsement")
    await expect(rowanRow.locator('.badge.card')).toHaveText('card: Rowan')
    await page.locator('#roomSheetClose').click()

    // The box is now one of the circle's relays: the next message is sheltered, and says so.
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/sheltered/)
    await page.locator('#chatInput').fill('through the box')
    await page.locator('#chatInput').press('Enter')
    const sent = page.locator('#chatLog .msg').filter({ hasText: 'through the box' })
    await expect(sent).toBeVisible()
    await expect(sent.locator('.chip.lane')).toHaveText(/sheltered/)
    await expect.poll(() => rowan.chat.messages().some(m => m.text === 'through the box')).toBe(true)

    // Ada's own card, signed by whatever holds her identity, reads back
    // under her key with the relay this room uses.
    await openRoomDetails(page)
    await page.locator('#myCardShow').click()
    const mine = page.locator('#myCardOut')
    await expect(mine).toBeVisible()
    const cardOut = await mine.inputValue()
    const read = readCard(cardOut, now())
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.card.event.kind).toBe(21641)
      expect(read.card.name).toBe('Ada')
      expect(read.card.boxes).toEqual([])
      // Her public relays: the device's defaults, every one a wss URL.
      expect(read.card.relays.length).toBeGreaterThan(0)
      for (const r of read.card.relays) expect(r.startsWith('wss://')).toBe(true)
    }
    await page.locator('#roomSheetClose').click()

    // Forgotten, the relay is a public relay again.
    await openRoomDetails(page)
    await page.getByRole('button', { name: "Forget Rowan's card" }).click()
    await page.getByRole('button', { name: 'Forget card' }).click()
    await expect(page.locator('#contactList')).toContainText('No contact cards yet')
    await expect(rowanRow.locator('.badge.card')).toHaveCount(0)
    await page.locator('#roomSheetClose').click()
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/public/)
  } finally {
    await rowan.leave()
    await context.close()
  }
})

test('a card opened as a link is offered at the door, and kept only on a press', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 900, height: 760 } })
  await context.routeWebSocket(() => true, ws => ws.close())
  await device(context)
  try {
    const page = await context.newPage()
    await page.goto(rowansCard(generateSecretKey(), 'wss://box.rowan.example', baseURL!))
    await expect(page.locator('#arrivalTitle')).toHaveText('This is a contact card')
    await expect(page.locator('#arrivalLead')).toContainText('From Rowan')
    await expect(page.locator('#arrivalLead')).toContainText('one box')
    // Nothing is kept by merely opening the link.
    expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.contact.v1.')).length)).toBe(0)
    await page.locator('#addCardArrival').click()
    await expect(page.locator('#arrivalLead')).toContainText('Rowan is in your contacts on this device')
    expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.contact.v1.')).length)).toBe(1)
    await expect(page.locator('#addCardArrival')).toBeHidden()
  } finally {
    await context.close()
  }
})
