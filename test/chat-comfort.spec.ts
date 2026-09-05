import { test, expect } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure'
import { localIdentity } from '../src/identity.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { reactionText, toggleReaction } from '../src/reactions.js'

test('timestamps, avatars, direct search, emoji insertion and encrypted reaction toggles work together', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
  const profileKey = generateSecretKey()
  const identity = localIdentity(profileKey)
  const publisher = new NostrRelayPool(['ws://127.0.0.1:7777'])
  const pictureURL = 'https://profiles.example/rowan.svg'
  let pictureRequests = 0
  await context.route(pictureURL, route => { pictureRequests++; return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="teal"/></svg>' }) })
  await publisher.publish(finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ name: 'Rowan', picture: pictureURL }) }, profileKey))
  const writer = await RoomAgent.join({ link, identity, relays: ['ws://127.0.0.1:7777'], name: 'Rowan' })
  try {
    const page = await context.newPage(); await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await writer.chat.send('Where is the toolbox?')
    const row = page.locator('#chatLog .msg').filter({ hasText: 'Where is the toolbox?' })
    await expect(row.locator('.messageHeader time')).toHaveAttribute('datetime', /T/)
    await expect(row.locator('.messageHeader time')).toContainText(/\d{1,2}:\d{2}/)
    await expect(row.locator('.avatar.initials')).toBeVisible()
    expect(pictureRequests).toBe(0)
    await page.locator('#chatProfiles').click(); await page.locator('#lookupProfiles').check()
    await page.locator('#profileSettingsClose').click()
    await expect(row.locator('img.avatar')).toHaveAttribute('src', pictureURL)
    // WebKit reports an SVG's rendered intrinsic size here. Verify decoding
    // independently of that engine-specific size; the source is checked above.
    await expect.poll(() => row.locator('img.avatar').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0)).toBe(true)
    expect(pictureRequests).toBeGreaterThan(0)
    await page.locator('#chatProfiles').click(); await page.locator('#lookupProfiles').uncheck(); await page.locator('#profileSettingsClose').click()
    await expect(row.locator('.avatar.initials')).toBeVisible()
    await expect(row.locator('img.avatar')).toHaveCount(0)
    await page.locator('#chatInput').fill('before after')
    await page.locator('#chatInput').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7))
    await page.locator('#emojiToggle').click(); await page.getByRole('searchbox', { name: 'Search emoji' }).fill('head against wall')
    await page.getByRole('button', { name: /🤦 facepalm/ }).click()
    await expect(page.locator('#chatInput')).toHaveValue('before 🤦after')
    await expect(page.locator('#chatInput')).toBeFocused()
    await page.locator('#chatSearch').click(); await page.locator('#messageSearchQuery').fill('toolbox')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await page.locator('#messageSearchClose').click(); await expect(page.locator('#chatSearch')).toBeFocused()
    await expect(page.locator('#chatInput')).toHaveValue('before 🤦after')
    await row.getByRole('button', { name: 'Add ❤️ reaction', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Remove ❤️ reaction, 1', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const target = writer.chat.messages().find(m => m.text === 'Where is the toolbox?')!
    const reaction = toggleReaction(writer.chat.messages(), target, target.participant, '❤️')
    await writer.chat.send(reactionText(reaction), { reaction })
    await expect(row.getByRole('button', { name: 'Remove ❤️ reaction, 2', exact: true })).toBeVisible()
    await row.getByRole('button', { name: 'Remove ❤️ reaction, 2', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Add ❤️ reaction, 1', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('#chatLog .msg')).toHaveCount(1)
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatLog .mine .text')).toHaveText('before 🤦after')
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/kithmoot-chat-320-${test.info().project.name}.png` })
  } finally { await writer.leave(); publisher.close(); await context.close() }
})
