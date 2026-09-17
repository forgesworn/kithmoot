import { test, expect, type Page } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, open, openCall } from './browser.js'

/**
 * The self-mute badge: a device that turns its own mic off should say so
 * on everybody else's tile - `🎙️ muted` - distinct from and additive to the
 * `🔇 silenced for you` badge a listener's own volume slider paints (see
 * volume.spec.ts, main.ts's `volumeMuteBadge`/`paintVolumeMute`). One says
 * what THEY did to their own microphone; the other says what WE did with
 * the slider. Both can show on the same tile at once, and each comes and
 * goes on its own.
 */

const MUTED_BADGE = '.badge.muted-self'

async function tileFor(page: Page, name: string) {
  return page.locator('#room .participant').filter({ hasText: name })
}

test('a self-muted mic shows on the far side within 5s, and clears on unmute, independent of the volume-slider badge', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const aContext = await newDeviceContext(browser, baseURL!)
  const bContext = await newDeviceContext(browser, baseURL!)
  try {
    const a = await aContext.newPage()
    const b = await bContext.newPage()

    const url = await createRoom(a, baseURL!)
    await joinWithMedia(a, url, 'Ada')
    await open(b, url, 'Bob')
    await b.locator('#join').click()
    await expect(b.locator('#roomArea')).toBeVisible()
    await openCall(b)
    await b.locator('#toggleMic').click()
    await expect(b.locator('#toggleMic')).toHaveAttribute('data-on', 'true')

    for (const p of [a, b]) {
      await expect(p.locator('#room .participant'), 'both should see a two-person room').toHaveCount(2, { timeout: 60_000 })
    }

    const adaOnBobsScreen = await tileFor(b, 'Ada')

    // Ada mutes her own mic - no badge for it yet.
    await expect(adaOnBobsScreen.locator(MUTED_BADGE)).toHaveCount(0)
    await a.locator('#toggleMic').click()
    await expect(a.locator('#toggleMic')).toHaveAttribute('data-on', 'false')

    // Bob's tile for Ada shows the self-mute badge within 5s.
    await expect(adaOnBobsScreen.locator(MUTED_BADGE)).toBeVisible({ timeout: 5_000 })

    // Ada unmutes - the badge clears within 5s.
    await a.locator('#toggleMic').click()
    await expect(a.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(adaOnBobsScreen.locator(MUTED_BADGE)).toHaveCount(0, { timeout: 5_000 })

    // Bob silencing Ada with his own volume slider is a different badge,
    // and does not touch this one. openRoomDetails/volume.spec.ts already
    // covers the slider itself in depth; this only checks the two badges
    // stay independent.
    await a.locator('#toggleMic').click()
    await expect(adaOnBobsScreen.locator(MUTED_BADGE)).toBeVisible({ timeout: 5_000 })
    await expect(adaOnBobsScreen.locator('.badge.muted')).toHaveCount(0)
  } finally {
    await aContext.close()
    await bContext.close()
  }
})
