import { test, expect } from '@playwright/test'
import { generateRoomSecret } from '../../src/room.js'
import { encodeRoomLink } from '../../src/link.js'
import { RoomAgent } from '../../src/agent.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { reactionText, toggleReaction } from '../../src/reactions.js'

/**
 * Regenerates the website's hero image, `site/img/web-conversation.png`,
 * from the real app: a room with a thread, an edit, a reaction and a
 * mention, on a phone-sized screen. Run with
 *
 *   npx playwright test -c test/tools/playwright.config.ts
 *
 * Not part of the acceptance suite; the picture is a build artefact of the
 * marketing page and is regenerated on purpose, never edited by hand. Every
 * name in it is invented.
 */
test('the hero image shows the conversation the page describes', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 880 }, deviceScaleFactor: 2, colorScheme: 'light' })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'The workshop', relays: [relay.href], iceUrls: [] })
  // Rowan is a person in the picture, driven from Node: the library joins
  // as an agent unless told otherwise, and an agent badge on Rowan would
  // make the page say something the caption does not.
  const rowan = await RoomAgent.join({ link, identity: localIdentity(generateSecretKey()), relays: ['ws://127.0.0.1:7777'], name: 'Rowan', agent: false })
  let scribe: RoomAgent | undefined
  try {
    const page = await context.newPage(); await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    // Scribe is the agent in the picture: it joins as one, so it wears the
    // badge, and what it says is the kind of thing an agent in a room says.
    // It arrives after Ada, so her page hears its announcement and knows it
    // for an agent before it speaks; a message from a participant the page
    // has not met yet is painted as a person's.
    scribe = await RoomAgent.join({ link, identity: localIdentity(generateSecretKey()), relays: ['ws://127.0.0.1:7777'], name: 'Scribe' })
    await expect(page.getByText(/2 people, 1 agent/).first()).toBeVisible()
    await rowan.chat.send('Budget draft is in the shared folder. Can someone check the venue line?')
    const root = page.locator('#chatLog .msg').filter({ hasText: 'check the venue line' })
    await expect(root).toBeVisible()
    await root.getByRole('button', { name: /^Reply to/ }).click()
    await page.locator('#chatInput').fill('Venue is £800, not £750')
    await page.locator('#chatInput').press('Enter')
    const thread = page.locator('#chatLog .thread')
    await expect(thread.locator('.msg')).toHaveCount(1)
    await thread.locator('.msg').first().getByRole('button', { name: 'Edit this message' }).click()
    await page.locator('#chatInput').fill('Venue is £850, not £750')
    await page.locator('#chatInput').press('Enter')
    await expect(thread.locator('.msg .chip.edited')).toBeVisible()
    await expect.poll(() => rowan.chat.messages().filter(m => m.replaces !== undefined).length).toBe(1)
    const reply = rowan.chat.messages().find(m => m.text === 'Venue is £800, not £750')!
    const reaction = toggleReaction(rowan.chat.messages(), reply, rowan.participant, '👍')
    await rowan.chat.send(reactionText(reaction), { reaction })
    await expect(thread.getByRole('button', { name: 'Add 👍 reaction, 1', exact: true })).toBeVisible()
    // Messages stamped in the same second sort by id, which is to say at
    // random, so each speaker waits a second before the next line.
    await page.waitForTimeout(1100)
    await scribe.chat.send('Noted for the minutes: venue £850, budget draft to be revised.')
    await expect(page.locator('#chatLog .msg.fromAgent')).toHaveCount(1)
    await page.waitForTimeout(1100)
    await rowan.chat.send('@Ada can you send the revised sheet?', { mentions: [reply.participant] })
    await expect(page.locator('#chatLog .msg.mentionsMe')).toHaveCount(1)
    await page.locator('#chatInput').fill('Sending it now.')
    // Let the outbox settle so nothing is shown as awaiting confirmation,
    // then show the conversation from its first message: the thread is the
    // point of the picture, and the log opens pinned to the newest line.
    await expect(page.locator('#outbox')).toBeHidden()
    await root.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'site/img/web-conversation.png' })
  } finally {
    await rowan.leave()
    await scribe?.leave()
    await context.close()
  }
})
