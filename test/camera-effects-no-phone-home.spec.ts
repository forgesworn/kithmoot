import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page, type Request } from '@playwright/test'
// @ts-expect-error - plain ESM helper, no types, and none wanted for a fixture
import { writeScene } from './synthetic-scene.mjs'
import { openRoomUrl, pinToTestRelays, TEST_RELAY_HTTP, TEST_RELAY_WS } from './relays.js'
import { openNewRoomForm, openCallEffects, nameCreator } from './browser.js'

/**
 * A camera effect must never phone home.
 *
 * Exercise the real bundled model and teardown while watching requests.
 * A camera dependency must never silently add an external endpoint.
 */

const sceneDir = join(tmpdir(), 'kithmoot-phone-home')
mkdirSync(sceneDir, { recursive: true })
const scenePath = join(sceneDir, 'synthetic-scene.y4m')
writeFileSync(scenePath, writeScene(640, 480, 12))

test.setTimeout(90_000)

test.beforeEach(async ({ page, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
  // Pin the creator before first navigation too. Rewriting only the final
  // invite lets initial room creation contact the public default relays.
  await page.addInitScript(url => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({
    default: [{ url, read: true, write: true }],
  })), relay.href)
})

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream', '--allow-loopback-in-peer-connection',
      `--use-file-for-fake-video-capture=${scenePath}`,
    ],
  },
})

const LOCAL_VIDEO = '.media.mine video'

async function goIn(page: Page): Promise<void> {
  await page.goto('/')
  await openNewRoomForm(page)
  await nameCreator(page, 'Robin')
  await page.locator('#create').click()
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  await openRoomUrl(page, pinToTestRelays(await share.inputValue()))
  await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#callToggle')).toBeVisible()
  if (await page.locator('#deviceControls').isHidden()) {
    await page.locator('#callToggle').click()
  }
  await expect(page.locator('#deviceControls')).toBeVisible()
}

async function openCamera(page: Page): Promise<void> {
  await goIn(page)
  await page.getByRole('button', { name: 'Camera' }).click()
  await expect(page.locator(LOCAL_VIDEO)).toBeVisible()
  await openCallEffects(page, 'Background')
  await page.waitForFunction((selector) => {
    const video = document.querySelector<HTMLVideoElement>(selector)
    return !!video && video.videoWidth > 0
  }, LOCAL_VIDEO)
}

async function settle(page: Page): Promise<void> {
  await expect(page.locator('#effectStatus')).not.toContainText('Loading', { timeout: 60_000 })
}

/** The mask size the segmenter reports, or 0 if it never ran. Read from the
 *  same effects panel the other camera-effects spec measures frame routes
 *  from, so this test cannot pass by the segmenter never actually starting. */
async function frameRoutes(page: Page): Promise<{ composite: number; blurAll: number }> {
  return page.evaluate(() => {
    const panel = document.getElementById('effects')!
    return {
      composite: Number(panel.dataset.composite ?? '0'),
      blurAll: Number(panel.dataset.blurAll ?? '0'),
    }
  })
}

test('background blur never makes a request outside the app and the local relay', async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('no baseURL configured for this project')
  const appOrigin = new URL(baseURL).origin
  const allowedOrigins = new Set([appOrigin, new URL(TEST_RELAY_HTTP).origin, new URL(TEST_RELAY_WS.replace('ws://', 'http://')).origin])
  const stray: string[] = []
  page.on('websocket', socket => {
    const url = new URL(socket.url().replace(/^ws/, 'http'))
    if (!allowedOrigins.has(url.origin)) stray.push(`WebSocket ${url.origin}`)
  })

  await page.route('**/*', async (route) => {
    const request: Request = route.request()
    const url = new URL(request.url())
    const isProxiedRelay = url.origin === appOrigin && (url.pathname.startsWith('/__test-relay') || url.pathname.startsWith('/upload') || url.pathname.startsWith('/blossom'))
    const isAllowed = allowedOrigins.has(url.origin) || isProxiedRelay
    if (isAllowed) {
      await route.continue()
      return
    }
    stray.push(`${request.method()} ${request.url()}`)
    await route.abort()
  })

  await openCamera(page)
  await settle(page)
  await expect(page.locator('#effectMode')).toHaveText('blur')

  // Require real inference, rather than accepting whole-frame fallback as
  // evidence that background separation works.
  await expect.poll(async () => (await frameRoutes(page)).composite).toBeGreaterThan(0)
  const running = await frameRoutes(page)
  expect(running.composite + running.blurAll).toBeGreaterThan(0)

  // The removed logger batched usage on a 60-second timer as well as close.
  // Observe both boundaries against the actual pinned runtime.
  await page.waitForTimeout(65_000)

  await page.locator('#effectModes button[data-mode="off"]').click()
  await expect(page.locator('#effectMode')).toHaveText('off')
  // Include effect teardown in request observation.
  await page.waitForTimeout(1_000)

  expect(stray, `requests outside the app and the local relay: ${stray.join(', ')}`).toEqual([])
})

test('the bundled model keeps a known person and rejects the background', async ({ page, baseURL }) => {
  const requests: string[] = []
  const origin = new URL(baseURL!).origin
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { requests.push(url.origin); await route.abort(); return }
    await route.continue()
  })
  const bundle = await build({ stdin: {
    contents: "export { createBundledSegmenter } from './app/src/bundled-segmenter.ts'",
    resolveDir: process.cwd(), loader: 'ts',
  }, bundle: true, write: false, format: 'esm', platform: 'browser',
    define: { 'import.meta.env.BASE_URL': JSON.stringify('/j/') }, logLevel: 'silent' })
  await page.route('**/__segmenter-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0]!.text }))
  await page.route('**/__segmenter-photo.png', route => route.fulfill({ contentType: 'image/png', body: readFileSync('test/fixtures/segmentation/astronaut.png') }))
  await page.goto(baseURL!)
  const evidence = await page.evaluate(async () => {
    const fixturePath = '/j/__segmenter-fixture.js'
    const { createBundledSegmenter } = await import(fixturePath)
    const image = new Image(); image.src = '/j/__segmenter-photo.png'; await image.decode()
    const segmenter = await createBundledSegmenter()
    const started = performance.now()
    try {
      const masks = [1, 1, 0, 2].map(stamp => segmenter.segment(image, stamp))
      const mask = masks[0]!
      const mean = (left: number, top: number, right: number, bottom: number) => {
        let sum = 0, count = 0
        for (let y = Math.floor(top * mask.height / 256); y < Math.floor(bottom * mask.height / 256); y++) {
          for (let x = Math.floor(left * mask.width / 256); x < Math.floor(right * mask.width / 256); x++) { sum += mask.data[y * mask.width + x]; count++ }
        }
        return sum / count
      }
      return { person: mean(90, 35, 130, 85), background: mean(220, 10, 250, 35),
        masksValid: masks.every(m => m && m.data.length === m.width * m.height && m.data.every(Number.isFinite)),
        inferenceMs: (performance.now() - started) / masks.length }
    } finally { segmenter.close() }
  })
  expect(evidence.person).toBeGreaterThan(0.75)
  expect(evidence.background).toBeLessThan(0.25)
  expect(evidence.masksValid).toBe(true)
  expect(requests).toEqual([])
  console.log('Bundled segmentation fixture measurements', evidence)
})

test('portrait publication keeps the person sharp while the bundled pipeline blurs the background', async ({ page, baseURL }, info) => {
  const bundle = await build({ stdin: {
    contents: "export { CameraPipeline } from './app/src/video-pipeline.ts'",
    resolveDir: process.cwd(), loader: 'ts',
  }, bundle: true, write: false, format: 'esm', platform: 'browser',
    define: { 'import.meta.env.BASE_URL': JSON.stringify('/j/') }, logLevel: 'silent' })
  await page.route('**/__pipeline-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0]!.text }))
  await page.route('**/__segmenter-photo.png', route => route.fulfill({ contentType: 'image/png', body: readFileSync('test/fixtures/segmentation/astronaut.png') }))
  await page.goto(baseURL!)
  const evidence = await page.evaluate(async () => {
    const fixturePath = '/j/__pipeline-fixture.js'
    const { CameraPipeline } = await import(fixturePath)
    const image = new Image(); image.src = '/j/__segmenter-photo.png'; await image.decode()
    const source = document.createElement('canvas'); source.width = 512; source.height = 512
    const ctx = source.getContext('2d')!
    const paint = () => {
      ctx.drawImage(image, 0, 0, 512, 512)
      // A measurable synthetic pattern behind the known person, inside the
      // portrait crop. It leaves the person's head and clothing untouched.
      for (let y = 20; y < 70; y += 4) for (let x = 360; x < 400; x += 4) {
        ctx.fillStyle = (x + y) % 8 ? '#202020' : '#eeeeee'; ctx.fillRect(x, y, 4, 4)
      }
    }
    paint()
    const timer = setInterval(paint, 80)
    const stream = source.captureStream(12)
    const native = navigator.mediaDevices.getUserMedia
    navigator.mediaDevices.getUserMedia = async () => stream
    const pipeline = new CameraPipeline({ mode: 'off', facePrivacy: 'off', framing: false, portrait: true })
    const preview = document.createElement('video'); preview.muted = true; preview.autoplay = true; preview.playsInline = true
    document.body.append(preview)
    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + 30_000
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Portrait pipeline did not produce the expected frame')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    const sample = () => {
      const canvas = document.createElement('canvas'); canvas.width = preview.videoWidth; canvas.height = preview.videoHeight
      const context = canvas.getContext('2d')!; context.drawImage(preview, 0, 0)
      const sharpness = (x: number, y: number, width: number, height: number) => {
        const pixels = context.getImageData(x, y, width, height).data
        const luma = (index: number) => (pixels[index * 4]! + pixels[index * 4 + 1]! + pixels[index * 4 + 2]!) / 3
        let square = 0, count = 0
        for (let row = 1; row < height - 1; row++) for (let col = 1; col < width - 1; col++) {
          const i = row * width + col
          const laplacian = 4 * luma(i) - luma(i - 1) - luma(i + 1) - luma(i - width) - luma(i + width)
          square += laplacian * laplacian; count++
        }
        return square / count
      }
      // A 512-square source becomes the centred 288x512 portrait crop.
      return { person: sharpness(78, 90, 60, 70), background: sharpness(253, 25, 30, 40), image: canvas.toDataURL('image/png') }
    }
    try {
      preview.srcObject = new MediaStream([await pipeline.start()]); await preview.play()
      await waitFor(() => pipeline.totals.passthrough >= 3 && preview.videoWidth > 0)
      const off = sample()
      pipeline.setMode('blur')
      await waitFor(() => pipeline.totals.composite >= 5)
      await new Promise(resolve => setTimeout(resolve, 200))
      const blurred = sample()
      return { off, blurred, width: preview.videoWidth, height: preview.videoHeight, totals: pipeline.totals }
    } finally {
      pipeline.stop(); clearInterval(timer); for (const track of stream.getTracks()) track.stop()
      preview.srcObject = null; preview.remove(); navigator.mediaDevices.getUserMedia = native
    }
  })
  expect(evidence.width / evidence.height).toBeCloseTo(9 / 16, 3)
  expect(evidence.blurred.person / evidence.off.person, 'the published person stays sharp').toBeGreaterThan(0.65)
  expect(evidence.blurred.background / evidence.off.background, 'the published background loses fine detail').toBeLessThan(0.2)
  expect(evidence.totals.composite).toBeGreaterThanOrEqual(5)
  const capture = info.outputPath('portrait-background-blurred.png')
  writeFileSync(capture, Buffer.from(evidence.blurred.image.split(',')[1]!, 'base64'))
  await info.attach('portrait-background-blurred.png', { path: capture, contentType: 'image/png' })
  console.log('Portrait background pipeline measurements', { ...evidence, off: { ...evidence.off, image: undefined }, blurred: { ...evidence.blurred, image: undefined } })
})
