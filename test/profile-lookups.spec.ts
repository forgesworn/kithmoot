import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { openRoomDetails } from './browser.js'

/**
 * Public-profile lookups, as a relay meets them. A lookup is a plaintext
 * query naming people's keys, so what is checked here is what leaves the
 * browser and not what the screen shows: every frame a page sends to any
 * relay is recorded, the room's own and the public profile relays alike.
 * See `app/src/profile-lookups.ts` for the rule.
 */

type Frame = { url: string; frame: unknown[] }

async function device(context: BrowserContext, relay: string): Promise<Frame[]> {
  const sent: Frame[] = []
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(() => true, ws => {
    const url = ws.url()
    if (url === relay) {
      const server = ws.connectToServer()
      ws.onMessage(raw => { sent.push({ url, frame: JSON.parse(String(raw)) as unknown[] }); server.send(raw) })
      return
    }
    // A public profile relay: never reached, and it finds nobody, but what
    // the page would have asked of it is kept.
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as unknown[]
      sent.push({ url, frame })
      if (frame[0] === 'REQ') ws.send(JSON.stringify(['EOSE', frame[1]]))
    })
  })
  return sent
}

/** The keys a page has asked any relay for a profile of. */
function asked(sent: Frame[]): string[] {
  const authors = new Set<string>()
  for (const { frame } of sent) {
    if (frame[0] !== 'REQ') continue
    for (const filter of frame.slice(2) as { kinds?: number[]; authors?: string[] }[]) {
      if (filter.kinds?.includes(0)) for (const author of filter.authors ?? []) authors.add(author)
    }
  }
  return [...authors]
}

async function openProfileSettings(page: Page): Promise<void> {
  await openRoomDetails(page)
  await page.locator('#roomProfileSettings').click()
  await expect(page.locator('#profileSettings')).toHaveJSProperty('open', true)
}

test('an open room looks people up, a direct message does not until asked, and nobody looks up a key their own browser made', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const contexts: BrowserContext[] = []
  const open = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    const sent = await device(context, relay.href)
    contexts.push(context)
    return { page: await context.newPage(), sent }
  }
  try {
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
    const ada = await open(); await ada.page.goto(link)
    await ada.page.locator('#displayName').fill('Ada'); await ada.page.locator('#join').click()
    const rowan = await open(); await rowan.page.goto(link)
    await rowan.page.locator('#displayName').fill('Rowan'); await rowan.page.locator('#join').click()
    await expect(rowan.page.locator('#roomArea')).toBeVisible()

    // In the open room each asks about the other, on the room's relay and
    // on the public ones, and neither asks about the key it made itself.
    await expect.poll(() => asked(ada.sent).length, { timeout: 60_000 }).toBe(1)
    await expect.poll(() => asked(rowan.sent).length, { timeout: 60_000 }).toBe(1)
    const adaKey = asked(rowan.sent)[0]!, rowanKey = asked(ada.sent)[0]!
    expect(adaKey).not.toBe(rowanKey)
    expect(new Set(ada.sent.filter(f => f.frame[0] === 'REQ' && asked([f]).length).map(f => f.url)).size).toBeGreaterThan(1)

    // A direct message. From here on Rowan's browser asks nothing.
    // Started from Ada's row, which tells her; asked for again, it opens.
    await openRoomDetails(rowan.page)
    await rowan.page.getByRole('button', { name: /^Message Ada privately/ }).click()
    await expect(rowan.page.locator('#status')).toContainText(/Private conversation with Ada/, { timeout: 30_000 })
    await expect(ada.page.locator('#chatLog')).toContainText('started a private conversation with you', { timeout: 30_000 })
    await openRoomDetails(rowan.page)
    await rowan.page.getByRole('button', { name: /^Message Ada privately/ }).click()
    await expect(rowan.page.locator('#roomTitle')).toHaveText('Private: Ada', { timeout: 30_000 })
    // All the open room ever asked, after every render it had: the other
    // person, and never the asker.
    expect(asked(rowan.sent)).toEqual([adaKey])
    rowan.sent.length = 0
    await ada.page.locator('#chatLog .system').getByRole('button', { name: 'Open Private: Rowan' }).click({ timeout: 30_000 })
    await expect(ada.page.locator('#roomTitle')).toHaveText('Private: Rowan', { timeout: 30_000 })
    expect(asked(ada.sent)).toEqual([rowanKey])
    ada.sent.length = 0
    await ada.page.locator('#chatInput').fill('Only the two of us')
    await ada.page.locator('#chatInput').press('Enter')
    await expect(rowan.page.locator('#chatLog')).toContainText('Only the two of us', { timeout: 60_000 })
    await rowan.page.locator('#chatInput').fill('And no relay told who')
    await rowan.page.locator('#chatInput').press('Enter')
    await expect(ada.page.locator('#chatLog')).toContainText('And no relay told who', { timeout: 60_000 })
    expect(asked(rowan.sent)).toEqual([])
    expect(asked(ada.sent)).toEqual([])
    // The name learned from the roster is still there.
    await expect(rowan.page.locator('#chatLog')).toContainText('Ada')

    // And the room says why there are no faces, where the switch is.
    await openProfileSettings(rowan.page)
    await expect(rowan.page.locator('#lookupProfiles')).toBeChecked()
    await expect(rowan.page.locator('#lookupProfilesMemberRooms')).not.toBeChecked()
    await expect(rowan.page.locator('#lookupHeld')).toBeVisible()
    await expect(rowan.page.locator('#lookupRelays')).toBeHidden()

    // Asked for, it looks up the other person and still not itself, and
    // names the relays it asks.
    await rowan.page.locator('#lookupProfilesMemberRooms').check()
    await expect(rowan.page.locator('#lookupHeld')).toBeHidden()
    await expect(rowan.page.locator('#lookupRelays')).toContainText('purplepag.es')
    await expect(rowan.page.locator('#lookupRelays')).toContainText(relay.host)
    await rowan.page.locator('#profileSettingsClose').click()
    await expect.poll(() => asked(rowan.sent), { timeout: 60_000 }).toEqual([adaKey])
    // Ada never turned hers on.
    expect(asked(ada.sent)).toEqual([])

    // The first switch off turns both off, and the second cannot be set.
    await openProfileSettings(rowan.page)
    await rowan.page.locator('#lookupProfiles').uncheck()
    await expect(rowan.page.locator('#lookupProfilesMemberRooms')).toBeDisabled()
    await rowan.page.locator('#profileSettingsClose').click()
    await openRoomDetails(rowan.page)
    await expect(rowan.page.locator('#roomProfileSettings')).toHaveText('Profile pictures: off')
  } finally {
    for (const context of contexts) await context.close()
  }
})

test('the rooms list asks no relay about anybody', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const contexts: BrowserContext[] = []
  const open = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    const sent = await device(context, relay.href)
    contexts.push(context)
    return { page: await context.newPage(), sent }
  }
  try {
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
    const ada = await open(); await ada.page.goto(link)
    await ada.page.locator('#displayName').fill('Ada'); await ada.page.locator('#join').click()
    await expect(ada.page.locator('#roomArea')).toBeVisible()
    const rowan = await open(); await rowan.page.goto(link)
    await rowan.page.locator('#displayName').fill('Rowan'); await rowan.page.locator('#join').click()
    await expect(rowan.page.locator('#roomArea')).toBeVisible()
    await expect.poll(() => asked(rowan.sent).length, { timeout: 60_000 }).toBe(1)

    // Rowan goes back to the list while Ada stays. The list shows that
    // somebody is there, and it learned that without a lookup.
    await rowan.page.locator('#backToRooms').click()
    await rowan.page.locator('#roomSwitcherHome').click()
    rowan.sent.length = 0
    const row = rowan.page.getByRole('button', { name: 'Open Workshop', exact: true })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await ada.page.locator('#chatInput').fill('Still here')
    await ada.page.locator('#chatInput').press('Enter')
    await expect(row).toContainText('Still here', { timeout: 60_000 })
    // Presence is heard a heartbeat at a time, so wait until the list
    // knows Ada is there: that is the moment it used to ask about her.
    await expect(rowan.page.locator('.here')).toHaveText('1 here', { timeout: 90_000 })
    expect(asked(rowan.sent)).toEqual([])
  } finally {
    for (const context of contexts) await context.close()
  }
})
