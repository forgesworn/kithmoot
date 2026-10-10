import { test, expect, type Browser, type Page } from '@playwright/test'
import { newDeviceContext, openNewRoomForm, requestAdmission } from './browser.js'
import { testRelaysFor } from './relays.js'

async function setup(browser: Browser, baseURL: string, phone = false) {
  const hostContext = await newDeviceContext(browser, baseURL)
  const guestContext = await newDeviceContext(browser, baseURL, phone ? { viewport: { width: 390, height: 844 } } : {})
  const relay = testRelaysFor(baseURL)![0]!
  await hostContext.addInitScript(url => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url, read: true, write: true }] })), relay)
  const host = await hostContext.newPage(), guest = await guestContext.newPage()
  await host.goto(baseURL)
  await openNewRoomForm(host)
  await host.locator('#roomName').fill('Guest preview workshop')
  await host.locator('#roomAsk').check(); await host.locator('#create').click()
  await expect.poll(() => host.locator('#shareUrl').inputValue()).not.toBe('')
  const link = await host.locator('#shareUrl').inputValue()
  await host.locator('#displayName').fill('Synthetic host'); await host.locator('#join').click()
  await expect(host.locator('#roomArea')).toBeVisible()
  const requests: string[] = [], replies: Array<() => void> = []
  let holdReplies = false
  await guestContext.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 20466) requests.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (holdReplies && frame[0] === 'EVENT' && frame[2].kind === 20467) { replies.push(() => ws.send(raw)); return }
      ws.send(raw)
    })
  })
  return { host, guest, link, requests, replies, hold: () => { holdReplies = true },
    close: async () => { await guestContext.close(); await hostContext.close() } }
}

test('a phone guest reviews details before one deliberate request, and retry needs a new action', async ({ browser, baseURL }, info) => {
  const f = await setup(browser, baseURL!, true)
  try {
    await f.guest.goto(f.link)
    await expect(f.guest.locator('#requestAdmission')).toBeVisible()
    await expect(f.guest.locator('#identityMore')).toBeHidden()
    await expect(f.guest.locator('#notify')).toBeHidden()
    await f.guest.locator('#displayName').fill('Synthetic visitor')
    await f.guest.evaluate(() => { document.documentElement.style.fontSize = '20px' })
    await f.guest.locator('#requestAdmission').scrollIntoViewIfNeeded()
    await expect(f.guest.locator('#requestAdmission')).toBeInViewport()
    await expect(f.guest.locator('#cancelAdmission')).toBeInViewport()
    expect(await f.guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await f.guest.waitForTimeout(300)
    expect(f.requests).toEqual([])
    await expect(f.host.locator('#approvals .approvalCard.knock')).toHaveCount(0)
    await expect(f.guest.locator('#roomArea')).toBeHidden()
    const screenshot = await f.guest.screenshot({ path: info.outputPath('guest-preview-phone.png'), fullPage: true })
    await info.attach('guest-preview-phone.png', { body: screenshot, contentType: 'image/png' })
    // Enter in the details field is an explicit request, then a repeated
    // native button event cannot start a second request/helper.
    await f.guest.locator('#displayName').press('Enter')
    await f.guest.locator('#requestAdmission').evaluate(button => (button as HTMLButtonElement).click())
    await expect(f.host.locator('#approvals .approvalCard.knock')).toContainText('Synthetic visitor wants to join')
    await expect(f.guest.locator('#admissionPreviewStatus')).toContainText('Waiting for someone')
    expect(new Set(f.requests).size).toBe(1)
    await f.guest.locator('#cancelAdmission').click()
    await expect(f.guest.locator('#arrivalTitle')).toHaveText('Your request was cancelled')
    const count = f.requests.length
    await f.guest.locator('#retryArrival').click()
    await expect(f.guest.locator('#requestAdmission')).toBeVisible()
    await expect(f.guest.locator('#displayName')).toHaveValue('Synthetic visitor')
    await f.guest.waitForTimeout(300); expect(f.requests).toHaveLength(count)
    await requestAdmission(f.guest)
    await expect.poll(() => new Set(f.requests).size).toBe(2)
  } finally { await f.close() }
})

test('cancelling while an acknowledged grant is delayed cannot cache access or open the room', async ({ browser, baseURL }) => {
  const f = await setup(browser, baseURL!)
  try {
    f.hold(); await f.guest.goto(f.link); await f.guest.locator('#displayName').fill('Delayed guest')
    await requestAdmission(f.guest)
    const card = f.host.locator('#approvals .approvalCard.knock')
    await expect(card).toContainText('Delayed guest wants to join')
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect.poll(() => f.replies.length).toBeGreaterThan(0)
    await f.guest.locator('#cancelAdmission').click()
    await expect(f.guest.locator('#arrivalTitle')).toHaveText('Your request was cancelled')
    for (const reply of f.replies) reply()
    await f.guest.waitForTimeout(300)
    await expect(f.guest.locator('#roomArea')).toBeHidden(); await expect(f.guest.locator('#join')).toBeHidden()
    expect(await f.guest.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kithmoot.admission.v1.')))).toEqual([])
  } finally { await f.close() }
})

test('permission denial explains the local check without preventing a request', async ({ browser, baseURL }) => {
  const f = await setup(browser, baseURL!)
  try {
    await f.guest.goto(f.link)
    await expect(f.guest.locator('#requestAdmission')).toBeVisible()
    await f.guest.bringToFront()
    await f.guest.evaluate(() => {
      const audit = { calls: 0 }; Object.assign(window, { previewPermissionAudit: audit })
      // WebKit continued using its native API with an instance-only override.
      // Cover every wrapper and prove the denied fixture was actually called.
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true,
        value: async () => { audit.calls++; throw new DOMException('Synthetic permission denied', 'NotAllowedError') } })
    })
    await f.guest.locator('#previewAdmissionCamera').click()
    expect(await f.guest.evaluate(() => (window as unknown as { previewPermissionAudit: { calls: number } }).previewPermissionAudit.calls)).toBe(1)
    await expect(f.guest.locator('#admissionPreviewStatus')).toContainText('Check camera permission')
    await f.guest.locator('#previewAdmissionMic').click()
    await expect(f.guest.locator('#admissionPreviewStatus')).toContainText('Check microphone permission')
    expect(await f.guest.evaluate(() => (window as unknown as { previewPermissionAudit: { calls: number } }).previewPermissionAudit.calls)).toBe(2)
    expect(f.requests).toEqual([]); await requestAdmission(f.guest)
    await expect(f.host.locator('#approvals .approvalCard.knock')).toHaveCount(1)
  } finally { await f.close() }
})

async function syntheticDevices(page: Page, hold = false) {
  await page.addInitScript(held => {
    const state = { calls: 0, tracks: [] as MediaStreamTrack[], release: () => {}, audio: [] as AudioContext[] }
    const gate = new Promise<void>(resolve => { state.release = resolve })
    Object.assign(window, { previewTestDevices: state })
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.calls++
      const stream = new MediaStream()
      if (constraints?.video) {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240
        const context = canvas.getContext('2d')!; context.fillStyle = 'orange'; context.fillRect(0, 0, 320, 240)
        for (const track of canvas.captureStream(15).getTracks()) stream.addTrack(track)
      }
      if (constraints?.audio) {
        const audio = new AudioContext(); await audio.resume(); state.audio.push(audio)
        const tone = audio.createOscillator(), destination = audio.createMediaStreamDestination()
        tone.connect(destination); tone.start()
        for (const track of destination.stream.getTracks()) stream.addTrack(track)
      }
      state.tracks.push(...stream.getTracks())
      if (held) await gate
      return stream
    }
  }, hold)
}

for (const action of ['request', 'cancel', 'hide'] as const) test(`local device checks stop on ${action} without publishing call media`, async ({ browser, baseURL }, info) => {
  test.skip(!info.project.name.startsWith('chromium'), 'Synthetic canvas/video measurement uses Chromium; basic request journeys run in every browser')
  const f = await setup(browser, baseURL!)
  try {
    await syntheticDevices(f.guest); await f.guest.goto(f.link)
    expect(await f.guest.evaluate(() => (window as unknown as { previewTestDevices: { calls: number; tracks: MediaStreamTrack[]; release(): void } }).previewTestDevices.calls)).toBe(0)
    await f.guest.locator('#previewAdmissionCamera').click()
    await expect(f.guest.locator('#admissionPreviewVideo')).toBeVisible()
    await f.guest.locator('#previewAdmissionMic').click()
    await expect.poll(() => f.guest.locator('#admissionPreviewMeter').evaluate(meter => (meter as HTMLMeterElement).value)).toBeGreaterThan(0.05)
    expect(f.requests).toEqual([]); await expect(f.guest.locator('#roomArea')).toBeHidden()
    if (action === 'request') await requestAdmission(f.guest)
    else if (action === 'cancel') await f.guest.locator('#cancelAdmission').click()
    else await f.guest.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect.poll(() => f.guest.evaluate(() => (window as unknown as { previewTestDevices: { calls: number; tracks: MediaStreamTrack[]; release(): void } }).previewTestDevices.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true)
    await expect(f.guest.locator('#admissionPreviewVideo')).toBeHidden(); await expect(f.guest.locator('#admissionPreviewMeter')).toBeHidden()
  } finally { await f.close() }
})

for (const device of ['camera', 'microphone'] as const) test(`a ${device} permission completion after closing the invitation releases its stream`, async ({ browser, baseURL }, info) => {
  test.skip(!info.project.name.startsWith('chromium'), 'Synthetic canvas permission completion uses Chromium')
  const f = await setup(browser, baseURL!)
  try {
    await syntheticDevices(f.guest, true); await f.guest.goto(f.link)
    await f.guest.locator(device === 'camera' ? '#previewAdmissionCamera' : '#previewAdmissionMic').click()
    await expect.poll(() => f.guest.evaluate(() => (window as unknown as { previewTestDevices: { calls: number; tracks: MediaStreamTrack[]; release(): void } }).previewTestDevices.tracks.length)).toBe(1)
    await f.guest.locator('#cancelAdmission').click()
    await expect(f.guest.locator('#arrivalTitle')).toHaveText('Invitation closed')
    await f.guest.evaluate(() => (window as unknown as { previewTestDevices: { calls: number; tracks: MediaStreamTrack[]; release(): void } }).previewTestDevices.release())
    await expect.poll(() => f.guest.evaluate(() => (window as unknown as { previewTestDevices: { calls: number; tracks: MediaStreamTrack[]; release(): void } }).previewTestDevices.tracks[0].readyState)).toBe('ended')
    expect(f.requests).toEqual([]); await expect(f.guest.locator('#admissionPreviewVideo')).toBeHidden()
  } finally { await f.close() }
})
