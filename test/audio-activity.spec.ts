import { test, expect } from '@playwright/test'
import { collectAppDiagnostics } from './app-diagnostics.js'
import { createRoom, inbound, join, joinWithMedia, newDeviceContext, open, openCall, SYNTHETIC_MIC } from './browser.js'

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
    const adaMeter = activity.locator('.audioSignal', { has: bob.getByText('Ada', { exact: true }) })
    const ownMeter = activity.locator('[data-audio-signal="mic"]')
    await expect(activity).toBeVisible()
    await expect(adaMeter).toContainText('Speaking')
    await expect(ownMeter).toContainText('You')
    await expect(ownMeter).toContainText('Speaking')
    const micTrace = ownMeter.locator('.audioTrace')
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
    await expect(adaMeter).toContainText('Speaking')
    await bob.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
    await expect(activity.locator('.audioTrace').first()).toBeHidden()
    await expect(activity.locator('.audioLevel').first()).toBeVisible()
    if (await bob.locator('#toggleMic').getAttribute('data-on') === 'true') await bob.locator('#toggleMic').evaluate(el => (el as HTMLButtonElement).click())
    await expect(bob.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await expect(ownMeter).toContainText('Muted')
    await expect(adaMeter).toContainText('Speaking')
    await bob.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
    await expect(micTrace).toHaveCSS('color', 'rgb(255, 255, 255)')
    expect((await activity.boundingBox())!.height).toBe(activityHeight)
    if (info.project.name === 'chromium') {
      await bob.setViewportSize({ width: 355, height: 740 })
      await bob.locator('#callChatToggle').click()
      await expect(bob.locator('#chatAudioActivity')).toBeVisible()
      await expect(bob.locator('#chatAudioActivity .audioSignal', { hasText: 'Ada' })).toContainText('Speaking')
      await expect.poll(() => bob.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await bob.screenshot({ path: info.outputPath('audio-activity.png') })
    await bob.locator('#leaveCall').evaluate(el => (el as HTMLButtonElement).click())
    await expect(activity).toBeHidden()
    await expect(bob.locator('#chatAudioActivity')).toBeHidden()
  } finally { await a.close(); await b.close() }
})

test('five callers keep independent microphone traces as speakers change and leave', async ({ browser, baseURL }, info) => {
  test.setTimeout(180_000)
  const names = ['Ada', 'Bob', 'Kit', 'Rowan', 'Sam', 'Chat only']
  const contexts = await Promise.all(names.map(() => newDeviceContext(browser, baseURL!)))
  const pages = await Promise.all(contexts.map(async context => {
    await context.addInitScript(SYNTHETIC_MIC, { silentOutput: true })
    await context.addInitScript(() => {
      const events: string[] = []
      Object.assign(window, { audioProbeEvents: events })
      const original = RTCPeerConnection.prototype.setLocalDescription
      RTCPeerConnection.prototype.setLocalDescription = function (description) {
        events.push(`${Math.round(performance.now())} local ${description?.type ?? 'implicit'}`)
        return original.call(this, description)
      }
      const replace = RTCRtpSender.prototype.replaceTrack
      RTCRtpSender.prototype.replaceTrack = function (track) {
        if (track?.kind === 'audio' || this.track?.kind === 'audio') events.push(`${Math.round(performance.now())} replace ${track?.kind ?? 'empty'}`)
        return replace.call(this, track)
      }
    })
    await context.addInitScript(() => localStorage.setItem('kithmoot.call.micOnJoin', 'off'))
    return context.newPage()
  }))
  const [ada, bob, kit] = pages
  try {
    const url = await createRoom(ada!, baseURL!)
    const strip = ada!.locator('#callAudioActivity')
    const card = (name: string) => strip.locator('.audioSignal').filter({ has: ada!.getByText(name, { exact: true }) })
    const state = (name: string) => card(name).locator('.audioSignalState')
    for (const [index, page] of pages.entries()) {
      await open(page, url, names[index]!)
      await join(page)
      if (index > 0 && index < 5) await expect(page.locator('#callToggle')).toHaveText('Join call')
      if (index < 5) {
        await openCall(page)
        await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
      }
    }

    await expect(strip.locator('.audioSignal')).toHaveCount(5)
    await expect(card('Chat only')).toHaveCount(0)
    await expect(strip.locator('.audioSignalLabel').first()).toHaveText('You')
    await expect(state('Rowan')).toHaveText('Off')
    await expect(state('Sam')).toHaveText('Off')
    const labels = await strip.locator('.audioSignalLabel').allTextContents()

    for (const [index, page] of [ada!, bob!, kit!].entries()) {
      await page.locator('#toggleMic').click()
      await expect(page.locator('#callAudioActivity [data-audio-signal="mic"] .audioSignalState')).toHaveText('Speaking')
      await expect(state(index === 0 ? 'You' : names[index]!)).toHaveText('Speaking', { timeout: 25_000 })
    }

    for (const name of ['You', 'Bob', 'Kit']) {
      await expect(state(name)).toHaveText('Speaking')
      await expect(card(name).locator('.audioEnvelope')).toHaveAttribute('d', /^M.*L/)
    }
    await expect(state('Rowan')).toHaveText('Off')
    await expect(state('Sam')).toHaveText('Off')
    await expect(strip.locator('.audioSignalLabel')).toHaveText(labels)
    await strip.screenshot({ path: info.outputPath('five-callers.png') })

    await bob!.locator('#toggleMic').evaluate(el => (el as HTMLButtonElement).click())
    await expect(state('Bob')).toHaveText('Muted', { timeout: 15_000 })
    await expect(card('Bob').locator('.audioEnvelope')).toHaveAttribute('d', 'M0 12H128')
    await expect(state('Kit')).toHaveText('Speaking')
    await expect(state('You')).toHaveText('Speaking')
    await expect(strip.locator('.audioSignalLabel')).toHaveText(labels)
    await bob!.locator('#toggleMic').evaluate(el => (el as HTMLButtonElement).click())
    await expect(state('Bob')).toHaveText('Speaking')
    await kit!.locator('#leaveCall').evaluate(el => (el as HTMLButtonElement).click())
    await expect(card('Kit')).toHaveCount(0, { timeout: 15_000 })
    await expect(strip.locator('.audioSignalLabel')).toHaveText(labels.filter(label => label !== 'Kit'))
  } catch (error) {
    const diagnosis = await bob!.evaluate(async () => {
      const w = window as unknown as { __pcs: RTCPeerConnection[]; audioProbeEvents: string[] }
      const senders = w.__pcs.filter(pc => pc.connectionState === 'connected').flatMap(pc => pc.getTransceivers()
        .filter(t => t.sender.track?.kind === 'audio')
        .map(t => ({ sender: t.sender, direction: t.currentDirection })))
      const read = async (sender: RTCRtpSender) => {
        const stats = [...(await sender.getStats()).values()]
        const input = stats.find(s => s.type === 'media-source' && s.kind === 'audio')
        const outgoing = stats.find(s => s.type === 'outbound-rtp' && s.kind === 'audio')
        return { samples: input?.totalSamplesDuration, level: input?.audioLevel, packets: outgoing?.packetsSent }
      }
      const before = await Promise.all(senders.map(async ({ sender, direction }) => ({ direction, ...(await read(sender)) })))
      const events = w.audioProbeEvents.slice()
      for (const [i, { sender, direction }] of senders.entries()) {
        if (before[i]?.packets !== 0 || (direction !== 'sendrecv' && direction !== 'sendonly')) continue
        const track = sender.track
        await sender.replaceTrack(null)
        await sender.replaceTrack(track)
      }
      await new Promise(resolve => setTimeout(resolve, 800))
      const after = await Promise.all(senders.map(({ sender }) => read(sender)))
      return { events, before, after }
    }).catch(error => String(error))
    console.log('MICROPHONE_DIAGNOSIS', JSON.stringify(diagnosis))
    for (const [index, page] of [ada!, bob!, kit!].entries()) {
      const body = await collectAppDiagnostics(page).catch(() => undefined)
      if (body) await info.attach(`${names[index]} call diagnostics`, { body, contentType: 'application/json' })
    }
    throw error
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})
