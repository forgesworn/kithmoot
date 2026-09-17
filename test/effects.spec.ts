import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
// @ts-expect-error - plain ESM helper, no types, and none wanted for a fixture
import { writeScene } from './synthetic-scene.mjs'
import { openRoomUrl, pinToTestRelays } from './relays.js'

/**
 * Does the blur actually blur, and does it survive a camera swap?
 *
 * Both questions are answered by measuring published pixels rather than by
 * reading the code back. The camera is Chromium's fake device pointed at a
 * generated scene (test/synthetic-scene.mjs): a head-and-shoulders
 * silhouette in front of a fine checkerboard. **Never a real room** - the
 * incident that prompted this whole feature was a real room reaching a
 * screenshot, and a test that needs one to pass would be a poor answer to it.
 *
 * "Blurred" is the variance of a Laplacian over a patch, which drops by an
 * order of magnitude when a checkerboard is blurred and barely moves when it
 * is not. It is a number, so the assertion is a number.
 *
 * Unlike test/e2e.spec.ts this needs no public relays and no network
 * weather. It does have to go into a room, because the camera control lives
 * inside one now, so it pins its room to the local test relay first and
 * measures pixels from there. Nobody else ever joins it.
 */

// Written to the OS temp directory rather than into `test-results/`, which
// Playwright empties for itself at the start of a run: a fixture put there
// is deleted between collection and the first test, and Chromium answers a
// missing capture file by quietly falling back to its own rolling colour
// pattern. That is a camera, so most of these still pass, which is the worst
// possible way for it to go wrong.
const sceneDir = join(tmpdir(), 'kithmoot-effects')
mkdirSync(sceneDir, { recursive: true })
const scenePath = join(sceneDir, 'synthetic-scene.y4m')
writeFileSync(scenePath, writeScene(640, 480, 12))

// Nothing here waits on a relay, so the 180s in playwright.config.ts - which
// exists for real relay weather - is three minutes of nothing when something
// is wrong. The slow part is fetching 11.7MB of WASM once.
test.setTimeout(90_000)

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${scenePath}`,
    ],
  },
})

/**
 * This device's own picture, wherever it is parented.
 *
 * The holder is one persistent element that moves: it sits in the strip
 * under the toggles when nobody is in a room, and in your own tile in the
 * room from the moment you go in. Keyed on the holder's own class rather
 * than on where it happens to be, so it survives being moved again.
 */
const LOCAL_VIDEO = '.media.mine video'

/** Regions of the 640x480 scene, as fractions, so they survive a camera that
 *  negotiates a different resolution than the file was written at. */
const BACKGROUND_PATCH = { x: 0.03, y: 0.05, w: 0.16, h: 0.2 }
const FACE_PATCH = { x: 0.42, y: 0.24, w: 0.16, h: 0.2 }

interface Sharpness {
  background: number
  face: number
  width: number
  height: number
}

/**
 * Pull the current published frame out of the local preview and measure how
 * much high-frequency detail survives in two places.
 *
 * The preview element is showing the canvas capture stream, which is the
 * exact track the mesh publishes, so this is measuring what the room would
 * see and not a separate rendering of it.
 */
async function measure(page: Page): Promise<Sharpness> {
  return page.evaluate(
    ({ background, face }) => {
      const video = document.querySelector<HTMLVideoElement>('.media.mine video')
      if (!video || video.videoWidth === 0) throw new Error('no local preview frame yet')
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2D context')
      ctx.drawImage(video, 0, 0)

      const patch = (region: { x: number; y: number; w: number; h: number }): number => {
        const x = Math.round(region.x * canvas.width)
        const y = Math.round(region.y * canvas.height)
        const w = Math.round(region.w * canvas.width)
        const h = Math.round(region.h * canvas.height)
        const { data } = ctx.getImageData(x, y, w, h)
        const luma = new Float64Array(w * h)
        for (let i = 0; i < w * h; i += 1) {
          luma[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!
        }
        // Variance of a four-neighbour Laplacian: the standard "is this
        // image in focus" measure, and it collapses under a Gaussian blur.
        const values: number[] = []
        for (let py = 1; py < h - 1; py += 1) {
          for (let px = 1; px < w - 1; px += 1) {
            const i = py * w + px
            values.push(
              4 * luma[i]! - luma[i - 1]! - luma[i + 1]! - luma[i - w]! - luma[i + w]!,
            )
          }
        }
        const mean = values.reduce((a, b) => a + b, 0) / values.length
        return values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
      }

      return { background: patch(background), face: patch(face), width: canvas.width, height: canvas.height }
    },
    { background: BACKGROUND_PATCH, face: FACE_PATCH },
  )
}

/**
 * Mean colour of a patch, and the whole background as raw bytes.
 *
 * Replacement is not answered by the sharpness measure alone: a blurred room
 * and a drawn sea are both "less detail than a checkerboard". What separates
 * them is that the sea is a different colour, and that it is not the same
 * two frames running. Both of those need pixels rather than a number, so
 * this hands back the bytes and lets the test do the arithmetic.
 */
async function samplePixels(page: Page): Promise<{
  background: { r: number; g: number; b: number }
  face: { r: number; g: number; b: number }
  /** Luma along the two outer columns and the very top of the frame.
   *
   *  Deliberately narrow. The generated scene's shoulders reach to about a
   *  sixth of the way in from each side and the whole silhouette slides a
   *  few pixels back and forth, so a wider sample would be measuring the
   *  person moving and calling it a moving background. */
  outside: number[]
}> {
  return page.evaluate(
    ({ background, face }) => {
      const video = document.querySelector<HTMLVideoElement>('.media.mine video')
      if (!video || video.videoWidth === 0) throw new Error('no local preview frame yet')
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2D context')
      ctx.drawImage(video, 0, 0)

      const mean = (region: { x: number; y: number; w: number; h: number }) => {
        const x = Math.round(region.x * canvas.width)
        const y = Math.round(region.y * canvas.height)
        const w = Math.round(region.w * canvas.width)
        const h = Math.round(region.h * canvas.height)
        const { data } = ctx.getImageData(x, y, w, h)
        let r = 0
        let g = 0
        let b = 0
        for (let i = 0; i < w * h; i += 1) {
          r += data[i * 4]!
          g += data[i * 4 + 1]!
          b += data[i * 4 + 2]!
        }
        return { r: r / (w * h), g: g / (w * h), b: b / (w * h) }
      }

      const strip = (x: number, y: number, w: number, h: number): number[] => {
        const px = Math.round(x * canvas.width)
        const py = Math.round(y * canvas.height)
        const pw = Math.round(w * canvas.width)
        const ph = Math.round(h * canvas.height)
        const { data } = ctx.getImageData(px, py, pw, ph)
        const out: number[] = []
        // Every fourth pixel: enough to see a scene move, a tenth of the
        // bytes to carry back out of the page.
        for (let i = 0; i < pw * ph; i += 4) {
          out.push(0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!)
        }
        return out
      }

      return {
        background: mean(background),
        face: mean(face),
        outside: [...strip(0, 0, 0.1, 1), ...strip(0.9, 0, 0.1, 1), ...strip(0.1, 0, 0.8, 0.1)],
      }
    },
    { background: BACKGROUND_PATCH, face: FACE_PATCH },
  )
}

/** Mean absolute difference between two of those strips. Zero means the
 *  background is a still picture; anything above it means something moved. */
function drift(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let total = 0
  for (let i = 0; i < n; i += 1) total += Math.abs(a[i]! - b[i]!)
  return n ? total / n : 0
}

async function openCamera(page: Page): Promise<void> {
  await goIn(page)
  await page.getByRole('button', { name: 'Camera' }).click()
  await expect(page.locator(LOCAL_VIDEO)).toBeVisible()
  await page.locator('#callExtras > summary').click()
  await page.locator('#cameraEffects > summary').click()
  await page.waitForFunction((selector) => {
    const video = document.querySelector<HTMLVideoElement>(selector)
    return !!video && video.videoWidth > 0
  }, LOCAL_VIDEO)
  // On screen, not merely in the document. Chromium does not paint a
  // MediaStream video that is scrolled out of view, and `drawImage` from an
  // unpainted element gives a flat frame: the measurement below then reads
  // zero detail with the effect off and nothing is learned. Whatever the
  // page puts above the preview, the measurement must not depend on it.
  await page.locator(LOCAL_VIDEO).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
}

/**
 * Start a room and go in.
 *
 * The camera and microphone buttons are not on the entry page any more: the
 * page was rebuilt to show nothing that is not the conversation until there
 * is a conversation, so they arrive with the room. Everything this file
 * measures is behind that door.
 */
async function goIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a room' }).click()
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  // Going in is what puts this device on a relay, and nothing measured in
  // this file has any business depending on which one. Re-opened on the
  // pinned link, so the room is on the test relay before the door opens.
  await openRoomUrl(page, pinToTestRelays(await share.inputValue()))
  await page.locator('#displayName').fill('Robin')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  // The camera and microphone are behind the call control in the room's bar
  // now: a message screen carries a header, the conversation and the box to
  // type in, and the camera appears when there is a call to point it at.
  await expect(page.locator('#callToggle')).toBeVisible()
  if (await page.locator('#deviceControls').isHidden()) {
    await page.locator('#callToggle').click()
  }
  await expect(page.locator('#deviceControls')).toBeVisible()
}

/** The frame routes taken since the camera came on. `passthrough` above zero
 *  while an effect is selected is the failure this feature exists to prevent. */
async function routes(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const panel = document.getElementById('effects')!
    return {
      passthrough: Number(panel.dataset.passthrough ?? '0'),
      blurAll: Number(panel.dataset.blurAll ?? '0'),
      composite: Number(panel.dataset.composite ?? '0'),
      fps: Number(panel.dataset.fps ?? '0'),
      frameCostMs: Number(panel.dataset.frameCostMs ?? '0'),
    }
  })
}

/** Waits for the segmenter to be past loading, whichever way it went. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('#effectStatus')).not.toContainText('Loading', { timeout: 60_000 })
}

test('blur is on by default and genuinely blurs the room', async ({ page }) => {
  await openCamera(page)
  await settle(page)
  await expect(page.locator('#effectMode')).toHaveText('blur')

  await page.waitForTimeout(1500)
  const blurred = await measure(page)

  await page.locator('#effectModes button[data-mode="off"]').click()
  await expect(page.locator('#effectMode')).toHaveText('off')
  await page.waitForTimeout(1000)
  const raw = await measure(page)

  // The room behind the person: an order of magnitude of detail should be
  // gone. Anything less than a halving would not be a blur anybody would
  // trust their living room to.
  expect(raw.background).toBeGreaterThan(50)
  expect(blurred.background).toBeLessThan(raw.background * 0.35)

  // And it is a background blur, not a blur: with the effect off, the face
  // and the wall are both sharp; with it on, only the wall should have gone.
  expect(blurred.face / blurred.background).toBeGreaterThan(raw.face / raw.background)
})

test('the strength control changes how much blur there is', async ({ page }) => {
  await openCamera(page)
  await settle(page)

  await page.locator('#blurStrength').fill('0')
  await page.waitForTimeout(1200)
  const weak = await measure(page)

  await page.locator('#blurStrength').fill('100')
  await page.waitForTimeout(1200)
  const strong = await measure(page)

  expect(strong.background).toBeLessThan(weak.background)
})

test('a camera swap never publishes an unblurred frame', async ({ page }) => {
  // Chromium's fake device is a single camera, so the device list is
  // doubled here to make the app's own switch control reachable. The second
  // entry carries the same id, so `getUserMedia` opens a real camera and the
  // swap - invalidate, reopen, restart the source - runs exactly as it would
  // on a phone flipping to its back camera.
  await page.addInitScript(() => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
    navigator.mediaDevices.enumerateDevices = async () => {
      const devices = await real()
      const cameras = devices.filter((d) => d.kind === 'videoinput')
      return [
        ...devices,
        ...cameras.map(
          (c) =>
            ({
              deviceId: c.deviceId,
              groupId: c.groupId,
              kind: 'videoinput',
              label: `${c.label} (second)`,
              toJSON: () => ({}),
            }) as MediaDeviceInfo,
        ),
      ]
    }
  })

  await openCamera(page)
  await settle(page)
  await expect(page.locator('#effectMode')).toHaveText('blur')

  const trackBefore = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('.media.mine video')
    return (video?.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id ?? null
  })

  const before = await routes(page)
  expect(before.passthrough).toBe(0)

  const button = page.locator('#switchCamera')
  await expect(button).toBeVisible()
  // Several times, because the leak this guards against is a race and a
  // single swap can miss it.
  for (let i = 0; i < 4; i += 1) {
    await button.click()
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(1200)

  const after = await routes(page)
  // The whole point: not one frame took the raw route across four swaps.
  expect(after.passthrough).toBe(0)
  expect(after.composite).toBeGreaterThan(before.composite)

  // And the published track is the same object it was before the swap, so
  // nothing renegotiated and there was no window to leak through.
  const trackAfter = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('.media.mine video')
    return (video?.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id ?? null
  })
  expect(trackAfter).toBe(trackBefore)

  // Still blurred afterwards, rather than merely not-passthrough.
  const sharpness = await measure(page)
  expect(sharpness.background).toBeLessThan(60)
})

test('replace swaps the room for the sea and leaves the person alone', async ({ page }) => {
  await openCamera(page)
  await settle(page)

  // The room as it really is, for comparison.
  await page.locator('#effectModes button[data-mode="off"]').click()
  await expect(page.locator('#effectMode')).toHaveText('off')
  await page.waitForTimeout(900)
  const raw = await samplePixels(page)
  const rawSharp = await measure(page)

  await page.locator('#effectModes button[data-mode="replace"]').click()
  await expect(page.locator('#effectMode')).toHaveText('replace')
  await page.locator('#backgroundChoices button[data-background="reef"]').click()
  await page.waitForTimeout(1600)

  const replaced = await samplePixels(page)
  const replacedSharp = await measure(page)

  // The room is gone: the checkerboard's detail has collapsed and what is
  // there now is sea rather than a grey wall.
  expect(rawSharp.background).toBeGreaterThan(50)
  expect(replacedSharp.background).toBeLessThan(rawSharp.background * 0.35)
  expect(replaced.background.b - replaced.background.r).toBeGreaterThan(40)
  expect(replaced.background.b - replaced.background.r).toBeGreaterThan(
    raw.background.b - raw.background.r + 30,
  )

  // The person is not: the face is still the face, warm where the sea is
  // cold, and the eyes and mouth are still hard-edged rather than smeared
  // or replaced along with everything else.
  expect(replaced.face.r).toBeGreaterThan(replaced.face.b)
  expect(Math.abs(replaced.face.r - raw.face.r)).toBeLessThan(40)
  expect(replacedSharp.face).toBeGreaterThan(rawSharp.face * 0.4)
  // And the person is a long way from the sea behind them, which is the
  // thing a broken mask destroys first.
  expect(replaced.face.r - replaced.background.r).toBeGreaterThan(30)
})

test('the sea moves, and a still picture does not', async ({ page }) => {
  await openCamera(page)
  await settle(page)
  await page.locator('#effectModes button[data-mode="replace"]').click()
  await expect(page.locator('#effectMode')).toHaveText('replace')

  // A drawn scene: light, motes and the odd fish, so two frames two and a
  // half seconds apart are not the same picture.
  await page.locator('#backgroundChoices button[data-background="reef"]').click()
  await page.waitForTimeout(1500)
  const first = await samplePixels(page)
  await page.waitForTimeout(2500)
  const second = await samplePixels(page)
  const moving = drift(first.outside, second.outside)

  // The same measurement against a photograph, which cannot move. This is
  // the control: without it "the numbers differ" would also be satisfied by
  // the camera's own noise.
  await page.locator('#backgroundChoices button[data-background="sea-sand"]').click()
  await page.waitForTimeout(1500)
  const stillFirst = await samplePixels(page)
  await page.waitForTimeout(2500)
  const stillSecond = await samplePixels(page)
  const still = drift(stillFirst.outside, stillSecond.outside)

  expect(still).toBeLessThan(0.05)
  expect(moving).toBeGreaterThan(0.2)
  expect(moving).toBeGreaterThan(still * 5)
})

test('a segmenter that will not load falls back to passthrough and says so', async ({ page }) => {
  await page.route('**/models/*.tflite', (route) => route.abort())
  await openCamera(page)
  await settle(page)

  await expect(page.locator('#effectStatus')).toHaveClass(/broken/)
  await expect(page.locator('#effectStatus')).toContainText('showing the room')

  // Passthrough, not a black frame and not a crash: there is still a picture
  // and it still has detail in it.
  await page.waitForTimeout(800)
  const sharpness = await measure(page)
  expect(sharpness.background).toBeGreaterThan(50)
})

test('voice masking states what it is, and offers the four presets', async ({ page }) => {
  await goIn(page)
  await page.getByRole('button', { name: 'Microphone' }).click()
  await page.locator('#callExtras > summary').click()
  await page.locator('#voiceEffects > summary').click()
  await expect(page.locator('#voiceEffects')).toBeVisible()

  // The claim has to be disclaimed in words, and the words changed with the
  // rest of the rewriting: "this is voice masking, not anonymity" is now
  // "this disguises your voice. It does not make you anonymous", which says
  // the same thing without asking the reader to know what anonymity means
  // here. What must never appear is an overclaim, and that half is unchanged.
  const copy = await page.locator('#voiceEffects .note').innerText()
  expect(copy).toContain('does not make you anonymous')
  expect(copy).not.toMatch(/unidentifiable/i)

  await page.locator('#voicePresets button[data-preset="lower"]').click()
  await expect(page.locator('#voiceMode')).toHaveText('lower')
  await expect(page.locator('#voiceStatus')).toContainText('ms of delay')
  await expect(page.locator('#voiceStatus')).not.toHaveClass(/broken/)
})
