import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { createRoom, newDeviceContext, open } from './browser.js'
import { testRelaysFor } from './relays.js'

/**
 * The room's maker adds a relay for everybody.
 *
 * The owner's words: "it would be nice to be able to add a more resilient
 * relay into a room, i.e. mine! and then have everyone else going through
 * that relay as well". The maker adds a relay in the room's relay settings
 * and shares it; a member already in the room starts using it without
 * touching anything, and keeps the relays it had.
 */

const OWNER_RELAY = 'wss://owner-relay.example/'

/** A relay that answers every subscription with nothing and every write
 *  with OK, and remembers who asked. */
async function fakeRelay(context: BrowserContext, frames: unknown[][]): Promise<void> {
  await context.routeWebSocket(OWNER_RELAY, ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as unknown[]
      frames.push(frame)
      if (frame[0] === 'REQ') ws.send(JSON.stringify(['EOSE', frame[1]]))
      if (frame[0] === 'EVENT') ws.send(JSON.stringify(['OK', (frame[1] as { id: string }).id, true, '']))
    })
  })
}

async function openRelaySettings(page: Page): Promise<void> {
  await page.locator('#roomMenu').click()
  await page.locator('#roomRelaySettings').click()
  await expect(page.locator('#relaySettings')).toBeVisible()
}

test('the maker shares a relay and a member already in the room starts using it', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = []
  try {
    const makerContext = await newDeviceContext(browser, baseURL!)
    contexts.push(makerContext)
    const makerFrames: unknown[][] = []
    await fakeRelay(makerContext, makerFrames)
    const maker = await makerContext.newPage()
    // WebKit blocks a plain ws:// relay from an https page, so use the
    // test relay through the page's own origin.
    const url = await createRoom(maker, baseURL!, testRelaysFor(baseURL!))
    if (await maker.locator('#join').isVisible()) await maker.locator('#join').click()
    await expect(maker.locator('#roomArea')).toBeVisible()

    const memberContext = await newDeviceContext(browser, baseURL!)
    contexts.push(memberContext)
    const memberFrames: unknown[][] = []
    await fakeRelay(memberContext, memberFrames)
    const member = await memberContext.newPage()
    await open(member, url, 'Bea')
    await member.locator('#join').click()
    await expect(member.locator('#roomArea')).toBeVisible()
    const before = await member.locator('#shareUrl').inputValue()

    // A member who did not make the room is not offered the button.
    await openRelaySettings(member)
    await expect(member.locator('#relayShareRow')).toBeHidden()
    const had = await member.locator('#relayList .relayRow').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.url!))
    expect(had.length).toBeGreaterThan(0)
    await member.locator('#relaySettingsClose').click()

    await openRelaySettings(maker)
    await expect(maker.locator('#relayShareRow')).toBeVisible()
    await maker.locator('#relayUrl').fill(OWNER_RELAY)
    await maker.getByRole('button', { name: 'Add relay', exact: true }).click()
    // Shared only once applied: what everybody is sent is what this device uses.
    await maker.locator('#relayShare').click()
    await expect(maker.locator('#relaySettingsStatus')).toContainText('Apply changes first')
    await maker.locator('#relaySave').click()
    await maker.locator('#relayShare').click()
    await maker.getByRole('button', { name: 'Use for everyone', exact: true }).click()
    await expect(maker.locator('#relaySettingsStatus')).toContainText('Everyone in this room will add these relays')
    // The group invitation goes with it, so a newcomer reading only the new
    // relay can still get in.
    await expect.poll(() => makerFrames.some(frame => frame[0] === 'EVENT' && (frame[1] as { kind: number }).kind === 1463)).toBe(true)

    // The member connects to it and subscribes, with nothing pressed.
    await expect.poll(() => memberFrames.some(frame => frame[0] === 'REQ'), { timeout: 30_000 }).toBe(true)
    await expect(member.locator('#status')).toContainText('owner-relay.example')
    await openRelaySettings(member)
    await expect(member.locator('#relayList .relayRow').filter({ hasText: OWNER_RELAY })).toBeVisible()
    // Nothing taken away: every relay the member had is still there.
    const now = await member.locator('#relayList .relayRow').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.url!))
    expect(now).toEqual(expect.arrayContaining([...had, OWNER_RELAY]))
    // And the member's own share link now carries it, for whoever they invite.
    await expect.poll(() => member.locator('#shareUrl').inputValue()).not.toBe(before)
  } finally {
    for (const context of contexts) await context.close()
  }
})
