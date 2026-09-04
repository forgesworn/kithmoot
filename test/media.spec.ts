import { test, expect, type Page } from '@playwright/test'
import { openRoomUrl, withRelays } from './relays.js'
import { createRoom, expectToSeeAndHear, inbound, joinWithMedia, newDeviceContext, offerPairing, open, openCall, openRoomDetails, remoteAudioCount, remotePictures, startSlowAckRelay, turnOnMedia } from './browser.js'

/**
 * Can you actually see and hear the other person?
 *
 * e2e.spec.ts answers a different question - whether the roster groups two
 * devices of one person into one tile - and it answers it well. But it asks
 * nothing about media, and on 29 August 2026 that gap hid the worst bug this
 * project has had: WebRTC negotiated, ICE connected, frames decoded at 20fps
 * on both sides, and **not one `<video>` or `<audio>` element ever reached
 * the page**. A room where everybody is present, correctly grouped, and
 * completely invisible and silent. 686 unit tests were green throughout.
 *
 * The cause was a subscription that went nowhere: the mesh does not exist
 * until `join()` builds it, and `RoomSession.onRemoteTrack` used to forward
 * straight to it, so subscribing first - which is what the app does, and the
 * only order with no window for a track to arrive unheard - returned a no-op
 * and dropped every track for the life of the call. A unit test now covers
 * that specific hole (session.test.ts), but a unit test could not have found
 * it, because nothing was wrong with any unit. What was wrong was the whole
 * path, end to end, in a real browser.
 *
 * So these assertions are deliberately made from the far end of that path -
 * the pixels and the samples, never the plumbing:
 *
 *   see  - `framesDecoded` rising AND the `<video>` element's own pixels,
 *          sampled off a canvas, non-flat and CHANGING between two samples.
 *          A black box that decodes frames is still a black box, and a
 *          frozen last frame is not a call.
 *   hear - `totalAudioEnergy` above zero, which Chromium only reports for
 *          audio that reached a sink. An `<audio>` element nobody attached
 *          reports exactly zero, which is how the silent room looked.
 *
 * Real public relays and real synthetic media, like e2e.spec.ts, and out of
 * `npm test` for the same reason: it inherits real relay weather.
 */

test('two people in a room can see and hear each other', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')

    // Both directions. A one-way call is a bug that has shipped before in
    // other projects precisely because only one side was ever asserted.
    await expectToSeeAndHear(pageA, 'Ada')
    await expectToSeeAndHear(pageB, 'Bob')

    // And you are in the room too: your own picture sits in your own tile
    // in the grid, beside everybody else's, not only in the preview strip
    // above the toggles. The preview strip is for before you join.
    const ownTile = pageA.locator('#room .participant', { hasText: '(you)' })
    await expect(ownTile.locator('video'), "Ada's own picture is not in her tile").toHaveCount(1)
    await expect(pageA.locator('#local video')).toHaveCount(0)
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

/**
 * Sharing a screen must not cost you your face.
 *
 * A device with its camera on that starts a screen share sends a SECOND
 * video track, and the room used to hang both on one `<video>` per device,
 * keyed by tag - so the screen share silently replaced the camera on
 * everybody else's screen. Two tracks decoding and one picture visible.
 * This is also the shape of the project's own headline claim (a laptop
 * sharing a screen beside a phone holding a camera), one device short of it.
 */
test('a screen share arrives alongside the camera, not instead of it', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')

    await expect
      .poll(async () => (await pageB.evaluate(remotePictures)).length, { timeout: 90_000 })
      .toBe(1)

    await pageA.locator('#toggleScreen').click()
    await expect(pageA.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')

    // Two inbound video streams, and - the part that regressed - two
    // pictures on screen rather than one that got overwritten.
    await expect
      .poll(async () => (await pageB.evaluate(inbound)).videoStreams, {
        message: 'the screen share never reached Bob as a second stream',
        timeout: 90_000,
      })
      .toBe(2)

    await expect
      .poll(async () => (await pageB.evaluate(remotePictures)).length, {
        message: 'the screen share replaced the camera instead of joining it',
        timeout: 90_000,
      })
      .toBe(2)

    const pictures = await pageB.evaluate(remotePictures)
    for (const picture of pictures) {
      expect(picture.spread, 'one of the two pictures is a flat colour').toBeGreaterThan(3)
    }
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

/**
 * The claim on the tin, with media in it.
 *
 * "Bring a phone for camera and mic and a laptop for a screen share, and
 * everyone else sees ONE participant with three tracks, not two strangers."
 * e2e.spec.ts proves the grouping - one tile, two devices, one badge - and
 * proves it well, but it proves it about LABELS. Nothing until now asserted
 * that the two devices of that one person actually deliver two live pictures
 * to the person watching, which is the difference between the claim and a
 * caption.
 *
 * So: Ada's laptop shares a screen, Ada's phone carries the camera, and the
 * assertion is made from Cara's screen - one tile, two pictures, both moving.
 */
test('one person on two devices delivers two live pictures to everybody else', async ({
  browser,
  baseURL,
}) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const laptop = await newDeviceContext(browser, baseURL!)
  const phone = await newDeviceContext(browser, baseURL!)
  const watcher = await newDeviceContext(browser, baseURL!)
  try {
    const pageLaptop = await laptop.newPage()
    const pagePhone = await phone.newPage()
    const pageCara = await watcher.newPage()

    const url = await createRoom(pageLaptop, baseURL!)

    // The laptop: a screen share and nothing else. It goes in first, and it
    // has to: both the screen-share button and the pass for a second device
    // are inside the room now, and the offer lives only as long as the page
    // that made it, so this page stays put from here on.
    await open(pageLaptop, url, 'Ada')
    await pageLaptop.locator('#join').click()
    await expect(pageLaptop.locator('#roomArea')).toBeVisible()
    await openCall(pageLaptop)
    await pageLaptop.locator('#toggleScreen').click()
    await expect(pageLaptop.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    const pairUrl = await offerPairing(pageLaptop)

    // The phone: a separate context, so separate localStorage - it opens the
    // PAIRING link and becomes a second device of Ada rather than a second
    // Ada. Camera and mic, as a phone would, turned on once it is in.
    await open(pagePhone, pairUrl, 'Ada')
    await pagePhone.locator('#join').click()
    await expect(pagePhone.locator('#roomArea')).toBeVisible()
    await turnOnMedia(pagePhone)

    // Cara: somebody else entirely, and the only screen that matters here.
    await open(pageCara, url, 'Cara')
    await pageCara.locator('#join').click()
    await expect(pageCara.locator('#roomArea')).toBeVisible()

    // One person, two devices - the grouping e2e.spec.ts guards, restated
    // here only because the media assertion below is meaningless without it.
    const grouped = pageCara.locator('#room .participant.linked')
    await expect(grouped).toHaveCount(1, { timeout: 90_000 })
    await expect(grouped.locator('h3')).toContainText('2 devices')

    // And the part nothing checked before: TWO live pictures, in that one
    // tile, from that one person.
    await expect
      .poll(async () => (await pageCara.evaluate(remotePictures)).length, {
        message: "Cara sees fewer than two pictures from Ada's two devices",
        timeout: 90_000,
      })
      .toBe(2)

    const first = await pageCara.evaluate(remotePictures)
    for (const picture of first) {
      expect(picture.spread, 'one of the two pictures is a flat colour').toBeGreaterThan(3)
    }

    await pageCara.waitForTimeout(3000)
    const second = await pageCara.evaluate(remotePictures)
    expect(
      second.some((p, i) => p.hash !== first[i]!.hash),
      'neither picture is moving',
    ).toBe(true)
  } finally {
    await laptop.close()
    await phone.close()
    await watcher.close()
  }
})

/**
 * Most people join a call with their camera and microphone off and turn
 * things on later, so a device with nothing to send is not an edge case -
 * it is the common one.
 *
 * It used to get nothing at all. A connection with no transceivers produces
 * an offer with no m-lines, which negotiates nothing and gathers no
 * candidates, so both sides ended `closed` and the route ladder escalated a
 * pair that was never going to connect through assist and forwarder to TURN.
 * The room then stayed broken after the person turned their camera on,
 * because the peers had been closed and were never rebuilt.
 */
test('somebody who joins with nothing on still sees and hears the room', async ({
  browser,
  baseURL,
}) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const speaking = await newDeviceContext(browser, baseURL!)
  const listening = await newDeviceContext(browser, baseURL!)
  try {
    const pageAda = await speaking.newPage()
    const pageBob = await listening.newPage()

    const url = await createRoom(pageAda, baseURL!)
    await joinWithMedia(pageAda, url, 'Ada')

    // Bob brings nothing at all.
    await open(pageBob, url, 'Bob')
    await pageBob.locator('#join').click()
    await expect(pageBob.locator('#roomArea')).toBeVisible()

    await expectToSeeAndHear(pageBob, 'Bob (who brought nothing)')

    // And he is a full participant, not a spectator: turning his camera on
    // has to reach Ada, on the connection that was built without it. He
    // brought nothing, so this is the first time he has opened the call.
    await openCall(pageBob)
    await pageBob.locator('#toggleCamera').click()
    await expect(pageBob.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect
      .poll(async () => (await pageAda.evaluate(remotePictures)).length, {
        message: "Bob's camera never reached Ada after he turned it on",
        timeout: 90_000,
      })
      .toBe(1)
  } finally {
    await speaking.close()
    await listening.close()
  }
})

/**
 * Turning a camera off has to look off to everybody else.
 *
 * Stopping a track locally is invisible on the wire: the sender stays in
 * place, sends nothing, and says nothing, so the far end holds the last
 * frame it decoded and shows it for the rest of the call. Nothing published
 * the change either - `publishActiveTracks()` was called when media was
 * turned ON and not when it was turned off - so a person who switched their
 * camera off carried on sitting on everybody else's screen, frozen
 * mid-gesture. "Off" that does not look off is a promise the room is not
 * keeping, and this is the test that holds it to it.
 */
test('turning a camera off takes the picture off everybody else screen', async ({
  browser,
  baseURL,
}) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')

    await expect
      .poll(async () => (await pageB.evaluate(remotePictures)).length, { timeout: 90_000 })
      .toBe(1)
    await pageA.locator('#toggleCamera').click()
    await expect(pageA.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')

    await expect
      .poll(async () => (await pageB.evaluate(remotePictures)).length, {
        message: "Ada's last frame is still on Bob's screen",
        timeout: 60_000,
      })
      .toBe(0)

    // And it comes back - once, not as a second picture beside the stale one.
    await pageA.locator('#toggleCamera').click()
    await expect(pageA.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect
      .poll(async () => (await pageB.evaluate(remotePictures)).length, {
        message: 'the camera did not come back, or came back twice',
        timeout: 90_000,
      })
      .toBe(1)
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

/**
 * BUG: the person who started the room could see and hear whoever joined,
 * and the joiner could see and hear nobody.
 *
 * Whoever is already in a room answers an arrival by opening a connection
 * and offering, the instant the announcement reaches them. The joiner's
 * `join()` used to build the mesh - the thing that subscribes to signals -
 * only after every relay had acknowledged the announcement, a full round
 * trip after it had been broadcast. A signal is ephemeral: a relay delivers
 * it to whoever is subscribed when it arrives and keeps it for nobody. So
 * the host's offer, the one carrying the host's camera and microphone, went
 * to a subscription that did not exist yet. The joiner's own offer came
 * later and was answered, and the call came up one way.
 *
 * The CI relay's round trip is under a millisecond, and this never once
 * showed on it. So this room is pinned to a relay whose acknowledgement lags
 * its delivery by nearly half a second - a slow public relay, made
 * deterministic - and the assertion is made from the joiner's screen, with
 * a bound: the host's picture has to arrive well inside the route timer.
 * Arriving after it would mean the first offer was lost and the ladder
 * rebuilt the pair, which is the bug with a recovery bolted on, not the
 * absence of the bug.
 */
test('whoever starts the room is seen and heard by a joiner, however slow the relay is to acknowledge', async ({
  browser,
  baseURL,
}) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  // This case pins the room to a relay on loopback, and Chromium's
  // local-network-access rules stop a page served from a public https origin
  // opening a ws:// socket to 127.0.0.1 - the join fails with "every relay
  // rejected the event" before anything under test has run. A page served
  // from localhost (the CI and local configuration) is itself loopback and
  // may. So against a deployed site this case is skipped, and the deployed
  // build is covered by the ordinary two-person case over public relays.
  test.skip(
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL ?? 'http://invalid/').hostname),
    'a public https origin cannot open a ws:// relay on loopback (local network access)',
  )

  const relay = await startSlowAckRelay(7778, 400)
  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = withRelays(await createRoom(pageA, baseURL!), [relay.url])
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')
    const joined = Date.now()

    // The direction that was dead: the joiner receiving the host.
    await expect
      .poll(async () => (await pageB.evaluate(inbound)).framesDecoded, {
        message:
          "Bob is not decoding Ada's video inside the route timer - the host's first offer was lost and nothing " +
          'made up for it in time',
        timeout: 8_000,
      })
      .toBeGreaterThan(0)
    test.info().annotations.push({
      type: 'first frame from the host',
      description: `${Date.now() - joined}ms after the joiner joined`,
    })

    await expectToSeeAndHear(pageB, 'Bob (who joined second)')
    await expectToSeeAndHear(pageA, 'Ada (who started the room)')
  } finally {
    await contextA.close()
    await contextB.close()
    await relay.stop()
  }
})

test('somebody who leaves is gone from everybody else at once', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  // Jitsi drops a tile the moment somebody hangs up. Before the farewell
  // carried `left`, the app had no Leave control at all and a closed tab
  // said nothing: everybody else kept the tile for PRESENCE_TTL_SECONDS,
  // and their mesh spent that time escalating a volunteer, a forwarder and
  // then TURN chasing a device that had gone.
  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')
    await expect(pageB.locator('#room .participant'), 'Bob never saw Ada').toHaveCount(2, { timeout: 60_000 })

    // Leaving is in the room's details, with everything else that is not
    // the conversation.
    await openRoomDetails(pageA)
    await pageA.locator('#leave').click({ timeout: 5_000 })

    // Well inside the 75 s presence timeout: this is the farewell arriving,
    // not the sweep catching up.
    await expect(pageB.locator('#room .participant'), 'Ada lingered after leaving').toHaveCount(1, {
      timeout: 15_000,
    })
    // And Ada is back at the door of the same room, able to rejoin.
    await expect(pageA.locator('#join')).toBeVisible({ timeout: 15_000 })
    await expect(pageA.locator('#roomArea')).toBeHidden()
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
