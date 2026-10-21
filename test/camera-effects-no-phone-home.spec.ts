import { mkdirSync, writeFileSync } from 'node:fs'
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
 * The old third-party camera SDK and weights have been removed. Until the
 * owned foreground model qualifies, the shipped blur covers the whole frame.
 * Exercise that actual path and teardown while watching all requests: adding
 * a camera SDK or model download must never silently add a remote endpoint.
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

  // Confirm the fallback processes frames, rather than passing because no
  // camera effect actually ran.
  await page.waitForTimeout(3_000)
  const running = await frameRoutes(page)
  expect(running.composite + running.blurAll).toBeGreaterThan(0)

  await page.locator('#effectModes button[data-mode="off"]').click()
  await expect(page.locator('#effectMode')).toHaveText('off')
  // Include effect teardown in request observation.
  await page.waitForTimeout(1_000)

  expect(stray, `requests outside the app and the local relay: ${stray.join(', ')}`).toEqual([])
})
