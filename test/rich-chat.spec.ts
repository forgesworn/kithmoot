import { test, expect } from '@playwright/test'
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
    await page.locator('#emojiToggle').click(); await page.getByRole('searchbox', { name: 'Search emoji' }).fill('600')
    await expect(page.locator('.emojiGrid button')).toHaveCount(0)
    await page.getByRole('button', { name: 'Unlock Nostr packs' }).click()
    await expect(page.locator('.emojiPicker [role=status]')).toContainText(member ? 'unlocked' : 'No member packs')
    expect(registryRequests).toBe(1)
    await expect(page.locator('.emojiGrid button')).toHaveCount(member ? 8 : 0)
    await page.getByRole('button', { name: 'Close emoji picker' }).click()
    await row.getByRole('button', { name: 'React to message from Rowan', exact: true }).click()
    await page.getByRole('button', { name: 'More emoji reactions', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search emoji' }).fill('unicorn')
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
  const gif = readFileSync(new URL('../app/public/chat-art/laugh.gif', import.meta.url))
  const external: string[] = []
  context.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http') && url.origin !== new URL(baseURL!).origin) external.push(url.href) })
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'GIF room', relays: [relay.href], iceUrls: [] })
  const writer = await RoomAgent.join({ link, relays: [TEST_RELAY_WS], name: 'Rowan', agent: false })
  try {
    const page = await context.newPage(); await openRoomUrl(page, link); await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await allowTestFileStorage(page, new URL(baseURL!).origin)
    await page.locator('#mediaToggle').click()
    await page.getByRole('searchbox', { name: 'Search GIFs and stickers' }).fill('laugh')
    await page.getByRole('button', { name: 'Add Laugh.gif', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'GIFs and stickers' })).not.toBeVisible()
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await expect(page.locator('#chatInput')).toHaveValue('')
    expect(external).toEqual([])
    await page.locator('#chatForm button[type=submit]').click()
    await expect.poll(() => writer.chat.messages().some(message => message.attachments?.length === 1)).toBe(true)
    const message = writer.chat.messages().find(message => message.attachments?.length === 1)!
    expect(message.text).toBe('Shared a file: Laugh.gif')
    const attachment = message.attachments![0]!
    const response = await context.request.get(TEST_RELAY_HTTP + new URL(attachment.url).pathname)
    const encrypted = await response.body()
    expect(encrypted.subarray(0, 8).toString()).toBe('FSWNENC2')
    const opened = decryptEnvelope(encrypted, attachment.key)
    expect(Buffer.from(opened.source)).toEqual(gif)
    await page.locator('#chatLog .attachment').getByRole('button', { name: 'Show', exact: true }).click()
    await expect(page.locator('#chatLog .attachment img')).toHaveAttribute('src', /^blob:/)
    await page.getByRole('button', { name: 'Expand Laugh.gif' }).click()
    await expect(page.getByRole('dialog', { name: 'Laugh.gif' }).locator('img')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('encrypted-gif.png') })
  } finally { await writer.leave(); await context.close() }
})
