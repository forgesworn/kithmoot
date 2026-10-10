import { test, expect, type Page } from '@playwright/test'
import { createRoom, open, openCall, newDeviceContext, SYNTHETIC_MIC, inbound } from './browser.js'

/** Real AudioWorklets and WebRTC, with synthetic audio and loopback relays.
 * Faults stop the processor itself or make native module loading receive 404. */
const observeVoiceNodes = () => {
  const native = AudioWorkletNode
  const nodes: AudioWorkletNode[] = []
  ;(window as unknown as { __voiceNodes: AudioWorkletNode[] }).__voiceNodes = nodes
  window.AudioWorkletNode = class extends native {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options)
      if (name === 'kithmoot-voice-mask') nodes.push(this)
    }
  }
}

const missingVoiceModule = () => {
  const NativeContext = AudioContext
  const faults = { rejected: 0 }
  ;(window as unknown as { __voiceModuleFault: typeof faults }).__voiceModuleFault = faults
  window.AudioContext = class extends NativeContext {
    constructor(options?: AudioContextOptions) {
      super(options)
      const load = this.audioWorklet.addModule.bind(this.audioWorklet)
      this.audioWorklet.addModule = (url, settings) => {
        const requested = new URL(String(url), document.baseURI)
        if (!requested.pathname.endsWith('/voice-worklet.js')) return load(url, settings)
        return load(new URL('missing-voice-worklet-fixture.js', requested).href, settings).catch(error => {
          faults.rejected++
          throw error
        })
      }
    }
  }
}

async function joinSilent(page: Page, url: string, name: string) {
  await open(page, url, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await openCall(page)
}

async function pickMask(page: Page, preset: string) {
  if (!await page.locator('#voicePresets').isVisible()) {
    if (!await page.locator('#voiceEffects').isVisible()) await page.locator('#callExtras > summary').click()
    if (!await page.locator('#voicePresets').isVisible()) await page.locator('#voiceEffects > summary').click()
  }
  await page.locator(`#voicePresets [data-preset="${preset}"]`).click()
  // Phone settings occupy a modal sheet: finish the choice before using the
  // microphone controls behind it, just as a person must.
  if (await page.locator('#mobileCallSettingsClose').isVisible()) {
    await page.locator('#mobileCallSettingsClose').click()
  }
}

async function energy(page: Page) { return (await page.evaluate(inbound)).audioEnergy }

function layout(project: string) {
  return project.includes('desktop') ? { viewport: { width: 1440, height: 900 } }
    : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
}

test('a selected mask rejects module failure without publishing a raw microphone', async ({ browser, baseURL }, info) => {
  const context = await newDeviceContext(browser, baseURL!, { ...layout(info.project.name), serviceWorkers: 'block' })
  await context.addInitScript(SYNTHETIC_MIC)
  await context.addInitScript(missingVoiceModule)
  const page = await context.newPage()
  try {
    const url = await createRoom(page, baseURL!)
    await joinSilent(page, url, 'Ada')
    await pickMask(page, 'deep') // Before capture, not after raw speech starts.
    await expect(page.locator('#voicePreview')).toBeDisabled()
    await page.locator('#toggleMic').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voiceModuleFault: { rejected: number } }).__voiceModuleFault.rejected),
      { message: 'native worklet loading rejected the missing module' }).toBeGreaterThan(0)
    await expect(page.locator('#voiceFailureNotice')).toBeVisible()
    await expect(page.locator('#voiceMode')).toHaveText('deep')
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    expect(await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
      .flatMap(pc => pc.getSenders()).filter(sender => sender.track?.kind === 'audio').length)).toBe(0)
    await expect(page.locator('#voiceStatus')).toContainText('Microphone muted')
    await pickMask(page, 'off')
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#voiceFailureNotice')).toBeHidden()
  } finally { await context.close() }
})

test('a stopped real masking processor mutes remote audio and retries the selected mask', async ({ browser, baseURL }, info) => {
  const a = await newDeviceContext(browser, baseURL!, layout(info.project.name))
  const b = await newDeviceContext(browser, baseURL!, layout(info.project.name))
  await a.addInitScript(SYNTHETIC_MIC)
  await a.addInitScript(observeVoiceNodes)
  const sender = await a.newPage(); const receiver = await b.newPage()
  try {
    const url = await createRoom(sender, baseURL!)
    await joinSilent(sender, url, 'Ada')
    await pickMask(sender, 'deep')
    await sender.locator('#toggleMic').click()
    await joinSilent(receiver, url, 'Bob')
    await expect.poll(() => energy(receiver), { message: 'masked audio reaches the other participant' }).toBeGreaterThan(0.01)
    await sender.evaluate(() => (window as unknown as { __voiceNodes: AudioWorkletNode[] }).__voiceNodes.at(-1)!.port.postMessage({ type: 'stop' }))
    await expect(sender.locator('#voiceFailureNotice')).toBeVisible()
    await expect(sender.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await expect(sender.locator('#voiceMode')).toHaveText('deep')
    // Let already-sent audio drain, then measure new decoded energy.
    await receiver.waitForTimeout(1000)
    const muted = await energy(receiver)
    await receiver.waitForTimeout(2000)
    expect(await energy(receiver) - muted).toBeLessThan(0.0001)
    await sender.locator('#toggleMic').click()
    await expect(sender.locator('#voiceFailureNotice')).toBeHidden()
    await expect(sender.locator('#voiceMode')).toHaveText('deep')
    await expect.poll(() => energy(receiver), { message: 'a new masked processor restores remote audio' }).toBeGreaterThan(muted + 0.01)
  } finally { await a.close(); await b.close() }
})

test('choosing Off after mask failure still requires a deliberate unmute', async ({ browser, baseURL }, info) => {
  const context = await newDeviceContext(browser, baseURL!, layout(info.project.name))
  await context.addInitScript(SYNTHETIC_MIC)
  await context.addInitScript(observeVoiceNodes)
  const page = await context.newPage()
  try {
    const url = await createRoom(page, baseURL!)
    await joinSilent(page, url, 'Ada')
    await pickMask(page, 'deep')
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await page.evaluate(() => (window as unknown as { __voiceNodes: AudioWorkletNode[] }).__voiceNodes.at(-1)!.port.postMessage({ type: 'stop' }))
    await expect(page.locator('#voiceFailureNotice')).toBeVisible()
    await pickMask(page, 'off')
    await expect(page.locator('#voiceMode')).toHaveText('off')
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
  } finally { await context.close() }
})
