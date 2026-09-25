import { test, expect } from '@playwright/test'
import { createRoom, joinWithMedia } from './browser.js'

/**
 * Call keyboard shortcuts: Control/Command+D for the microphone,
 * Control/Command+E for the camera, and holding Space to talk while
 * otherwise muted. See app/src/call-shortcuts.ts.
 *
 * Both toggle chords are pressed as `Control+…` here rather than the
 * platform's own modifier, because the app listens for either `ctrlKey` or
 * `metaKey` - one real keypress is enough to prove the chord works, on
 * whichever OS this happens to run on.
 */

test('Control+D and Control+E toggle the mic and camera, including with focus in the chat box', async ({ page, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const url = await createRoom(page, baseURL!)
  await joinWithMedia(page, url, 'Ada')

  const mic = page.locator('#toggleMic')
  const camera = page.locator('#toggleCamera')
  await expect(mic).toHaveAttribute('data-on', 'true')
  await expect(camera).toHaveAttribute('data-on', 'true')

  // Focus somewhere ordinary first: the chords work from the room at large.
  await page.locator('#chatLog').focus()
  await page.keyboard.press('Control+d')
  await expect(mic).toHaveAttribute('data-on', 'false')
  await page.keyboard.press('Control+e')
  await expect(camera).toHaveAttribute('data-on', 'false')

  // The screen-reader announcement follows a shortcut toggle.
  await expect(page.locator('#callShortcutAnnounce')).toHaveText('Camera off')

  // And they still work with focus inside the message box - the modifier
  // is what makes that safe, unlike plain Space below.
  const chatInput = page.locator('#chatInput')
  await chatInput.focus()
  await page.keyboard.press('Control+d')
  await expect(mic).toHaveAttribute('data-on', 'true')
  await expect(page.locator('#callShortcutAnnounce')).toHaveText('Microphone on')
  await page.keyboard.press('Control+e')
  await expect(camera).toHaveAttribute('data-on', 'true')

  // Typing the letters themselves, with no modifier, must still reach the
  // composer rather than being eaten as a shortcut.
  await chatInput.fill('')
  await page.keyboard.type('de')
  await expect(chatInput).toHaveValue('de')
})

test('holding Space unmutes while muted and re-mutes on release, but only outside the chat box', async ({ page, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const url = await createRoom(page, baseURL!)
  await joinWithMedia(page, url, 'Ada')

  const mic = page.locator('#toggleMic')
  await expect(mic).toHaveAttribute('data-on', 'true')
  await page.locator('#chatLog').focus()
  await page.keyboard.press('Control+d')
  await expect(mic).toHaveAttribute('data-on', 'false')

  await page.keyboard.down('Space')
  await expect(mic).toHaveAttribute('data-on', 'true')
  await page.keyboard.up('Space')
  await expect(mic).toHaveAttribute('data-on', 'false')

  // In the chat box, Space must only ever be a space character - never a
  // push-to-talk key.
  const chatInput = page.locator('#chatInput')
  await chatInput.focus()
  await chatInput.fill('a')
  await page.keyboard.press('End')
  await page.keyboard.down('Space')
  await page.waitForTimeout(200)
  await expect(mic).toHaveAttribute('data-on', 'false')
  await page.keyboard.up('Space')
  await expect(chatInput).toHaveValue('a ')
})
