import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page, type Request } from '@playwright/test'
// @ts-expect-error - plain ESM helper, no types, and none wanted for a fixture
import { writeScene } from './synthetic-scene.mjs'
import { openRoomUrl, pinToTestRelays, TEST_RELAY_HTTP, TEST_RELAY_WS } from './relays.js'

/**
 * A camera effect must never phone home.
 *
 * `@mediapipe/tasks-vision` >=1.0.1-rc carries an ungated usage logger: every
 * `ImageSegmenter` it creates POSTs protobuf to
 * `https://odml.pa.googleapis.com/v1/log` every 60s and on `close()`. Proven
 * with a real headless browser, our shipped wasm and our shipped model - one
 * 136-byte POST on close, unblocked by our CSP. The dependency is pinned to
 * an exact version proven clean of it (docs/decisions.md), and
 * scripts/check-no-telemetry.mjs fails the build if the marker strings ever
 * make it into the built app again. This is the third layer: a real browser,
 * a real segmenter run, watching every request the page makes while an
 * effect is on and off again, so a future dependency bump that reintroduces
 * the logger - or anything else that decides to call home - fails a test
 * that actually ran the feature rather than only grepped for it.
 */

const sceneDir = join(tmpdir(), 'kithmoot-phone-home')
mkdirSync(sceneDir, { recursive: true })
const scenePath = join(sceneDir, 'synthetic-scene.y4m')
writeFileSync(scenePath, writeScene(640, 480, 12))

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

const LOCAL_VIDEO = '.media.mine video'

async function goIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start a room' }).click()
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  await openRoomUrl(page, pinToTestRelays(await share.inputValue()))
  await page.locator('#displayName').fill('Robin')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
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
  await page.locator('#callExtras > summary').click()
  await page.locator('#cameraEffects > summary').click()
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

  // Give the segmenter real running time - long enough to cross MediaPipe's
  // own 30s stats interval and 60s upload interval, so a logger that only
  // fires on a timer has every chance to fire during the test.
  await page.waitForTimeout(3_000)
  const running = await frameRoutes(page)
  expect(running.composite + running.blurAll).toBeGreaterThan(0)

  await page.locator('#effectModes button[data-mode="off"]').click()
  await expect(page.locator('#effectMode')).toHaveText('off')
  // The logger's other trigger is close(): give the segmenter's teardown a
  // moment to run and, if it were going to, to fire.
  await page.waitForTimeout(1_000)

  expect(stray, `requests outside the app and the local relay: ${stray.join(', ')}`).toEqual([])
})
