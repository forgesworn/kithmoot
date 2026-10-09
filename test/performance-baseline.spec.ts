import { test, expect, type BrowserContext, type Page, type CDPSession } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRoom, newDeviceContext, open, turnOnMedia, SYNTHETIC_MIC } from './browser.js'
import { performanceSample } from './performance-sample.js'

/** Opt-in diagnostic workload; synthetic media on one host is not physical qualification. */
test('collect a reproducible encoded-media baseline', async ({ browser, baseURL }, info) => {
  const devices = Number(process.env.PERF_DEVICES ?? 2)
  const seconds = Number(process.env.PERF_SECONDS ?? 45)
  if (!Number.isInteger(devices) || devices < 2 || devices > 32) throw new Error('PERF_DEVICES must be 2–32')
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 2700) throw new Error('PERF_SECONDS must be 10–2700')
  const contexts: BrowserContext[] = []
  let measurementStarted: number | undefined
  const result = {
    schemaVersion: 1, evidence: 'synthetic encoded media on one host', qualified: false,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpus: os.cpus().length, loadAverageAtStart: os.loadavg() },
    browser: browser.version(), requestedDevices: devices, requestedSeconds: seconds,
    people: 0, agents: 0, physicalDevices: 0, syntheticBrowserClients: 0,
    requestedPublishers: { camera: devices, audio: devices, share: 0 },
    cameraPublishers: 0, audioPublishers: 0, sharePublishers: 0,
    routeRequested: 'direct mesh; loopback', battery: null, thermal: null,
    startedAt: new Date().toISOString(), measurementStartedAt: null as string | null, joinedMs: [] as number[],
    samples: [] as unknown[], failure: null as string | null,
  }
  try {
    const pages: Page[] = []
    const monitors: CDPSession[] = []
    for (let device = 0; device < devices; device++) {
      const context = await newDeviceContext(browser, baseURL!)
      contexts.push(context)
      result.syntheticBrowserClients++
      await context.addInitScript(SYNTHETIC_MIC)
      const page = await context.newPage()
      pages.push(page)
      const monitor = await context.newCDPSession(page)
      await monitor.send('Performance.enable')
      monitors.push(monitor)
    }
    const room = await createRoom(pages[0]!, baseURL!)
    for (const [index, page] of pages.entries()) {
      const started = Date.now()
      await open(page, room, `Device ${index + 1}`)
      await page.locator('#join').click()
      await expect(page.locator('#roomArea')).toBeVisible()
      // Join the existing call after its roster entry arrives, rather than
      // starting a second call before another client's presence settles.
      if (index > 0) await expect(page.locator('#callToggle')).toHaveText('Join call')
      await turnOnMedia(page)
      result.cameraPublishers++
      result.audioPublishers++
      result.joinedMs.push(Date.now() - started)
    }
    for (const page of pages) {
      await expect.poll(async () => {
        const sample = await page.evaluate(performanceSample)
        return sample.connections.flatMap(c => c.streams).filter(s => s.direction === 'inbound-rtp' && s.kind === 'video' && Number(s.framesDecoded) > 0).length
      }, { timeout: 60_000 }).toBe(devices - 1)
    }
    measurementStarted = Date.now()
    result.measurementStartedAt = new Date(measurementStarted).toISOString()
    while (Date.now() - measurementStarted < seconds * 1000) {
      const clients = await Promise.all(pages.map(async (page, device) => {
        const media = await page.evaluate(performanceSample)
        const { metrics } = await monitors[device]!.send('Performance.getMetrics')
        const allowed = new Set(['Timestamp', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes'])
        return { device, media, renderer: Object.fromEntries(metrics.filter(m => allowed.has(m.name)).map(m => [m.name, m.value])) }
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
