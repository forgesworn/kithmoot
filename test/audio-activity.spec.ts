import { test, expect } from '@playwright/test'
import { createRoom, inbound, joinWithMedia, newDeviceContext, SYNTHETIC_MIC } from './browser.js'

test('measured audio stays visible without cameras, with playback muted and with reduced motion', async ({ browser, baseURL }, info) => {
  test.setTimeout(180_000)
  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  await a.addInitScript(SYNTHETIC_MIC)
  await b.addInitScript(SYNTHETIC_MIC)
  try {
    const ada = await a.newPage()
    const bob = await b.newPage()
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    await joinWithMedia(bob, url, 'Bob')
    await expect.poll(() => bob.evaluate(inbound).then(stats => stats.audioEnergy), { timeout: 90_000 }).toBeGreaterThan(0)
    const activity = bob.locator('#callAudioActivity')
    await expect(activity).toBeVisible()
    await expect(activity.locator('[data-audio-signal="incoming"]')).toContainText('Sound')
    await expect(activity.locator('[data-audio-signal="mic"]')).toContainText('Sound')
    const micTrace = activity.locator('[data-audio-signal="mic"] .audioTrace')
    // A real PCM trace has signed detail in the current block, not a closed RMS envelope.
    await expect.poll(() => micTrace.locator('.audioEnvelope').getAttribute('d')).toMatch(/^M.*L/)
    const trace = (await micTrace.locator('.audioEnvelope').getAttribute('d'))!
    expect(trace).not.toContain('Z')
    expect(trace.split('L').length).toBe(256)
    expect(await micTrace.locator('.audioBaseline').evaluate(el => getComputedStyle(el).stroke)).toBe('rgb(255, 255, 255)')
    const activeInk = await micTrace.evaluate(el => getComputedStyle(el).color)
    expect(activeInk).not.toBe('rgb(255, 255, 255)')
    const activityHeight = (await activity.boundingBox())!.height
    await bob.locator('#toggleCamera').evaluate(el => (el as HTMLButtonElement).click())
    await expect(activity).toBeVisible()
    await bob.locator('#toggleCompanion').evaluate(el => (el as HTMLButtonElement).click())
    await expect(bob.locator('#toggleCompanion')).toHaveAttribute('data-on', 'true')
    await expect(activity.locator('[data-audio-signal="incoming"]')).toContainText('Sound')
    await bob.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
    await expect(activity.locator('.audioTrace').first()).toBeHidden()
    await expect(activity.locator('.audioLevel').first()).toBeVisible()
    if (await bob.locator('#toggleMic').getAttribute('data-on') === 'true') await bob.locator('#toggleMic').evaluate(el => (el as HTMLButtonElement).click())
    await expect(bob.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await expect(activity.locator('[data-audio-signal="mic"]')).toContainText('Muted')
    await expect(activity.locator('[data-audio-signal="incoming"]')).toContainText('Sound')
    await bob.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
    await expect(micTrace).toHaveCSS('color', 'rgb(255, 255, 255)')
    expect((await activity.boundingBox())!.height).toBe(activityHeight)
    if (info.project.name === 'chromium') {
      await bob.setViewportSize({ width: 355, height: 740 })
      await bob.locator('#callChatToggle').click()
      await expect(bob.locator('#chatAudioActivity')).toBeVisible()
      await expect(bob.locator('#chatAudioActivity [data-audio-signal="incoming"]')).toContainText('Sound')
      await expect.poll(() => bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await bob.screenshot({ path: info.outputPath('audio-activity.png') })
    await bob.locator('#leaveCall').evaluate(el => (el as HTMLButtonElement).click())
    await expect(activity).toBeHidden()
    await expect(bob.locator('#chatAudioActivity')).toBeHidden()
  } finally { await a.close(); await b.close() }
})
