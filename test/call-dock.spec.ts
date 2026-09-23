import { test, expect, type Page } from '@playwright/test'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { testRelaysFor } from './relays.js'
import { createRoom, expectToSeeAndHear, inbound, joinWithMedia, newDeviceContext, open } from './browser.js'

/**
 * Nothing a person navigates to ends a call.
 *
 * Two people on a call; one of them goes to another room to chat and comes
 * back. The far end must notice nothing: no departure, no second arrival, and
 * the sound never stops in either direction. See `DockedCall` in
 * app/src/main.ts.
 */

const energy = (page: Page) => page.evaluate(inbound).then(stats => stats.audioEnergy)

async function keepsHearing(page: Page, who: string): Promise<void> {
  const before = await energy(page)
  await expect.poll(() => energy(page), { message: `${who} stopped hearing the call`, timeout: 20_000 }).toBeGreaterThan(before)
}

test('a call carries on while its member chats in another room, and comes back without a rejoin', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium supplies the synthetic microphone and camera')
  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  const secret = generateRoomSecret()
  const side = { roomId: deriveRoom(secret).roomId, name: 'Side room', link: encodeRoomLink(baseURL!, { secret, name: 'Side room', relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] }), openedAt: Math.floor(Date.now() / 1000), readAt: 0 }
  await contextA.addInitScript(room => localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room)), side)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    // Bo joins Ada's call, as a person would once the room says one is on.
    await open(pageB, url, 'Bo')
    await pageB.locator('#join').click()
    await expect(pageB.locator('#callToggle')).toHaveText('Join call')
    await pageB.locator('#callToggle').click()
    await expect(pageB.locator('#deviceControls')).toBeVisible()
    await pageB.locator('#toggleCamera').click()
    await pageB.locator('#toggleMic').click()
    await expect(pageB.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expectToSeeAndHear(pageA, 'Ada')
    await expectToSeeAndHear(pageB, 'Bo')

    // Away, with no question asked.
    await pageA.keyboard.press('Control+k')
    await pageA.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Side room', exact: true }).click()
    await expect(pageA.locator('#roomTitle')).toHaveText('Side room')
    await expect(pageA.locator('#actionConfirm')).toBeHidden()
    await expect(pageA.locator('#callDock')).toBeVisible()
    await expect(pageA.locator('#callDockText')).toHaveText(/^On a call in Room [0-9a-f]+ with Bo\.$/)
    await expect(pageA.locator('#callDockMic')).toHaveAttribute('aria-pressed', 'true')
    await expect(pageA.locator('#callBay')).toBeHidden()
    await pageA.locator('#chatInput').fill('Just popping in here')
    await pageA.keyboard.press('Enter')
    await expect(pageA.locator('#chatLog')).toContainText('Just popping in here')

    // Both still hear each other, and Bo's screen says nothing happened.
    await keepsHearing(pageB, 'Bo')
    await keepsHearing(pageA, 'Ada')
    await pageB.locator('#chatInput').fill('Still here?')
    await pageB.keyboard.press('Enter')
    await pageB.waitForTimeout(5_000)
    await expect(pageB.locator('#room .participant')).toHaveCount(2)
    await expect(pageB.locator('#chatLog')).not.toContainText('Ada left.')

    // Back, to the room as it was left, with what was said meanwhile.
    await pageA.locator('#callDockBack').click()
    await expect(pageA.locator('#roomTitle')).toContainText('Room ')
    await expect(pageA.locator('#callDock')).toBeHidden()
    await expect(pageA.locator('#callBay')).toBeVisible()
    await expect(pageA.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(pageA.locator('#chatLog')).toContainText('Still here?')
    await expectToSeeAndHear(pageA, 'Ada')
    await keepsHearing(pageB, 'Bo')
    expect((await pageB.locator('#chatLog').textContent())!.split('Ada came in.').length - 1).toBeLessThanOrEqual(1)

    // Leave from the dock ends the call, and leaves the room on screen alone.
    await pageA.keyboard.press('Control+k')
    await pageA.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Side room', exact: true }).click()
    await expect(pageA.locator('#callDock')).toBeVisible()
    await pageA.locator('#callDockLeave').click()
    await expect(pageA.locator('#callDock')).toBeHidden()
    await expect(pageA.locator('#roomTitle')).toHaveText('Side room')
    await expect(pageA.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await expect(pageB.locator('#room .participant')).toHaveCount(1, { timeout: 30_000 })
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

