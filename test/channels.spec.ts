import { test, expect } from '@playwright/test'
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { newDeviceContext, open, startRelay } from './browser.js'
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

      // The room has one conversation, so there are no tabs to show yet.
      await expect(adminPage.locator('#channelBar')).toBeHidden()

      // Ada is an admin and the room has a keeper, so she may open one.
      // Bob may not, and is shown no control rather than a dead one.
      await expect(adminPage.locator('#channelNew')).toBeVisible({ timeout: 60_000 })
      await expect(memberPage.locator('#channelNew')).toBeHidden()

      await adminPage.locator('#channelName').fill('shipping')
      await adminPage.locator('#channelAdd').click()

      // Both of them, because the list is announced to the room and not
      // just to the person who asked for it.
      for (const page of [adminPage, memberPage]) {
        await expect(page.locator('#channelBar button', { hasText: 'shipping' })).toBeVisible({ timeout: 60_000 })
        await expect(page.locator('#channelBar button', { hasText: 'Main' })).toBeVisible()
      }

      // A message sent in a channel belongs to that channel, and the main
      // chat does not see it.
      await memberPage.locator('#channelBar button', { hasText: 'shipping' }).click()
      await memberPage.locator('#chatInput').fill('the crates are late')
      await memberPage.locator('#chatForm button[type=submit]').click()
      await expect(adminPage.locator('#chatLog')).not.toContainText('the crates are late')

      await adminPage.locator('#channelBar button', { hasText: 'shipping' }).click()
      await expect(adminPage.locator('#chatLog')).toContainText('the crates are late', { timeout: 60_000 })

      await adminPage.locator('#channelBar button', { hasText: 'Main' }).click()
      await expect(adminPage.locator('#chatLog')).not.toContainText('the crates are late')
    } finally {
      await adminCtx.close()
      await memberCtx.close()
    }
  })
})
