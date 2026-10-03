import { test, expect } from '@playwright/test'
import { newDeviceContext, open, openRoomDetails, startRelay } from './browser.js'
import { RoomAgent } from '../src/agent.js'

/**
 * A member renames the room, and the other member's screen follows.
 *
 * The unit tests prove the op, the order and the epochs. This asks what a
 * person sees: the title changes on both screens, and the chat says who
 * renamed it.
 */
const RELAY_PORT = 7797

test.describe('room name', () => {
  let relay: { url: string; stop(): Promise<void> } | undefined
  let keeper: RoomAgent | undefined

  test.afterEach(async () => {
    keeper?.leave()
    keeper = undefined
    await relay?.stop()
    relay = undefined
  })

  test('a member renames the room for everybody', async ({ browser, baseURL }) => {
    test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
    relay = await startRelay(RELAY_PORT)
    keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', relays: [relay.url] })

    const adaCtx = await newDeviceContext(browser, baseURL!)
    const bobCtx = await newDeviceContext(browser, baseURL!)
    try {
      const ada = await adaCtx.newPage()
      const bob = await bobCtx.newPage()
      await open(ada, keeper.url, 'Ada')
      await ada.locator('#join').click()
      await open(bob, keeper.url, 'Bob')
      await bob.locator('#join').click()

      await openRoomDetails(ada)
      await expect(ada.locator('#roomRename')).toBeVisible({ timeout: 60_000 })
      await ada.locator('#roomRenameInput').fill('Book club')
      await ada.locator('#roomRenameSave').click()

      for (const page of [ada, bob]) {
        await expect(page.locator('#roomTitle')).toHaveText('Book club', { timeout: 60_000 })
        await expect(page.locator('#chatLog')).toContainText('renamed the room to “Book club”', { timeout: 60_000 })
      }
    } finally {
      await adaCtx.close()
      await bobCtx.close()
    }
  })
})
