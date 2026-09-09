import { test, expect } from '@playwright/test'
import { newDeviceContext } from './browser.js'
import { testRelaysFor } from './relays.js'

// A room where people with the link ask, and somebody in it lets them in.
// The creator picks that at the start form; a joiner opening the link waits
// on the door; the creator sees who is asking, with their name, and either
// lets them in or declines, in which case the door says nobody let them in.
test('people with the link ask, and the person in the room lets them in or declines', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!), c = await newDeviceContext(browser, baseURL!)
  try {
    const host = await a.newPage()
    const relays = testRelaysFor(baseURL!)
    if (relays) await host.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await host.goto(baseURL!)
    await host.locator('#roomName').fill('Asked in')
    await host.locator('input[name="roomAccess"][value="ask"]').check()
    await host.locator('#create').click()
    const share = host.locator('#shareUrl')
    await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
    const link = await share.inputValue()
    await host.locator('#displayName').fill('Ada')
    await host.locator('#join').click()
    await expect(host.locator('#roomArea')).toBeVisible()

    // Rowan asks. The host sees who, by name, and lets them in.
    // Rowan's name goes in the request, so it is typed before the link
    // opens: the door for a room that asks first has no Join to press yet.
    const rowan = await b.newPage()
    await rowan.addInitScript(() => localStorage.setItem('kithmoot.name', 'Rowan'))
    await rowan.goto(link)
    await expect(rowan.locator('#status')).toContainText('Asking to be let in', { timeout: 60_000 })
    const card = host.locator('#approvals .approvalCard.knock')
    await expect(card).toContainText('Rowan wants to join', { timeout: 60_000 })
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(rowan.locator('#status')).toContainText('You are on the list', { timeout: 60_000 })
    await expect(host.locator('#chatLog')).toContainText('You let Rowan in.')
    await expect(rowan.locator('#join')).toBeVisible()
    await expect(rowan.locator('#displayName')).toHaveValue('Rowan')
    await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    // Sam asks and is declined: nothing goes over the wire, and the door
    // says somebody has to accept them.
    const sam = await c.newPage()
    await sam.addInitScript(() => localStorage.setItem('kithmoot.name', 'Sam'))
    await sam.goto(link)
    const second = host.locator('#approvals .approvalCard.knock')
    await expect(second).toContainText('Sam wants to join', { timeout: 60_000 })
    await second.getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(host.locator('#chatLog')).toContainText('You declined Sam.')
    await expect(host.locator('#approvals .approvalCard.knock')).toHaveCount(0)

    // The switch is in Room details for the device that answers the link.
    await host.locator('#roomMenu').click()
    await expect(host.locator('#toggleKnock')).toHaveAttribute('data-on', 'true')
  } finally { await a.close(); await b.close(); await c.close() }
})
