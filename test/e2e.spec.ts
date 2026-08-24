import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * Automated version of the acceptance test documented in README.md: two
 * devices of one participant must render as ONE tile group to everyone
 * else, not two strangers. Verified once by hand against live public
 * relays (see .superpowers/sdd progress notes); this test repeats that
 * check on every run so the claim cannot silently regress.
 *
 * Runs against REAL public relays (see RELAYS below) via a real built app
 * in real Chromium - deliberately not mocked, because the thing under test
 * is the wire-format roundtrip through those relays, not just local logic.
 * That means it needs the network and inherits real relay weather; it is
 * excluded from `npm test` for that reason (see playwright.config.ts) and
 * run on demand via `npm run test:e2e`.
 *
 * PRIVATE CONTEXTS, NOT TABS: device A and device B use SEPARATE Playwright
 * browser contexts (not two tabs/pages in one context), because a plain
 * join link and a pairing link are told apart by localStorage - two tabs in
 * one context would share it and silently defeat the point of the test.
 *
 * PAIRING IS A LIVE EXCHANGE: the pairing link carries a one-off code, never
 * an identity (src/pairing.ts). Page A has to STAY on the page that issued
 * it, because that page is what listens for B's request and answers it with
 * a device credential - so "Add a device" is clicked after A has finished
 * navigating, not before. A also has to accept a confirm() before the
 * credential is minted, which Playwright dismisses by default; the dialog
 * handler below is what makes it an approval rather than a refusal.
 *
 * CLICK ORDER, AND WHY IT DIFFERS FROM THE HUMAN-FACING PROCEDURE:
 * KithMoot's roster event (kind 20461, src/kinds.ts) is in Nostr's
 * "ephemeral" range (20000-29999), which relays are NOT required to store -
 * a REQ from a subscriber that only starts listening after the event was
 * published is not guaranteed to see it. The manual, human-facing procedure
 * in README opens the third browser LAST, and that works today against
 * nos.lol/relay.primal.net, which are lenient about this. This test does
 * not rely on that leniency: every context opens its room/pairing/join URL
 * and clicks "Join room" (which is what subscribes) before checking
 * anything, and the third context's subscription is established before it
 * asserts - so the test passes on strict NIP-01 relay behaviour too, not
 * just on today's lenient ones. The end state asserted is identical either
 * way; only the setup ordering changed, to make the test reliable rather
 * than merely lucky.
 *
 * RELAYS: this test creates a room through the real app UI, so it inherits
 * whichever relays app/src/main.ts's own RELAYS constant names - that is
 * the one place to change if a relay goes flaky again (see the comment
 * there), not this file.
 */

async function newDeviceContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.grantPermissions(['camera', 'microphone'], { origin: baseURL })
  return context
}

/** Opens the app fresh and starts a brand new room, without joining it -
 *  `startNewRoom()` in app/src/main.ts only generates the room secret and
 *  updates the address bar; it does not touch the network. Returns the
 *  plain join URL and, after clicking "Add a device", the pairing URL -
 *  both read straight, so this never needs to guess the URL fragment
 *  format the app happens to use today. */
async function createRoom(page: Page, baseURL: string): Promise<string> {
  await page.goto(baseURL)
  // #iceServers sits inside a collapsed <details> and already defaults to
  // a public STUN server (app/index.html) - nothing to change here.
  await page.locator('#create').click()
  await expect(page.locator('#links')).toBeVisible()

  const joinUrl = await page.locator('#shareUrl').inputValue()
  expect(joinUrl, 'room creation did not produce a join URL').toContain('#')
  return joinUrl
}

/** Starts a pairing exchange on the page that will host it. The page must
 *  stay put afterwards: closing or navigating retires the code. */
async function offerPairing(page: Page, joinUrl: string): Promise<string> {
  page.on('dialog', (dialog) => {
    void dialog.accept()
  })
  await page.locator('#addDevice').click()
  const pairUrl = await page.locator('#pairUrl').inputValue()
  expect(pairUrl, 'add device did not produce a pairing URL').toContain('#')
  expect(pairUrl, 'pairing URL must differ from the plain join URL').not.toBe(joinUrl)
  // The whole point of the rebuild: a pairing link is a room capability plus
  // a one-off code, and carries nothing secret to the person.
  expect(pairUrl.length, 'a pairing URL carrying a secret key would be far longer').toBeLessThan(
    joinUrl.length + 80,
  )
  return pairUrl
}

/** Navigates to a join or pairing URL and enables camera + mic - real
 *  synthetic media, granted with no human present via the
 *  --use-fake-device-for-media-stream / --use-fake-ui-for-media-stream
 *  launch flags in playwright.config.ts. Stops short of clicking "Join
 *  room" so the caller controls subscribe/publish ordering. */
async function prepareDevice(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect(page.locator('#deviceControls')).toBeVisible()
  // A device opening a pairing link holds the join button disabled until the
  // credential has actually arrived - joining early would mint a fresh
  // participant key and put it in the room as a stranger.
  await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
  await page.locator('#toggleCamera').click()
  await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
}

async function joinRoom(page: Page): Promise<void> {
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

test('two devices of one participant render as one tile group to a third person', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const url = baseURL!

  const [ctxA, ctxB, ctxC] = await Promise.all([
    newDeviceContext(browser, url),
    newDeviceContext(browser, url),
    newDeviceContext(browser, url),
  ])

  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    const pageC = await ctxC.newPage()

    // A creates the room (no network yet) and produces the join link.
    const joinUrl = await createRoom(pageA, url)

    // Get every device to the "ready, media on, not yet joined" point
    // before any of them subscribes or publishes. A settles on its room
    // page FIRST, then offers pairing - the offer only lives as long as the
    // page that made it.
    await prepareDevice(pageA, joinUrl)
    const pairUrl = await offerPairing(pageA, joinUrl)
    // B: a SEPARATE context (own localStorage) opening the PAIRING url, so
    // it becomes a second device under A's identity - not a new person.
    await prepareDevice(pageB, pairUrl)
    // C: a separate person entirely, via the plain join URL.
    await prepareDevice(pageC, joinUrl)

    // C subscribes FIRST, before the paired devices publish anything - see
    // the file-level comment on why this ordering matters for a roster
    // event in Nostr's ephemeral kind range.
    await joinRoom(pageC)
    await joinRoom(pageA)
    await joinRoom(pageB)

    // --- The assertion that matters -----------------------------------
    // From C's view: exactly one tile group for the paired person,
    // reporting two devices, plus C's own separate tile. If the paired
    // devices ever rendered as two strangers instead, this is where it
    // would show up.
    const room = pageC.locator('#room')
    await expect(room.locator('.participant')).toHaveCount(2, { timeout: 60_000 })

    const linked = room.locator('.participant.linked')
    await expect(linked).toHaveCount(1)
    await expect(linked.locator('h3')).toContainText('2 devices')
    await expect(linked.locator('.badge')).toHaveText('one person')

    // C's own tile is separate, not folded into the paired one - proves
    // the grouping is per-participant, not "everyone in the room".
    const own = room.locator('.participant:not(.linked)')
    await expect(own).toHaveCount(1)
    await expect(own.locator('h3')).toContainText('(you)')
    await expect(own.locator('h3')).toContainText('1 device')
  } finally {
    await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()])
  }
})
