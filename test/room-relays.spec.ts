import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { createRoom, expectToSeeAndHear, joinWithMedia, newDeviceContext, open, startRelay, turnOnMedia } from './browser.js'
import { TEST_RELAY_PORT, testRelaysFor, withRelays } from './relays.js'

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

/**
 * The room's own relays: whatever a member has saved, everybody uses the
 * relays the room was made on.
 *
 * The bug this guards: a joiner whose saved relays for a room (and whose
 * defaults) named only relay B never met a creator on relay A. The saved
 * list won outright, the link's relays were ignored, and neither side ever
 * saw the other's call offers. Now the creator's relays ride in the signed
 * group invitation and every member's pool puts them first.
 */
test('a joiner whose own relays are all elsewhere still meets the room on the relays it was made on', async ({ browser, baseURL, browserName }) => {
  // Three relays of their own, over plain ws:// on loopback, which only
  // Chromium lets an https page open; the media half needs its fake camera.
  test.skip(browserName !== 'chromium', 'Chromium only: loopback ws:// relays and a fake camera')
  const relayA = await startRelay(TEST_RELAY_PORT + 21)
  const relayB = await startRelay(TEST_RELAY_PORT + 22)
  const relayC = await startRelay(TEST_RELAY_PORT + 23)
  const contexts: BrowserContext[] = []
  const A = `${relayA.url}/`, B = `${relayB.url}/`
  try {
    const makerContext = await newDeviceContext(browser, baseURL!)
    contexts.push(makerContext)
    const maker = await makerContext.newPage()
    const url = await createRoom(maker, baseURL!, [relayA.url])
    await maker.locator('#displayName').fill('Maker')
    await maker.locator('#join').click()
    await expect(maker.locator('#roomArea')).toBeVisible()
    await turnOnMedia(maker)
    // The room's relays are fixed now, signed, and kept apart.
    const fixed = await maker.evaluate(() => JSON.parse(localStorage.getItem('kithmoot.room-relays-fixed.v1') ?? '{}') as Record<string, { c: string[]; signed: boolean }>)
    const [roomId] = Object.keys(fixed)
    expect(fixed[roomId!]).toEqual({ c: [A], signed: true })

    // The joiner's own relays, both its defaults and its saved list for this
    // very room, name only B. C is a relay nobody uses.
    const joinerContext = await newDeviceContext(browser, baseURL!)
    contexts.push(joinerContext)
    await joinerContext.addInitScript(([room, b]) => {
      localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: b, read: true, write: true }], [`room:${room}`]: [{ url: b, read: true, write: true }] }))
    }, [roomId!, B])
    const joiner = await joinerContext.newPage()
    await joinWithMedia(joiner, url, 'Joiner')

    await expectToSeeAndHear(joiner, 'Joiner')
    await expectToSeeAndHear(maker, 'Maker')
    await joiner.locator('#chatInput').fill('Joiner on the room relay')
    await joiner.locator('#chatInput').press('Enter')
    await expect(maker.locator('#chatLog')).toContainText('Joiner on the room relay')
    await maker.locator('#chatInput').fill('Maker heard you')
    await maker.locator('#chatInput').press('Enter')
    await expect(joiner.locator('#chatLog')).toContainText('Maker heard you')

    // Learnt from the signed invitation, and the joiner's own list untouched.
    const held = await joiner.evaluate(room => ({
      fixed: (JSON.parse(localStorage.getItem('kithmoot.room-relays-fixed.v1') ?? '{}') as Record<string, unknown>)[room],
      own: (JSON.parse(localStorage.getItem('kithmoot.relays.v1') ?? '{}') as Record<string, { url: string }[]>)[`room:${room}`]!.map(relay => relay.url),
    }), roomId!)
    expect(held).toEqual({ fixed: { c: [A], signed: true }, own: [B] })
    // And a link the joiner hands on names the room's relay, not its own.
    const shared = await joiner.locator('#shareUrl').inputValue()
    expect(JSON.parse(Buffer.from(new URL(shared).hash.slice(1), 'base64url').toString()).r).toEqual([A])

    // Back in from a stale bookmark that names only B: still on A.
    await open(joiner, withRelays(url, [B]), 'Joiner')
    await joiner.locator('#join').click()
    await expect(joiner.locator('#roomArea')).toBeVisible()
    await expect(joiner.locator('#room .participant')).toHaveCount(2, { timeout: 60_000 })
    await joiner.locator('#chatInput').fill('Back from the bookmark')
    await joiner.locator('#chatInput').press('Enter')
    await expect(maker.locator('#chatLog')).toContainText('Back from the bookmark')
    await maker.locator('#chatInput').fill('Still here')
    await maker.locator('#chatInput').press('Enter')
    await expect(joiner.locator('#chatLog')).toContainText('Still here')
  } finally {
    for (const context of contexts) await context.close()
    await Promise.all([relayA.stop(), relayB.stop(), relayC.stop()])
  }
})
