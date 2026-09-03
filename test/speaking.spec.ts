import { test, expect } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext } from './browser.js'

/**
 * Does the speaking indicator light up for real audio?
 *
 * The unit tests answer whether the detector turns levels into a stable yes
 * or no, and the monitor's tests answer whether the Web Audio graph is
 * wired to a destination. Neither can answer this one, for the reason
 * `media.spec.ts` exists: every unit can be correct while the path through
 * them carries nothing. An analyser that is never pulled reports the
 * buffer's initial 128s - perfect silence - with no error anywhere, so the
 * whole feature fails by simply never happening.
 *
 * So this is asserted from the far end: Chromium's fake microphone makes a
 * real tone, that tone crosses a real WebRTC connection, and the assertion
 * is on the class the other person's browser puts on the tile.
 *
 * The mute case matters more than the lit case. A speaking indicator that
 * lights up and never goes out is worse than none at all, and it is the
 * failure a test that only checks the happy path will miss every time.
 */
test('a talking device lights its tile for everybody else, and goes dark when muted', async ({
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

    // Ada's tile as Bob sees it. The fake microphone is a continuous tone,
    // so once her audio is flowing this must light and stay lit.
    const adaOnBob = pageB.locator('#room .participant', { hasText: 'Ada' })
    await expect(adaOnBob, "Bob never saw Ada's tile light up while she was talking").toHaveClass(
      /speaking/,
      { timeout: 30_000 },
    )

    // And her own tile, from the local microphone tap rather than a remote
    // track: a person has to be able to see they are being picked up.
    const ownTile = pageA.locator('#room .participant', { hasText: '(you)' })
    await expect(ownTile, 'Ada could not see that her own microphone was live').toHaveClass(
      /speaking/,
      { timeout: 30_000 },
    )

    // Mute. The track stays published with `enabled = false`, which feeds
    // the analyser silence rather than ending anything, so this is the
    // hangover expiring rather than a track teardown.
    await pageA.locator('#toggleMic').click()
    await expect(pageA.locator('#toggleMic')).toHaveAttribute('data-on', 'false')

    await expect(adaOnBob, "Ada's tile stayed lit after she muted").not.toHaveClass(/speaking/, {
      timeout: 15_000,
    })
    await expect(ownTile, "Ada's own tile stayed lit after she muted").not.toHaveClass(/speaking/, {
      timeout: 15_000,
    })
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
