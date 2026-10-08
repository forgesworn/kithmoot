import { test, expect, type Browser } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { dmPolicy } from '../src/dm.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { readFile } from 'node:fs/promises'
import { TEST_RELAY_WS } from './relays.js'

async function device(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const sockets: WebSocket[] = []
    ;(window as typeof window & { testSockets: WebSocket[] }).testSockets = sockets
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by test')
        super(target, protocols)
        sockets.push(this)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return { context, relay: relay.href }
}

test('private chat rows show the peer picture before opening and respect the profile switch', async ({ browser, baseURL }) => {
  const { context, relay } = await device(browser, baseURL!)
  const selfKey = generateSecretKey(), peerKey = generateSecretKey()
  const self = getPublicKey(selfKey), peer = getPublicKey(peerKey)
  const secret = generateRoomSecret(), groupSecret = generateRoomSecret()
  const privateId = deriveRoom(secret).roomId, groupId = deriveRoom(groupSecret).roomId
  const picture = 'https://avatars.example.test/peer.png'
  const ownPicture = 'https://avatars.example.test/self.png'
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  const requests: string[] = []
  await context.route('https://avatars.example.test/**', async route => {
    requests.push(route.request().url())
    expect(route.request().headers()['referer']).toBeUndefined()
    await route.fulfill({ contentType: 'image/png', body: await readFile('app/public/pwa-192x192.png') })
  })
  await context.addInitScript(({ key, rooms }) => {
    if (localStorage.getItem('test.avatar-seeded')) return
    localStorage.setItem('test.avatar-seeded', '1')
    localStorage.setItem('kithmoot.participant', key)
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.id, JSON.stringify(room.value))
  }, { key: Array.from(selfKey, x => x.toString(16).padStart(2, '0')).join(''), rooms: [
    { id: privateId, value: { link: encodeJoinUrl(baseURL!, secret, [relay], dmPolicy(self, peer)), name: 'Peer', openedAt: Math.floor(Date.now()/1000), readAt: 0 } },
    { id: groupId, value: { link: encodeJoinUrl(baseURL!, groupSecret, [relay]), name: 'Group', openedAt: Math.floor(Date.now()/1000), readAt: 0 } },
  ] })
  try {
    for (const [key, url] of [[peerKey, picture], [selfKey, ownPicture]] as const) {
      await pool.publish(finalizeEvent({ kind: 0, tags: [], created_at: Math.floor(Date.now()/1000), content: JSON.stringify({ picture: url }) }, key))
    }
    const page = await context.newPage()
    await page.goto(baseURL!)
    const avatar = page.locator(`#roomList [data-room="${privateId}"] .roomAvatar img`)
    await expect(avatar).toHaveAttribute('src', picture)
    await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await expect(page.locator(`#roomList [data-room="${groupId}"] .roomAvatar img`)).toHaveCount(0)
    await page.reload()
    await expect(avatar).toHaveAttribute('src', picture)
    await page.locator('#openAppSettings').click()
    await page.locator('#appConnections > summary').click()
    await page.locator('#appProfileSettings').click()
    await page.locator('#lookupProfiles').uncheck()
    await expect(avatar).toHaveCount(0)
    const count = requests.filter(url => url === picture).length
    await page.reload()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(2)
    await expect(avatar).toHaveCount(0)
    expect(requests.filter(url => url === picture)).toHaveLength(count)
  } finally { pool.close(); await context.close() }
})


test('duration sliders set the signed room deadline and the brand returns home', async ({ browser, baseURL }) => {
  const { context } = await device(browser, baseURL!)
  try {
    const page = await context.newPage(); await page.goto(baseURL!)
    await page.locator('#roomName').fill('Slider lifetime')
    await page.locator('#roomEnds').selectOption('duration')
    await page.locator('#roomDurationHours').press('Home')
    await expect(page.locator('#roomDurationSummary')).toHaveText('Choose at least one minute.')
    await page.locator('#roomDurationDays').press('Home')
    await page.locator('#roomDurationDays').press('ArrowRight')
    for (let i = 0; i < 5; i++) await page.locator('#roomDurationMinutes').press('ArrowRight')
    await expect(page.locator('#roomDurationSummary')).toContainText('1 days, 0 hours, 5 minutes')
    await expect(page.locator('#roomWhenEnds')).toHaveValue('destruct')
    const before = Math.floor(Date.now()/1000)
    await page.locator('#create').click()
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomFuse')).toBeVisible()
    const saved = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kithmoot.room.')).map(key => JSON.parse(localStorage.getItem(key)!)).find(room => room.name === 'Slider lifetime'))
    expect(saved.destruct).toBe(true)
    expect(saved.endsAt).toBeGreaterThanOrEqual(before + 86400 + 300)
    expect(saved.endsAt).toBeLessThanOrEqual(Math.floor(Date.now()/1000) + 86400 + 300)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('#workspaceBrandHome:visible, #appHome:visible').first().click()
    await expect(page.locator('#home')).toBeVisible()
    await expect(page.locator('#roomList')).toContainText('Slider lifetime')
    await page.locator('#appHome').focus(); await page.locator('#appHome').press('Enter')
    await expect(page.locator('#home')).toBeVisible()
  } finally { await context.close() }
})
