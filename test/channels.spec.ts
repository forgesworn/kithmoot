import { test, expect } from '@playwright/test'
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { closeRoomBoard, goToConversation, newDeviceContext, open, openRoomBoard, startRelay, openRoomInfoPage } from './browser.js'
import { RoomAgent } from '../src/agent.js'

/**
 * Several conversations in one long-lived room.
 *
 * The unit tests prove the protocol: an admin asks, the keeper signs, and
 * every member believes the signature and nothing else. What they cannot
 * prove is that a person can SEE it - that the tabs appear, that switching
 * takes the chat with it, and that the controls to open a channel are absent
 * for somebody who may not use them. That is what this asks.
 *
 * A real keeper over a real relay socket, because the signed list only
 * exists if something holds the room's authority key and stays in the room.
 */
const RELAY_PORT = 7793

test.describe('channels', () => {
  let relay: { url: string; stop(): Promise<void> } | undefined
  let keeper: RoomAgent | undefined

  test.afterEach(async () => {
    keeper?.leave()
    keeper = undefined
    await relay?.stop()
    relay = undefined
  })

  test('an admin opens a channel, everybody gets the tab, and the chat follows it', async ({ browser, baseURL }) => {
    test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
    relay = await startRelay(RELAY_PORT)

    // The browser's participant key, decided here so the keeper can name it
    // an admin before the browser has ever run.
    const adminSk = generateSecretKey()
    const memberSk = generateSecretKey()
    keeper = await RoomAgent.create({
      base: baseURL!,
      name: 'Keeper',
      relays: [relay.url],
      admins: [getPublicKey(adminSk)],
    })

    const contextFor = async (sk: Uint8Array) => {
      const context = await newDeviceContext(browser, baseURL!)
      await context.addInitScript(
        (hex) => localStorage.setItem('kithmoot.participant', hex as string),
        bytesToHex(sk),
      )
      return context
    }

    const adminCtx = await contextFor(adminSk)
    const memberCtx = await contextFor(memberSk)
    try {
      const adminPage = await adminCtx.newPage()
      const memberPage = await memberCtx.newPage()
      await open(adminPage, keeper.url, 'Ada')
      await adminPage.locator('#join').click()
      await open(memberPage, keeper.url, 'Bob')
      await memberPage.locator('#join').click()

      // The list is there from the moment somebody is in the room, carrying
      // the conversations every room has whether or not anybody has used
      // them. One that vanishes when quiet can never answer the question it
      // exists for - is something being said out of my sight - so it does
      // not vanish. What is NOT there yet is a channel nobody has opened.
      await openRoomInfoPage(adminPage, 'Conversations')
      await expect(adminPage.locator('#channelBar')).toBeVisible()
      await expect(adminPage.locator('#channelBar button', { hasText: 'shipping' })).toHaveCount(0)

      // Ada is an admin and the room has a keeper, so she may open one.
      // Bob may not, and is shown no control rather than a dead one. Both
      // sheets are opened first: a control that is merely behind a shut
      // sheet would read as absent, and then Bob's half of this would pass
      // for a reason that has nothing to do with who he is.
      await openRoomInfoPage(adminPage, 'Conversations')
      await openRoomInfoPage(memberPage, 'Conversations')
      await expect(adminPage.locator('#channelNew')).toBeVisible({ timeout: 60_000 })
      await expect(memberPage.locator('#channelNew')).toBeHidden()

      await adminPage.locator('#channelName').fill('shipping')
      await adminPage.locator('#channelAdd').click()

      // Both of them, because the list is announced to the room and not
      // just to the person who asked for it.
      for (const page of [adminPage, memberPage]) {
        await openRoomInfoPage(page, 'Conversations')
        await expect(page.locator('#channelBar button', { hasText: 'shipping' })).toBeVisible({ timeout: 60_000 })
        await expect(page.locator('#channelBar button', { hasText: 'Chat' })).toBeVisible()
      }

      // A message sent in a channel belongs to that channel, and the main
      // chat does not see it.
      await goToConversation(memberPage, 'shipping')
      await memberPage.locator('#chatInput').fill('the crates are late')
      await memberPage.locator('#chatForm button[type=submit]').click()
      await expect(adminPage.locator('#chatLog')).not.toContainText('the crates are late')

      await goToConversation(adminPage, 'shipping')
      await expect(adminPage.locator('#chatLog')).toContainText('the crates are late', { timeout: 60_000 })

      await goToConversation(adminPage, 'Chat')
      await expect(adminPage.locator('#chatLog')).not.toContainText('the crates are late')
    } finally {
      await adminCtx.close()
      await memberCtx.close()
    }
  })

  test('a channel called board, opened before the name was refused, never shows the board, and no new one can be opened', async ({ browser, baseURL }) => {
    test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
    test.setTimeout(240_000)
    relay = await startRelay(RELAY_PORT)
    const adminSk = generateSecretKey()
    const made = await RoomAgent.create({ base: baseURL!, name: 'Keeper', relays: [relay.url], admins: [getPublicKey(adminSk)] })
    const state = made.keeperState!
    made.leave()
    // The same room, its keeper restarted with a list an older keeper signed.
    keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', relays: [relay.url], admins: [getPublicKey(adminSk)], state: { ...state, channels: ['board'] } })

    const adminCtx = await newDeviceContext(browser, baseURL!)
    await adminCtx.addInitScript((hex) => localStorage.setItem('kithmoot.participant', hex as string), bytesToHex(adminSk))
    const memberCtx = await newDeviceContext(browser, baseURL!)
    try {
      const ada = await adminCtx.newPage(), bob = await memberCtx.newPage()
      await open(ada, keeper.url, 'Ada')
      await ada.locator('#join').click()
      await open(bob, keeper.url, 'Bob')
      await bob.locator('#join').click()
      await openRoomInfoPage(bob, 'Conversations')
      const tab = bob.locator('#channelBar button[data-channel="board"]')
      await expect(tab).toBeVisible({ timeout: 60_000 })
      await goToConversation(bob, 'Chat')

      // Ada puts a card on the room's board, and Bob's board has it: its
      // parts are on the stream the channel reads.
      await openRoomBoard(ada)
      const board = (page: typeof ada) => page.frameLocator('#roomBoardPanel iframe')
      const composer = board(ada).getByRole('textbox', { name: 'Add a card to To do', exact: true })
      await composer.click()
      await composer.fill('Book the hall')
      await composer.press('Enter')
      await expect(ada.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.', { timeout: 60_000 })
      await closeRoomBoard(ada)
      await openRoomBoard(bob)
      await expect(board(bob).getByRole('link', { name: 'Book the hall', exact: true })).toBeVisible({ timeout: 60_000 })
      await closeRoomBoard(bob)

      // The channel shows none of it: nothing said, nothing unread, no line.
      await openRoomInfoPage(bob, 'Conversations')
      await expect(tab.locator('.tabDot')).toHaveCount(0)
      await expect(tab.locator('.channelDesc')).not.toContainText('Board update')
      await goToConversation(bob, 'board')
      await expect(bob.locator('#chatLog')).not.toContainText('Board update')

      // What is typed there stays conversation, and the board is untouched.
      await bob.locator('#chatInput').fill('The hall is booked')
      await bob.locator('#chatForm button[type=submit]').click()
      await goToConversation(ada, 'board')
      await expect(ada.locator('#chatLog')).toContainText('The hall is booked', { timeout: 60_000 })
      await expect(ada.locator('#chatLog')).not.toContainText('Board update')
      await openRoomBoard(ada)
      await expect(board(ada).getByRole('link', { name: 'Book the hall', exact: true })).toBeVisible()
      await expect(ada.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
      await closeRoomBoard(ada)

      // No new channel takes a name the room already uses; asking is answered on the spot.
      await openRoomInfoPage(ada, 'Conversations')
      await expect(ada.locator('#channelNew')).toBeVisible({ timeout: 60_000 })
      await ada.locator('#channelName').fill('boards')
      await ada.locator('#channelAdd').click()
      await expect(ada.locator('#status')).toHaveText('"boards" is used by the room itself. Choose another name.')
      await expect(ada.locator('#channelName')).toHaveValue('boards')
      await expect(ada.locator('#channelBar button[data-channel="boards"]')).toHaveCount(0)
    } finally {
      await adminCtx.close()
      await memberCtx.close()
    }
  })
})
