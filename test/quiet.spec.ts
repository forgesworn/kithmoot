import { test, expect, type BrowserContext } from '@playwright/test'
import { Relay } from 'nostr-tools/relay'
import type { Event } from 'nostr-tools/pure'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { KINDS } from '../src/kinds.js'
import { openRoomDetails } from './browser.js'
import { fetchFromTestBlossom, routeTestBlossom } from './blossom.js'

/**
 * A quiet conversation, as two people meet it: started from a person's
 * row, named for the other person, and a message that reaches them with
 * nothing but a gift wrap on the relay. The relay is watched from outside
 * the browsers, so the claim is checked on the wire and not on the screen.
 * The acceptance build shortens the slot (see playwright.config.ts); the
 * shape of what is posted is the same at any slot length.
 */

async function device(context: BrowserContext) {
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
}

test('a quiet conversation reaches the other person with only gift wraps on the relay', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const contexts: BrowserContext[] = []
  const open = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
    await device(context)
    contexts.push(context)
    return context.newPage()
  }
  // The relay, watched from outside: every chat event since the test
  // began, and every wrap. A wrap's created_at is jittered up to two days
  // into the past, which is the point of it, so wraps are not asked for
  // by time; the relay is fresh for the run and holds nobody else's.
  const seen: Event[] = []
  const watcher = await Relay.connect('ws://127.0.0.1:7777')
  const since = Math.floor(Date.now() / 1000) - 5
  watcher.subscribe([{ kinds: [KINDS.CHAT], since }, { kinds: [1059] }], { onevent: (e) => seen.push(e) })
  try {
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
    const ada = await open(); await ada.goto(link)
    await ada.locator('#displayName').fill('Ada'); await ada.locator('#join').click()
    const rowan = await open(); await rowan.goto(link)
    await rowan.locator('#displayName').fill('Rowan'); await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada quietly/ }).click()
    await expect(rowan.locator('#status')).toContainText(/Quiet conversation with Ada/, { timeout: 30_000 })
    await expect(ada.locator('#chatLog')).toContainText('started a quiet conversation with you', { timeout: 30_000 })

    // Rowan goes in by the same button, while Ada is still on his roster;
    // Ada by the way the statement offers.
    await rowan.locator('#roomSheetClose').click()
    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada quietly/ }).click()
    await expect(rowan.locator('#roomTitle')).toHaveText('Quiet: Ada', { timeout: 30_000 })
    await ada.locator('#chatLog .system').getByRole('button', { name: 'Open Quiet: Rowan' }).click()
    await expect(ada.locator('#roomTitle')).toHaveText('Quiet: Rowan', { timeout: 30_000 })

    // The room says what it is, beside the composer (attached; the note
    // steps aside at phone width, see style.css) and on its sheet.
    await expect(rowan.locator('#laneNote .chip.quiet')).toBeAttached()
    await expect(rowan.locator('#laneNote .chip.quiet')).toHaveText(/quiet/)
    await openRoomDetails(rowan)
    await expect(rowan.locator('#quietState')).toContainText('cannot tell whether anything was said')
    await rowan.locator('#roomSheetClose').click()

    // What the relay has been given so far: the workshop's chat and nothing of the quiet room.
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    const chatBefore = seen.filter((e) => e.kind === KINDS.CHAT).length
    const wrapsBefore = seen.filter((e) => e.kind === 1059).length

    await rowan.locator('#chatInput').fill('meet at the mill')
    await rowan.locator('#chatInput').press('Enter')
    // The outbox says what it is waiting for; the wrap reaches the relay at
    // a slot; the other person reads it from the broadcast. Three steps,
    // asserted apart, so a failure names the half that stalled.
    await expect(rowan.locator('#outbox')).toContainText('Waiting for this quiet room', { timeout: 10_000 })
    await expect.poll(() => seen.filter((e) => e.kind === 1059).length, { timeout: 60_000, message: 'no wrap reached the relay after the send' }).toBeGreaterThan(wrapsBefore)
    await expect(ada.locator('#chatLog')).toContainText('meet at the mill', { timeout: 90_000 })
    await expect(rowan.locator('#chatLog .msg').filter({ hasText: 'meet at the mill' })).toBeVisible({ timeout: 30_000 })
    await expect(rowan.locator('#outbox')).toHaveJSProperty('hidden', true)

    // On the wire: no chat event was added, wraps were, each to one key,
    // signed by nobody the room knows, and none of them says a word.
    expect(seen.filter((e) => e.kind === KINDS.CHAT).length).toBe(chatBefore)
    const wraps = seen.filter((e) => e.kind === 1059).slice(wrapsBefore)
    expect(wraps.length).toBeGreaterThan(0)
    for (const w of wraps) {
      expect(w.tags.map((t) => t[0])).toEqual(['p'])
      expect(w.content).not.toContain('mill')
    }
    const sizes = new Set(wraps.map((w) => w.content.length))
    expect(sizes.size).toBe(1)

    // On the front page's list, a quiet room is not read in the background;
    // it says so, where a plain room would count what is new.
    await ada.locator('#backToRooms').click()
    await ada.locator('#roomSwitcherHome').click()
    await expect(ada.locator('#rooms')).toBeVisible()
    const quietRow = ada.locator('#roomList .roomRow', { has: ada.locator('.roomName', { hasText: 'Quiet: Rowan' }) })
    await expect(quietRow.locator('.unread')).toHaveText('quiet room: open it to read', { timeout: 30_000 })
  } finally {
    watcher.close()
    for (const context of contexts) await context.close()
  }
})

/**
 * A file dropped into a quiet room: the announcement Wildbloom would
 * normally post - a kind-1063 event naming the blob's URL and hash, signed
 * by this room's device key - never leaves the device. The chat message
 * that follows already carries what a reader needs, sealed the same way
 * every other quiet message is. Checked the same way as the text case
 * above: on the wire, from outside both browsers.
 */
test('a quiet room shares a file with no kind-1063 announcement, and the other person still opens it', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const blobOrigin = new URL(baseURL!).origin
  const contexts: BrowserContext[] = []
  const open = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
    await device(context)
    // The default Blossom server is this app's own origin. Vite proxies it
    // to the acceptance companion, which receives and serves real streamed
    // bytes so WebKit's upload path is exercised end to end.
    await routeTestBlossom(context, blobOrigin)
    contexts.push(context)
    return context.newPage()
  }
  // Every chat event and wrap since the test began, and every kind-1063
  // file announcement there has ever been reason to expect - watched from
  // outside the browsers, exactly like the text case above.
  const seen: Event[] = []
  const watcher = await Relay.connect('ws://127.0.0.1:7777')
  const since = Math.floor(Date.now() / 1000) - 5
  watcher.subscribe([{ kinds: [KINDS.CHAT, 1063], since }, { kinds: [1059] }], { onevent: (e) => seen.push(e) })
  try {
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
    const ada = await open(); await ada.goto(link)
    await ada.locator('#displayName').fill('Ada'); await ada.locator('#join').click()
    const rowan = await open(); await rowan.goto(link)
    await rowan.locator('#displayName').fill('Rowan'); await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada quietly/ }).click()
    await expect(rowan.locator('#status')).toContainText(/Quiet conversation with Ada/, { timeout: 30_000 })
    await expect(ada.locator('#chatLog')).toContainText('started a quiet conversation with you', { timeout: 30_000 })

    // The first click only starts the conversation; Rowan's sheet still
    // covers the room behind it. Close it, reopen it and click through
    // again to actually be looking at the quiet conversation - the same
    // dance the text case above does, and for the same reason: a modal
    // sheet left open makes everything behind it, including the attach
    // button used below, unclickable.
    await rowan.locator('#roomSheetClose').click()
    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada quietly/ }).click()
    await expect(rowan.locator('#roomTitle')).toHaveText('Quiet: Ada', { timeout: 30_000 })
    await ada.locator('#chatLog .system').getByRole('button', { name: 'Open Quiet: Rowan' }).click()
    await expect(ada.locator('#roomTitle')).toHaveText('Quiet: Rowan', { timeout: 30_000 })

    await expect.poll(() => seen.length).toBeGreaterThan(0)
    const wrapsBefore = seen.filter((e) => e.kind === 1059).length
    const fileAnnouncementsBefore = seen.filter((e) => e.kind === 1063).length

    await rowan.locator('#attachToggle').click()
    await rowan.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
    await rowan.locator('#attachFile').setInputFiles({ name: 'floorplan.txt', mimeType: 'text/plain', buffer: Buffer.from('Room B, second floor') })
    await expect(rowan.locator('#attachStaged .attachChip')).toHaveCount(1, { timeout: 15_000 })
    await rowan.locator('#chatInput').fill('the floorplan')
    await rowan.locator('#chatInput').press('Enter')

    // The wrap reaches the relay at a slot; the other person reads the
    // message, with its attachment, off the broadcast.
    await expect.poll(() => seen.filter((e) => e.kind === 1059).length, { timeout: 60_000, message: 'no wrap reached the relay after the send' }).toBeGreaterThan(wrapsBefore)
    await expect(ada.locator('#chatLog')).toContainText('the floorplan', { timeout: 90_000 })
    await expect(ada.locator('#chatLog .attachment')).toContainText('floorplan.txt', { timeout: 30_000 })

    // The file itself still opens: the chat message carried the url, hash
    // and key on its own, with no kind-1063 event to resolve.
    await ada.locator('#chatLog .attachment').getByRole('button', { name: 'Show' }).click()
    await expect(ada.locator('#chatLog .attachment')).toContainText('Save floorplan.txt', { timeout: 30_000 })

    // On the wire, start to finish: this share added no file announcement.
    // The relay may still return another test's recent stored event before
    // this baseline; those are not traffic from either device in this room.
    expect(seen.filter((e) => e.kind === 1063)).toHaveLength(fileAnnouncementsBefore)
  } finally {
    watcher.close()
    for (const context of contexts) await context.close()
  }
})

/**
 * A quiet room's file announcement is skipped by a decision made once, with
 * the transport that would carry it, before the upload that decision waits
 * on. This proves that holds even when the room this upload was for stops
 * being the current room while the Blossom upload is still in flight: the
 * device leaves (a keeper closing the room or removing a member reaches the
 * same code, `leaveWithNotice`, without this tab choosing anything). The
 * Blossom response is held open with a gate so the leave happens first,
 * deterministically, rather than by chance before the network round trip
 * finishes.
 */
test('a quiet room does not leak a file announcement if this device leaves while the upload is still pending', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const blobOrigin = new URL(baseURL!).origin
  let uploads = 0
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const contexts: BrowserContext[] = []
  const open = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
    await device(context)
    await context.route(`${blobOrigin}/upload`, async route => {
      uploads++
      const response = await fetchFromTestBlossom(route, blobOrigin)
      // Held open until the room has changed underneath it.
      await released
      // The request this held may already be a lost cause by the time it is
      // released - the room it was for reloaded its page - so a fulfil that
      // no longer has anywhere to land is not this test's problem.
      await route.fulfill({ response }).catch(() => {})
    })
    contexts.push(context)
    return context.newPage()
  }
  const seen: Event[] = []
  const watcher = await Relay.connect('ws://127.0.0.1:7777')
  const since = Math.floor(Date.now() / 1000) - 5
  watcher.subscribe([{ kinds: [KINDS.CHAT, 1063], since }, { kinds: [1059] }], { onevent: (e) => seen.push(e) })
  try {
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
    const ada = await open(); await ada.goto(link)
    await ada.locator('#displayName').fill('Ada'); await ada.locator('#join').click()
    const rowan = await open(); await rowan.goto(link)
    await rowan.locator('#displayName').fill('Rowan'); await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada quietly/ }).click()
    await expect(rowan.locator('#status')).toContainText(/Quiet conversation with Ada/, { timeout: 30_000 })
    await expect(ada.locator('#chatLog')).toContainText('started a quiet conversation with you', { timeout: 30_000 })
    await rowan.locator('#roomSheetClose').click()
    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada quietly/ }).click()
    await expect(rowan.locator('#roomTitle')).toHaveText('Quiet: Ada', { timeout: 30_000 })
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    const fileAnnouncementsBefore = seen.filter((e) => e.kind === 1063).length

    await rowan.locator('#attachToggle').click()
    await rowan.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
    await rowan.locator('#attachFile').setInputFiles({ name: 'blueprint.txt', mimeType: 'text/plain', buffer: Buffer.from('Room B, second floor') })
    // The upload has reached the server and is held there; the room this
    // device is in is still the quiet one.
    await expect.poll(() => uploads).toBe(1)

    // Leave now, with the upload still pending. Rowan's own device does
    // this here, but the code path is the same one a keeper closing the
    // room or removing this member reaches on its own.
    await openRoomDetails(rowan)
    await rowan.locator('#leave').click()
    await rowan.locator('#actionConfirm').click()
    // Only now let the held response through, so the room change is not a
    // race against the network but has already happened.
    release()
    await rowan.waitForTimeout(3_000)

    // Whatever became of that upload - it may never have finished, given
    // to a room that no longer exists in this tab - no kind-1063 reached
    // the relay for it.
    expect(seen.filter((e) => e.kind === 1063)).toHaveLength(fileAnnouncementsBefore)
  } finally {
    watcher.close()
    for (const context of contexts) await context.close()
  }
})
