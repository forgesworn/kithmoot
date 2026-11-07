import { test, expect } from '@playwright/test'
import { createRoom, join, newDeviceContext, open, startRelay } from './browser.js'
import { RoomAgent } from '../src/agent.js'
import { AgentRuntime } from '../src/node/runtime.js'
import { createWeriftFactory } from '../src/node/webrtc.js'

/**
 * Zap the maker, walked as a person would.
 *
 * An agent in the room carries its maker's Lightning address on its roster
 * entry. The menu on one of its messages offers Zap, and the dialog that opens
 * shows the address in full, names the agent beside it, and says nobody
 * vouches for it. The link to the viewer's wallet is a real link and can be
 * reached from the keyboard, because the confirmation dialog cycles Tab only
 * through controls that say they are one.
 *
 * Nothing here touches the network for the address: the test asserts what is
 * on screen, never a payment, and the address is a made-up one.
 */

const RELAY_PORT = 7789

test('an agent with a Lightning address offers Zap from its message', async ({ browser, baseURL }, testInfo) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  test.setTimeout(180_000)

  const relay = await startRelay(RELAY_PORT)
  const context = await newDeviceContext(browser, baseURL!)
  let runtime: AgentRuntime | undefined
  try {
    const page = await context.newPage()
    const url = await createRoom(page, baseURL!, [relay.url], 'Alice')
    await open(page, url, 'Alice')
    await join(page)
    await expect(page.locator('#roomArea')).toBeVisible()

    // The agent declares the address with capitals; the roster carries it
    // lower-cased, and that is what the viewer sees.
    const factory = await createWeriftFactory()
    const agent = await RoomAgent.join({ link: url, name: 'Ada', factory, zap: 'Maker@Example.COM' })
    runtime = new AgentRuntime(agent, { persona: { name: 'Ada', system: '' } }).start()
    await runtime.say('hello from the agent')
    const line = page.locator('#chatLog [data-message-id]', { hasText: 'hello from the agent' }).first()
    await expect(line).toBeVisible({ timeout: 60_000 })

    // The message's own menu, on a right-click, offers Zap for an agent that
    // is in the roster with an address.
    await line.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Zap' }).click()

    const dialog = page.locator('#actionDialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Goes to whoever runs Ada')
    await expect(dialog).toContainText('Asserted by nobody.')
    await expect(dialog.locator('.zapAddress')).toHaveText('maker@example.com')
    const wallet = dialog.locator('a.zapWallet')
    await expect(wallet).toHaveText('Open in wallet')
    await expect(wallet).toHaveAttribute('href', 'lightning:maker@example.com')
    await page.screenshot({ path: testInfo.outputPath('zap-dialog.png') })

    // Keyboard: the dialog opens on Close; Tab reaches the wallet link and
    // Copy without leaving the dialog.
    const reached = new Set<string>()
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab')
      reached.add(await page.evaluate(() => {
        const el = document.activeElement
        return el instanceof HTMLAnchorElement ? 'link' : el?.textContent?.trim() ?? ''
      }))
    }
    expect(reached).toContain('link')
    expect(reached).toContain('Copy')

    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
  } finally {
    await runtime?.close()
    await context.close()
    await relay.stop()
  }
})
