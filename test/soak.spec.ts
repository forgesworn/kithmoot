import { test, expect, type Page } from '@playwright/test'
import { withRelays } from './relays.js'
import { createRoom, expectToSeeAndHear, joinWithMedia, newDeviceContext, remotePictures, startRelay } from './browser.js'

/**
 * Does a call that came up STAY up?
 *
 * media.spec.ts proves two people can see and hear each other, and it
 * proves it from the pixels. It then looks away: the longest it ever holds
 * a picture is three seconds. Everything that took a working call down in
 * the field happened later than that, and none of it was a media fault.
 * The room's own bookkeeping did it: a heartbeat that did not arrive
 * through a relay, a clock that disagreed, a rung of the route ladder that
 * gave up and never tried again - and each one closed a peer connection
 * that was carrying perfectly good video.
 *
 * So this spec takes the relay away. Signalling, presence, chat: gone, for
 * longer than the presence timeout. The two browsers are on the same
 * machine and their connection needs nothing from anybody, and the claim
 * under test is that the room knows that: a device whose media is flowing
 * is a device that is here, whatever the relay has or has not carried
 * lately. Measured the way media.spec.ts measures - off the decoded pixels,
 * sampled every few seconds, and required to keep changing.
 */

const RELAY_PORT = 7779
/** Longer than `PRESENCE_TTL_SECONDS`, with margin for a sweep. */
const OUTAGE_MS = 90_000
const SAMPLE_MS = 5_000

async function expectStillMoving(page: Page, who: string, last: number): Promise<number> {
  await expect(page.locator('#room .participant'), `${who} lost the other person's tile`).toHaveCount(2)
  const pictures = await page.evaluate(remotePictures)
  expect(pictures.length, `${who} has no remote picture`).toBeGreaterThan(0)
  expect(pictures[0]!.hash, `${who}'s remote picture has frozen`).not.toBe(last)
  return pictures[0]!.hash
}

test('video keeps flowing through a relay outage longer than the presence timeout', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  test.setTimeout(300_000)

  let relay = await startRelay(RELAY_PORT)
  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const a = await contextA.newPage()
    const b = await contextB.newPage()

    const url = withRelays(await createRoom(a, baseURL!), [relay.url])
    await joinWithMedia(a, url, 'Alice')
    await joinWithMedia(b, url, 'Bob')
    await expectToSeeAndHear(a, 'Alice')
    await expectToSeeAndHear(b, 'Bob')

    // The relay goes away, and stays away past the point where every
    // heartbeat either side sent has lapsed.
    await relay.stop()
    let lastA = (await a.evaluate(remotePictures))[0]!.hash
    let lastB = (await b.evaluate(remotePictures))[0]!.hash
    const outageStarted = Date.now()
    while (Date.now() - outageStarted < OUTAGE_MS) {
      await a.waitForTimeout(SAMPLE_MS)
      const elapsed = Math.round((Date.now() - outageStarted) / 1000)
      lastA = await expectStillMoving(a, `Alice, ${elapsed}s into the outage,`, lastA)
      lastB = await expectStillMoving(b, `Bob, ${elapsed}s into the outage,`, lastB)
    }

    // And when it comes back, the room is whole: nobody was evicted, so
    // nobody has to be re-admitted, and the relay-borne channels - chat, for
    // one - pick up where they left off once nostr-tools has re-dialled.
    relay = await startRelay(RELAY_PORT)
    await a.locator('#chatInput').fill('still here')
    await a.locator('#chatInput').press('Enter')
    await expect(b.locator('#chatLog'), 'chat did not come back after the relay did').toContainText('still here', {
      timeout: 120_000,
    })
    lastA = await expectStillMoving(a, 'Alice, after the relay returned,', lastA)
    lastB = await expectStillMoving(b, 'Bob, after the relay returned,', lastB)
  } finally {
    await relay.stop().catch(() => {})
    await contextA.close()
    await contextB.close()
  }
})
