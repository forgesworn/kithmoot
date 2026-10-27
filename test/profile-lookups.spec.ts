import { test, expect, type BrowserContext } from '@playwright/test'
import { bytesToHex } from '@noble/hashes/utils'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { accountDevice, signInAccount } from './nostr-account.js'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { dmPolicy } from '../src/dm.js'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { joinWithMedia, leaveToChats, newDeviceContext, openNewRoomForm, nameCreator, openRoomDetails, openProfileSettings, TEST_RELAY_WS } from './browser.js'

/**
 * Public-profile lookups, as a relay meets them. A lookup is a plaintext
 * query naming people's keys, so what is checked here is what leaves the
 * browser and not what the screen shows: every frame a page sends to any
 * relay is recorded, the room's own and the public profile relays alike.
 *
 * Two rules are held to. A browser never asks about the name-only key it
 * made for itself. And the people in the chats list, who are not in the room
 * on screen, are asked about on the public profile relays alone, so the
 * relays of whichever room happens to be open do not learn who the person
 * talks to elsewhere.
 */

test('saved public profile opt-out survives actual app startup and reload', async ({ page, context, baseURL }) => {
  await context.addInitScript(() => localStorage.setItem('kithmoot.profiles.enabled', 'false'))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(baseURL!)
  await expect(page.locator('html')).toHaveAttribute('data-ordinary-startup', 'ready')
  await expect(page.locator('#ordinaryStartupNotice')).toBeHidden()
  await openProfileSettings(page)
  await expect(page.locator('#lookupProfiles')).not.toBeChecked()
  await page.locator('#profileSettingsClose').click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-ordinary-startup', 'ready')
  await expect(page.locator('#ordinaryStartupNotice')).toBeHidden()
  expect(errors).toEqual([])
})

test('the signed-in account keeps its own kind-0 name with directory lookups off, including after reload', async ({ browser, baseURL }) => {
  const secret = generateSecretKey(), pubkey = getPublicKey(secret)
  const profile = finalizeEvent({ kind: 0, tags: [], created_at: Math.floor(Date.now() / 1000), content: '{"name":"TheCryptoDonkey"}' }, secret)
  const context = await accountDevice(browser, baseURL!, secret)
  await context.addInitScript(() => localStorage.setItem('kithmoot.profiles.enabled', 'false'))
  const authors: string[] = []
  await context.routeWebSocket(() => true, ws => {
    const server = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'REQ') {
        const filters = frame.slice(2) as { kinds?: number[]; authors?: string[] }[]
        for (const filter of filters) {
          if (!filter.kinds?.includes(0)) continue
          authors.push(...filter.authors ?? [])
          if (filter.authors?.includes(pubkey)) ws.send(JSON.stringify(['EVENT', frame[1], profile]))
        }
      }
      server.send(raw)
    })
  })
  try {
    const page = await context.newPage()
    await signInAccount(page, baseURL!)
    await expect(page.locator('#accountProfile')).toContainText('TheCryptoDonkey')
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Own account name')
    await nameCreator(page, 'Typed fallback')
    await page.locator('#create').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await openRoomDetails(page)
    await expect(page.locator('#sendingIdentity')).toBeVisible()
    await expect(page.locator('#sendingIdentity')).toContainText('TheCryptoDonkey')
    await page.screenshot({ path: test.info().outputPath('own-account-name-phone.png'), fullPage: true })
    await page.locator('#roomSheetClose').click()
    await page.reload()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await openRoomDetails(page)
    await expect(page.locator('#sendingIdentity')).toBeVisible()
    await expect(page.locator('#accountProfile')).toContainText('TheCryptoDonkey')
    await expect(page.locator('#sendingIdentity')).toContainText('TheCryptoDonkey')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: test.info().outputPath('own-account-name-desktop.png'), fullPage: true })
    await page.locator('#roomSheetClose').click()
    await openProfileSettings(page)
    await expect(page.locator('#lookupProfiles')).not.toBeChecked()
    expect(authors.length).toBeGreaterThan(0)
    expect([...new Set(authors)]).toEqual([pubkey])
  } finally { await context.close() }
})

const PUBLIC_PROFILE_HOSTS = ['purplepag.es', 'relay.damus.io', 'relay.primal.net']

type Frame = { url: string; frame: unknown[] }

/** Record every frame the page sends. The room's relay is the real one; any
 *  other relay is a stand-in that finds nobody, but keeps what it was asked. */
async function record(context: BrowserContext, roomRelay: string): Promise<Frame[]> {
  const sent: Frame[] = []
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(() => true, ws => {
    const url = ws.url()
    if (url === roomRelay) {
      const server = ws.connectToServer()
      ws.onMessage(raw => { sent.push({ url, frame: JSON.parse(String(raw)) as unknown[] }); server.send(raw) })
      return
    }
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as unknown[]
      sent.push({ url, frame })
      if (frame[0] === 'REQ') ws.send(JSON.stringify(['EOSE', frame[1]]))
      if (frame[0] === 'EVENT') ws.send(JSON.stringify(['OK', (frame[1] as { id: string }).id, true, '']))
    })
  })
  return sent
}

/** Every profile (kind 0) question in the frames, with the relay it went to. */
function asks(sent: Frame[]): { url: string; authors: string[] }[] {
  const found: { url: string; authors: string[] }[] = []
  for (const { url, frame } of sent) {
    if (frame[0] !== 'REQ') continue
    for (const filter of frame.slice(2) as { kinds?: number[]; authors?: string[] }[]) {
      if (filter.kinds?.includes(0)) found.push({ url, authors: filter.authors ?? [] })
    }
  }
  return found
}

/** The relays that were asked about this key. */
const relaysAskedAbout = (sent: Frame[], pubkey: string): string[] => [...new Set(asks(sent).filter(ask => ask.authors.includes(pubkey)).map(ask => ask.url))]
const hostOf = (url: string): string => new URL(url).host

/** A browser that already holds a name-only participant key, and the private
 *  chats it already has, as a browser that has been used before does. */
async function seed(context: BrowserContext, participant: Uint8Array, rooms: { id: string; link: string; name: string }[]): Promise<void> {
  await context.addInitScript(({ key, rooms }) => {
    if (localStorage.getItem('test.profile-lookups-seeded')) return
    localStorage.setItem('test.profile-lookups-seeded', '1')
    localStorage.setItem('kithmoot.profiles.enabled', 'true')
    localStorage.setItem('kithmoot.participant', key)
    for (const room of rooms) {
      localStorage.setItem('kithmoot.room.' + room.id, JSON.stringify({ link: room.link, name: room.name, openedAt: Math.floor(Date.now() / 1000), readAt: 0 }))
    }
  }, { key: bytesToHex(participant), rooms })
}

test('a browser never asks any relay about the name-only key it made itself, and does ask about the people in the room', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const roomRelay = new URL('/__test-relay', baseURL); roomRelay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  const sent = await record(context, roomRelay.href)
  const own = generateSecretKey(), ownKey = getPublicKey(own)
  await seed(context, own, [])
  const ada = localIdentity(generateSecretKey())
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [roomRelay.href], iceUrls: [] })
  const agent = await RoomAgent.join({ link, identity: ada, relays: [TEST_RELAY_WS], name: 'Ada' })
  try {
    const page = await context.newPage()
    await page.goto(link)
    await page.locator('#displayName').fill('Rowan')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await agent.chat.send('Hello from Ada')
    await expect(page.locator('#chatLog')).toContainText('Hello from Ada', { timeout: 60_000 })
    await page.locator('#chatInput').fill('Said by the key this browser made')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Said by the key this browser made')

    // Somebody else in the room is asked about, on the room's relay as well
    // as the public ones: the control that shows the recorder would have
    // seen a question about this browser's own key had one been sent.
    await expect.poll(() => relaysAskedAbout(sent, ada.pubkey).length, { timeout: 60_000 }).toBeGreaterThan(1)
    const askedOf = relaysAskedAbout(sent, ada.pubkey)
    expect(askedOf).toContain(roomRelay.href)
    expect(askedOf.map(hostOf)).toEqual(expect.arrayContaining(PUBLIC_PROFILE_HOSTS.slice(0, 1)))

    // The browser's own key was on screen all that time, in the roster and
    // on its message, and no relay was asked about it.
    expect(asks(sent).flatMap(ask => ask.authors)).not.toContain(ownKey)
    // Nor is it asked when the room is left for the list and opened again.
    // A room this browser has joined opens again from its link by itself.
    await page.reload()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => asks(sent).length, { timeout: 60_000 }).toBeGreaterThan(0)
    expect(asks(sent).flatMap(ask => ask.authors)).not.toContain(ownKey)
  } finally {
    await agent.leave()
    await context.close()
  }
})

test('a private chat peer who is not in the open room is asked about on the public profile relays and never on the room’s', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const roomRelay = new URL('/__test-relay', baseURL); roomRelay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  const sent = await record(context, roomRelay.href)
  const own = generateSecretKey(), ownKey = getPublicKey(own)
  const peer = getPublicKey(generateSecretKey())
  const privateSecret = generateRoomSecret()
  const privateLink = encodeJoinUrl(baseURL!, privateSecret, [roomRelay.href], dmPolicy(ownKey, peer))
  const privateId = deriveRoom(privateSecret).roomId
  await seed(context, own, [{ id: privateId, link: privateLink, name: 'Peer' }])
  const ada = localIdentity(generateSecretKey())
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [roomRelay.href], iceUrls: [] })
  const agent = await RoomAgent.join({ link, identity: ada, relays: [TEST_RELAY_WS], name: 'Ada' })
  try {
    const page = await context.newPage()
    await page.goto(link)
    await page.locator('#displayName').fill('Rowan')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await agent.chat.send('Hello from Ada')
    await expect(page.locator('#chatLog')).toContainText('Hello from Ada', { timeout: 60_000 })
    // The private chat is on the list beside the room.
    await expect(page.locator(`#roomList [data-room="${privateId}"]`)).toBeVisible({ timeout: 60_000 })

    // The peer is asked about, where the public profiles are...
    await expect.poll(() => relaysAskedAbout(sent, peer).length, { timeout: 60_000 }).toBeGreaterThan(0)
    // ...and the person in the room is asked about on the room's relay, so
    // the control holds: the room's relay would have been asked about the
    // peer too, had the peer's lookup gone there.
    await expect.poll(() => relaysAskedAbout(sent, ada.pubkey), { timeout: 60_000 }).toContain(roomRelay.href)
    const askedOfPeer = relaysAskedAbout(sent, peer)
    expect(askedOfPeer).not.toContain(roomRelay.href)
    expect(askedOfPeer.map(hostOf).every(host => PUBLIC_PROFILE_HOSTS.includes(host))).toBe(true)
    expect(asks(sent).flatMap(ask => ask.authors)).not.toContain(ownKey)

    // The dialog that holds the switch names the servers a lookup asks.
    await openProfileSettings(page)
    for (const host of PUBLIC_PROFILE_HOSTS) await expect(page.locator('#lookupHosts')).toContainText(host)
    await expect(page.locator('#lookupHosts')).not.toContainText(roomRelay.host)
  } finally {
    await agent.leave()
    await context.close()
  }
})

test('going home on a docked call closes the room’s lookups, so its people are asked about afresh on coming back', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium supplies the synthetic microphone and camera')
  test.setTimeout(180_000)
  const roomRelay = new URL('/__test-relay', baseURL); roomRelay.protocol = 'wss:'
  const context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => localStorage.setItem('kithmoot.profiles.enabled', 'true'))
  const sent = await record(context, roomRelay.href)
  const bo = localIdentity(generateSecretKey())
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [roomRelay.href], iceUrls: [] })
  const agent = await RoomAgent.join({ link, identity: bo, relays: [TEST_RELAY_WS], name: 'Bo' })
  try {
    const page = await context.newPage()
    await joinWithMedia(page, link, 'Ada')
    await agent.chat.send('Hello from Bo')
    await expect(page.locator('#chatLog')).toContainText('Hello from Bo', { timeout: 60_000 })
    const askedOnRoomRelay = () => asks(sent).filter(ask => ask.url === roomRelay.href && ask.authors.includes(bo.pubkey)).length
    await expect.poll(askedOnRoomRelay, { timeout: 60_000 }).toBeGreaterThan(0)
    const before = askedOnRoomRelay()

    // Home, with the call kept on a dock. The room's lookups end here; the
    // room's relays stay in the lookup pool only if this did not restart it.
    const mark = sent.length
    await leaveToChats(page)
    await expect(page.locator('#callDock')).toBeVisible()
    // The docked call's people are not the room on screen's, and nothing is
    // asked about them anywhere but the public profile relays.
    await page.waitForTimeout(2_000)
    const atHome = asks(sent.slice(mark))
    expect(atHome.every(ask => PUBLIC_PROFILE_HOSTS.includes(hostOf(ask.url)))).toBe(true)
    // Back, to the same room and the same call without a rejoin. Its people
    // are asked about again, which only happens if the book was restarted.
    await page.locator('#callDockBack').click()
    await expect(page.locator('#callDock')).toBeHidden()
    await expect(page.locator('#callBay')).toBeVisible()
    await expect.poll(askedOnRoomRelay, { timeout: 60_000 }).toBeGreaterThan(before)
  } finally {
    await agent.leave()
    await context.close()
  }
})
