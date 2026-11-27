import { test, expect, type BrowserContext } from '@playwright/test'
import { bytesToHex } from '@noble/hashes/utils'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { accountDevice, signInAccount } from './nostr-account.js'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { dmPolicy } from '../src/dm.js'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { joinWithMedia, leaveToChats, newDeviceContext, openNewRoomForm, nameCreator, openRoomInfoPage, openProfileSettings, TEST_RELAY_WS } from './browser.js'

/**
 * Public-profile lookups, as a relay meets them. A lookup is a plaintext
 * query naming people's keys, so what is checked here is what leaves the
 * browser and not what the screen shows: every frame a page sends to any
 * relay is recorded, the room's own and the public profile relays alike.
 *
 * A room or chat should never prompt a lookup of its participants, even
 * with the public People directory enabled.
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
    await openRoomInfoPage(page, 'How you appear')
    await expect(page.locator('#sendingIdentity')).toBeVisible()
    await expect(page.locator('#sendingIdentity')).toContainText('TheCryptoDonkey')
    await expect(page.locator('#sendingIdentity .sendingName')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('own-account-name-phone.png'), fullPage: true })
    await page.locator('#roomSheetClose').click()
    await page.reload()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await openRoomInfoPage(page, 'How you appear')
    await expect(page.locator('#sendingIdentity')).toBeVisible()
    await expect(page.locator('#accountProfile')).toContainText('TheCryptoDonkey')
    await expect(page.locator('#sendingIdentity')).toContainText('TheCryptoDonkey')
    await expect(page.locator('#sendingIdentity .sendingName')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: test.info().outputPath('own-account-name-desktop.png'), fullPage: true })
    await page.locator('#roomSheetClose').click()
    await openProfileSettings(page)
    await expect(page.locator('#lookupProfiles')).not.toBeChecked()
    expect(authors.length).toBeGreaterThan(0)
    expect([...new Set(authors)]).toEqual([pubkey])
  } finally { await context.close() }
})

const PUBLIC_PROFILE_HOSTS = ['purplepag.es', 'relay.primal.net']

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

test('room participants do not trigger kind-0 queries, including after reopening', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const roomRelay = new URL('/__test-relay', baseURL); roomRelay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  const sent = await record(context, roomRelay.href)
  const own = generateSecretKey()
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

    expect(asks(sent)).toEqual([])
    await page.reload()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#chatLog')).toContainText('Hello from Ada')
    expect(asks(sent)).toEqual([])
  } finally {
    await agent.leave()
    await context.close()
  }
})

test('private chats in the rooms list do not trigger kind-0 queries', async ({ browser, baseURL }) => {
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

    // The dialog that holds the switch names the servers a lookup asks.
    await openProfileSettings(page)
    for (const host of PUBLIC_PROFILE_HOSTS) await expect(page.locator('#lookupHosts')).toContainText(host)
    await expect(page.locator('#lookupHosts')).not.toContainText(roomRelay.host)
    expect(asks(sent)).toEqual([])
  } finally {
    await agent.leave()
    await context.close()
  }
})

test('docking a call and returning to it do not trigger kind-0 queries', async ({ browser, baseURL }) => {
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
    await leaveToChats(page)
    await expect(page.locator('#callDock')).toBeVisible()
    await page.locator('#callDockBack').click()
    await expect(page.locator('#callDock')).toBeHidden()
    await expect(page.locator('#callBay')).toBeVisible()
    expect(asks(sent)).toEqual([])
  } finally {
    await agent.leave()
    await context.close()
  }
})
