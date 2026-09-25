import { test, expect } from '@playwright/test'
import { createRoom, joinWithMedia, openCall } from './browser.js'

/**
 * A remembered call choice survives a reload and is applied the next time
 * the camera starts - see app/src/call-prefs.ts. This is the storage
 * round-trip proven against the real page; effects.spec.ts already proves
 * the effect itself does what its mode says.
 */

test('a background effect choice and its blur strength survive a reload and reapply on the next camera start', async ({ page, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const url = await createRoom(page, baseURL!)
  await joinWithMedia(page, url, 'Ada')

  // Reveal the effect controls, which only exist once a camera is running,
  // and turn the effect off with a blur strength that is not the default.
  await page.locator('#callExtras > summary').click()
  await page.locator('#cameraEffects > summary').click()
  await page.locator('#effectModes button[data-mode="off"]').click()
  await expect(page.locator('#effectMode')).toHaveText('off')
  await page.locator('#blurStrength').evaluate((el) => {
    const input = el as HTMLInputElement
    input.value = '30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('kithmoot.call.effectMode')))
    .toBe('off')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('kithmoot.call.blurStrength')))
    .toBe('0.3')

  // A fresh load of the page, same device: no camera running yet, and
  // nothing chosen again.
  await page.reload()
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await openCall(page)
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')

  await page.locator('#toggleCamera').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')

  // The remembered choice applied itself the moment the camera started,
  // with no interaction with the effect controls this time.
  await expect(page.locator('#effectMode')).toHaveText('off')
  await expect(page.locator('#effectModes button[data-mode="off"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('#blurStrength')).toHaveValue('30')
})

test('a voice preset survives a reload and reapplies the next time the microphone starts', async ({ page, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const url = await createRoom(page, baseURL!)
  await joinWithMedia(page, url, 'Ada')

  await page.locator('#callExtras > summary').click()
  await page.locator('#voiceEffects > summary').click()
  await page.locator('#voicePresets button[data-preset="deep"]').click()
  await expect(page.locator('#voiceMode')).toHaveText('deep')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('kithmoot.call.voicePreset')))
    .toBe('deep')

  await page.reload()
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await openCall(page)
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')

  await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
  await expect(page.locator('#voiceMode')).toHaveText('deep')
  await expect(page.locator('#voicePresets button[data-preset="deep"]')).toHaveAttribute('aria-checked', 'true')
})
