import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { localIdentity } from '../src/identity.js'
import { RoomAgent } from '../src/agent.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { decryptEnvelope } from '../src/attachment.js'
import { CULT_REGISTRY } from '../app/src/nostr-packs.js'
import { allowTestFileStorage, TEST_RELAY_WS, TEST_RELAY_HTTP } from './browser.js'
import { openRoomUrl } from './relays.js'
import { routeTestBlossom } from './blossom.js'
import { nostrTestDevice, signInNostrTestDevice } from './nostr-device.js'
import { FAMILIAR_ART } from '../src/familiar-emoji.js'

async function artworkSearch(page: Page, name: string) {
  const query = page.getByRole('searchbox', { name, exact: true })
  if (!(await query.isVisible())) await page.getByRole('button', { name: 'Search artwork', exact: true }).click()
  return query
}

async function openGIFs(page: Page) {
  if (await page.locator('#mediaToggle').isVisible()) await page.locator('#mediaToggle').click()
  else {
    await page.locator('#emojiToggle').click()
    await page.locator('.chatArtPicker').getByRole('tab', { name: 'GIFs', exact: true }).click()
  }
}

test('familiar artwork keeps Unicode, human tones, drafts and links intact', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, socket => socket.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const external: string[] = []
  context.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http') && url.origin !== new URL(baseURL!).origin) external.push(url.href) })
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Familiar emoji room', relays: [relay.href], iceUrls: [] })
  const writer = await RoomAgent.join({ link, relays: [TEST_RELAY_WS], name: 'Rowan', agent: false })
  try {
    const page = await context.newPage(); await openRoomUrl(page, link); await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Nice ')
    await page.locator('#emojiToggle').click()
    await expect(page.locator('.emojiGrid button')).toHaveCount(FAMILIAR_ART.filter(item => String(item.category) !== 'forgesworn').length)
    await page.getByRole('combobox', { name: 'Hand colour' }).selectOption('3')
    await page.locator('.emojiGrid button').filter({ has: page.locator('.familiarEmoji', { hasText: '👍🏽' }) }).click()
    await expect(page.locator('#chatInput')).toHaveValue('Nice 👍🏽')
    await page.getByRole('button', { name: 'Close emoji picker', exact: true }).click()
    await page.locator('#chatForm button[type=submit]').click()
    await expect.poll(() => writer.chat.messages().some(message => message.text === 'Nice 👍🏽')).toBe(true)
    await writer.chat.send('Received 👎🏿 ❤️, keep 👩🏽‍💻 intact. https://example.test/👍🏽')
    const row = page.locator('#chatLog .msg').filter({ hasText: 'Received' }).first()
    await expect(row.locator('.text')).toHaveText('Received 👎🏿 ❤️, keep 👩🏽‍💻 intact. https://example.test/👍🏽')
    await expect(row.locator('.familiarEmoji')).toHaveCount(2)
    await expect(row.locator('a .familiarEmoji')).toHaveCount(0)
    await row.getByRole('button', { name: 'React to message from Rowan', exact: true }).click()
    await page.getByRole('button', { name: 'Add 👍🏽 reaction', exact: true }).click()
    await expect.poll(() => writer.chat.messages().some(message => message.reaction?.emoji === '👍🏽')).toBe(true)
    await page.locator('#emojiToggle').click()
    await expect(page.getByRole('combobox', { name: 'Hand colour' })).toHaveValue('3')
    await (await artworkSearch(page, 'Search emoji')).fill('donkey')
    await expect(page.locator('.emojiGrid .familiarEmoji')).toHaveText('🫏')
    await page.locator('.emojiGrid button').click()
    await expect(page.locator('#chatInput')).toHaveValue('🫏')
    await page.getByRole('button', { name: 'Close emoji picker', exact: true }).click()
    await page.locator('#chatInput').fill('')
    await page.locator('#emojiToggle').click()
    await page.getByRole('button', { name: 'ForgeSworn', exact: true }).click()
    await expect(page.locator('.emojiGrid button')).toHaveCount(9)
    await expect(page.getByRole('combobox', { name: 'Hand colour' })).toBeHidden()
    await page.locator('.emojiGrid button').filter({ has: page.locator('.familiarEmoji', { hasText: ':fs_kithmoot:' }) }).click()
    await expect(page.locator('#chatInput')).toHaveValue(':fs_kithmoot:')
    await page.getByRole('button', { name: 'Close emoji picker', exact: true }).click()
    await page.locator('#chatForm button[type=submit]').click()
    await expect.poll(() => writer.chat.messages().some(message => message.text === ':fs_kithmoot:')).toBe(true)
    await writer.chat.send('Brand :fs_forgesworn: ₿ 🕷️ 🪨, literal :fs_bad: https://example.test/:fs_kithmoot:')
    const brandRow = page.locator('#chatLog .msg').filter({ hasText: 'Brand' }).first()
    await expect(brandRow.locator('.familiarEmoji')).toHaveCount(4)
    await expect(brandRow.locator('a .familiarEmoji')).toHaveCount(0)
    await expect(brandRow.locator('.text')).toHaveText('Brand :fs_forgesworn: ₿ 🕷️ 🪨, literal :fs_bad: https://example.test/:fs_kithmoot:')
    await brandRow.getByRole('button', { name: 'React to message from Rowan', exact: true }).click()
    await page.getByRole('button', { name: 'More emoji reactions', exact: true }).click()
    await page.getByRole('button', { name: 'ForgeSworn', exact: true }).click()
    await page.locator('.emojiGrid button').filter({ has: page.locator('.familiarEmoji', { hasText: ':fs_forgesworn:' }) }).click()
    await expect.poll(() => writer.chat.messages().some(message => message.reaction?.emoji === ':fs_forgesworn:')).toBe(true)
    expect(external).toEqual([])
    await page.screenshot({ path: test.info().outputPath('familiar-emoji-phone.png') })
  } finally { await writer.leave(); await context.close() }
})

for (const member of [false, true]) test(`full reactions, clickable profiles and picker-only member packs (${member ? 'member' : 'non-member'})`, async ({ browser, baseURL }) => {
  const secret = generateSecretKey(), senderKey = generateSecretKey(), identity = localIdentity(senderKey)
  const context = await nostrTestDevice(browser, baseURL!, secret)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Rich chat', relays: [relay.href], iceUrls: [] })
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  let registryRequests = 0
  await context.route(CULT_REGISTRY, route => {
    registryRequests++; expect(route.request().headers()['authorization']).toBeUndefined()
    return route.fulfill({ json: { names: member ? { test: getPublicKey(secret) } : {} } })
  })
  await context.route('https://profiles.example/.well-known/nostr.json?name=rowan', route => route.fulfill({ json: { names: { rowan: identity.pubkey } } }))
  await pool.publish(finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ name: 'Rowan', nip05: 'rowan@profiles.example' }) }, senderKey))
  const writer = await RoomAgent.join({ link, identity, relays: [TEST_RELAY_WS], name: 'Rowan', agent: false })
  try {
    const page = await context.newPage(); await signInNostrTestDevice(page, baseURL!)
    await openRoomUrl(page, link); await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await writer.chat.send(':600_spin:')
    const row = page.locator('#chatLog .msg').filter({ hasText: 'Rowan' }).first()
    // Receiving this local artwork is independent of membership and needs no registry request.
    await expect(row.locator('.cultEmoji img')).toBeVisible()
    await expect.poll(() => row.locator('.cultEmoji img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1024)
    expect(registryRequests).toBe(0)
    await page.locator('#emojiToggle').click(); await (await artworkSearch(page, 'Search emoji')).fill('600')
    const basic600 = FAMILIAR_ART.filter(item => item.keywords.includes('600')).length
    await expect(page.locator('.emojiGrid button')).toHaveCount(basic600)
    await page.getByRole('button', { name: 'Characters', exact: true }).click()
    await (await artworkSearch(page, 'Search emoji')).fill('600')
    await page.getByRole('button', { name: 'Unlock Nostr packs' }).click()
    await expect(page.locator('.chatArtPicker [role=status]')).toContainText(member ? 'unlocked' : 'No member packs')
    expect(registryRequests).toBe(1)
    await expect(page.locator('.emojiGrid button')).toHaveCount(basic600 + (member ? 8 : 0))
    await page.getByRole('button', { name: 'Close emoji picker' }).click()
    await row.getByRole('button', { name: 'React to message from Rowan', exact: true }).click()
    await page.getByRole('button', { name: 'More emoji reactions', exact: true }).click()
    await (await artworkSearch(page, 'Search emoji')).fill('unicorn')
    await page.getByRole('button', { name: '🦄 unicorn', exact: true }).click()
    const reaction = row.getByRole('button', { name: 'Remove 🦄 reaction, 1', exact: true })
    await expect(reaction).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => writer.chat.messages().some(message => message.reaction?.emoji === '🦄' && message.reaction.active)).toBe(true)
    const bubble = await row.locator('.bubble').boundingBox(), chip = await reaction.boundingBox()
    expect(chip!.height).toBeGreaterThanOrEqual(44)
    expect(chip!.y).toBeLessThan(bubble!.y + bubble!.height)
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).__copied = value } } }))
    await row.getByRole('button', { name: 'View details for Rowan' }).click()
    const card = page.getByRole('dialog', { name: 'Participant details' })
    await card.getByRole('button', { name: 'Copy npub', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Copied npub' })).toBeVisible()
    expect(await page.evaluate(() => (window as any).__copied)).toMatch(/^npub1/)
    await expect(card.getByRole('button', { name: 'Copy NIP-05', exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Copy NIP-05', exact: true }).click()
    expect(await page.evaluate(() => (window as any).__copied)).toBe('rowan@profiles.example')
    await page.screenshot({ path: test.info().outputPath('participant-card.png') })
    await card.getByRole('button', { name: 'Message privately', exact: true }).click()
    await expect(page.locator('#status')).toContainText('Private conversation with Rowan', { timeout: 30_000 })
  } finally { await writer.leave(); pool.close(); await context.close() }
})

test('original artwork search makes no third-party requests and a bundled GIF arrives encrypted', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, socket => socket.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await routeTestBlossom(context, new URL(baseURL!).origin)
  const gif = readFileSync(new URL('../app/public/chat-art/coffee.gif', import.meta.url))
  const external: string[] = []
  context.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http') && url.origin !== new URL(baseURL!).origin) external.push(url.href) })
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'GIF room', relays: [relay.href], iceUrls: [] })
  const writer = await RoomAgent.join({ link, relays: [TEST_RELAY_WS], name: 'Rowan', agent: false })
  try {
    const page = await context.newPage(); await openRoomUrl(page, link); await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await allowTestFileStorage(page, new URL(baseURL!).origin)
    await openGIFs(page)
    await (await artworkSearch(page, 'Search GIFs and stickers')).fill('coffee')
    await page.getByRole('button', { name: 'Add Coffee.gif', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'GIFs and stickers' })).not.toBeVisible()
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await expect(page.locator('#chatInput')).toHaveValue('')
    expect(external).toEqual([])
    await page.locator('#chatForm button[type=submit]').click()
    await expect.poll(() => writer.chat.messages().some(message => message.attachments?.length === 1)).toBe(true)
    const message = writer.chat.messages().find(message => message.attachments?.length === 1)!
    expect(message.text).toBe('Shared a file: Coffee.gif')
    const attachment = message.attachments![0]!
    const response = await context.request.get(TEST_RELAY_HTTP + new URL(attachment.url).pathname)
    const encrypted = await response.body()
    expect(encrypted.subarray(0, 8).toString()).toBe('FSWNENC2')
    const opened = decryptEnvelope(encrypted, attachment.key)
    expect(Buffer.from(opened.source).equals(gif)).toBe(true)
    await page.locator('#chatLog .attachment').getByRole('button', { name: 'Show', exact: true }).click()
    await expect(page.locator('#chatLog .attachment img')).toHaveAttribute('src', /^blob:/)
    await page.getByRole('button', { name: 'Expand Coffee.gif' }).click()
    await expect(page.getByRole('dialog', { name: 'Coffee.gif' }).locator('img')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('encrypted-gif.png') })
  } finally { await writer.leave(); await context.close() }
})

for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }, { width: 844, height: 390 }]) test(`composer artwork tray keeps browsing and draft usable at ${size.width}x${size.height}`, async ({ browser, baseURL }) => {
  const touch = size.width === 390 || size.height === 390
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: size, hasTouch: touch })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, socket => socket.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Artwork tray', relays: [relay.href], iceUrls: [] })
  try {
    const page = await context.newPage(); await openRoomUrl(page, link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const input = page.locator('#chatInput')
    if (size.width === 390) expect((await input.boundingBox())!.width).toBeGreaterThan(180)
    await input.fill('hello world')
    await input.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(6, 6))
    await page.locator('#emojiToggle').click()
    const picker = page.locator('.chatArtPicker')
    await expect(picker).toBeVisible()
    if (touch) expect(await picker.evaluate(element => document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && element.contains(document.activeElement))).toBe(true)
    await page.locator('.emojiGrid button').filter({ has: page.locator('.familiarEmoji', { hasText: '👍' }) }).first().click()
    await page.locator('.emojiGrid button').filter({ has: page.locator('.familiarEmoji', { hasText: '👎' }) }).first().click()
    await expect(picker).toBeVisible()
    await expect(input).toHaveValue('hello 👍👎world')
    await page.screenshot({ path: test.info().outputPath(`art-tray-${size.width}x${size.height}.png`) })
    const close = page.getByRole('button', { name: 'Close emoji picker', exact: true })
    const before = await close.boundingBox()
    await picker.locator('.chatArtPickerScroll').evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await picker.locator('.chatArtPickerScroll').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(close).toBeVisible()
    const after = await close.boundingBox()
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
    const bounds = await picker.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width + 1)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height + 1)
    await close.click()
    await expect(input).toHaveValue('hello 👍👎world')
    await expect(input).toBeFocused()
    await page.keyboard.type('!')
    await expect(input).toHaveValue('hello 👍👎!world')
    await page.keyboard.press('Backspace')
    await page.locator('#emojiToggle').click()
    const recents = picker.getByRole('button', { name: 'Recents', exact: true })
    if (!(await recents.isVisible())) await picker.getByRole('button', { name: 'Emoji collections', exact: true }).click()
    await recents.click()
    await expect(picker.locator('.emojiGrid button')).toHaveCount(2)
    await picker.getByRole('tab', { name: 'Stickers', exact: true }).click()
    await expect(picker.locator('.chatArtPickerMediaCard')).toHaveCount(24)
    await picker.getByRole('tab', { name: 'GIFs', exact: true }).click()
    await expect(picker.locator('.chatArtPickerMediaCard')).toHaveCount(1)
    const preview = picker.getByRole('button', { name: 'Preview Coffee.gif', exact: true })
    await preview.click()
    await expect(picker.locator('.chatArtPickerPreview img')).toHaveAttribute('src', /\/chat-art\/coffee\.gif$/)
    await expect(input).toHaveValue('hello 👍👎world')
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
    await picker.getByRole('button', { name: 'Back to choices', exact: true }).click()
    await expect(preview).toBeFocused()
    await picker.getByRole('button', { name: 'Close media picker', exact: true }).click()
    await expect(input).toHaveValue('hello 👍👎world')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally { await context.close() }
})
