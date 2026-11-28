import { test, expect, type Browser } from '@playwright/test'
import { build } from 'esbuild'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { dmPolicy } from '../src/dm.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { readFile } from 'node:fs/promises'
import { TEST_RELAY_WS } from './relays.js'
import { openNewRoomForm, openProfileSettings, nameCreator, openBoardsDestination } from './browser.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { ORDINARY_SIGNET_KEYS } from '../app/src/ordinary-signet-snapshot.js'
import type { PersonaConnection } from '../app/src/persona-store.js'

async function device(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const sockets: WebSocket[] = []
    ;(window as typeof window & { testSockets: WebSocket[] }).testSockets = sockets
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev', 'wss://relay.ditto.pub', 'wss://offchain.pub']
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

test('the account avatar reveals the persona name on hover, focus and activation', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const context = await accountDevice(browser, baseURL!, secret)
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  const picture = 'https://avatars.example.test/work.png'
  try {
    await context.route(picture, async route => route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'image/png',
      body: await readFile('app/public/pwa-192x192.png'),
    }))
    await pool.publish(finalizeEvent({
      kind: 0, tags: [], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ name: 'Work', picture }),
    }, secret))
    const page = await context.newPage()
    await signInAccount(page, baseURL!)
    await page.setViewportSize({ width: 1280, height: 800 })
    const avatar = page.getByRole('button', { name: 'Account menu for Work' })
    const image = avatar.locator('img')
    await expect(image).toHaveAttribute('src', /^blob:/)
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    const tooltip = avatar.locator('#railPersonaTip')
    await expect(tooltip).toHaveText('Work')
    await expect(tooltip).toBeHidden()
    await avatar.hover()
    await expect(tooltip).toBeVisible()
    const box = (await tooltip.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tooltip).toBeHidden()
    await page.mouse.move(300, 10)
    await avatar.hover()
    await expect(tooltip).toBeVisible()
    await page.mouse.move(300, 10)
    await expect(tooltip).toBeHidden()

    await page.keyboard.press('Tab')
    await avatar.focus()
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tooltip).toBeHidden()
    await expect(avatar).toBeFocused()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Personas' })
    await expect(dialog.getByText('Work', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Current persona')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(dialog.getByRole('textbox', { name: 'Name for the new persona' })).toBeHidden()
    await expect(dialog.getByRole('button', { name: 'Add from My Signet' })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(avatar).toBeFocused()

    await page.setViewportSize({ width: 390, height: 844 })
    await avatar.click()
    await expect(dialog.getByText('Work', { exact: true })).toBeVisible()
  } finally { pool.close(); await context.close() }
})

test('an invitation suggests the last persona used here and waits for explicit entry', async ({ browser, baseURL }) => {
  const personalKey = generateSecretKey(), workKey = generateSecretKey()
  const activeKey = personalKey.slice()
  const context = await accountDevice(browser, baseURL!, activeKey)
  const seedPage = new URL('/__persona-fixture', baseURL!).href
  try {
    await context.route(seedPage, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }))
    const page = await context.newPage()
    await page.goto(seedPage)
    const fixture = await build({
      stdin: { contents: 'export { PersonaStore } from "./app/src/persona-store.ts"', resolveDir: process.cwd() },
      bundle: true, format: 'iife', globalName: 'TestPersonas', write: false,
    })
    await page.addScriptTag({ content: fixture.outputFiles[0]!.text })
    const origin = new URL(baseURL!).origin
    const at = Math.floor(Date.now() / 1000)
    const connection = (key: Uint8Array, label: string): PersonaConnection => {
      const pubkey = getPublicKey(key)
      const proof = finalizeEvent({ kind: 21236, created_at: at,
        tags: [['challenge', 'a'.repeat(64)], ['origin', origin], ['app', 'KithMoot']], content: '' }, key)
      return { pubkey, label, method: 'nip07', session: {
        [ORDINARY_SIGNET_KEYS.pubkey]: pubkey, [ORDINARY_SIGNET_KEYS.method]: 'nip07',
        [ORDINARY_SIGNET_KEYS.authEvent]: JSON.stringify(proof),
      } }
    }
    const work = connection(workKey, 'Work'), personal = connection(personalKey, 'Personal')
    const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
    const secret = generateRoomSecret(), roomId = deriveRoom(secret).roomId
    const link = encodeJoinUrl(baseURL!, secret, [relay.href])
    await page.evaluate(async ({ work, personal, roomId, link, at }) => {
      const { PersonaStore } = (window as unknown as { TestPersonas: typeof import('../app/src/persona-store.js') }).TestPersonas
      const store = new PersonaStore(location.origin)
      await store.add(work)
      await store.add(personal)
      for (const persona of [personal, work]) {
        localStorage.setItem(`kithmoot.account.${persona.pubkey}.kithmoot.room.${roomId}`, JSON.stringify({
          roomId, link, openedAt: at - 120, joinedAt: persona === work ? at - 60 : at - 120, joinedAs: persona.pubkey,
        }))
      }
    }, { work, personal, roomId, link, at })

    await page.goto(link)
    await expect(page.getByRole('button', { name: /Switch persona.*Work was last used here/ })).toBeVisible()
    await expect(page.locator('#roomArea')).toBeHidden()
    await page.locator('#doorPersonas').click()
    const choice = page.getByRole('button', { name: 'Work Last used in this room' })
    await expect(choice).toBeVisible()
    activeKey.set(workKey)
    await page.evaluate(pubkey => { window.nostr!.getPublicKey = async () => pubkey }, work.pubkey)
    await choice.click()
    await expect(page.getByRole('dialog', { name: 'Personas' })).toBeHidden()
    await expect(page.locator('#railPersonas')).toHaveAttribute('aria-label', 'Account menu for Work')
    await expect(page.locator('#roomArea')).toBeHidden()
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect.poll(() => page.evaluate(({ roomId, owner }) => JSON.parse(localStorage.getItem(`kithmoot.account.${owner}.kithmoot.room.${roomId}`)!).joinedAt,
      { roomId, owner: work.pubkey })).toBeGreaterThan(at - 60)
  } finally { await context.close() }
})

test('compact navigation keeps the account within reach in People, Boards and a chat', async ({ browser, baseURL }) => {
  const context = await accountDevice({ newContext: options => browser.newContext({ ...options, hasTouch: true }) }, baseURL!)
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 320, height: 640 })
    await signInAccount(page, baseURL!)
    const dialog = page.getByRole('dialog', { name: 'Personas' })
    // People from the bar; Boards has no bar button since each room has its
    // own board, so it opens the keyboard's way (Control or Command+3).
    for (const [destination, header] of [['People', '#peopleListHead'], ['Boards', '#workspaceWorkHead']]) {
      if (destination === 'Boards') await openBoardsDestination(page)
      else await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: destination }).tap()
      const avatar = page.locator(header).getByRole('button', { name: /^Account menu for / })
      const box = await avatar.boundingBox()
      expect(box?.width).toBeGreaterThanOrEqual(44)
      expect(box?.height).toBeGreaterThanOrEqual(44)
      expect((box?.x ?? 320) + (box?.width ?? 1)).toBeLessThanOrEqual(320)
      await avatar.tap()
      await expect(dialog.getByText('Current persona')).toBeVisible()
      await dialog.getByRole('button', { name: 'Close' }).tap()
      const settings = page.locator(header).getByRole('button', { name: 'Settings' })
      await settings.tap()
      await page.locator('#settingsBack').tap()
      await expect(avatar).toBeVisible()
      await expect(settings).toBeFocused()
    }
    await page.locator('#railChats').tap()
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Design review')
    await nameCreator(page, 'Ada')
    await page.locator('#create').tap()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#roomMenu').tap()
    await page.getByRole('menuitem', { name: 'Switch persona…' }).tap()
    await expect(dialog.getByText('Current persona')).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).tap()
    await expect(page.locator('#roomArea')).toBeVisible()
  } finally { await context.close() }
})

test('private chat rows use initials even with public profile lookups enabled', async ({ browser, baseURL }) => {
  const { context, relay } = await device(browser, baseURL!)
  const selfKey = generateSecretKey(), peerKey = generateSecretKey()
  const self = getPublicKey(selfKey), peer = getPublicKey(peerKey)
  const secret = generateRoomSecret(), groupSecret = generateRoomSecret()
  const privateId = deriveRoom(secret).roomId, groupId = deriveRoom(groupSecret).roomId
  const picture = 'https://avatars.example.test/peer.png'
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  const requests: string[] = []
  await context.route(picture, route => {
    requests.push(route.request().url())
    return route.abort()
  })
  await context.addInitScript(({ key, rooms }) => {
    if (localStorage.getItem('test.avatar-seeded')) return
    localStorage.setItem('test.avatar-seeded', '1')
    localStorage.setItem('kithmoot.profiles.enabled', 'true')
    localStorage.setItem('kithmoot.participant', key)
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.id, JSON.stringify(room.value))
  }, { key: Array.from(selfKey, x => x.toString(16).padStart(2, '0')).join(''), rooms: [
    { id: privateId, value: { link: encodeJoinUrl(baseURL!, secret, [relay], dmPolicy(self, peer)), name: 'Peer', openedAt: Math.floor(Date.now()/1000), readAt: 0 } },
    { id: groupId, value: { link: encodeJoinUrl(baseURL!, groupSecret, [relay]), name: 'Group', openedAt: Math.floor(Date.now()/1000), readAt: 0 } },
  ] })
  try {
    await pool.publish(finalizeEvent({
      kind: 0, tags: [], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ picture }),
    }, peerKey))
    const page = await context.newPage()
    await page.goto(baseURL!)
    const avatar = page.locator(`#roomList [data-room="${privateId}"] .roomAvatar`)
    await expect(avatar).toHaveText('P')
    await expect(avatar.locator('img')).toHaveCount(0)
    await expect(page.locator(`#roomList [data-room="${groupId}"] .roomAvatar img`)).toHaveCount(0)
    await page.reload()
    await expect(avatar).toHaveText('P')
    await openProfileSettings(page)
    await expect(page.locator('#lookupProfiles')).toBeChecked()
    await page.locator('#lookupProfiles').uncheck()
    await page.reload()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(2)
    await expect(avatar).toHaveText('P')
    await expect(avatar.locator('img')).toHaveCount(0)
    expect(requests).toEqual([])
  } finally { pool.close(); await context.close() }
})


test('duration sliders set the signed room deadline and the brand returns home', async ({ browser, baseURL }) => {
  const { context } = await device(browser, baseURL!)
  try {
    const page = await context.newPage(); await page.goto(baseURL!)
    await openNewRoomForm(page)
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
    await nameCreator(page, 'Ada')
    await page.locator('#create').click()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#roomFuse')).toBeVisible()
    const saved = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kithmoot.room.')).map(key => JSON.parse(localStorage.getItem(key)!)).find(room => room.name === 'Slider lifetime'))
    expect(saved.destruct).toBe(true)
    expect(saved.endsAt).toBeGreaterThanOrEqual(before + 86400 + 300)
    expect(saved.endsAt).toBeLessThanOrEqual(Math.floor(Date.now()/1000) + 86400 + 300)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('#workspaceBrandHome:visible, #appHome:visible').first().click()
    await expect(page.locator('#home:visible, #rooms:visible').first()).toBeVisible()
    await expect(page.locator('#roomList')).toContainText('Slider lifetime')
    await page.locator('#appHome').focus(); await page.locator('#appHome').press('Enter')
    await expect(page.locator('#home:visible, #rooms:visible').first()).toBeVisible()
  } finally { await context.close() }
})
