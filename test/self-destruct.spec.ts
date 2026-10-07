import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import type { Event } from 'nostr-tools/pure'
import { openNewRoomForm, openRoomDetails } from './browser.js'
import { openRoomUrl } from './relays.js'
import { parseRoomLink } from '../src/link.js'
import { deriveInvitationId } from '../src/invitation.js'

// Self-destructing rooms, against the local test relay. The test build
// offers an end `VITE_TEST_ROOM_END_SECONDS` away (playwright.config.ts), so
// a room can be watched to its end; a real build never offers it.

const TEST_END_SECONDS = 90

async function device(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by self-destruct acceptance test')
        super(target, protocols)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

/** Every event a page publishes, as sent. */
function recordPublished(page: Page, sent: Event[] = []): Event[] {
  page.on('websocket', socket => socket.on('framesent', frame => {
    try {
      const message = JSON.parse(String(frame.payload))
      if (Array.isArray(message) && message[0] === 'EVENT' && message[1] && typeof message[1] === 'object') sent.push(message[1] as Event)
    } catch { /* Not a relay frame. */ }
  }))
  return sent
}

async function enter(page: Page, link: string, name: string) {
  await openRoomUrl(page, link)
  await expect(page.locator('#join')).toBeVisible()
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

/** Everything this browser still holds that names the room or its link:
 *  local and session storage, keys and values. */
async function traces(page: Page, names: string[]): Promise<string[]> {
  return page.evaluate(names => {
    const found: string[] = []
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) {
        const value = storage.getItem(key) ?? ''
        if (names.some(name => key.includes(name) || value.includes(name))) found.push(key)
      }
    }
    return found
  }, names)
}

/** How many sealed events the room archive holds, in every conversation. */
async function archived(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>(resolve => {
    const open = indexedDB.open('kithmoot-room-archive-v1')
    open.onerror = () => resolve(0)
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains('events')) { db.close(); resolve(0); return }
      const count = db.transaction('events', 'readonly').objectStore('events').count()
      count.onsuccess = () => { db.close(); resolve(count.result) }
      count.onerror = () => { db.close(); resolve(0) }
    }
  }))
}

/** Every event id a kind 5 this page sent asked to delete. */
function deletionsAsked(sent: Event[]): Set<string> {
  return new Set(sent.filter(e => e.kind === 5).flatMap(e => e.tags.filter(t => t[0] === 'e').map(t => t[1]!)))
}

test('a room self-destructs at its end on every device, including one that was away', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
  test.setTimeout(240_000)
  const contexts: BrowserContext[] = []
  try {
    const owner = await device(browser, baseURL!); contexts.push(owner)
    const page = await owner.newPage()
    const sent = recordPublished(page)
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Short fuse')
    await page.locator('#roomEnds').selectOption('test')
    // D1: a dated room self-destructs unless the person says otherwise, and
    // the form says what that can and cannot do.
    await expect(page.locator('#roomWhenEndsLabel')).toHaveText('When it ends')
    await expect(page.locator('#roomWhenEnds')).toHaveValue('destruct')
    await expect(page.locator('#roomWhenEndsHint')).toContainText('Someone could still have kept a copy')
    await page.locator('#create').click()
    await expect(page.locator('#join')).toBeVisible()
    const link = await page.locator('#shareUrl').inputValue()
    const invitationId = deriveInvitationId(parseRoomLink(link).invitation!)
    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const roomId = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.'))!.slice('kithmoot.room.'.length))

    // The countdown, in words and with a fuse, green while there is time.
    const pill = page.locator('#roomEndsLine')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-stage', 'green')
    await expect(pill.locator('.fuseText')).toContainText('Self-destructs in')
    await expect(pill.locator('.fuseSpoken')).toContainText('Self-destructs in')
    await expect(pill.locator('svg.fuseIcon')).toHaveCount(1)

    await page.locator('#chatInput').fill('Burn after reading')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Burn after reading')

    // A second device joins, speaks, then goes away before the end with
    // everything it keeps still on disk.
    const away = await device(browser, baseURL!); contexts.push(away)
    let other = await away.newPage()
    const awaySent = recordPublished(other)
    await enter(other, link, 'Guest')
    await other.locator('#chatInput').fill('Guest was here')
    await other.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Guest was here')
    await expect(other.locator('#roomEndsLine')).toHaveAttribute('data-stage', /green|final/)
    const guestDevice = awaySent.find(e => e.kind === 1460)?.pubkey
    expect(guestDevice).toBeTruthy()
    await other.close()

    // The final minute: a banner across the chat, the pill red.
    await expect(page.locator('#fuseBanner')).toBeVisible({ timeout: TEST_END_SECONDS * 1000 })
    await expect(page.locator('#fuseBanner')).toContainText('Save anything you need now')
    await expect(pill).toHaveAttribute('data-stage', 'final')
    await expect(page.locator('#fuseAnnounce')).toHaveText('This room self-destructs in under a minute. Save anything you need now.')

    // The end: the room goes, with no question asked.
    await expect(page.locator('#roomArea')).toBeHidden({ timeout: (TEST_END_SECONDS + 30) * 1000 })
    await expect(page.locator('#status')).toContainText('This room self-destructed.')
    const hostDevice = sent.find(e => e.kind === 1460)!.pubkey
    const hostEvents = sent.filter(e => e.pubkey === hostDevice && e.kind !== 5).map(e => e.id)
    await expect.poll(() => hostEvents.filter(id => !deletionsAsked(sent).has(id)).length, { timeout: 30_000 }).toBeLessThan(hostEvents.length)
    // Its own chat and roster, asked to be deleted.
    const asked = deletionsAsked(sent)
    const chat = sent.find(e => e.kind === 1460 && e.pubkey === hostDevice)!
    expect(asked.has(chat.id)).toBe(true)
    // The tombstone row, naming no room, and nothing left that does.
    await expect(page.locator('#roomList .tombstoneRow')).toHaveCount(1)
    await expect(page.locator('#roomList .tombstoneRow')).toContainText('A room self-destructed ·')
    await expect(page.locator('#roomList .tombstoneRow')).not.toContainText('Short fuse')
    await expect(page.locator('#roomList .roomRow:not(.tombstoneRow)')).toHaveCount(0)
    await expect.poll(() => traces(page, [roomId, invitationId])).toEqual([])
    await expect.poll(() => archived(page)).toBe(0)

    // The device that was away comes back after the end and does the same
    // at launch, from what it stored.
    other = await away.newPage()
    recordPublished(other, awaySent)
    await other.goto(baseURL!)
    await expect(other.locator('#roomList .tombstoneRow')).toHaveCount(1, { timeout: 30_000 })
    await expect.poll(() => [...deletionsAsked(awaySent)].length, { timeout: 30_000 }).toBeGreaterThan(0)
    const guestChat = awaySent.find(e => e.kind === 1460 && e.pubkey === guestDevice)!
    expect(deletionsAsked(awaySent).has(guestChat.id)).toBe(true)
    await expect.poll(() => traces(other, [roomId, invitationId])).toEqual([])
    await expect.poll(() => archived(other)).toBe(0)

    // Dismiss takes the row away.
    await other.locator('#roomList .tombstoneRow [data-action="dismiss"]').click()
    await expect(other.locator('#roomList .tombstoneRow')).toHaveCount(0)
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
  }
})

test('the authority makes a room with no end self-destruct now: both devices tidy it away', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
  test.setTimeout(120_000)
  const contexts: BrowserContext[] = []
  try {
    const owner = await device(browser, baseURL!); contexts.push(owner)
    const page = await owner.newPage()
    const sent = recordPublished(page)
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Planning')
    // No end: the choice reads "If it is ended", and keeps a copy unless chosen.
    await expect(page.locator('#roomWhenEndsLabel')).toHaveText('If it is ended')
    await expect(page.locator('#roomWhenEnds')).toHaveValue('keep')
    await page.locator('#create').click()
    await expect(page.locator('#join')).toBeVisible()
    const link = await page.locator('#shareUrl').inputValue()
    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#roomEndsLine')).toBeHidden()
    const roomId = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.'))!.slice('kithmoot.room.'.length))

    const member = await device(browser, baseURL!); contexts.push(member)
    const other = await member.newPage()
    const memberSent = recordPublished(other)
    await enter(other, link, 'Member')
    await other.locator('#chatInput').fill('Member here')
    await other.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Member here')
    await openRoomDetails(other)
    await expect(other.locator('#selfDestructNow')).toBeHidden()
    await other.locator('#roomSheetClose').click()

    await openRoomDetails(page)
    await page.locator('#selfDestructNow').click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Self-destruct Planning now?')
    await expect(dialog).toContainText('This cannot be undone.')
    await page.locator('#actionConfirm').click()

    for (const who of [page, other]) {
      await expect(who.locator('#roomArea')).toBeHidden({ timeout: 45_000 })
      await expect(who.locator('#status')).toContainText('This room self-destructed.')
      await expect(who.locator('#roomList .tombstoneRow')).toHaveCount(1)
      await expect.poll(() => traces(who, [roomId])).toEqual([])
    }
    // The closing rekey carried the flag; the plain retirement did not.
    const retirement = sent.find(e => e.kind === 1461)!
    expect(retirement.content).not.toContain('destruct')
    const memberDevice = memberSent.find(e => e.kind === 1460)!.pubkey
    const memberChat = memberSent.find(e => e.kind === 1460 && e.pubkey === memberDevice)!
    await expect.poll(() => deletionsAsked(memberSent).has(memberChat.id), { timeout: 30_000 }).toBe(true)
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
  }
})

test('a dated room that keeps a read-only copy counts down in grey and is not wiped', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
  test.setTimeout(180_000)
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    const sent = recordPublished(page)
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Kept')
    await page.locator('#roomEnds').selectOption('test')
    await page.locator('#roomWhenEnds').selectOption('keep')
    await page.locator('#create').click()
    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#roomEndsLine')).toHaveAttribute('data-stage', 'neutral')
    await expect(page.locator('#roomEndsLine .fuseText')).toContainText('Ends in')
    // No banner, and at the end the old ending: the room stays listed as ended.
    await expect(page.locator('#roomArea')).toBeHidden({ timeout: (TEST_END_SECONDS + 30) * 1000 })
    await expect(page.locator('#fuseBanner')).toBeHidden()
    await expect(page.locator('#status, #arrivalLead').filter({ hasText: 'This conference room ended on' }).first()).toBeVisible()
    await page.goto(baseURL!)
    await expect(page.locator('#roomList .tombstoneRow')).toHaveCount(0)
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await expect(page.locator('#roomList .roomPreview')).toContainText('Ended')
    expect(sent.filter(e => e.kind === 5)).toEqual([])
  } finally {
    await context.close()
  }
})

test('the countdown walks green, amber and red by the clock', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Week')
    await page.locator('#roomEnds').selectOption('7')
    await page.locator('#create').click()
    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const pill = page.locator('#roomEndsLine')
    await expect(pill).toHaveAttribute('data-stage', 'green')
    await expect(pill.locator('.fuseText')).toHaveText(/Self-destructs in (6 days|7 days)/)
    const ends = Number(await pill.getAttribute('data-fuse-ends'))
    // Only the clock is moved: a stage is a reading of it.
    await page.clock.setFixedTime(new Date((ends - 5 * 3600 - 12 * 60) * 1000))
    await expect(pill).toHaveAttribute('data-stage', 'amber')
    await expect(pill.locator('.fuseText')).toHaveText('Self-destructs in 5 h 12 m')
    await expect(pill.locator('.fuseSpoken')).toHaveText('Self-destructs in 5 hours 12 minutes')
    await expect(page.locator('#fuseAnnounce')).toHaveText('This room self-destructs in 5 hours 12 minutes.')
    await page.clock.setFixedTime(new Date((ends - 42 * 60 - 7) * 1000))
    await expect(pill).toHaveAttribute('data-stage', 'red')
    await expect(pill.locator('.fuseText')).toHaveText('Self-destructs in 42:07')
  } finally {
    await context.close()
  }
})

test('the desktop rail shows the countdown beside the room', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'the rail is the installed window\'s')
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Railed')
    await page.locator('#roomEnds').selectOption('3')
    await page.locator('#create').click()
    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const row = page.locator('.workspaceRoom').filter({ hasText: 'Railed' })
    await expect(row.locator('.fusePill')).toHaveAttribute('data-stage', 'green')
    await expect(row.locator('.fusePill .fuseSpoken')).toContainText('Self-destructs in')
  } finally {
    await context.close()
  }
})
