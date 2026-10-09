import { test, expect, type Page } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, remotePictures, openCall, open, turnOnMedia } from './browser.js'

test.use({ trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true } })

/** Synthetic coloured cameras and shares; real call, compositor, muxer and
 * file decoder. Colour changes make frozen or substituted exports observable. */
async function syntheticMedia(page: Page, colour: string): Promise<void> {
  await page.addInitScript(({ colour }) => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    const track = (colour: string) => {
      const canvas = document.createElement('canvas')
      canvas.width = 640; canvas.height = 360
      const context = canvas.getContext('2d')!
      let phase = 0
      const paint = () => {
        context.fillStyle = colour; context.fillRect(0, 0, 640, 360)
        context.fillStyle = '#ffffff'; context.fillRect((phase++ * 10) % 640, 8, 12, 24)
      }
      paint()
      const timer = setInterval(paint, 67)
      const video = canvas.captureStream(15).getVideoTracks()[0]!
      const stop = video.stop.bind(video)
      video.stop = () => { clearInterval(timer); stop() }
      return video
    }
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = constraints?.audio ? await original({ audio: constraints.audio }) : new MediaStream()
      if (constraints?.video) stream.addTrack(track(colour))
      return stream
    }
    navigator.mediaDevices.getDisplayMedia = async () => new MediaStream([track((window as unknown as { shareColour?: string }).shareColour ?? '#ffd000')])
  }, { colour })
}

/** Decode the actual saved file, rather than trusting a stream/notice flag. */
async function exportedMedia(page: Page): Promise<{ duration: number; videoDuration: number; preview: string; energy: number; red: number; blue: number; yellow: number; green: number; width: number; height: number }> {
  return page.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
    const bytes = await (await fetch(link.href)).arrayBuffer()
    const audio = new AudioContext()
    let duration = 0, energy = 0
    try {
      const decoded = await audio.decodeAudioData(bytes)
      duration = decoded.duration
      const samples = decoded.getChannelData(0)
      for (const sample of samples) energy += sample * sample
      energy = Math.sqrt(energy / samples.length)
    } finally { await audio.close() }
    const video = document.createElement('video')
    video.muted = true; video.playsInline = true; video.src = link.href
    const loaded = new Promise<void>((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true })
      video.addEventListener('error', () => reject(new Error('saved video did not decode')), { once: true })
    })
    await loaded
    await video.play()
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const context = canvas.getContext('2d')!
    const colours = { red: 0, blue: 0, yellow: 0, green: 0 }
    // Play all frames, retaining colour evidence from before/after share
    // replacement and pause. Sample every 100ms to keep this bounded.
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        context.drawImage(video, 0, 0)
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data
        const found = { red: 0, blue: 0, yellow: 0, green: 0 }
        for (let i = 0; i < data.length; i += 16) {
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
          if (r > 150 && g < 80 && b < 80) found.red++
          if (b > 150 && r < 80 && g < 80) found.blue++
          if (r > 150 && g > 100 && b < 80) found.yellow++
          if (g > 150 && r < 80 && b < 80) found.green++
        }
        for (const key of Object.keys(found) as Array<keyof typeof found>) colours[key] = Math.max(colours[key], found[key])
      }, 100)
      const timeout = setTimeout(() => { clearInterval(timer); video.pause(); reject(new Error('saved video did not finish playback')) }, (duration + 10) * 1000)
      video.addEventListener('ended', () => { clearInterval(timer); clearTimeout(timeout); resolve() }, { once: true })
    })
    const videoDuration = video.currentTime
    video.pause(); video.removeAttribute('src'); video.load()
    return { duration, videoDuration, preview: canvas.toDataURL('image/png'), energy, ...colours, width: canvas.width, height: canvas.height }
  })
}

for (const { layout, phone } of [
  { layout: 'gallery', phone: false }, { layout: 'gallery', phone: true },
  { layout: 'speaker', phone: false }, { layout: 'screen-camera', phone: false },
] as const) {
  test(`${layout} recording exports chosen video and call audio on one timeline (${phone ? 'touch phone' : 'desktop'})`, async ({ browser, baseURL }, info) => {
    const aContext = await newDeviceContext(browser, baseURL!, phone ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } } : {})
    const bContext = await newDeviceContext(browser, baseURL!)
    try {
      const a = await aContext.newPage(), b = await bContext.newPage()
      await syntheticMedia(a, '#ed2020'); await syntheticMedia(b, '#2020ed')
      const url = await createRoom(a, baseURL!)
      await joinWithMedia(a, url, 'Ada')
      await open(b, url, 'Bob'); await b.locator('#join').click()
      // Wait for the advertised call before pressing Join. Starting two
      // independent call ids is not evidence of recording one shared call.
      await expect(b.locator('#callToggle')).toHaveText('Join call')
      await turnOnMedia(b)
      await expect.poll(async () => (await a.evaluate(remotePictures)).length).toBeGreaterThan(0)
      if (layout === 'screen-camera') {
        await openCall(b)
        await b.locator('#toggleScreen').click()
        await expect(a.getByRole('button', { name: 'Expand screen share from Bob', exact: true })).toBeVisible()
      }
      await openCall(a)
      await a.locator('#callExtras > summary').click()
      await a.locator('#meetingPanel > summary').click()
      await a.locator('#recordToggle').click()
      if (layout === 'gallery' && !phone) {
        await expect(a.locator('#actionCancel')).toBeFocused()
        await a.keyboard.press('Tab'); await expect(a.locator('#actionConfirm')).toBeFocused()
        await a.keyboard.press('Tab'); await expect(a.locator('input[value="audio"][name="recording-layout"]')).toBeFocused()
        await a.keyboard.press('ArrowDown'); await expect(a.locator('input[value="gallery"][name="recording-layout"]')).toBeChecked()
      }
      await a.locator(`input[name="recording-layout"][value="${layout}"]`).check()
      if (layout === 'screen-camera') await expect(a.locator('#recordingShareSource')).toContainText('Bob')
      await a.locator('#actionConfirm').click()
      if (await a.locator('#mobileCallSettings').isVisible()) await a.locator('#mobileCallSettingsClose').click()
      await expect(b.locator('#recordingBannerText')).toContainText('Ada')
      await expect(b.locator('#recordingBannerText')).toContainText(layout === 'screen-camera' ? 'screen share with camera' : `${layout} video`)
      await expect(a.locator('#recordingElapsed')).toBeVisible()
      await a.waitForTimeout(2400)
      // Pausing gallery DOM views must not freeze the independent export.
      if (layout === 'gallery') {
        await a.locator('#callGalleryCollapse').click()
        await expect(a.locator('#whoIsHere')).toBeHidden()
        await a.waitForTimeout(1300)
        await a.locator('#callGalleryCollapse').click()
      }
      await a.locator('#recordingPause').click()
      await expect(a.locator('#recordingPause')).toHaveText('Resume recording')
      await a.waitForTimeout(1400)
      await a.locator('#recordingPause').click()
      if (layout === 'screen-camera') {
        await b.locator('#toggleScreen').click()
        await b.evaluate(() => { (window as unknown as { shareColour: string }).shareColour = '#20ed20' })
        await b.locator('#toggleScreen').click()
        await expect(a.getByRole('button', { name: 'Expand screen share from Bob', exact: true })).toBeVisible()
      }
      await a.waitForTimeout(2400)
      const text = await a.locator('#recordingElapsed').textContent()
      const [m, s] = text!.split(' ')[0]!.split(':').map(Number)
      const elapsed = m! * 60 + s!
      await a.locator('#diagnostics').evaluate((button: HTMLButtonElement) => button.click())
      await expect(a.locator('#diagnosticsOut')).not.toHaveValue('')
      const diagnostic = JSON.parse(await a.locator('#diagnosticsOut').inputValue())
      await info.attach('capture-inputs.json', { body: JSON.stringify({ participants: diagnostic.participants, pictures: diagnostic.pictures, recording: diagnostic.recording }, null, 2), contentType: 'application/json' })
      await a.locator('#recordingStop').click()
      await expect(a.locator('#recordingReady')).toBeVisible()
      await expect(b.locator('#recordingBanner')).toBeHidden()
      const exported = await exportedMedia(a)
      await info.attach('export-last-frame.png', { body: Buffer.from(exported.preview.split(',')[1]!, 'base64'), contentType: 'image/png' })
      expect(exported.width).toBe(1280); expect(exported.height).toBe(720)
      expect(exported.duration).toBeGreaterThan(elapsed - 1)
      expect(exported.duration).toBeLessThan(elapsed + 2)
      expect(Math.abs(exported.videoDuration - exported.duration)).toBeLessThan(0.5)
      expect(exported.energy).toBeGreaterThan(0.001)
      if (layout === 'gallery') { expect(exported.red).toBeGreaterThan(5000); expect(exported.blue).toBeGreaterThan(5000) }
      if (layout === 'speaker') expect(Math.max(exported.red, exported.blue)).toBeGreaterThan(30_000)
      if (layout === 'screen-camera') {
        expect(exported.yellow).toBeGreaterThan(30_000)
        expect(exported.green).toBeGreaterThan(30_000)
        expect(exported.blue).toBeGreaterThan(3000)
        expect(exported.red).toBeLessThan(1000)
      }
    } finally { await aContext.close(); await bContext.close() }
  })
}
