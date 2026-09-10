import { test, expect } from '@playwright/test'
import { newDeviceContext } from './browser.js'
import { testRelaysFor } from './relays.js'

// A private room: a room that asks first, whose link is never handed out.
// People get in by being invited from a room they share with somebody in
// it, and an invited person is let straight in without the card.
test('somebody invited from a shared room is let straight into a room that asks first', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  try {
    const relays = testRelaysFor(baseURL!)
    const ada = await a.newPage()
    if (relays) await ada.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await ada.addInitScript(() => localStorage.setItem('kithmoot.name', 'Ada'))

    // The private room, made and entered once so it is saved on Ada's device.
    await ada.goto(baseURL!)
    await ada.locator('#roomName').fill('Private build')
    await ada.locator('input[name="roomAccess"][value="ask"]').check()
    await ada.locator('#create').click()
    await expect(ada.locator('#join')).toBeVisible({ timeout: 30_000 })
    await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible()

    // The shared room, where Ada and Rowan meet.
    await ada.locator('#backToRooms').click()
    await ada.locator('#roomSwitcherHome').click()
    await ada.locator('#roomName').fill('Shared')
    await ada.locator('#create').click()
    await expect(ada.locator('#join')).toBeVisible({ timeout: 30_000 })
    await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible()
    const shared = ada.locator('#shareUrl')
    await expect.poll(async () => (await shared.inputValue()).length).toBeGreaterThan(0)
    const sharedLink = await shared.inputValue()

    const rowan = await b.newPage()
    await rowan.addInitScript(() => localStorage.setItem('kithmoot.name', 'Rowan'))
    await rowan.goto(sharedLink)
    await expect(rowan.locator('#join')).toBeVisible({ timeout: 60_000 })
    await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    // Ada invites Rowan to the private room from Rowan's row.
    await ada.locator('#roomMenu').click()
    await ada.getByRole('button', { name: 'Invite Rowan to a room', exact: true }).click({ timeout: 60_000 })
    const chooser = ada.locator('#inviteToRoom')
    await expect(chooser).toBeVisible()
    await chooser.getByRole('button', { name: 'Private build', exact: true }).click()
    await ada.locator('#roomSheetClose').click()
    await expect(ada.locator('#chatLog')).toContainText('You invited Rowan to Private build.')
    await expect(rowan.locator('#chatLog')).toContainText('invited you to Private build', { timeout: 60_000 })

    // Ada goes back to the private room, so her device is answering its
    // link. Once the invite has been confirmed sent, or switching asks
    // about unsent work.
    await expect(ada.locator('#outbox')).toBeHidden({ timeout: 60_000 })
    await ada.locator('#backToRooms').click()
    await ada.locator('#roomSwitcherHome').click()
    await ada.getByRole('button', { name: 'Open Private build', exact: true }).click()
    await expect(ada.locator('#roomTitle')).toHaveText('Private build', { timeout: 60_000 })
    await expect(ada.locator('#join')).toBeVisible({ timeout: 60_000 })
    await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })

    // Rowan opens it from their rooms and is let straight in: no card.
    await rowan.locator('#backToRooms').click()
    await rowan.locator('#roomSwitcherHome').click()
    await rowan.getByRole('button', { name: 'Open Private build', exact: true }).click()
    // A pre-approved invitation may complete before the next browser poll.
    // The admission and its acknowledgement are the durable result to verify.
    await expect(rowan.locator('#status')).toContainText('You are on the list', { timeout: 90_000 })
    await expect(ada.locator('#approvals .approvalCard.knock')).toHaveCount(0)
    await expect(ada.locator('#chatLog')).toContainText('Rowan came in on your invite.')
    await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()
    await expect(rowan.locator('#roomTitle')).toHaveText('Private build')
  } finally { await a.close(); await b.close() }
})
