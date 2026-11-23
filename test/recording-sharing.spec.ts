import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { createRoom, joinWithMedia, newDeviceContext, openCall, open, turnOnMedia, allowTestFileStorage, chooseCallMore, join } from './browser.js'
import { fetchFromTestBlossom, routeTestBlossom } from './blossom.js'

test.use({ trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true } })

async function localClip(page: Page) {
  return page.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
    const bytes = await (await fetch(link.href)).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return { name: link.download, size: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') }
  })
}

async function readClip(page: Page, url: string): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async url => {
    const bytes = await (await fetch(url)).arrayBuffer()
    return Array.from(new Uint8Array(bytes))
  }, url))
}

async function mediaPackets(bytes: Buffer) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([Uint8Array.from(bytes)])) })
  try {
    const tracks = await input.getTracks()
    return await Promise.all(tracks.map(async track => {
      const hash = createHash('sha256')
      let count = 0
      for await (const packet of new EncodedPacketSink(track).packets()) {
        hash.update(packet.data)
        count++
      }
      return { type: track.type, count, sha256: hash.digest('hex') }
    }))
  } finally { input.dispose() }
}

for (const phone of [false, true]) test(`recorded video survives storage refusal and failed uploads, then arrives encrypted after Send (${phone ? 'touch phone' : 'desktop'})`, async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium recording/export fixture; other browser and physical gates remain separate')
  const aContext = await newDeviceContext(browser, baseURL!, phone ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } } : {}), bContext = await newDeviceContext(browser, baseURL!)
  const origin = new URL(baseURL!).origin
  await routeTestBlossom(aContext, origin); await routeTestBlossom(bContext, origin)
  // The default public server must never be reached from a test.
  const defaultHits: string[] = []
  await aContext.route(url => url.origin === 'https://blossom.yakihonne.com', route => { defaultHits.push(route.request().url()); return route.abort() })
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
    await open(b, url, 'Bob'); await join(b)
    await expect(b.locator('#callToggle')).toHaveText('Join call')
    await turnOnMedia(b)
    await openCall(a)
    await chooseCallMore(a, 'Record call…')
    await a.locator('input[name="recording-layout"][value="gallery"]').check()
    await a.locator('#actionConfirm').click()
    await expect(a.locator('#recordingElapsed')).toBeVisible()
    await a.waitForTimeout(3500)
    await a.locator('#recordingStop').click()
    await expect(a.locator('#recordingReady')).toBeVisible()
    const original = await localClip(a)
    expect(original.size).toBeGreaterThan(0)
    const originalPackets = await mediaPackets(await readClip(a, (await a.locator('#recordingSave').getAttribute('href'))!))
    expect(originalPackets.filter(track => track.count > 0).map(track => track.type).sort()).toEqual(['audio', 'video'])

    await a.locator('#recordingShare').click()
    // Held in the tray with the one-time notice: nothing leaves until Send.
    await expect(a.locator('#attachStaged')).toContainText(original.name)
    await expect(a.locator('#attachStaged .attachChip .s')).toHaveText('Not uploaded')
    await expect(a.locator('#fileNotice')).toBeVisible()
    await expect(a.locator('#recordingSave')).toBeVisible()
    await expect(a.locator('#recordingShare')).toBeDisabled()
    expect(await localClip(a)).toEqual(original)
    expect(uploads).toBe(0)
    await expect(b.locator('#chatLog .attachment')).toHaveCount(0)

    await allowTestFileStorage(a, origin)
    // Send is the act: the first upload is refused, so nothing is sent and the file stays held.
    await a.locator('#chatForm button[type=submit]').click()
    await expect(a.locator('#fileTrayErrorText')).toContainText('didn’t take')
    await expect(a.locator('#fileTryAgain')).toBeVisible()
    expect(await localClip(a)).toEqual(original)
    await expect(a.locator('#attachStaged .attachChip .s')).toHaveText('Not uploaded')

    await a.locator('#fileTryAgain').click()
    await expect(a.locator('#attachStaged')).toContainText(original.name)
    await expect(a.locator('#attachStaged .attachChip .s')).toHaveText(/\d+(\.\d)? ?(B|KB|MB)$/)
    await expect(a.locator('#recordingReadyText')).toContainText('press Send')
    await expect(a.locator('#recordingShare')).toBeDisabled()
    expect(await localClip(a)).toEqual(original)
    expect(uploads).toBe(2)
    expect(uploadHeaders).toEqual(['FSWNENC2', 'FSWNENC2'])
    expect(downloads).toBe(0)
    expect(defaultHits).toEqual([])
    await expect(b.locator('#chatLog .attachment')).toHaveCount(0)

    await a.locator('#chatForm button[type=submit]').click()
    const attachment = b.locator('#chatLog .attachment').filter({ hasText: original.name }).first()
    await expect(attachment).toBeVisible()
    expect(downloads).toBe(0)
    await attachment.getByRole('button', { name: /^Show/ }).click()
    const video = attachment.frameLocator('iframe.attachmentPreviewFrame').locator('video')
    await expect(video).toBeVisible()
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    const saveUrl = (await attachment.getByRole('link', { name: /^Save / }).getAttribute('href'))!
    const receivedBytes = await readClip(b, saveUrl)
    const received = {
      size: receivedBytes.byteLength,
      sha256: createHash('sha256').update(receivedBytes).digest('hex'),
      ...await video.evaluate((element: HTMLVideoElement) => ({ width: element.videoWidth, height: element.videoHeight })),
    }
    // Sharing rebuilds the container to remove metadata. The saved original
    // stays intact, and every compressed audio/video packet reaches the peer.
    const receivedPackets = await mediaPackets(receivedBytes)
    expect(receivedPackets.sort((a, b) => a.type.localeCompare(b.type)))
      .toEqual(originalPackets.sort((a, b) => a.type.localeCompare(b.type)))
    expect(received.width).toBe(1280); expect(received.height).toBe(720)
    expect(downloads).toBeGreaterThan(0)
    await video.evaluate(v => (v as HTMLVideoElement).play())
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1)
    await expect(a.locator('#recordingSave')).toBeVisible()
    await a.locator('#recordingDiscard').click()
    await a.locator('#actionConfirm').click()
    await expect(a.locator('#recordingReady')).toBeHidden()
    await expect(video).toBeVisible()
    await info.attach('encrypted-recording-share.json', { body: JSON.stringify({ original, received, originalPackets, receivedPackets, uploads, downloads, encryptedHeaders: uploadHeaders }), contentType: 'application/json' })
  } finally { await aContext.close(); await bContext.close() }
})
