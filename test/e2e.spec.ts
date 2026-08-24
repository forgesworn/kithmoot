import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { base64urlnopad } from '@scure/base'

/**
 * Automated version of the acceptance test documented in README.md: two
 * devices of one participant must render as ONE tile group to everyone
 * else, not two strangers - and everyone must see it whatever order they
 * arrived in. Verified once by hand against live public
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
 * TWO CASES, AND WHY BOTH EXIST:
 * KithMoot's roster event (kind 20461, src/kinds.ts) is in Nostr's
 * "ephemeral" range (20000-29999), which relays do not store - a subscriber
 * that starts listening after the event was published is never sent it. The
 * protocol answer is announce-and-respond: an arriving device announces, and
 * the devices already present re-announce so the newcomer learns of them
 * (see docs/decisions.md).
 *
 * The first case has C subscribe FIRST and asserts the end state. That is
 * ordering-independent coverage of the happy path and worth keeping, but it
 * is deliberately NOT evidence about the roster: C hears everyone simply
 * because it was already listening.
 *
 * The second case is the evidence. C is the LAST to arrive - A and B are
 * already in the room and have stopped publishing before C's page even
 * loads - so the only way C can see them is because they answer its
 * announcement. It is the human-facing procedure in README, run exactly as
 * written, and before announce-and-respond existed it could not pass: a
 * device joining second saw an empty room.
 *
 * RELAYS: the first case creates a room through the real app UI, so it
 * inherits whichever relays app/src/main.ts's own RELAYS constant names -
 * that is the one place to change if a relay goes flaky again (see the
 * comment there), not this file.
 *
 * The join-last case pins itself to ONE relay, and not for convenience.
 * Measured on 24 August 2026 by publishing a kind-20461 event and
 * subscribing strictly afterwards:
 *
 *   wss://relay.trotters.cc   accepted, NOT replayed   (strict, NIP-01)
 *   wss://nos.lol             accepted, REPLAYED       (lenient)
 *   wss://relay.primal.net    accepted, REPLAYED       (lenient)
 *
 * Two of the three defaults store ephemeral events and replay them to a
 * later subscriber. Against those, a late joiner sees the room whether or
 * not announce-and-respond exists - so a join-last case run on the default
 * list asserts nothing about the roster at all. Verified: with the
 * re-announce disabled at source, that version of this test still passed.
 * Pinned to the strict relay it fails, which is what makes it evidence.
 */

/** A relay that honours NIP-01's ephemeral semantics - it does not replay a
 *  kind-20461 to a subscriber that arrived later. Override if this one is
 *  down; the test needs a strict relay, not this specific one. */
const STRICT_RELAY = process.env.E2E_STRICT_RELAY ?? 'wss://relay.trotters.cc'

/**
 * Rewrite the relay hint list inside a join URL's fragment, leaving every
 * other field exactly as the app wrote it.
 *
 * Parsed and re-encoded generically rather than rebuilt from known fields,
 * so a fragment that grows a new key later still round-trips untouched.
 */
function withRelays(url: string, relays: string[]): string {
  const parsed = new URL(url)
  const payload = JSON.parse(
    new TextDecoder().decode(base64urlnopad.decode(parsed.hash.slice(1))),
  ) as Record<string, unknown>
  payload.r = relays
  parsed.hash = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
  return parsed.href
}

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

/**
 * The assertion that matters, from the observer's own screen: exactly one
 * tile group for the paired person, reporting two devices, plus the
 * observer's own separate tile. If the paired devices ever rendered as two
 * strangers - or if the observer never learned they were there at all -
 * this is where it shows up.
 *
 * The generous timeout is deliberate: this waits on a real round trip
 * through public relays, and the fix for a slow relay is patience, never a
 * weaker assertion or a contrived arrival order.
 */
async function expectOnePairedGroupPlusSelf(page: Page): Promise<void> {
  const room = page.locator('#room')
  await expect(room.locator('.participant')).toHaveCount(2, { timeout: 60_000 })

  const linked = room.locator('.participant.linked')
  await expect(linked).toHaveCount(1)
  await expect(linked.locator('h3')).toContainText('2 devices')
  await expect(linked.locator('.badge')).toHaveText('one person')

  // The observer's own tile is separate, not folded into the paired one -
  // proves the grouping is per-participant, not "everyone in the room".
  const own = room.locator('.participant:not(.linked)')
  await expect(own).toHaveCount(1)
  await expect(own.locator('h3')).toContainText('(you)')
  await expect(own.locator('h3')).toContainText('1 device')
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

    await expectOnePairedGroupPlusSelf(pageC)
  } finally {
    await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()])
  }
})


test('a person who joins last still sees everyone already in the room', async ({ browser, baseURL }) => {
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

    // Pin the room to a relay that does not replay ephemeral events, so the
    // only thing that can tell C about A and B is A and B telling it. See
    // the measurements in the file comment above.
    const defaultUrl = await createRoom(pageA, url)
    // goto() to a URL that differs only in its fragment is a same-document
    // navigation, so the app's module-level entry point would never re-run
    // and the patched relay list would be silently ignored. reload() forces
    // a real document load, which is what re-reads the fragment.
    await pageA.goto(withRelays(defaultUrl, [STRICT_RELAY]))
    await pageA.reload()
    await prepareDevice(pageA, withRelays(defaultUrl, [STRICT_RELAY]))

    // Read the room link back off the app rather than trusting the patch:
    // this is the URL the app itself now hands out, carrying the relay list
    // it is actually using.
    const joinUrl = await pageA.locator('#shareUrl').inputValue()
    expect(joinUrl, 'the app did not pick up the pinned relay').not.toBe(defaultUrl)

    // README's procedure, run exactly as written from here on. A turns its
    // media on and JOINS - so its roster entry is published and gone before
    // anyone else is listening.
    await joinRoom(pageA)

    // Then A offers pairing, and B - a separate context, so separate
    // localStorage - takes it up and joins as A's second device.
    const pairUrl = await offerPairing(pageA, joinUrl)
    await prepareDevice(pageB, pairUrl)
    await joinRoom(pageB)

    // Wait for the room to actually settle into its two-device state before
    // C exists at all. This is a real signal, not a sleep: A can only render
    // "2 devices" once B's entry has been round-tripped through a relay.
    await expect(pageA.locator('#room .participant.linked h3')).toContainText('2 devices', {
      timeout: 60_000,
    })

    // NOW C arrives. Its page has not loaded until this line, so its
    // subscription starts strictly after A and B stopped publishing. Nothing
    // a relay stored can help it - relays do not store this kind - so the
    // only way C sees them is because they answer its announcement.
    const pageC = await ctxC.newPage()
    await prepareDevice(pageC, joinUrl)
    await joinRoom(pageC)

    await expectOnePairedGroupPlusSelf(pageC)
  } finally {
    await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()])
  }
})
