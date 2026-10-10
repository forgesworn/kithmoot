import { test, expect, type Page } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, openCall, open, turnOnMedia, allowTestFileStorage } from './browser.js'
import { fetchFromTestBlossom, routeTestBlossom } from './blossom.js'

test.use({ trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true } })

async function localClip(page: Page) {
  return page.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
    const bytes = await (await fetch(link.href)).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { name: link.download, size: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') }
  })
}

for (const phone of [false, true]) test(`recorded video survives storage refusal and failed uploads, then arrives encrypted after Send (${phone ? 'touch phone' : 'desktop'})`, async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium recording/export fixture; other browser and physical gates remain separate')
  const aContext = await newDeviceContext(browser, baseURL!, phone ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } } : {}), bContext = await newDeviceContext(browser, baseURL!)
  const origin = new URL(baseURL!).origin
  await routeTestBlossom(aContext, origin); await routeTestBlossom(bContext, origin)
  let uploads = 0, downloads = 0
  const uploadHeaders: string[] = []
  await aContext.route(`${origin}/upload`, async route => {
    uploads++
    const bytes = route.request().postDataBuffer()!
    uploadHeaders.push(bytes.subarray(0, 8).toString())
    if (uploads === 1) await route.fulfill({ status: 503, body: 'Synthetic storage failure' })
    else await route.fulfill({ response: await fetchFromTestBlossom(route, origin) })
  })
  bContext.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/blossom/')) downloads++ })
  try {
    const a = await aContext.newPage(), b = await bContext.newPage()
    const url = await createRoom(a, baseURL!)
    await joinWithMedia(a, url, 'Ada')
    await open(b, url, 'Bob'); await b.locator('#join').click()
    await expect(b.locator('#callToggle')).toHaveText('Join call')
    await turnOnMedia(b)
    await openCall(a)
    await expect(a.locator('#recordToggle')).toBeInViewport()
    await a.locator('#recordToggle').click()
    await a.locator('input[name="recording-layout"][value="gallery"]').check()
    await a.locator('#actionConfirm').click()
    if (await a.locator('#mobileCallSettings').isVisible()) await a.locator('#mobileCallSettingsClose').click()
    await expect(a.locator('#recordingElapsed')).toBeVisible()
    await a.waitForTimeout(3500)
    await a.locator('#recordingStop').click()
    await expect(a.locator('#recordingReady')).toBeVisible()
    const original = await localClip(a)
    expect(original.size).toBeGreaterThan(0)

    await a.locator('#recordingShare').click()
    await expect(a.locator('#pendingFileNames')).toContainText(original.name)
    await expect(a.locator('#recordingSave')).toBeVisible()
    await expect(a.locator('#recordingShare')).toBeDisabled()
    expect(await localClip(a)).toEqual(original)
    expect(uploads).toBe(0)
    await expect(b.locator('#chatLog .attachment')).toHaveCount(0)

    await allowTestFileStorage(a, origin)
    await a.locator('#uploadPendingFiles').click()
    await expect(a.locator('#attachStatus')).toContainText('503')
    await expect(a.locator('#uploadPendingFiles')).toBeEnabled()
    expect(await localClip(a)).toEqual(original)
    await expect(a.locator('#pendingFileNames')).toContainText(original.name)

    await a.locator('#uploadPendingFiles').click()
    await expect(a.locator('#attachStaged')).toContainText(original.name)
    await expect(a.locator('#pendingFileNames')).toBeHidden()
    await expect(a.locator('#recordingReadyText')).toContainText('press Send')
    await expect(a.locator('#recordingShare')).toBeDisabled()
    expect(await localClip(a)).toEqual(original)
    expect(uploads).toBe(2)
    expect(uploadHeaders).toEqual(['FSWNENC2', 'FSWNENC2'])
    expect(downloads).toBe(0)
    await expect(b.locator('#chatLog .attachment')).toHaveCount(0)

    await a.locator('#chatForm button[type=submit]').click()
    const attachment = b.locator('#chatLog .attachment').filter({ hasText: original.name }).first()
    await expect(attachment).toBeVisible()
    expect(downloads).toBe(0)
    await attachment.getByRole('button', { name: 'Show', exact: true }).click()
    const video = attachment.locator('video')
    await expect(video).toBeVisible()
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    const received = await video.evaluate(async (element: HTMLVideoElement) => {
      const bytes = await (await fetch(element.src)).arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return { size: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''), width: element.videoWidth, height: element.videoHeight }
    })
    expect(received.size).toBe(original.size); expect(received.sha256).toBe(original.sha256)
    expect(received.width).toBe(1280); expect(received.height).toBe(720)
    expect(downloads).toBeGreaterThan(0)
    await video.evaluate(v => (v as HTMLVideoElement).play())
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
    await expect(a.locator('#recordingSave')).toBeVisible()
    await a.locator('#recordingDiscard').click()
    await a.locator('#actionConfirm').click()
    await expect(a.locator('#recordingReady')).toBeHidden()
    await expect(video).toBeVisible()
    await info.attach('encrypted-recording-share.json', { body: JSON.stringify({ original, received, uploads, downloads, encryptedHeaders: uploadHeaders }), contentType: 'application/json' })
  } finally { await aContext.close(); await bContext.close() }
})
