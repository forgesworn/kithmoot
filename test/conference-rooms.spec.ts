import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import type { Event } from 'nostr-tools/pure'
import { openNewRoomForm } from './browser.js'
import { openRoomUrl } from './relays.js'
import { parseRoomLink } from '../src/link.js'
import { formatConferenceEnd } from '../app/src/conference.js'

// A conference room: a group room that ends on a fixed date and is wiped
// from relays when it does. Made here with "Ends: After 1 day", against the
// local test relay. Every event the creator's page sends is read off its
// socket, so the check covers what the relay was told, ephemeral kinds
// included, not only what it chose to keep.

/** A device whose every relay socket goes to the local test relay, as in
 *  persistent-groups.spec.ts. */
async function device(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by conference acceptance test')
        super(target, protocols)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

/** Every event this page publishes, as sent. */
function recordPublished(page: Page): Event[] {
  const sent: Event[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    try {
      const message = JSON.parse(String(frame.payload))
      if (Array.isArray(message) && message[0] === 'EVENT' && message[1] && typeof message[1] === 'object') sent.push(message[1] as Event)
    } catch { /* Not a relay frame. */ }
  }))
  return sent
}

const expirationOf = (event: Event) => event.tags.filter(t => t[0] === 'expiration').map(t => Number(t[1]))

test('a conference room ends in a day: it says so, tags what it sends, shows a QR, and refuses a late arrival', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = []
  try {
    const owner = await device(browser, baseURL!); contexts.push(owner)
    const page = await owner.newPage()
    const sent = recordPublished(page)
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Workshop')
    await expect(page.locator('#roomEndsRow')).toBeVisible()
    await page.locator('#roomEnds').selectOption('1')
    await expect(page.locator('#roomEndsHint')).toBeVisible()
    // A conference room that keeps its read-only copy, as before
    // self-destruct; a dated room self-destructs unless this is chosen.
    await page.locator('#roomWhenEnds').selectOption('keep')
    const madeAt = Math.floor(Date.now() / 1000)
    await page.locator('#create').click()
    await expect(page.locator('#join')).toBeVisible()
    const link = await page.locator('#shareUrl').inputValue()
    expect(parseRoomLink(link).invitation?.persistent).toBe(true)

    // The invitation carries the end, a day on, as a NIP-40 expiration.
    await expect.poll(() => sent.filter(e => e.kind === 1463).length).toBeGreaterThan(0)
    const [ends] = expirationOf(sent.find(e => e.kind === 1463)!)
    expect(ends).toBeGreaterThanOrEqual(madeAt + 86_400)
    expect(ends).toBeLessThanOrEqual(madeAt + 86_400 + 10)

    await page.locator('#displayName').fill('Host')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Welcome to the workshop')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Welcome to the workshop')

    // The end, in the room's header.
    // A neutral countdown pill, its date in its title.
    await expect(page.locator('#roomEndsLine')).toBeVisible()
    await expect(page.locator('#roomEndsLine')).toHaveAttribute('data-stage', 'neutral')
    await expect(page.locator('#roomEndsLine .fuseText')).toHaveText(/^Ends in 23 h \d+ m$/)
    await expect(page.locator('#roomEndsLine')).toHaveAttribute('title', `Ends ${formatConferenceEnd(ends)}`)

    // One tap to a QR big enough to scan across a table, with the end beside it.
    await page.locator('#inviteQr').click()
    await expect(page.locator('#inviteDialog')).toBeVisible()
    await expect(page.locator('#shareQr')).toBeVisible()
    await expect.poll(() => page.locator('#shareQr').evaluate(c => (c as HTMLCanvasElement).width)).toBeGreaterThanOrEqual(480)
    await expect(page.locator('#inviteEnds')).toContainText(`Ends ${formatConferenceEnd(ends)}`)
    await page.locator('#inviteClose').click()

    // Everything the page sent for the room lapses by the room's end: the
    // invitation, chat and roster at it, signals and bells sooner if their
    // own life is shorter.
    await expect.poll(() => sent.filter(e => e.kind === 1460).length).toBeGreaterThan(0)
    expect(sent.length).toBeGreaterThan(2)
    const kinds = new Set(sent.map(e => e.kind))
    expect(kinds).toContain(1460)
    expect(kinds).toContain(1463)
    expect(kinds).toContain(20461)
    for (const event of sent) {
      const tags = expirationOf(event)
      expect(tags, `kind ${event.kind} carries one expiration`).toHaveLength(1)
      expect(tags[0], `kind ${event.kind}`).toBeLessThanOrEqual(ends)
      if (event.kind !== 21059 && event.kind !== 1464) expect(tags[0], `kind ${event.kind}`).toBe(ends)
    }

    // A day and a minute later, the link refuses, with the date. The test
    // relay ignores NIP-40 and still hands out the invitation, which is the
    // case this has to cover: a relay that honours it has nothing to hand.
    const late = await device(browser, baseURL!); contexts.push(late)
    const arrival = await late.newPage()
    await arrival.clock.setFixedTime(new Date((ends + 60) * 1000))
    await openRoomUrl(arrival, link)
    await expect(arrival.locator('#arrivalTitle')).toHaveText('This room has ended')
    await expect(arrival.locator('#arrivalLead')).toContainText(`This conference room ended on ${formatConferenceEnd(ends)}.`)
    await expect(arrival.locator('#join')).toBeHidden()
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
  }
})

test('a room that asks before anyone joins offers no end', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await expect(page.locator('#roomEndsRow')).toBeVisible()
    await page.locator('#roomAsk').check()
    await expect(page.locator('#roomEndsRow')).toBeHidden()
  } finally {
    await context.close()
  }
})
