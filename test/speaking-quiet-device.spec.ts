import { test, expect } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext } from './browser.js'

/**
 * A device that is not playing the call's sound - its person listens on
 * another of their devices - still shows who is speaking. The owner's case:
 * sound on the phone, faces on the desktop, and no way to tell who was
 * talking.
 */
test('a device kept quiet still lights the tile of whoever is speaking', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')
    const adaOnBob = pageB.locator('#room .participant', { hasText: 'Ada' })
    await expect(adaOnBob).toHaveClass(/speaking/, { timeout: 30_000 })

    // Bob's device goes quiet: the sound is on his other device.
    await pageB.locator('#toggleCompanion').evaluate(el => (el as HTMLButtonElement).click())
    await expect(pageB.locator('#toggleCompanion')).toHaveAttribute('data-on', 'true')
    await expect.poll(() => pageB.evaluate(() => [...document.querySelectorAll('#room audio')].every(el => (el as HTMLAudioElement).muted))).toBe(true)
    // Give the detector time to drop and come back if it is going to.
    await pageB.waitForTimeout(3_000)
    await expect(adaOnBob, "Bob's quiet device lost Ada's speaking ring").toHaveClass(/speaking/, { timeout: 15_000 })
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
