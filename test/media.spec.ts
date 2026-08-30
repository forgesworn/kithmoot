import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { openRoomUrl, pinToTestRelays } from './relays.js'

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

/** Reaches every RTCPeerConnection the app builds without the app having to
 *  expose one. Installed before any page script runs. */
const INSTRUMENT = () => {
  const win = window as unknown as { __pcs: RTCPeerConnection[] }
  win.__pcs = []
  const Original = window.RTCPeerConnection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window.RTCPeerConnection = class extends Original {
    constructor(...args: any[]) {
      super(...(args as [RTCConfiguration?]))
      win.__pcs.push(this)
    }
  } as unknown as typeof RTCPeerConnection
}

/** Inbound receive statistics, summed across every connection this device
 *  holds - the mesh is one connection per remote device, and the question
 *  here is only ever "is anything arriving". */
const inbound = async () => {
  const win = window as unknown as { __pcs: RTCPeerConnection[] }
  let framesDecoded = 0
  let audioEnergy = 0
  let videoStreams = 0
  for (const pc of win.__pcs ?? []) {
    let report: RTCStatsReport
    try {
      report = await pc.getStats()
    } catch {
      continue
    }
    report.forEach((r) => {
      if (r.type !== 'inbound-rtp') return
      if (r.kind === 'video') {
        videoStreams++
        framesDecoded += r.framesDecoded ?? 0
      } else {
        audioEnergy += r.totalAudioEnergy ?? 0
      }
    })
  }
  return { framesDecoded, audioEnergy, videoStreams }
}

/** Every remote `<video>` in the room, with the picture it is currently
 *  showing reduced to a mean and a spread. A tile that never got a track has
 *  no element at all; one showing a black frame has a spread near zero. */
const remotePictures = () => {
  const out: { width: number; height: number; mean: number; spread: number; hash: number }[] = []
  for (const tile of Array.from(document.querySelectorAll('#room .participant'))) {
    if ((tile.querySelector('h3')?.textContent ?? '').includes('(you)')) continue
    for (const video of Array.from(tile.querySelectorAll('video'))) {
      if (!video.videoWidth || !video.videoHeight) continue
      const canvas = document.createElement('canvas')
      canvas.width = 96
      canvas.height = 72
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0, 96, 72)
      const data = ctx.getImageData(0, 0, 96, 72).data
      let sum = 0
      let sumSquares = 0
      let count = 0
      let hash = 0
      for (let p = 0; p < data.length; p += 4) {
        const luminance = data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114
        sum += luminance
        sumSquares += luminance * luminance
        count++
        hash = (hash * 31 + (luminance | 0)) >>> 0
      }
      const mean = sum / count
      out.push({
        width: video.videoWidth,
        height: video.videoHeight,
        mean,
        spread: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)),
        hash,
      })
    }
  }
  return out
}

/**
 * Does this browser's fake microphone actually make a sound?
 *
 * It is supposed to: `--use-fake-device-for-media-stream` feeds a tone.
 * On macOS it sometimes stops - the device is present, `live` and unmuted,
 * and emits pure silence, at the `getUserMedia` level with no application
 * code anywhere near it. Every audio assertion below then fails for a reason
 * that has nothing to do with this project, and reads exactly like the bug
 * they exist to catch.
 *
 * So they are gated on this, and the gate is a real measurement rather than
 * an assumption: if the source is silent the audio checks are skipped with a
 * note saying why, and the video and roster checks carry on regardless. It
 * never makes a failing audio path look like a passing one - silence
 * downstream is only excused when silence upstream has been demonstrated.
 */
const fakeMicMakesSound = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const ctx = new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buffer = new Float32Array(analyser.fftSize)
  let peak = 0
  const started = performance.now()
  while (performance.now() - started < 2000) {
    analyser.getFloatTimeDomainData(buffer)
    for (const sample of buffer) peak = Math.max(peak, Math.abs(sample))
    if (peak > 0.001) break
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  for (const track of stream.getTracks()) track.stop()
  await ctx.close().catch(() => {})
  return peak > 0.001
}

/** Remote `<audio>` elements that are actually wired to a stream. Zero of
 *  these is precisely what the silent room looked like. */
const remoteAudioCount = () =>
  Array.from(document.querySelectorAll('#room .participant audio')).filter(
    (el) => (el as HTMLAudioElement).srcObject !== null,
  ).length

/** Starts a pairing exchange on the page that will host it. That page must
 *  stay put afterwards: closing or navigating retires the code, and it is
 *  the page that answers the request with a device credential. The dialog
 *  handler is what turns Playwright's default refusal into an approval. */
async function offerPairing(page: Page): Promise<string> {
  page.on('dialog', (dialog) => {
    void dialog.accept()
  })
  await page.locator('#addDevice').click()
  const pairUrl = await page.locator('#pairUrl').inputValue()
  expect(pairUrl, 'add device did not produce a pairing URL').toContain('#')
  return pairUrl
}

/** Opens a room and joins WITHOUT touching the camera or microphone, so the
 *  caller can decide what this device brings. */
async function open(page: Page, url: string, name: string): Promise<void> {
  await openRoomUrl(page, url)
  await page.locator('#displayName').fill(name)
  await expect(page.locator('#deviceControls')).toBeVisible()
  await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
}

async function newDeviceContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.grantPermissions(['camera', 'microphone'], { origin: new URL(baseURL).origin })
  await context.addInitScript(INSTRUMENT)
  return context
}

async function createRoom(page: Page, baseURL: string): Promise<string> {
  await page.goto(baseURL)
  await page.locator('#create').click()
  await expect(page.locator('#links')).toBeVisible()
  return pinToTestRelays(await page.locator('#shareUrl').inputValue())
}

/** Opens the room with camera and microphone on, and joins. */
async function joinWithMedia(page: Page, url: string, name: string): Promise<void> {
  await openRoomUrl(page, url)
  await page.locator('#displayName').fill(name)
  await expect(page.locator('#deviceControls')).toBeVisible()
  await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
  await page.locator('#toggleCamera').click()
  await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

/**
 * The whole assertion, from one person's screen: the other person is there,
 * visible, moving, and audible.
 */
async function expectToSeeAndHear(page: Page, who: string): Promise<void> {
  await expect(page.locator('#room .participant'), `${who} never saw anybody`).toHaveCount(2, {
    timeout: 60_000,
  })

  // A real element, with a real picture in it. Both halves matter: the bug
  // this guards produced no element at all, and a tile can also exist and
  // show nothing.
  await expect
    .poll(async () => (await page.evaluate(remotePictures)).length, {
      message: `${who} has no remote <video> element - the room is invisible`,
      timeout: 90_000,
    })
    .toBeGreaterThan(0)

  await expect
    .poll(async () => (await page.evaluate(inbound)).framesDecoded, {
      message: `${who} is decoding no video frames`,
      timeout: 90_000,
    })
    .toBeGreaterThan(0)

  const first = await page.evaluate(remotePictures)
  expect(first[0]!.spread, `${who}'s remote tile is a flat colour, not a picture`).toBeGreaterThan(3)

  // Moving, not a single frame frozen on arrival. Sampled twice with a real
  // gap, because "changed" is the only evidence of "live".
  await page.waitForTimeout(3000)
  const second = await page.evaluate(remotePictures)
  expect(second[0]!.hash, `${who}'s remote picture is frozen`).not.toBe(first[0]!.hash)

  // Wired up for sound. This half holds whatever the microphone is doing:
  // the element is what the bug removed, and its absence is what made the
  // room silent.
  expect(await page.evaluate(remoteAudioCount), `${who} has no remote <audio> element`).toBeGreaterThan(0)

  // Actually carrying sound. `totalAudioEnergy` is reported for audio that
  // reached a sink, so it stays at exactly zero when nothing was attached -
  // which is what made the silent room measurable rather than suspected.
  if (!(await page.evaluate(fakeMicMakesSound))) {
    test.info().annotations.push({
      type: 'audio not checked',
      description:
        "this browser's fake microphone is emitting silence, so there is no sound for the far end to receive - an environment fault, not a finding",
    })
    return
  }
  await expect
    .poll(async () => (await page.evaluate(inbound)).audioEnergy, {
      message: `${who} is receiving audio that carries no sound`,
      timeout: 60_000,
    })
    .toBeGreaterThan(0)
}

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

    // The laptop: a screen share and nothing else. It has to settle on its
    // room page before offering pairing, because the offer lives only as
    // long as the page that made it.
    await open(pageLaptop, url, 'Ada')
    await pageLaptop.locator('#toggleScreen').click()
    await expect(pageLaptop.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    const pairUrl = await offerPairing(pageLaptop)

    // The phone: a separate context, so separate localStorage - it opens the
    // PAIRING link and becomes a second device of Ada rather than a second
    // Ada. Camera and mic, as a phone would.
    await open(pagePhone, pairUrl, 'Ada')
    await pagePhone.locator('#toggleCamera').click()
    await pagePhone.locator('#toggleMic').click()
    await expect(pagePhone.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')

    // Cara: somebody else entirely, and the only screen that matters here.
    await open(pageCara, url, 'Cara')

    await pageLaptop.locator('#join').click()
    await pagePhone.locator('#join').click()
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
    // has to reach Ada, on the connection that was built without it.
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
