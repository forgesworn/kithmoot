import { test, expect, type Page } from '@playwright/test'
import { createRoom, INSTRUMENT, joinWithMedia, newDeviceContext, open, openCall, remotePictures } from './browser.js'

/**
 * Meeting mode and recording, from both sides of the call.
 *
 * Meeting mode is only worth anything if it holds against an app that
 * ignores it, so the first spec has the attendee's page do exactly that:
 * once its own app has locked the camera and microphone, it pushes a fresh
 * camera and microphone into its senders by hand. The packets reach the
 * host - the spec checks they do - and the host's app still shows and plays
 * nothing from them, because it gates on the signed speaker list, not on the
 * sender's good manners.
 */

/** What this page receives from the far end, in bytes, summed. Counted at
 *  the RTP layer, before anything the app decides to show or play. */
const bytesIn = async () => {
  const win = window as unknown as { __pcs: RTCPeerConnection[] }
  let audio = 0
  let video = 0
  for (const pc of win.__pcs ?? []) {
    let report: RTCStatsReport
    try { report = await pc.getStats() } catch { continue }
    report.forEach((r) => {
      if (r.type !== 'inbound-rtp') return
      if (r.kind === 'video') video += r.bytesReceived ?? 0
      else audio += r.bytesReceived ?? 0
    })
  }
  return { audio, video }
}

/** The hostile half: send a camera and a microphone the app has turned off,
 *  straight into every sender, and open any transceiver the app closed. */
const sendAnyway = async () => {
  const win = window as unknown as { __pcs: RTCPeerConnection[] }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  const audio = stream.getAudioTracks()[0]!
  const video = stream.getVideoTracks()[0]!
  let senders = 0
  for (const pc of win.__pcs ?? []) {
    if (pc.connectionState === 'closed') continue
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track.kind
      if (t.sender.track) continue
      await t.sender.replaceTrack(kind === 'video' ? video : audio).catch(() => {})
      if (t.direction === 'recvonly') t.direction = 'sendrecv'
      if (t.direction === 'inactive') t.direction = 'sendonly'
      senders++
    }
  }
  return senders
}

/** Whether every remote `<audio>` on this page under `name`'s tile is muted. */
const audioFrom = (name: string) => {
  const tile = Array.from(document.querySelectorAll('#room .participant')).find(t => (t.textContent ?? '').includes(name))
  return Array.from(tile?.querySelectorAll('audio') ?? []).map(el => ({ muted: (el as HTMLAudioElement).muted, wired: (el as HTMLAudioElement).srcObject !== null }))
}

async function openMeetingPanel(page: Page): Promise<void> {
  await openCall(page)
  // Behind More, beside the call's other less-used controls.
  const more = page.locator('#callExtras')
  if (!await more.evaluate(el => (el as HTMLDetailsElement).open)) await more.locator('> summary').click()
  const panel = page.locator('#meetingPanel')
  await expect(panel, 'the room\'s creator is offered meeting mode').toBeVisible()
  if (!await panel.evaluate(el => (el as HTMLDetailsElement).open)) await panel.locator('summary').click()
}

test('meeting mode locks an attendee, and holds when the attendee\'s app ignores it', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const aContext = await newDeviceContext(browser, baseURL!)
  const bContext = await newDeviceContext(browser, baseURL!)
  try {
    const a = await aContext.newPage()
    const b = await bContext.newPage()
    await a.addInitScript(INSTRUMENT)
    await b.addInitScript(INSTRUMENT)

    const url = await createRoom(a, baseURL!)
    await joinWithMedia(a, url, 'Ada')
    await joinWithMedia(b, url, 'Bob')
    await expect.poll(async () => (await a.evaluate(remotePictures)).length, { message: 'Ada should see Bob before meeting mode', timeout: 90_000 }).toBeGreaterThan(0)

    // Bob is not the room's creator, so he is not offered the controls.
    await expect(b.locator('#meetingPanel')).toBeHidden()

    await openMeetingPanel(a)
    await a.locator('#meetingModeToggle').click()
    await expect(a.locator('#meetingModeToggle')).toHaveText('End meeting mode')

    // Bob's own app turns everything off and locks it, and says why.
    await expect(b.locator('#meetingNotice')).toBeVisible()
    await expect(b.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')
    await expect(b.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await expect(b.locator('#toggleMic')).toHaveClass(/meetingLocked/)
    // Pressable, so it can say why; Playwright treats `aria-disabled` as
    // disabled, so the press is forced.
    await b.locator('#toggleMic').click({ force: true })
    await expect(b.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    // Ada, on the stage, keeps hers.
    await expect(a.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(a.locator('#toggleMic')).not.toHaveClass(/meetingLocked/)

    // Now Bob's page sends anyway.
    const before = await a.evaluate(bytesIn)
    expect(await b.evaluate(sendAnyway), 'the hostile page found senders to use').toBeGreaterThan(0)
    await expect.poll(async () => (await a.evaluate(bytesIn)).video - before.video, {
      message: 'the hostile page\'s video should actually be arriving at Ada - otherwise this proves nothing',
      timeout: 60_000,
    }).toBeGreaterThan(50_000)

    // Arriving, and still neither seen nor heard.
    await a.waitForTimeout(3_000)
    expect(await a.evaluate(remotePictures), 'Ada is shown a picture from somebody who is not a speaker').toHaveLength(0)
    for (const el of await a.evaluate(audioFrom, 'Bob')) expect(el.muted, 'Ada is played sound from somebody who is not a speaker').toBe(true)

    // Bob raises his hand; Ada sees it.
    await b.locator('#raiseHand').click()
    await expect(b.locator('#raiseHand')).toHaveText('Lower your hand')
    await expect(a.locator('#meetingPeople .handRaised')).toBeVisible()

    // Ada makes him a speaker: his hand goes down, his controls unlock, and
    // what he sends is shown again.
    await a.locator('#meetingPeople button', { hasText: 'Make speaker' }).click()
    await expect(b.locator('#toggleMic')).not.toHaveClass(/meetingLocked/)
    await expect(b.locator('#raiseHand')).toBeHidden()
    await expect(a.locator('#meetingPeople .handRaised')).toHaveCount(0)
    await b.locator('#toggleCamera').click()
    await expect(b.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect.poll(async () => (await a.evaluate(remotePictures)).length, { message: 'a speaker is seen again', timeout: 60_000 }).toBeGreaterThan(0)
  } finally {
    await aContext.close()
    await bContext.close()
  }
})

test('a recording is announced to everybody, before joining as well as during, and stays on the recorder\'s device', async ({ browser, baseURL }, info) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const aContext = await newDeviceContext(browser, baseURL!)
  const bContext = await newDeviceContext(browser, baseURL!)
  const cContext = await newDeviceContext(browser, baseURL!)
  try {
    // Measure the browser recorder's actual capture intervals. The displayed
    // clock rounds down and refreshes once a second; reading it before a
    // delayed Stop click is not the duration of the exported file.
    await aContext.addInitScript(() => {
      const calls: Array<{ method: string; at: number }> = []
      Object.assign(window, { testRecordingCalls: calls })
      for (const method of ['start', 'pause', 'resume', 'stop'] as const) {
        const original = MediaRecorder.prototype[method]
        MediaRecorder.prototype[method] = function (...args: unknown[]) {
          Reflect.apply(original, this, args)
          calls.push({ method, at: performance.now() })
        }
      }
    })
    const a = await aContext.newPage()
    const b = await bContext.newPage()
    const c = await cContext.newPage()

    const url = await createRoom(a, baseURL!)
    await joinWithMedia(a, url, 'Ada')
    await joinWithMedia(b, url, 'Bob')
    await expect(a.locator('#room .participant')).toHaveCount(2, { timeout: 60_000 })

    await openCall(a)
    await expect(a.locator('#recordToggle')).toBeInViewport()
    await expect(a.locator('#callExtras')).not.toHaveAttribute('open', '')
    await expect(b.locator('#recordToggle')).toBeVisible()
    await expect(b.locator('#recordToggle')).toBeDisabled()
    await expect(b.locator('#recordingAuthorityHint')).toBeVisible()
    await a.locator('#recordToggle').click()
    await expect(a.locator('#actionDialog')).toBeVisible()
    await a.locator('#actionConfirm').click()
    await expect(a.locator('#recordToggle')).toHaveText('Stop recording')
    await expect(a.locator('#recordingBanner')).toBeVisible()
    await expect(a.locator('#recordingBannerText')).toContainText('You are recording')

    // Somebody already on the call is told.
    await expect(b.locator('#recordingBanner')).toBeVisible()
    await expect(b.locator('#recordingBannerText')).toContainText('being recorded')
    await expect(b.locator('#recordingBannerText')).toContainText('Ada')
    await expect(b.locator('#recordingBannerText')).toContainText('capturing call audio')

    const elapsedSeconds = async () => {
      const text = await a.locator('#recordingElapsed').textContent()
      const [minutes, seconds] = text!.split(' ')[0]!.split(':').map(Number)
      return minutes! * 60 + seconds!
    }
    await expect.poll(elapsedSeconds).toBeGreaterThanOrEqual(2)
    await a.locator('#recordingPause').click()
    await expect(a.locator('#recordingPause')).toHaveText('Resume recording')
    await expect(a.locator('#recordingBannerText')).toContainText('paused')
    const heldTime = await elapsedSeconds()
    // Privacy remains explicit while paused: existing members and late
    // joiners still see the signed notice, and cannot pause somebody else.
    await expect(b.locator('#recordingPause')).toBeHidden()
    await expect(b.locator('#recordingBanner')).toBeVisible()

    // Somebody arriving is told in the room, and asked before the call.
    await open(c, url, 'Cy')
    await c.locator('#join').click()
    await expect(c.locator('#roomArea')).toBeVisible()
    await expect(c.locator('#recordingBanner')).toBeVisible({ timeout: 30_000 })
    await expect(c.locator('#joinCall')).toBeVisible({ timeout: 60_000 })
    await c.locator('#joinCall').click()
    await expect(c.locator('#actionDialog')).toBeVisible()
    await expect(c.locator('#actionTitle')).toHaveText('This call is being recorded')
    await expect(c.locator('#actionDescription')).toContainText('capturing call audio')
    await c.locator('#actionCancel').click()
    await expect(c.locator('#actionDialog')).toBeHidden()
    await a.waitForTimeout(1200)
    expect(await elapsedSeconds()).toBe(heldTime)
    await a.locator('#recordingPause').click()
    await expect(a.locator('#recordingPause')).toHaveText('Pause recording')
    await expect.poll(elapsedSeconds).toBeGreaterThanOrEqual(heldTime + 2)

    // Stopped: the notice comes down everywhere, and the file waits on
    // Ada's device for her to decide.
    // From the notice itself, where the recorder always sees it.
    await a.locator('#recordingStop').click()
    await expect(a.locator('#recordingReady')).toBeVisible({ timeout: 30_000 })
    await expect(a.locator('#recordingBanner')).toBeHidden()
    await expect(b.locator('#recordingBanner')).toBeHidden({ timeout: 30_000 })
    await expect(a.locator('#recordingSave')).toHaveAttribute('download', /^call-recording-.*\.(webm|ogg|m4a)$/)
    // Decode the actual exported bytes. A paused interval must be omitted
    // from the audio timeline rather than becoming an unexplained silent gap.
    const duration = await a.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
      const bytes = await (await fetch(link.href)).arrayBuffer()
      const context = new AudioContext()
      try { return (await context.decodeAudioData(bytes)).duration }
      finally { await context.close() }
    })
    const calls = await a.evaluate(() => (window as unknown as {
      testRecordingCalls: Array<{ method: string; at: number }>
    }).testRecordingCalls)
    expect(calls.map(call => call.method)).toEqual(['start', 'pause', 'resume', 'stop'])
    const recordedSeconds = ((calls[1]!.at - calls[0]!.at) + (calls[3]!.at - calls[2]!.at)) / 1000
    await info.attach('recording-timeline', { contentType: 'application/json', body: JSON.stringify({
      recordedSeconds, decodedSeconds: duration, pausedSeconds: (calls[2]!.at - calls[1]!.at) / 1000,
    }) })
    expect(duration).toBeGreaterThan(recordedSeconds - 1)
    expect(duration).toBeLessThan(recordedSeconds + 1)
  } finally {
    await aContext.close()
    await bContext.close()
    await cContext.close()
  }
})
