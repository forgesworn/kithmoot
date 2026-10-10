import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRoom, newDeviceContext, open, openCall, turnOnMedia, SYNTHETIC_MIC } from './browser.js'
import { performanceSample } from './performance-sample.js'

const workloads = (process.env.PERF_WORKLOADS ?? process.env.PERF_WORKLOAD ?? 'video').split(',').map(value => value.trim())
if (new Set(workloads).size !== workloads.length || workloads.some(value => !['idle', 'chat', 'audio', 'video', 'share'].includes(value))) {
  throw new Error('PERF_WORKLOADS must list distinct idle, chat, audio, video or share workloads')
}
const docked = process.env.PERF_DOCKED === '1'
const popout = process.env.PERF_POPOUT === '1'
if (docked && workloads.some(value => ['idle', 'chat'].includes(value))) throw new Error('A docked workload needs a call')
if (popout && workloads.some(value => value !== 'share')) throw new Error('A popout workload needs screen sharing')

/** Count transport work without retaining request URLs, frame bodies or identities. */
async function monitorPage(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page)
  const network = { httpRequests: 0, httpResponses: 0, httpFailed: 0, httpEncodedBytes: 0,
    socketsOpened: 0, socketsClosed: 0, framesSent: 0, framesReceived: 0, frameBytesSent: 0, frameBytesReceived: 0 }
  session.on('Network.requestWillBeSent', () => { network.httpRequests++ })
  session.on('Network.responseReceived', () => { network.httpResponses++ })
  session.on('Network.loadingFailed', () => { network.httpFailed++ })
  session.on('Network.loadingFinished', event => { network.httpEncodedBytes += event.encodedDataLength })
  session.on('Network.webSocketCreated', () => { network.socketsOpened++ })
  session.on('Network.webSocketClosed', () => { network.socketsClosed++ })
  const frameBytes = (frame: { opcode: number; payloadData: string }) => frame.opcode === 2
    ? Buffer.byteLength(frame.payloadData, 'base64') : Buffer.byteLength(frame.payloadData, 'utf8')
  session.on('Network.webSocketFrameSent', event => { network.framesSent++; network.frameBytesSent += frameBytes(event.response) })
  session.on('Network.webSocketFrameReceived', event => { network.framesReceived++; network.frameBytesReceived += frameBytes(event.response) })
  await session.send('Network.enable')
  await session.send('Performance.enable')
  return { session, network }
}

/** Opt-in diagnostic workload; synthetic media on one host is not physical qualification. */
for (const workload of workloads) {
  test(`collect a reproducible ${workload} workload baseline`, async ({ browser, baseURL }, info) => {
    const devices = Number(process.env.PERF_DEVICES ?? 2)
    const seconds = Number(process.env.PERF_SECONDS ?? 45)
    if (!Number.isInteger(devices) || devices < 2 || devices > 32) throw new Error('PERF_DEVICES must be 2–32')
    if (!Number.isFinite(seconds) || seconds < 10 || seconds > 2700) throw new Error('PERF_SECONDS must be 10–2700')
    const contexts: BrowserContext[] = []
    let measurementStarted: number | undefined
    const result = {
      schemaVersion: 2, evidence: 'synthetic browser workload on one host', qualified: false,
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpus: os.cpus().length, loadAverageAtStart: os.loadavg() },
      browser: browser.version(), requestedDevices: devices, requestedSeconds: seconds,
      workload: { kind: workload, docked, requestedPopouts: popout ? 1 : 0, chatStrategy: workload === 'chat' ? 'one round-robin message per collection step' : null },
      people: 0, agents: 0, physicalDevices: 0, syntheticBrowserClients: 0,
      requestedPublishers: { camera: ['video', 'share'].includes(workload) ? devices : 0,
        audio: ['audio', 'video', 'share'].includes(workload) ? devices : 0, share: workload === 'share' ? 1 : 0 },
      cameraPublishers: 0, audioPublishers: 0, sharePublishers: 0,
      popouts: 0, chatMessagesDelivered: 0, chatDeliveryMs: [] as number[],
      routeRequested: 'mesh preferred; loopback signalling', battery: null, thermal: null,
      startedAt: new Date().toISOString(), measurementStartedAt: null as string | null, joinedMs: [] as number[],
      samples: [] as unknown[], failure: null as string | null,
    }
    try {
      const pages: Page[] = []
      const targets: Array<{ page: Page; device: number; presentation: 'primary' | 'share-popout'; monitor: Awaited<ReturnType<typeof monitorPage>> }> = []
      for (let device = 0; device < devices; device++) {
        const context = await newDeviceContext(browser, baseURL!)
        contexts.push(context)
        result.syntheticBrowserClients++
        await context.addInitScript(SYNTHETIC_MIC)
        const page = await context.newPage()
        pages.push(page)
        targets.push({ page, device, presentation: 'primary', monitor: await monitorPage(context, page) })
      }
      const room = await createRoom(pages[0]!, baseURL!)
      for (const [index, page] of pages.entries()) {
        const started = Date.now()
        await open(page, room, `Device ${index + 1}`)
        await page.locator('#join').click()
        await expect(page.locator('#roomArea')).toBeVisible()
        // Join the existing call after its roster entry arrives, rather than
        // starting a second call before another client's presence settles.
        if (result.requestedPublishers.audio) {
          if (index > 0) await expect(page.locator('#callToggle')).toHaveText('Join call')
          if (result.requestedPublishers.camera) {
            await turnOnMedia(page)
            result.cameraPublishers++
          } else {
            await openCall(page)
            await page.locator('#toggleMic').click()
            await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
            await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')
          }
          result.audioPublishers++
        }
        result.joinedMs.push(Date.now() - started)
      }
      if (workload === 'share') {
        await pages[0]!.locator('#toggleScreen').click()
        await expect(pages[0]!.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
        result.sharePublishers++
      }
      for (const [index, page] of pages.entries()) {
        await expect.poll(async () => {
          const sample = await page.evaluate(performanceSample)
          const streams = sample.connections.flatMap(c => c.streams)
          const audio = streams.filter(s => s.direction === 'inbound-rtp' && s.kind === 'audio' && Number(s.totalAudioEnergy) > 0).length
          const video = streams.filter(s => s.direction === 'inbound-rtp' && s.kind === 'video' && Number(s.framesDecoded) > 0).length
          const expectedVideo = result.requestedPublishers.camera ? devices - 1 + (workload === 'share' && index > 0 ? 1 : 0) : 0
          return audio === (result.requestedPublishers.audio ? devices - 1 : 0) && video === expectedVideo
        }, { timeout: 60_000 }).toBe(true)
        if (!result.requestedPublishers.audio) {
          expect(await page.evaluate(() => ((window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? [])
            .some(pc => pc.getSenders().some(sender => sender.track)))).toBe(false)
        }
      }
      if (popout) {
        const viewer = pages[1]!
        await viewer.getByRole('button', { name: 'Expand screen share from Device 1', exact: true }).click()
        const next = viewer.waitForEvent('popup')
        await viewer.getByRole('dialog', { name: 'Screen-share viewer' }).getByRole('button', { name: 'Pop out', exact: true }).click()
        const popup = await next
        targets.push({ page: popup, device: 1, presentation: 'share-popout', monitor: await monitorPage(contexts[1]!, popup) })
        await expect.poll(() => popup.locator('.shareStage > video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
        await expect.poll(() => popup.locator('.shareOwnerCamera video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
        await expect(popup.locator('audio')).toHaveCount(0)
        result.popouts++
      }
      if (docked) {
        await pages[1]!.locator('#workspaceBrandHome').click()
        await expect(pages[1]!.locator('#home')).toBeVisible()
        await expect(pages[1]!.locator('#callDock')).toBeVisible()
      }
      measurementStarted = Date.now()
      result.measurementStartedAt = new Date(measurementStarted).toISOString()
      while (Date.now() - measurementStarted < seconds * 1000) {
        if (workload === 'chat') {
          const text = `Performance sample ${result.chatMessagesDelivered + 1}`
          const sender = pages[result.chatMessagesDelivered % pages.length]!
          const started = Date.now()
          await sender.locator('#chatInput').fill(text)
          await sender.locator('#chatInput').press('Enter')
          await Promise.all(pages.map(page => expect(page.locator('#chatLog')).toContainText(text)))
          result.chatMessagesDelivered++
          result.chatDeliveryMs.push(Date.now() - started)
        }
        const clients = await Promise.all(targets.map(async ({ page, device, presentation, monitor }) => {
          const media = await page.evaluate(performanceSample)
          const { metrics } = await monitor.session.send('Performance.getMetrics')
          const allowed = new Set(['Timestamp', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes'])
          return { device, presentation, media, network: { ...monitor.network }, renderer: Object.fromEntries(metrics.filter(m => allowed.has(m.name)).map(m => [m.name, m.value])) }
        }))
        result.samples.push({ elapsedMs: Date.now() - measurementStarted, clients })
        await pages[0]!.waitForTimeout(Math.min(2000, Math.max(0, seconds * 1000 - (Date.now() - measurementStarted))))
      }
    } catch (error) {
      // Avoid publishing Playwright errors containing room URLs or identities.
      result.failure = error instanceof Error ? error.name : 'UnknownError'
      throw error
    } finally {
      const directory = info.outputPath('performance')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = path.join(directory, 'baseline.json')
      await writeFile(file, JSON.stringify({ ...result, endedAt: new Date().toISOString(),
        measurementElapsedMs: measurementStarted === undefined ? null : Date.now() - measurementStarted,
        loadAverageAtEnd: os.loadavg(),
      }, null, 2) + '\n', { mode: 0o600 })
      await info.attach('performance-baseline', { path: file, contentType: 'application/json' })
      await Promise.allSettled(contexts.map(context => context.close()))
    }
  })
}
