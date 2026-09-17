import { test, expect } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, open, openCall, turnOnMedia } from './browser.js'

/**
 * Person beside their screen, and a chat that slides rather than sits.
 *
 * Two specs' worth of geometry in one file because they are the same
 * feature seen from two sides: a screen share used to force its owner's
 * whole tile across the row, so two people sharing stacked one above the
 * other instead of reading as two people talking to each other, and the
 * desktop shell's conversation used to be a permanent column taking width
 * from the stage whether anybody wanted to read it or not.
 *
 * Deliberately built with VITE_DESKTOP=true (see the harness that starts
 * this file - `html[data-desktop]` gates both the room's sharing layout at
 * this width and the whole drawer). The pixels are read straight off
 * `boundingBox()`, the same way media.spec.ts trusts the decoded frame over
 * the plumbing that produced it.
 */

test('two sharers sit beside their own cameras, level with each other, and the chat drawer changes the room width', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved - run against a VITE_DESKTOP=true build')

  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await a.newPage()
    const pageB = await b.newPage()
    await pageA.setViewportSize({ width: 1400, height: 900 })
    await pageB.setViewportSize({ width: 1400, height: 900 })

    const link = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, link, 'Ada')
    await open(pageB, link, 'Bob')
    await pageB.locator('#join').click()
    await expect(pageB.locator('#roomArea')).toBeVisible()
    await turnOnMedia(pageB)

    await openCall(pageA)
    await openCall(pageB)
    await pageA.locator('#toggleScreen').click()
    await expect(pageA.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await pageB.locator('#toggleScreen').click()
    await expect(pageB.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')

    // Both shares visible on Ada's screen, each inside its owner's tile.
    const tiles = pageA.locator('#room .participant:has(video.screenPreview)')
    await expect(tiles).toHaveCount(2, { timeout: 60_000 })

    const cameraBoxes: { x: number; y: number; width: number; height: number }[] = []
    for (let i = 0; i < 2; i++) {
      const tile = tiles.nth(i)
      const camera = tile.locator('video:not(.screenPreview)')
      const share = tile.locator('video.screenPreview')
      await expect(camera).toBeVisible()
      await expect(share).toBeVisible()
      const camBox = (await camera.boundingBox())!
      const shareBox = (await share.boundingBox())!
      cameraBoxes.push(camBox)
      // The share sits to the right of its own owner's camera, same row.
      expect(shareBox.x, 'the share is not to the right of its own camera').toBeGreaterThanOrEqual(camBox.x + camBox.width - 2)
      expect(Math.abs(shareBox.y - camBox.y), 'the share is not on the same row as its camera').toBeLessThanOrEqual(4)
      // The screen is what people are reading; the camera is a modest,
      // fixed-width strip of context beside it, not the other half of it.
      expect(shareBox.width, 'the share is not wider than its own camera').toBeGreaterThan(camBox.width)
    }

    // Equal faces: the two cameras are one uniform size, whoever is sharing.
    expect(Math.abs(cameraBoxes[0].width - cameraBoxes[1].width), 'camera tiles are not the same width').toBeLessThanOrEqual(2)
    expect(Math.abs(cameraBoxes[0].height - cameraBoxes[1].height), 'camera tiles are not the same height').toBeLessThanOrEqual(2)

    // Both sharers visible at once, on the same row rather than stacked.
    // Allows for a few pixels' difference in heading height (a longer name
    // or an extra badge) above the media row - a real layout variable, not
    // the stacking this asserts against, which differs by a tile height.
    expect(Math.abs(cameraBoxes[0].y - cameraBoxes[1].y), 'the two sharers are not on the same row').toBeLessThanOrEqual(12)

    // The chat drawer: open by default (chat has always been there on
    // desktop; a closed default would quietly take it away), and toggling
    // it changes the room's own width rather than merely floating over it
    // unchanged.
    const toggle = pageA.locator('#chatDrawerToggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const stage = pageA.locator('#callStage')
    const openWidth = (await stage.boundingBox())!.width

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(pageA.locator('#chatDrawer')).toHaveJSProperty('dataset.open', 'false')
    await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(openWidth + 20)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => (await stage.boundingBox())!.width).toBeLessThanOrEqual(openWidth + 2)
  } finally {
    await a.close()
    await b.close()
  }
})

