import { build } from 'esbuild'
import { syntheticSource } from './browser-protected-share-fixture.js'
import { test, expect, type Page } from '@playwright/test'

let moduleCode: string
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['app/src/browser-share.ts'], bundle: true, format: 'esm', write: false, target: 'es2022' })
  moduleCode = result.outputFiles[0]!.text
})

async function fixture(page: Page, baseURL: string): Promise<void> {
  await page.route('**/__share-module.js', route => route.fulfill({ contentType: 'text/javascript', body: moduleCode }))
  await page.route('**/__share-fixture', route => route.fulfill({ contentType: 'text/html', body: `
    <button id="start">Prepare protected share</button><script type="module">
    import { BrowserShare } from '/__share-module.js';
    window.ended = 0; window.share = new BrowserShare(() => window.ended++);
    document.querySelector('button').onclick = () => {
      window.result = undefined; window.error = undefined;
      window.share.start(window.area === true).then(stream => window.result = stream, error => window.error = error.message);
    };
    </script>` }))
  await page.goto(new URL('/__share-fixture', baseURL).href)
}


async function prepare(page: Page): Promise<Page> {
  const pending = page.waitForEvent('popup'); await page.locator('#start').click()
  const popup = await pending; await syntheticSource(popup)
  await popup.getByRole('button', { name: 'Choose a window or tab' }).click()
  await expect(popup.getByRole('button', { name: 'Start protected sharing' })).toBeEnabled()
  return popup
}

async function connectReceiver(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { result: MediaStream; receiver: HTMLVideoElement; pcs: RTCPeerConnection[]; samples: { leaked: boolean; frames: number } }
    const sender = new RTCPeerConnection({ iceServers: [] }), receiver = new RTCPeerConnection({ iceServers: [] })
    sender.onicecandidate = e => { if (e.candidate) void receiver.addIceCandidate(e.candidate) }
    receiver.onicecandidate = e => { if (e.candidate) void sender.addIceCandidate(e.candidate) }
    const video = document.createElement('video'); video.autoplay = true; video.muted = true; document.body.append(video)
    receiver.ontrack = e => { if (e.track.kind === 'video') video.srcObject = new MediaStream([e.track]) }
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    w.samples = { leaked: false, frames: 0 }; w.receiver = video; w.pcs = [sender, receiver]
    const frame = () => {
      ctx.drawImage(video, 0, 0, 64, 36)
      const d = ctx.getImageData(0, 0, 64, 36).data
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 150 && d[i + 1]! < 80 && d[i + 2]! < 80) w.samples.leaked = true
      w.samples.frames++
      video.requestVideoFrameCallback(frame)
    }
    video.requestVideoFrameCallback(frame)
    for (const track of w.result.getTracks()) sender.addTrack(track)
    await sender.setLocalDescription(await sender.createOffer()); await receiver.setRemoteDescription(sender.localDescription!)
    await receiver.setLocalDescription(await receiver.createAnswer()); await sender.setRemoteDescription(receiver.localDescription!)
    await video.play()
  })
}

async function pixels(page: Page): Promise<{ centre: number[]; edge: number[]; frames: number; leaked: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as { receiver: HTMLVideoElement; samples: { frames: number; leaked: boolean } }
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18
    const ctx = canvas.getContext('2d')!; ctx.drawImage(w.receiver, 0, 0, 32, 18)
    return { centre: [...ctx.getImageData(16, 9, 1, 1).data], edge: [...ctx.getImageData(2, 2, 1, 1).data], ...w.samples }
  })
}

test('protected sharing sends only the cropped/redacted canvas, hides sound and covers source changes', async ({ page, baseURL }) => {
  await fixture(page, baseURL!)
  await page.evaluate(() => { Object.assign(window, { area: true }) })
  const popup = await prepare(page)
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { result?: MediaStream }).result))).toBe(false)
  await popup.getByRole('button', { name: 'Hide a region', exact: true }).click()
  const grip = popup.getByRole('button', { name: 'Resize shared area', exact: true })
  await grip.press('ArrowLeft'); await grip.press('ArrowUp')
  await popup.getByRole('button', { name: 'Start protected sharing' }).click()
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { result?: MediaStream }).result))).toBe(true)
  const rawId = await popup.evaluate(() => (window as unknown as { raw: MediaStream }).raw.getVideoTracks()[0]!.id)
  expect(await page.evaluate(() => (window as unknown as { result: MediaStream }).result.getVideoTracks()[0]!.id)).not.toBe(rawId)
  expect(await page.evaluate(() => (window as unknown as { result: MediaStream }).result.getVideoTracks()[0]!.getSettings().width)).toBeLessThan(640)
  await connectReceiver(page)
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeGreaterThan(130)
  expect((await pixels(page)).centre[0]).toBeLessThan(80)
  const frames = (await pixels(page)).frames
  await popup.getByRole('button', { name: 'Hide my share', exact: true }).click()
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeLessThan(80)
  expect(await popup.evaluate(() => (window as unknown as { raw: MediaStream }).raw.getAudioTracks()[0]!.enabled)).toBe(false)
  await popup.getByRole('button', { name: 'Show my share', exact: true }).click()
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeGreaterThan(130)
  expect(await popup.evaluate(() => (window as unknown as { raw: MediaStream }).raw.getAudioTracks()[0]!.enabled)).toBe(true)
  await popup.getByRole('group', { name: 'Hidden region 1', exact: true }).press('ArrowLeft')
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeLessThan(80)
  expect(await popup.evaluate(() => (window as unknown as { raw: MediaStream }).raw.getAudioTracks()[0]!.enabled)).toBe(false)
  await popup.getByRole('button', { name: 'Show my share', exact: true }).click()
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeGreaterThan(130)
  await popup.evaluate(() => { (window as unknown as { sourceCanvas: HTMLCanvasElement }).sourceCanvas.width = 800 })
  await expect(popup.locator('#status')).toContainText('source changed')
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeLessThan(80)
  await popup.getByRole('button', { name: 'Show my share', exact: true }).click()
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeLessThan(80)
  await popup.getByRole('button', { name: 'Confirm changed source', exact: true }).click()
  await expect.poll(async () => (await pixels(page)).edge[1]).toBeGreaterThan(130)
  expect((await pixels(page)).frames).toBeGreaterThan(frames)
  expect((await pixels(page)).leaked).toBe(false)
  await page.evaluate(() => (window as unknown as { share: { stop(): void } }).share.stop())
  expect(await page.evaluate(() => (window as unknown as { result: MediaStream }).result.getTracks().every(t => t.readyState === 'ended'))).toBe(true)
  await expect.poll(() => popup.isClosed()).toBe(true)
})

test('cancelling while the picker is pending stops every track in a late result', async ({ page, baseURL }) => {
  await fixture(page, baseURL!)
  const pending = page.waitForEvent('popup'); await page.locator('#start').click(); const popup = await pending
  // Hold the browser promise in the opener so it can settle after the popup closes.
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); const stream = canvas.captureStream(1)
    const w = window as unknown as { late: MediaStream; settle: (s: MediaStream) => void; capture: Promise<MediaStream> }
    w.late = stream; w.capture = new Promise(resolve => { w.settle = resolve })
  })
  await popup.evaluate(() => { navigator.mediaDevices.getDisplayMedia = () => (window.opener as unknown as { capture: Promise<MediaStream> }).capture })
  await popup.getByRole('button', { name: 'Choose a window or tab' }).click()
  await page.evaluate(() => (window as unknown as { share: { stop(): void } }).share.stop())
  await page.evaluate(() => { const w = window as unknown as { late: MediaStream; settle: (s: MediaStream) => void }; w.settle(w.late) })
  await expect.poll(() => page.evaluate(() => (window as unknown as { late: MediaStream }).late.getTracks().every(t => t.readyState === 'ended'))).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as unknown as { error?: string }).error)).toBe('Sharing cancelled.')
})

test('source closure and compositor failure stop protected output and raw capture', async ({ page, baseURL }) => {
  for (const failure of ['ended', 'compositor'] as const) {
    await fixture(page, baseURL!); const popup = await prepare(page)
    await popup.getByRole('button', { name: 'Start protected sharing' }).click()
    if (failure === 'ended') await popup.evaluate(() => (window as unknown as { raw: MediaStream }).raw.getVideoTracks()[0]!.dispatchEvent(new Event('ended')))
    else await popup.evaluate(() => { const ctx = (document.querySelector('#outgoing') as HTMLCanvasElement).getContext('2d')!; ctx.drawImage = () => { throw new Error('synthetic compositor failure') } })
    await expect.poll(() => popup.isClosed()).toBe(true)
    await expect.poll(() => page.evaluate(() => (window as unknown as { result: MediaStream }).result.getTracks().every(t => t.readyState === 'ended'))).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { ended: number }).ended)).toBe(1)
  }
})

test('monitor, unknown and sharing-controls sources are refused before any publication', async ({ page, baseURL }) => {
  for (const surface of ['monitor', 'unknown', 'controls'] as const) {
    await fixture(page, baseURL!)
    const pending = page.waitForEvent('popup'); await page.locator('#start').click(); const popup = await pending
    await syntheticSource(popup)
    await popup.evaluate(kind => {
      const source = (window as unknown as { raw: MediaStream }).raw.getVideoTracks()[0]!
      const settings = source.getSettings.bind(source)
      source.getSettings = () => ({ ...settings(), displaySurface: kind === 'unknown' ? undefined : kind === 'monitor' ? 'monitor' : 'window' }) as MediaTrackSettings
      if (kind === 'controls') Object.defineProperty(source, 'label', { value: document.title })
    }, surface)
    await popup.getByRole('button', { name: 'Choose a window or tab' }).click()
    await expect(popup.locator('#status')).toContainText('Choose another window')
    await expect(popup.getByRole('button', { name: 'Start protected sharing' })).toBeDisabled()
    expect(await page.evaluate(() => Boolean((window as unknown as { result?: MediaStream }).result))).toBe(false)
    expect(await popup.evaluate(() => (window as unknown as { raw: MediaStream }).raw.getTracks().every(t => t.readyState === 'ended'))).toBe(true)
    await page.evaluate(() => (window as unknown as { share: { stop(): void } }).share.stop())
  }
})
