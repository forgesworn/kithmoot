import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createRoom, joinWithMedia, open, turnOnMedia, openCall, INSTRUMENT, SYNTHETIC_MIC, remotePictures } from '../../test/browser.js'
import { localAsset, HOME } from '../policy.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
// Keep the packaged app's production CSP intact. Only this synthetic WSS
// endpoint is intercepted; its Nostr traffic reaches the ordinary local relay.
const relays = ['wss://recording-relay.invalid']
process.env.E2E_RELAYS = relays.join(',')

test('native desktop exports gallery video and audio with signed notices and a local copy', async ({ browser }, info) => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-recording-'))
  const executable = process.env.DESKTOP_EXECUTABLE
  const native = await electron.launch({
    executablePath: executable ?? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [...(executable ? [] : [desktop]), `--user-data-dir=${profile}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const context = await browser.newContext({ permissions: ['camera', 'microphone', 'local-network-access'] })
  try {
    const version = await native.evaluate(({ app }) => app.getVersion())
    expect(version).toBe(JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version)
    for (const isolated of [native.context(), context]) {
      await isolated.routeWebSocket(url => url.origin === relays[0], socket => {
        const backend = new WebSocket('ws://127.0.0.1:17777')
        const pending: Array<string | Buffer> = []
        socket.onMessage(message => { if (backend.readyState === WebSocket.OPEN) backend.send(message); else pending.push(message) })
        backend.on('open', () => { for (const message of pending.splice(0)) backend.send(message) })
        backend.on('message', message => socket.send(message.toString()))
        backend.on('error', () => socket.close())
        backend.on('close', () => socket.close())
        socket.onClose(() => backend.close())
      })
    }
    await context.route('https://kithmoot.forgesworn.dev/**', async route => {
      const path = localAsset(route.request().url(), join(desktop, 'web'))
      if (!path) return route.fulfill({ status: 404, body: 'Not found' })
      const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }
      await route.fulfill({ body: await readFile(path), contentType: types[extname(path)] ?? 'application/octet-stream' })
    })
    const mac = await native.firstWindow(), peer = await context.newPage()
    for (const page of [mac, peer]) {
      await page.addInitScript(INSTRUMENT)
      await page.addInitScript(SYNTHETIC_MIC)
      await page.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    }
    const url = await createRoom(mac, HOME, relays)
    await joinWithMedia(mac, url, 'Desktop recorder')
    await open(peer, url, 'Browser participant'); await peer.locator('#join').click()
    await expect(peer.locator('#callToggle')).toHaveText('Join call')
    await turnOnMedia(peer)
    await expect.poll(async () => (await mac.evaluate(remotePictures)).length).toBeGreaterThan(0)
    await openCall(mac)
    await mac.locator('#callExtras > summary').click()
    await mac.locator('#meetingPanel > summary').click()
    await mac.locator('#recordToggle').click()
    await mac.locator('input[name="recording-layout"][value="gallery"]').check()
    await mac.locator('#actionConfirm').click()
    await expect(peer.locator('#recordingBannerText')).toContainText('Desktop recorder')
    await expect(peer.locator('#recordingBannerText')).toContainText('gallery video')
    await expect(mac.locator('#recordingElapsed')).toBeVisible()
    await mac.waitForTimeout(2500)
    await mac.locator('#recordingPause').click()
    await expect(mac.locator('#recordingPause')).toHaveText('Resume recording')
    await mac.waitForTimeout(1000)
    await mac.locator('#recordingPause').click()
    await mac.waitForTimeout(1500)
    await mac.locator('#recordingStop').click()
    await expect(peer.locator('#recordingBanner')).toBeHidden()
    await expect(mac.locator('#recordingSave')).toBeVisible()
    const savedFile = join(profile, 'synthetic-recording.webm')
    await native.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(path)
        item.once('done', (_event, state) => { (globalThis as unknown as { recordingDownloadState: string }).recordingDownloadState = state })
      })
    }, savedFile)
    await mac.locator('#recordingSave').click()
    await expect.poll(() => native.evaluate(() => (globalThis as unknown as { recordingDownloadState: string }).recordingDownloadState)).toBe('completed')
    const savedBytes = await readFile(savedFile)
    const exportPath = info.outputPath('native-recording-export.webm')
    await writeFile(exportPath, savedBytes)
    await info.attach('native-recording-export.webm', { path: exportPath, contentType: 'video/webm' })
    // Decode the real finished clip, including its muxed audio track. Merely
    // seeing a recording indicator does not establish a usable native export.
    const exported = await mac.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement, base64) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer, audio = new AudioContext()
      let duration = 0, energy = 0
      try {
        // decodeAudioData transfers its input buffer; preserve the downloaded
        // bytes for the independent video decoder and file-size evidence.
        const decoded = await audio.decodeAudioData(bytes.slice(0)); duration = decoded.duration
        const samples = decoded.getChannelData(0)
        for (const sample of samples) energy += sample * sample
        energy = Math.sqrt(energy / samples.length)
      } finally { await audio.close() }
      const video = document.createElement('video'); video.muted = true
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' })); video.src = url
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error(`Native export did not decode: ${video.error?.code} ${video.error?.message}; name=${link.download}; bytes=${bytes.byteLength}`)) })
      await video.play()
      await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Native export did not finish')), (duration + 10) * 1000); video.onended = () => { clearTimeout(timeout); resolve() } })
      const result = { bytes: bytes.byteLength, name: link.download, duration, videoDuration: video.currentTime, width: video.videoWidth, height: video.videoHeight, energy }
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url)
      return result
    }, savedBytes.toString('base64'))
    expect(exported.bytes).toBeGreaterThan(0)
    expect(exported.width).toBe(1280); expect(exported.height).toBe(720)
    expect(exported.duration).toBeGreaterThan(3)
    expect(Math.abs(exported.duration - exported.videoDuration)).toBeLessThan(0.5)
    expect(exported.energy).toBeGreaterThan(0.001)
    await expect(mac.locator('#recordingShare')).toHaveText('Add to message')
    await expect(peer.locator('#chatLog .attachment')).toHaveCount(0)
    const receiptPath = info.outputPath('native-recording-export.json')
    await writeFile(receiptPath, JSON.stringify({ version, packaged: !!executable, syntheticInputs: true, exported }, null, 2))
    await info.attach('native-recording-export.json', { path: receiptPath, contentType: 'application/json' })
    await mac.locator('#recordingDiscard').click(); await mac.locator('#actionConfirm').click()
    await expect(mac.locator('#recordingReady')).toBeHidden()
    await peer.locator('#leaveCall').click(); await mac.locator('#leaveCall').click()
  } finally {
    await native.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await native.close().catch(() => {}); await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
