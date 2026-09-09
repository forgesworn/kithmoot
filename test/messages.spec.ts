import { test, expect, type BrowserContext } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../src/identity.js'
import { openRoomDetails } from './browser.js'

/**
 * The message layer, as a person meets it: a reply that sits under the
 * message it answers, an edit that changes the words and says so, a
 * retraction that leaves a marked gap, a mention that lights up for the
 * one it names, and a private conversation started from a person's row.
 * See docs/messages.md.
 */

async function device(context: BrowserContext) {
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
}

test('replies nest, edits show the latest, retractions leave a marked gap, and a mention on the wire lights up', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await device(context)
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
  const rowan = await RoomAgent.join({ link, identity: localIdentity(generateSecretKey()), relays: ['ws://127.0.0.1:7777'], name: 'Rowan' })
  try {
    const page = await context.newPage(); await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()

    // Rowan asks; Ada answers in a thread.
    await rowan.chat.send('Shall we ship on Friday?')
    const root = page.locator('#chatLog .msg').filter({ hasText: 'Shall we ship on Friday?' })
    await expect(root).toBeVisible()
    await root.locator('.messageMore').click()
    await page.locator('#messageActionPanel').getByRole('button', { name: /^Reply to/ }).click()
    await expect(page.locator('#composerContext')).toContainText('Replying to Rowan')
    await page.locator('#chatInput').fill('Yes, if the vectors are green')
    await page.locator('#chatInput').press('Enter')
    const thread = page.locator('#chatLog .thread')
    await expect(thread.locator('.msg')).toHaveCount(1)
    await expect(thread).toContainText('Yes, if the vectors are green')
    // Saying your own name is not being addressed: no row of yours lights.
    await page.locator('#chatInput').fill('Ada here, by the way')
    await page.locator('#chatInput').press('Enter')
    const own = page.locator('#chatLog .msg').filter({ hasText: 'Ada here, by the way' })
    await expect(own).toBeVisible()
    await expect(own).not.toHaveClass(/mentionsMe/)
    await expect(own.locator('.mention.me')).toHaveCount(0)
    await expect(page.locator('#composerContext')).toBeHidden()
    // On the wire, the reply names its parent and its root by id and author.
    await expect.poll(() => rowan.chat.messages().find(m => m.text === 'Yes, if the vectors are green')?.thread?.messageId)
      .toBe(rowan.chat.messages().find(m => m.text === 'Shall we ship on Friday?')!.id)

    // Ada corrects herself. The bubble changes; the message keeps its place.
    const reply = thread.locator('.msg').first()
    await reply.locator('.messageMore').click()
    await page.locator('#messageActionPanel').getByRole('button', { name: 'Edit this message' }).click()
    await expect(page.locator('#composerContext')).toContainText('Editing your message')
    await expect(page.locator('#chatInput')).toHaveValue('Yes, if the vectors are green')
    await page.locator('#chatInput').fill('Yes, once the vectors are green')
    await page.locator('#chatInput').press('Enter')
    await expect(thread.locator('.msg')).toHaveCount(1)
    await expect(thread.locator('.msg .bubble')).toContainText('Yes, once the vectors are green')
    await expect(thread.locator('.msg .chip.edited')).toBeVisible()
    await expect.poll(() => rowan.chat.messages().filter(m => m.replaces !== undefined).length).toBe(1)

    // And thinks better of it. What is left says so.
    await reply.locator('.messageMore').click()
    await page.locator('#messageActionPanel').getByRole('button', { name: 'Retract this message' }).click()
    await page.locator('#actionConfirm').click()
    await expect(thread.locator('.msg.retracted')).toHaveCount(1)
    await expect(thread.locator('.msg.retracted .bubble')).toContainText('Message retracted')
    await expect(thread.locator('.msg.retracted .messageMore')).toHaveCount(0)
    await expect.poll(() => rowan.chat.messages().filter(m => m.retracts !== undefined).length).toBe(1)

    // Rowan names Ada on the wire. Her row lights; the picker offered the name.
    const ada = rowan.chat.messages().find(m => m.text === 'Yes, if the vectors are green')!.participant
    await rowan.chat.send('@Ada please look', { mentions: [ada] })
    const named = page.locator('#chatLog .msg').filter({ hasText: '@Ada please look' })
    await expect(named).toHaveClass(/mentionsMe/)
    await rowan.chat.send('everyone: standup moved', { mentions: ['everyone'] })
    await expect(page.locator('#chatLog .msg').filter({ hasText: 'standup moved' })).toHaveClass(/mentionsMe/)
    await rowan.chat.send('Tally, are you there', { mentions: ['b'.repeat(64)] })
    await expect(page.locator('#chatLog .msg').filter({ hasText: 'Tally, are you there' })).not.toHaveClass(/mentionsMe/)
    await page.locator('#chatInput').fill('@Row')
    await expect(page.locator('#mentions [role="option"]').first()).toContainText('Rowan')
    await page.locator('#chatInput').fill('@Rowan thanks')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => rowan.chat.messages().find(m => m.text === '@Rowan thanks')?.mentions).toEqual([rowan.participant])
  } finally {
    await rowan.leave()
    await context.close()
  }
})

test('a private conversation is started from a person and reaches them inside the room', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const contexts: BrowserContext[] = []
  const open = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
    await device(context)
    contexts.push(context)
    return context.newPage()
  }
  try {
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
    const ada = await open(); await ada.goto(link)
    await ada.locator('#displayName').fill('Ada'); await ada.locator('#join').click()
    const rowan = await open(); await rowan.goto(link)
    await rowan.locator('#displayName').fill('Rowan'); await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada privately/ }).click()
    await expect(rowan.locator('#status')).toContainText(/Private conversation with Ada/, { timeout: 30_000 })
    // Ada is told, in the room, and the room is on her list, named for Rowan.
    await expect(ada.locator('#chatLog')).toContainText('started a private conversation with you', { timeout: 30_000 })
    // An invitation is a statement, not a message: no bubble for it anywhere.
    await expect(rowan.locator('#chatLog .msg')).toHaveCount(0)
    await expect(ada.locator('#chatLog .msg')).toHaveCount(0)
    // The room is on both lists, named for the other person.
    await ada.locator('#backToRooms').click()
    await expect(ada.locator('#roomSwitcherList')).toContainText('Private: Rowan', { timeout: 30_000 })
    await ada.locator('#roomSwitcherClose').click()
    await rowan.locator('#roomSheetClose').click()
    await rowan.locator('#backToRooms').click()
    await expect(rowan.locator('#roomSwitcherList')).toContainText('Private: Ada', { timeout: 30_000 })
    await rowan.locator('#roomSwitcherClose').click()
    // Started again from the same person, it is the same room, not a second
    // one - and it opens. Done while Ada is still on Rowan's roster: once
    // either of them leaves the workshop for the private room, the other's
    // "Message ..." button goes with them.
    await openRoomDetails(rowan)
    await rowan.getByRole('button', { name: /^Message Ada privately/ }).click()
    await expect(rowan.locator('#roomTitle')).toHaveText('Private: Ada', { timeout: 30_000 })
    await rowan.locator('#backToRooms').click()
    await expect(rowan.locator('#roomSwitcherList .switchRoom').filter({ hasText: 'Private: Ada' })).toHaveCount(1)
    // "It is in your rooms" comes with the way there. Inside, the room is
    // titled for the other person and says who can read it.
    await ada.locator('#chatLog .system').getByRole('button', { name: 'Open Private: Rowan' }).click()
    await expect(ada.locator('#roomTitle')).toHaveText('Private: Rowan', { timeout: 30_000 })
    await expect(ada.locator('#chatLog')).toContainText('Only you and Rowan can read this.')
    await expect(ada.locator('#invitePeople')).toHaveJSProperty('hidden', true)
    await expect(rowan.locator('#invitePeople')).toHaveJSProperty('hidden', true)
  } finally {
    for (const context of contexts) await context.close()
  }
})
