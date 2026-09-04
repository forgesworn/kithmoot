import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openRoomUrl, pinToTestRelays } from './relays.js'

/**
 * What the browser acceptance specs share: how to reach every peer
 * connection the app builds, how to read a remote picture off its pixels,
 * and how to drive the app's own controls. Extracted from media.spec.ts so
 * a soak test - the one question that file never asks, whether a call that
 * came up stays up - measures with exactly the same instruments.
 */

/**
 * A microphone that is never silent: every audio `getUserMedia` returns a
 * steady tone from an oscillator, video untouched.
 *
 * Chromium's fake microphone is supposed to emit a tone, and on macOS it
 * sometimes emits silence instead - present, `live`, unmuted, and empty -
 * at the `getUserMedia` level with no application code anywhere near it.
 * media.spec.ts gates its sound assertions on measuring that; a spec whose
 * whole point is that an agent HEARS somebody cannot gate it away, so it
 * brings its own sound.
 */
export const SYNTHETIC_MIC = () => {
  const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    if (!constraints?.audio) return native(constraints)
    const ctx = new AudioContext()
    await ctx.resume().catch(() => {})
    const osc = ctx.createOscillator()
    osc.frequency.value = 440
    const gain = ctx.createGain()
    gain.gain.value = 0.3
    const dest = ctx.createMediaStreamDestination()
    osc.connect(gain).connect(dest)
    osc.start()
    const stream = dest.stream
    if (constraints.video) for (const t of (await native({ video: constraints.video })).getVideoTracks()) stream.addTrack(t)
    ;(window as unknown as { __syntheticMic: unknown }).__syntheticMic = { ctx, osc }
    return stream
  }
}

/** Reaches every RTCPeerConnection the app builds without the app having to
 *  expose one. Installed before any page script runs. */
export const INSTRUMENT = () => {
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
export const inbound = async () => {
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
export const remotePictures = () => {
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
export const fakeMicMakesSound = async () => {
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
export const remoteAudioCount = () =>
  Array.from(document.querySelectorAll('#room .participant audio')).filter(
    (el) => (el as HTMLAudioElement).srcObject !== null,
  ).length

/** Starts a pairing exchange on the page that will host it. That page must
 *  stay put afterwards: closing or navigating retires the code, and it is
 *  the page that answers the request with a device credential. The dialog
 *  handler is what turns Playwright's default refusal into an approval. */
export async function offerPairing(page: Page): Promise<string> {
  page.on('dialog', (dialog) => {
    void dialog.accept()
  })
  // The pass for a second device is offered from inside the room now, out of
  // the sheet that holds everything which is not the conversation. A page
  // still at the door has no `#addDevice` to click.
  await openRoomDetails(page)
  await page.locator('#addDevice').click()
  const pairUrl = await page.locator('#pairUrl').inputValue()
  expect(pairUrl, 'add device did not produce a pairing URL').toContain('#')
  // Shut the sheet again. It is a modal dialog, so leaving it open makes
  // the rest of the page inert - and what a person does after taking a
  // pairing link is go back to the room.
  await page.locator('#roomSheetClose').click()
  await expect(page.locator('#roomSheet')).toHaveJSProperty('open', false)
  return pairUrl
}

/**
 * The room's details: everything that is not the conversation. The room's
 * own link, the pass for a second device, who is here, the conversations,
 * the admin controls, the bug report.
 *
 * It is a sheet now rather than a drawer on the page, because a message
 * screen shows a header, the messages and the box to type in and nothing
 * else. Anything reaching for one of those controls opens the sheet itself
 * rather than assuming it is already open.
 */
export async function openRoomDetails(page: Page): Promise<void> {
  const sheet = page.locator('#roomSheet')
  if (!(await sheet.evaluate((el) => (el as HTMLDialogElement).open))) {
    await page.locator('#roomMenu').click()
  }
  await expect(sheet).toHaveJSProperty('open', true)
}

/** Move to one of the room's conversations. Picking one closes the sheet it
 *  was picked in, which is what makes it a switcher rather than a tab row. */
export async function goToConversation(page: Page, name: string): Promise<void> {
  await openRoomDetails(page)
  await page.locator('#channelBar button', { hasText: name }).click()
  await expect(page.locator('#roomSheet')).toHaveJSProperty('open', false)
}

/**
 * Up to the door and no further: a room link opened and a name typed, with
 * the way in ready to click. The caller decides when this device actually
 * goes in, because that is what decides who is listening when.
 *
 * There is nothing else to do out here. The camera and microphone buttons
 * are not on the entry page: the rebuilt page shows nothing that is not the
 * conversation until there is a conversation, so they arrive with the room.
 */
export async function open(page: Page, url: string, name: string): Promise<void> {
  await openRoomUrl(page, url)
  await page.locator('#displayName').fill(name)
  await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
}

export async function newDeviceContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.grantPermissions(['camera', 'microphone'], { origin: new URL(baseURL).origin })
  await context.addInitScript(INSTRUMENT)
  return context
}

export async function createRoom(page: Page, baseURL: string): Promise<string> {
  await page.goto(baseURL)
  await page.locator('#create').click()
  // Wait for the link itself rather than the box that used to hold it. The
  // entry page was rebuilt to put the conversation first and `#links` went
  // with it; this waits for the thing the next line actually reads, which
  // cannot be removed without this failing honestly.
  // The link exists as soon as the room does, but the drawer around it stays
  // hidden until somebody joins, because the rebuilt page shows nothing that
  // is not the conversation until there is a conversation. So wait for the
  // value rather than for it to be on screen: waiting for visibility here
  // would be asserting a thing the page deliberately does not do yet.
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  return pinToTestRelays(await share.inputValue())
}

/**
 * In, with a camera and a microphone on - in the order a person can
 * actually do it.
 *
 * This used to turn the camera and microphone on and THEN join, because the
 * media row was on the entry page. It is not any more: a person puts in a
 * name, goes in, and turns their camera or microphone on once they are
 * inside, where there is a room for it to be about. Turning them on before
 * joining is not a thing the app offers, so a helper that did it was not
 * walking the product - it was walking a page that no longer exists.
 *
 * This is the only order there is now, which means every spec joining "with
 * media" is really joining with nothing and adding tracks a moment later.
 * That path is renegotiation rather than a first offer, and it is the one
 * the app has.
 */
export async function joinWithMedia(page: Page, url: string, name: string): Promise<void> {
  await open(page, url, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await turnOnMedia(page)
}

/**
 * Open the call.
 *
 * The camera, microphone and screen share live behind the call control in
 * the room's bar: the message screen carries a header, the conversation and
 * the box to type in, and the call controls appear when there is a call to
 * point them at. Idempotent, so a caller that does not know whether the
 * call is already open can just say so.
 */
export async function openCall(page: Page): Promise<void> {
  await expect(
    page.locator('#callToggle'),
    'the call control only appears once this device is in the room',
  ).toBeVisible()
  if (await page.locator('#deviceControls').isHidden()) {
    await page.locator('#callToggle').click()
  }
  await expect(page.locator('#deviceControls')).toBeVisible()
}

/** Camera and microphone on, from inside the room. The controls arrive with
 *  the room, so this is only ever called after joining. */
export async function turnOnMedia(page: Page): Promise<void> {
  await openCall(page)
  await page.locator('#toggleCamera').click()
  await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
}

/**
 * The whole assertion, from one person's screen: the other person is there,
 * visible, moving, and audible.
 */
export async function expectToSeeAndHear(page: Page, who: string): Promise<void> {
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

/**
 * A second copy of test/ws-relay.mjs on its own port, acknowledging late.
 * See `RELAY_OK_DELAY_MS` there. Resolves once it answers HTTP, which is how
 * playwright.config.ts waits for the main one too.
 */
export async function startSlowAckRelay(port: number, okDelayMs: number): Promise<{ url: string; stop(): Promise<void> }> {
  return startRelay(port, okDelayMs)
}

/** A copy of test/ws-relay.mjs on its own port, so a spec can stop and
 *  restart the relay under a live call. */
export async function startRelay(port: number, okDelayMs = 0): Promise<{ url: string; stop(): Promise<void> }> {
  const script = fileURLToPath(new URL('./ws-relay.mjs', import.meta.url))
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, RELAY_PORT: String(port), RELAY_OK_DELAY_MS: String(okDelayMs) },
    stdio: 'ignore',
  })
  // Resolved when the process is gone, however it went. `stop()` waits on
  // this rather than on a fresh `once('exit')`, which never fires for a
  // process that has already exited - and a spec that stops the relay
  // deliberately, then again in its teardown, would otherwise hang there
  // until the test timeout.
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const started = Date.now()
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() - started > 15_000) {
      child.kill()
      throw new Error('the slow-ack relay did not start')
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    url: `ws://127.0.0.1:${port}`,
    stop: () => {
      child.kill()
      return exited
    },
  }
}

