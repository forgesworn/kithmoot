import { test, expect, request as playwrightRequest, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { allowTestFileStorage, openNewRoomForm, openRoomDetails, TEST_RELAY_HTTP } from './browser.js'
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

interface BlobCall { method: string; hash: string; auth?: Event; status?: number }

/** Every Blossom upload and delete a page sends, with its authorisation
 *  decoded and the hash it names (from the upload's answer, or the URL). */
function recordBlossom(page: Page, calls: BlobCall[] = []): BlobCall[] {
  page.on('requestfinished', async req => {
    const url = new URL(req.url())
    const upload = req.method() === 'PUT' && url.pathname === '/upload'
    const blob = req.method() === 'DELETE' && url.pathname.startsWith('/blossom/')
    if (!upload && !blob) return
    const header = req.headers()['authorization']
    const auth = header?.startsWith('Nostr ') ? JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8')) as Event : undefined
    const response = await req.response()
    const hash = upload ? (await response?.json().catch(() => ({})) as { sha256?: string }).sha256 ?? '' : url.pathname.slice('/blossom/'.length)
    calls.push({ method: req.method(), hash, ...(auth ? { auth } : {}), ...(response ? { status: response.status() } : {}) })
  })
  page.on('requestfailed', req => {
    const url = new URL(req.url())
    if (req.method() === 'DELETE' && url.pathname.startsWith('/blossom/')) calls.push({ method: 'DELETE', hash: url.pathname.slice('/blossom/'.length) })
  })
  return calls
}

/** Share a file into the room's chat from this page. */
async function shareFile(page: Page, baseURL: string, name: string) {
  await allowTestFileStorage(page, new URL(baseURL).origin)
  await page.locator('#attachFile').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name} contents`) })
  await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
  await page.locator('#chatForm button[type=submit]').click()
  await expect(page.locator('#chatLog .attachment').filter({ hasText: name })).toBeVisible()
}

/** Whether the test Blossom store still serves a blob, asked from outside
 *  the browser. */
async function stored(hash: string): Promise<boolean> {
  const api = await playwrightRequest.newContext()
  try { return (await api.get(`${TEST_RELAY_HTTP}/blossom/${hash}`)).status() === 200 } finally { await api.dispose() }
}

/** Each upload this page made was asked to be deleted, with a valid BUD-02
 *  authorisation from the key that uploaded it, and the bytes are gone. */
async function expectOwnUploadsDeleted(calls: BlobCall[]) {
  const uploads = calls.filter(c => c.method === 'PUT' && c.hash)
  expect(uploads.length).toBeGreaterThan(0)
  for (const upload of uploads) {
    await expect.poll(() => calls.some(c => c.method === 'DELETE' && c.hash === upload.hash && c.status === 200), { timeout: 30_000 }).toBe(true)
    const del = calls.find(c => c.method === 'DELETE' && c.hash === upload.hash && c.status === 200)!
    expect(verifyEvent(del.auth!)).toBe(true)
    expect(del.auth!.kind).toBe(24242)
    expect(del.auth!.tags).toContainEqual(['t', 'delete'])
    expect(del.auth!.tags).toContainEqual(['x', upload.hash])
    expect(del.auth!.pubkey).toBe(upload.auth!.pubkey)
    expect(await stored(upload.hash)).toBe(false)
  }
  // Nobody else's file was asked for.
  const own = new Set(uploads.map(u => u.hash))
  expect(calls.filter(c => c.method === 'DELETE').every(c => own.has(c.hash))).toBe(true)
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
    const hostBlobs = recordBlossom(page)
    await shareFile(page, baseURL!, 'burn.txt')

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
    // The file it shared, deleted from the file server by the key that put it there.
    await expectOwnUploadsDeleted(hostBlobs)
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
    // No end: no choice at creation; Self-destruct now is the way (D5).
    await expect(page.locator('#roomWhenEndsRow')).toBeHidden()
    await page.locator('#create').click()
    await expect(page.locator('#join')).toBeVisible()
    const link = await page.locator('#shareUrl').inputValue()
    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#roomEndsLine')).toBeHidden()
    const roomId = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.'))!.slice('kithmoot.room.'.length))

    const hostBlobs = recordBlossom(page)
    await shareFile(page, baseURL!, 'host-notes.txt')

    const member = await device(browser, baseURL!); contexts.push(member)
    const other = await member.newPage()
    const memberSent = recordPublished(other)
    const memberBlobs = recordBlossom(other)
    await enter(other, link, 'Member')
    await other.locator('#chatInput').fill('Member here')
    await other.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Member here')
    await shareFile(other, baseURL!, 'member-notes.txt')
    await expect(page.locator('#chatLog .attachment').filter({ hasText: 'member-notes.txt' })).toBeVisible()
    await openRoomDetails(other)
    await expect(other.locator('#selfDestructNow')).toBeHidden()
    await other.locator('#roomSheetClose').click()

    await openRoomDetails(page)
    await page.locator('#selfDestructNow').click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Self-destruct Planning now?')
    await expect(dialog).toContainText('asks the file server to delete the files each device shared')
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
    // Each device deleted the file it shared from the file server, and
    // only that: the other's is the other's to delete.
    await expectOwnUploadsDeleted(hostBlobs)
    await expectOwnUploadsDeleted(memberBlobs)
    for (const who of [page, other]) expect(await who.evaluate(() => localStorage.getItem('kithmoot.blob-deletes.v1'))).toBeNull()
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
  }
})

for (const [flagged, path] of [[true, 'rooms list'], [false, 'rooms list'], [false, 'room link']] as const) {
  test(`a member away when the room is made to self-destruct tidies it away from the ${path} (${flagged ? 'flagged at creation' : 'flagged only at closure'})`, async ({ browser, baseURL }, info) => {
    test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
    test.setTimeout(150_000)
    const contexts: BrowserContext[] = []
    try {
      const owner = await device(browser, baseURL!); contexts.push(owner)
      const page = await owner.newPage()
      await page.goto(baseURL!)
      await openNewRoomForm(page)
      await page.locator('#roomName').fill('Away')
      // Flagged at creation: a week-long room that self-destructs. Not: a
      // room with no end, made to self-destruct only by its closing rekey.
      if (flagged) await page.locator('#roomEnds').selectOption('7')
      await page.locator('#create').click()
      await expect(page.locator('#join')).toBeVisible()
      const link = await page.locator('#shareUrl').inputValue()
      await page.locator('#displayName').fill('Host')
      await page.locator('#join').click()
      await expect(page.locator('#roomArea')).toBeVisible()
      const roomId = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.'))!.slice('kithmoot.room.'.length))

      const away = await device(browser, baseURL!); contexts.push(away)
      let other = await away.newPage()
      const awaySent = recordPublished(other)
      await enter(other, link, 'Member')
      await other.locator('#chatInput').fill('Said before going away')
      await other.locator('#chatInput').press('Enter')
      await expect(page.locator('#chatLog')).toContainText('Said before going away')
      const memberChat = awaySent.find(e => e.kind === 1460)!
      // Away: the tab closed, with the rooms list's watch closed too.
      await other.goto('about:blank')
      await other.close()

      await openRoomDetails(page)
      await page.locator('#selfDestructNow').click()
      await page.locator('#actionConfirm').click()
      await expect(page.locator('#status')).toContainText('This room self-destructed.', { timeout: 45_000 })

      other = await away.newPage()
      recordPublished(other, awaySent)
      // Back on the rooms list, or at the room's own link: a kept member's
      // door offers Join, and joining finds the closing rekey.
      if (path === 'rooms list') await other.goto(baseURL!)
      else {
        await openRoomUrl(other, link)
        await expect(other.locator('#join, #arrivalTitle:has-text("ended")').first()).toBeVisible()
        if (await other.locator('#join').isVisible()) await other.locator('#join').click()
      }
      await expect.poll(() => deletionsAsked(awaySent).has(memberChat.id), { timeout: 45_000 }).toBe(true)
      await expect.poll(() => traces(other, [roomId]), { timeout: 30_000 }).toEqual([])
      await other.goto(baseURL!)
      await expect(other.locator('#roomList .tombstoneRow')).toHaveCount(1)
    } finally {
      for (const context of contexts) await context.close().catch(() => {})
    }
  })
}

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
    // The countdown sits on its own line under the name, so a narrow rail
    // never squeezes the name to a letter a line beside it.
    for (const width of [undefined, 200]) {
      if (width) await page.locator('#workspaceNav').evaluate((el, w) => { el.style.width = `${w}px`; el.style.minWidth = `${w}px`; el.style.maxWidth = `${w}px` }, width)
      const name = (await row.locator('.workspaceRoomLink').boundingBox())!
      const pill = (await row.locator('.fusePill').boundingBox())!
      expect(pill.y, `rail ${width ?? 'default'}px: the countdown is under the name`).toBeGreaterThanOrEqual(name.y + name.height - 8)
      expect(name.height, `rail ${width ?? 'default'}px: the name is one line`).toBeLessThan(48)
    }
  } finally {
    await context.close()
  }
})

test('Leave and tidy up deletes the files this device shared, and tries again at the next launch when the server was down', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
  test.setTimeout(120_000)
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    const blobs = recordBlossom(page)
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Files')
    await page.locator('#create').click()
    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const roomId = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kithmoot.room.'))!.slice('kithmoot.room.'.length))
    await shareFile(page, baseURL!, 'first.txt')
    await shareFile(page, baseURL!, 'second.txt')
    const uploads = blobs.filter(c => c.method === 'PUT')
    expect(uploads).toHaveLength(2)
    // What this device keeps: where each file is, under the room; no name.
    const record = await page.evaluate(roomId => localStorage.getItem(`kithmoot.uploads.v1.${roomId}`), roomId)
    expect(record).toContain(uploads[0]!.hash)
    expect(record).not.toContain('first.txt')

    // The file server is down for the tidy-up.
    await context.route(url => url.pathname.startsWith('/blossom/'), route => route.request().method() === 'DELETE' ? route.abort('connectionrefused') : route.fallback())
    await openRoomDetails(page)
    await page.locator('#tidyUpRoom').click()
    await expect(page.locator('#tidyUpLead')).toContainText('ask the file server to delete the files this device shared')
    await expect(page.locator('#tidyUpSteps li[data-step="files"]')).toContainText('Ask the file server to delete the files this device shared in the room')
    await expect(page.locator('#tidyUpLimits')).toContainText('Files other members shared are theirs')
    await page.locator('#tidyUpRun').click()
    await expect(page.locator('#tidyUpDone')).toBeVisible({ timeout: 60_000 })
    const step = page.locator('#tidyUpSteps li[data-step="files"] .tidyResult')
    await expect(step).toContainText('Deleted 0 of 2.')
    await expect(step).toContainText('asks again each time it starts, for 7 days')
    for (const upload of uploads) expect(await stored(upload.hash)).toBe(true)
    // The room is wiped all the same; the deletes kept name no room.
    await expect.poll(() => page.evaluate(roomId => Object.keys(localStorage).filter(key => key.includes(roomId)), roomId)).toEqual([])
    const pending = await page.evaluate(() => localStorage.getItem('kithmoot.blob-deletes.v1'))
    expect(pending).toBeTruthy()
    expect(pending).not.toContain(roomId)
    await page.locator('#tidyUpDone').click()

    // The next launch, with the server back: both deleted.
    await context.unrouteAll()
    await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
    await page.goto(baseURL!)
    await expectOwnUploadsDeleted(blobs)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('kithmoot.blob-deletes.v1'))).toBeNull()
  } finally {
    await context.close()
  }
})
