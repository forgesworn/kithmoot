import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { base64urlnopad } from '@scure/base'
import { openRoomUrl, pinToTestRelays, testRelays, withRelays } from './relays.js'

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
 * The first case has C subscribe before B and asserts the end state. That is
 * ordering-independent coverage of the happy path and worth keeping, but it
 * is deliberately NOT evidence about the roster: C hears B simply because it
 * was already listening. It cannot put C ahead of A any more - the pass for
 * a second device is offered from inside the room now, so A has to be in
 * before there is a pairing link for B at all - and it does not need to,
 * because the case below is where the evidence lives.
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
const STRICT_RELAY = process.env.E2E_STRICT_RELAY ?? testRelays()?.[0] ?? 'wss://relay.trotters.cc'

async function newDeviceContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  // grantPermissions keys on an origin, and baseURL carries the app's `/j/`
  // sub-path - hand it the origin alone.
  await context.grantPermissions(['camera', 'microphone'], { origin: new URL(baseURL).origin })
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
  await page.locator('#roomType').selectOption('temporary')
  await page.locator('#create').click()
  // The room's own link exists as soon as the room does, but the drawer
  // holding it stays shut until somebody has gone in - the entry page shows
  // nothing that is not the conversation until there is a conversation, and
  // the `#links` box that used to sit here went with the rebuild. So this
  // waits for the value rather than the box, which is the thing the next
  // line reads and cannot be removed without failing honestly.
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)

  const joinUrl = await share.inputValue()
  expect(joinUrl, 'room creation did not produce a join URL').toContain('#')
  const payload = JSON.parse(
    new TextDecoder().decode(base64urlnopad.decode(new URL(joinUrl).hash.slice(1))),
  ) as Record<string, unknown>
  expect(payload.v, 'new room links must use the invitation format').toBe(2)
  expect(payload.s, 'a share URL must never contain the room traffic secret').toBeUndefined()
  expect(payload.j, 'the invitation bearer is missing').toEqual(expect.any(String))
  expect(payload.h, 'the pinned inviter pubkey is missing').toMatch(/^[0-9a-f]{64}$/)
  return joinUrl
}

/** The room's details - the link, the pass for a second device, who is
 *  here, the conversations, the admin controls. A sheet one tap off the
 *  message screen, which carries the header, the messages and the box to
 *  type in and nothing else. */
async function openRoomTools(page: Page): Promise<void> {
  const sheet = page.locator('#roomSheet')
  if (!(await sheet.evaluate((el) => (el as HTMLDialogElement).open))) {
    await page.locator('#roomMenu').click()
  }
  await expect(sheet).toHaveJSProperty('open', true)
}

/** Starts a pairing exchange on the page that will host it. The page must
 *  stay put afterwards: closing or navigating retires the code - and it must
 *  already be IN the room, because the pass for a second device is offered
 *  from the drawer inside it, not from the entry page. */
async function offerPairing(page: Page, joinUrl: string): Promise<string> {
  page.on('dialog', (dialog) => {
    void dialog.accept()
  })
  await openRoomTools(page)
  await page.locator('#addDevice').click()
  const pairUrl = await page.locator('#pairUrl').inputValue()
  expect(pairUrl, 'add device did not produce a pairing URL').toContain('#')
  expect(pairUrl, 'pairing URL must differ from the plain join URL').not.toBe(joinUrl)
  // The whole point of the rebuild: a pairing link is a room capability plus
  // a one-off code, and carries nothing secret to the person.
  expect(pairUrl.length, 'a pairing URL carrying a secret key would be far longer').toBeLessThan(
    joinUrl.length + 80,
  )
  // Shut the sheet again. It is a modal dialog, so leaving it open makes
  // the rest of the page inert - and what a person does after taking a
  // pairing link is go back to the room.
  await page.locator('#roomSheetClose').click()
  await expect(page.locator('#roomSheet')).toHaveJSProperty('open', false)
  return pairUrl
}

/**
 * Navigates to a join or pairing URL and gets as far as the door: a name
 * typed, and the way in ready to click. Stops there so the caller controls
 * subscribe/publish ordering.
 *
 * It used to turn the camera and microphone on here as well, because the
 * media row was on the entry page. It is not any more - a person goes in
 * first and turns their camera on inside, where there is a room for it to
 * be about - so that half moved to `turnOnMedia`, after `joinRoom`.
 */
async function prepareDevice(page: Page, url: string, name?: string): Promise<void> {
  await openRoomUrl(page, url)
  if (name !== undefined) {
    // Typed before joining, exactly as a person would: the roster entry
    // this device publishes carries whatever is in the field at join.
    await page.locator('#displayName').fill(name)
    await expect(page.locator('#whoami .name')).toHaveText(name)
  }
  await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
  // A device opening a pairing link holds the join button disabled until the
  // credential has actually arrived - joining early would mint a fresh
  // participant key and put it in the room as a stranger.
  await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
}

async function joinRoom(page: Page): Promise<void> {
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

/** Camera and microphone on - real synthetic media, granted with no human
 *  present via the --use-fake-device-for-media-stream and
 *  --use-fake-ui-for-media-stream launch flags in playwright.config.ts.
 *  Only reachable from inside the room, and now from behind the call
 *  control in the room's bar: a message screen carries a header, the
 *  conversation and the box to type in, and the camera appears when there
 *  is a call to point it at. */
async function turnOnMedia(page: Page): Promise<void> {
  await expect(
    page.locator('#callToggle'),
    'the call control only appears once this device is in the room',
  ).toBeVisible()
  if (await page.locator('#deviceControls').isHidden()) {
    await page.locator('#callToggle').click()
  }
  await expect(page.locator('#deviceControls')).toBeVisible()
  await page.locator('#toggleCamera').click()
  await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
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

/**
 * The observer's own screen again, this time on names. Two people who typed
 * the SAME name must still be two people on screen - which is only true
 * because a short pubkey renders beside every name, never instead of one.
 * A name is self-asserted; nothing checks it, and this is what stops that
 * mattering.
 */
async function expectSameNameStillTwoPeople(page: Page, name: string): Promise<void> {
  const room = page.locator('#room')
  const named = room.locator(`.participant h3 .name:text-is("${name}")`)
  await expect(named).toHaveCount(2, { timeout: 60_000 })

  const keys = await room.locator('.participant h3 .pubkey').allTextContents()
  expect(keys, 'every tile must show a short pubkey beside the name').toHaveLength(2)
  expect(new Set(keys).size, 'two people called the same thing must show different keys').toBe(2)
}

test('rotating a share link retires its public capability without moving the room', async ({ page, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const first = pinToTestRelays(await createRoom(page, baseURL!))
  await prepareDevice(page, first, 'Robin')
  // The new link is handed out from inside the room, so replacing it is too.
  await joinRoom(page)
  await openRoomTools(page)
  // A restored creator tab has the same local inviter key and would keep the
  // old link alive unless rotation is coordinated across tabs. It stays at
  // the door: this is about what it would still ANSWER, and its own copy of
  // the control is read off the app's `hidden` flag rather than off the
  // screen, because a control behind a shut drawer is not the same claim.
  const otherCreatorTab = await page.context().newPage()
  await openRoomUrl(otherCreatorTab, first)
  await expect(otherCreatorTab.locator('#rotateShare')).toHaveJSProperty('hidden', false)
  page.on('dialog', (dialog) => void dialog.accept())
  await page.locator('#rotateShare').click()
  await expect(page.locator('#shareUrl')).not.toHaveValue(first, { timeout: 60_000 })
  const second = await page.locator('#shareUrl').inputValue()

  expect(second).not.toBe(first)
  await expect(page.locator('#status')).toContainText('Current clients will no longer answer the old link')
  // And the room this tab is in is untouched by its link being replaced -
  // still in it, still with everything the room offers. The camera is
  // behind the call control now rather than beside the conversation, so
  // what this checks is that the control is there to press.
  await expect(page.locator('#roomArea')).toBeVisible()
  await expect(page.locator('#callToggle')).toBeVisible()
  // The wording pass that came with the rebuilt page took "retired" out of
  // this sentence along with every other word that assumed the reader knew
  // the vocabulary. What it says now is what the other tab actually reads.
  await expect(otherCreatorTab.locator('#status')).toContainText('replaced in another tab')
  await expect(otherCreatorTab.locator('#rotateShare')).toHaveJSProperty('hidden', true)
})

test('an admitted member keeps the invitation available after the creator leaves', async ({ browser, page, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const joinUrl = pinToTestRelays(await createRoom(page, baseURL!))
  // Re-open the creator on the rewritten relay hints so its responder and
  // the two independent browsers rendezvous on the same relay.
  await openRoomUrl(page, joinUrl)
  await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
  const memberContext = await newDeviceContext(browser, baseURL!)
  const arrivalContext = await newDeviceContext(browser, baseURL!)

  try {
    const member = await memberContext.newPage()
    await openRoomUrl(member, joinUrl)
    await expect(member.locator('#join')).toBeVisible({ timeout: 60_000 })
    // "Getting you in…" is a promise, and this is its ending. It used to
    // have none: the progress line stayed on screen, still styled as work
    // in progress, under a way in that was ready to be pressed, so the page
    // said it was still working and the button beside it said go. The line
    // says the admission landed and that the next move is the reader's, and
    // the progress styling comes off with it.
    await expect(member.locator('#status')).toContainText('Invitation accepted', { timeout: 15_000 })
    await expect(member.locator('#status')).toHaveClass(/\bdone\b/)

    // The creator was the original responder. Closing it leaves only the
    // newly admitted browser on the invitation rendezvous.
    await page.close()

    const arrival = await arrivalContext.newPage()
    await openRoomUrl(arrival, joinUrl)
    await expect(arrival.locator('#join')).toBeVisible({ timeout: 60_000 })
    // The same ending, for a browser admitted after the creator has gone.
    await expect(arrival.locator('#status')).toContainText('Invitation accepted', { timeout: 15_000 })
    // Read off the app's own flag, not off the screen: this browser holds no
    // inviter key so it must not be offering to replace the link, and the
    // drawer being shut would say that for it whether or not it were true.
    await expect(arrival.locator('#rotateShare')).toHaveJSProperty('hidden', true)
  } finally {
    await memberContext.close()
    await arrivalContext.close()
  }
})

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
    const joinUrl = pinToTestRelays(await createRoom(pageA, url))

    // Every device types the SAME name, deliberately. A and B are one
    // person on two devices; C is somebody else entirely who happens to
    // have typed the same thing - which anybody can.
    //
    // A goes in first, and now has to: the pass for a second device is
    // offered from the drawer inside the room, so there is no pairing link
    // to hand B until A is in. A then stays put, because the offer only
    // lives as long as the page that made it.
    await prepareDevice(pageA, joinUrl, 'Robin')
    await joinRoom(pageA)
    await turnOnMedia(pageA)
    const pairUrl = await offerPairing(pageA, joinUrl)

    // B: a SEPARATE context (own localStorage) opening the PAIRING url, so
    // it becomes a second device under A's identity - not a new person.
    await prepareDevice(pageB, pairUrl, 'Robin')
    // C: a separate person entirely, via the plain join URL.
    await prepareDevice(pageC, joinUrl, 'Robin')

    // C subscribes before B publishes anything - see the file-level comment
    // on why arrival order matters for a roster event in Nostr's ephemeral
    // kind range. C can no longer be first of all three, because A has to be
    // in the room to produce B's pairing link at all; this case was never
    // the evidence about the roster in any event, and the join-last case
    // below still is.
    await joinRoom(pageC)
    await turnOnMedia(pageC)
    await joinRoom(pageB)
    await turnOnMedia(pageB)

    await expectOnePairedGroupPlusSelf(pageC)
    await expectSameNameStillTwoPeople(pageC, 'Robin')
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

    // README's procedure, run exactly as written from here on. A JOINS and
    // turns its media on - so its roster entry is published and gone before
    // anyone else is listening.
    await joinRoom(pageA)
    await turnOnMedia(pageA)

    // Then A offers pairing, and B - a separate context, so separate
    // localStorage - takes it up and joins as A's second device.
    const pairUrl = await offerPairing(pageA, joinUrl)
    await prepareDevice(pageB, pairUrl)
    await joinRoom(pageB)
    await turnOnMedia(pageB)

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
