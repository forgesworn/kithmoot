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
    // Short of the desktop call stage's own height threshold (541px, see
    // DESKTOP_STAGE in call-stage.ts) and wide of its "short landscape"
    // phone layout (1024px, see style.css). Neither picture layout takes
    // over, so this exercises the plain "Speaking:" line in `.callHead`
    // (app/src/main.ts `paintSpeakingLine`) rather than the desktop stage's
    // own `#speakingNow`, which call-layout.spec.ts already covers.
    await pageA.setViewportSize({ width: 1100, height: 500 })
    await pageB.setViewportSize({ width: 1100, height: 500 })

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

    // The plain-text "Speaking:" line beside the call controls, not just the
    // ring round the tile: Bob's screen names Ada, and Ada's own screen
    // names Bob rather than naming herself - seeing your own name on this
    // line while you talk is pointless, so a device's own person is never
    // listed on its own line.
    await expect(pageB.locator('#speakingLine'), "Bob's speaking line never named Ada").toContainText(
      'Ada',
      { timeout: 30_000 },
    )
    await expect(pageA.locator('#speakingLine'), "Ada's own speaking line never named Bob").toContainText(
      'Bob',
      { timeout: 30_000 },
    )
    await expect(pageA.locator('#speakingLine'), "Ada's own speaking line named herself").not.toContainText(
      'You',
      { timeout: 5_000 },
    )

    // With Bob's mic muted, Ada is the only one truly speaking on her own
    // screen - and since she is never named on her own line, that line must
    // read exactly as it does when nobody is speaking at all: empty and
    // hidden, not "Speaking: You".
    await pageB.locator('#toggleMic').click()
    await expect(pageB.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await expect(pageA.locator('#speakingLine'), "Ada's line named herself once Bob had muted").toBeEmpty({
      timeout: 15_000,
    })
    await expect(pageA.locator('#speakingLine'), "Ada's line stayed visible with only herself speaking").toBeHidden({
      timeout: 15_000,
    })
    await pageB.locator('#toggleMic').click()
    await expect(pageB.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(pageA.locator('#speakingLine'), "Ada's line did not pick Bob back up after he unmuted").toContainText(
      'Bob',
      { timeout: 30_000 },
    )

    // High contrast. Forced colours drop box-shadows and repaint label
    // backgrounds, which once erased the whole cue; the ring must survive
    // as an outline and the label must take the system highlight.
    await pageA.emulateMedia({ forcedColors: 'active' })
    // Polled: the detector can drop the class for a moment between reads on a
    // slow runner, and the question is the style while speaking, not the timing.
    const cueWhileSpeaking = () => ownTile.evaluate(tile => {
      if (!tile.classList.contains('speaking')) return undefined
      const label = tile.querySelector('h3')!
      return {
        outline: getComputedStyle(tile).outlineWidth,
        labelDiffers: getComputedStyle(label).backgroundColor !== getComputedStyle(document.body).backgroundColor,
      }
    })
    await expect.poll(async () => (await cueWhileSpeaking())?.outline, {
      message: 'the speaking ring vanished in high contrast', timeout: 15_000,
    }).toBe('4px')
    await expect.poll(async () => (await cueWhileSpeaking())?.labelDiffers, {
      message: 'the speaking label looked like any other in high contrast', timeout: 15_000,
    }).toBe(true)
    await pageA.emulateMedia({ forcedColors: 'none' })

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

    // The line holds a name for about a second past the tile itself going
    // dark, so it does not flicker on every gap inside speech - but it must
    // still drop her, or a line that never lets go is worse than none.
    await expect(pageB.locator('#speakingLine'), "Bob's speaking line still named Ada after she muted").not.toContainText(
      'Ada',
      { timeout: 15_000 },
    )
    // Bob's own fake microphone is live and continuous throughout, so Ada's
    // line keeps naming him regardless of her own mute state.
    await expect(pageA.locator('#speakingLine'), "Ada's own speaking line lost Bob after she muted").toContainText(
      'Bob',
      { timeout: 15_000 },
    )
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
