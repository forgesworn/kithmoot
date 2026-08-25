import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
// @ts-expect-error - plain ESM helper, no types, and none wanted for a fixture
import { writeScene } from './synthetic-scene.mjs'

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
 * Unlike test/e2e.spec.ts this needs no relays and no network: the room is
 * created locally and nothing is ever joined.
 */

const here = dirname(fileURLToPath(import.meta.url))
const scenePath = resolve(here, '../test-results/synthetic-scene.y4m')
mkdirSync(dirname(scenePath), { recursive: true })
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
      const video = document.querySelector<HTMLVideoElement>('#local video')
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

async function openCamera(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a room' }).click()
  await page.getByRole('button', { name: 'Camera' }).click()
  await expect(page.locator('#local video')).toBeVisible()
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#local video')
    return !!video && video.videoWidth > 0
  })
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
    const video = document.querySelector<HTMLVideoElement>('#local video')
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
    const video = document.querySelector<HTMLVideoElement>('#local video')
    return (video?.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id ?? null
  })
  expect(trackAfter).toBe(trackBefore)

  // Still blurred afterwards, rather than merely not-passthrough.
  const sharpness = await measure(page)
  expect(sharpness.background).toBeLessThan(60)
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
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a room' }).click()
  await page.getByRole('button', { name: 'Microphone' }).click()
  await expect(page.locator('#voiceEffects')).toBeVisible()

  const copy = await page.locator('#voiceEffects .note').innerText()
  expect(copy).toContain('not anonymity')
  expect(copy).not.toMatch(/unidentifiable/i)

  await page.locator('#voicePresets button[data-preset="lower"]').click()
  await expect(page.locator('#voiceMode')).toHaveText('lower')
  await expect(page.locator('#voiceStatus')).toContainText('ms of delay')
  await expect(page.locator('#voiceStatus')).not.toHaveClass(/broken/)
})
