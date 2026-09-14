import { test, expect, type Page } from '@playwright/test'
import { createRoom, newDeviceContext, open, openCall, SYNTHETIC_SCREEN_WITH_AUDIO } from './browser.js'

/**
 * A shared tab's own sound, carried alongside its picture.
 *
 * During the 13 September 2026 dogfood call, nobody could hear a screen
 * share's audio: `getDisplayMedia` only ever asked for video, so a shared
 * tab's sound was never captured, let alone advertised or sent. These specs
 * drive the fix from the far end, the same way media.spec.ts does for the
 * camera and microphone: a real synthetic audio track, captured, advertised
 * as `screen-audio`, and heard on a live `<audio>` element at the far end -
 * never just "the roster says so".
 *
 * Chromium's fake desktop capture has no sound of its own, so the presenter
 * here brings a WebAudio oscillator through `SYNTHETIC_SCREEN_WITH_AUDIO`,
 * the same trick `SYNTHETIC_MIC` uses for the microphone.
 */

async function readDiagnostics(page: Page): Promise<{ me: { publishing: string[]; screenAudio: { present: boolean; muted?: boolean; readyState?: string } } }> {
  // Cleared first, and every call in these specs re-clicks: collection is
  // async (it walks every peer connection's stats), so a read taken soon
  // after a previous one could otherwise see the still-truthy old value
  // rather than wait for the refreshed one.
  await page.evaluate(() => { (document.getElementById('diagnosticsOut') as HTMLTextAreaElement).value = '' })
  await page.evaluate(() => (document.getElementById('diagnostics') as HTMLButtonElement).click())
  const text = await expect
    .poll(async () => page.locator('#diagnosticsOut').inputValue(), { timeout: 10_000 })
    .toBeTruthy()
    .then(() => page.locator('#diagnosticsOut').inputValue())
  return JSON.parse(text)
}

test('a screen share carries its own tab audio, and losing just the sound keeps the picture', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  try {
    // The presenter's context already carries the silent SYNTHETIC_SCREEN
    // from newDeviceContext; registering the audio-bearing version after it
    // means it runs second and wins, per addInitScript's ordering.
    await a.addInitScript(SYNTHETIC_SCREEN_WITH_AUDIO)
    const presenter = await a.newPage(), viewer = await b.newPage()

    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click()
    await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(viewer, link, 'Rowan'); await viewer.locator('#join').click()
    await expect(viewer.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openCall(viewer)

    await presenter.locator('#toggleScreen').click()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')

    // Advertised, not just captured.
    await expect.poll(async () => (await readDiagnostics(presenter)).me.publishing).toContain('screen-audio')
    const withAudio = await readDiagnostics(presenter)
    expect(withAudio.me.screenAudio.present, 'the sharer does not think it has captured any sound').toBe(true)
    expect(withAudio.me.screenAudio.readyState).toBe('live')

    // No note when there is sound to share.
    await expect(presenter.locator('#screenAudioNote')).toBeHidden()

    // The viewer gets a live audio element, unmuted, actually carrying sound.
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60_000 })
    const remoteAudio = viewer.locator('#room .participant:not(:has-text("(you)")) audio')
    await expect(remoteAudio).toHaveCount(1, { timeout: 60_000 })
    await expect.poll(() => remoteAudio.evaluate((el) => (el as HTMLAudioElement).muted)).toBe(false)
    await expect
      .poll(() => remoteAudio.evaluate((el) => {
        const track = (el as HTMLAudioElement).srcObject instanceof MediaStream
          ? ((el as HTMLAudioElement).srcObject as MediaStream).getAudioTracks()[0]
          : undefined
        return track?.readyState
      }))
      .toBe('live')

    // The browser ends the shared tab's sound on its own - a tab switch, on
    // a browser that ties system audio to a shared tab having focus - while
    // the picture keeps going. `MediaStreamTrack.stop()` never fires `ended`
    // (confirmed against this Chromium: readyState moves to "ended" but the
    // event does not fire), which is exactly why `screenTrack`'s own `ended`
    // listener exists for the browser's "Stop sharing" button rather than
    // our own toggle calling it directly - and a synthetic WebAudio track's
    // source cannot be made to end itself the way a real capture's can. So
    // this fires the one event the app's listener actually reacts to, on
    // the exact track object it is sending - found via the sender it was
    // handed to - which is what real display-audio ending looks like from
    // the app's side regardless of why the browser decided to end it.
    await presenter.evaluate(() => {
      const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? []
      for (const pc of pcs) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio' && s.track.readyState === 'live')
        if (sender?.track) { sender.track.dispatchEvent(new Event('ended')); return }
      }
      throw new Error('no live outbound audio sender found')
    })

    await expect.poll(async () => (await readDiagnostics(presenter)).me.publishing).not.toContain('screen-audio')
    const afterAudioEnded = await readDiagnostics(presenter)
    expect(afterAudioEnded.me.publishing, 'the picture must survive its sound ending on its own').toContain('screen')
    expect(afterAudioEnded.me.screenAudio.present).toBe(false)
    // The note appears once the share is left with no sound.
    await expect(presenter.locator('#screenAudioNote')).toBeVisible()
    // The viewer's picture is untouched; only the sound goes quiet.
    await expect(expand).toBeVisible()
    await expect(remoteAudio).toHaveCount(0, { timeout: 10_000 })

    // Stopping the share removes the picture's advert too, and the viewer's
    // Expand control goes with it.
    await presenter.locator('#toggleScreen').click()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'false')
    await expect(presenter.locator('#screenAudioNote')).toBeHidden()
    const stopped = await readDiagnostics(presenter)
    expect(stopped.me.publishing).not.toContain('screen')
    expect(stopped.me.publishing).not.toContain('screen-audio')
    await expect(expand).toBeHidden({ timeout: 10_000 })
  } finally {
    await a.close(); await b.close()
  }
})

test('a screen share with no captured audio still shares video, with a note by the toggle', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  // newDeviceContext already installs the silent SYNTHETIC_SCREEN - the
  // ordinary case for Firefox, Safari, a window share, or an unticked box.
  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  try {
    const presenter = await a.newPage(), viewer = await b.newPage()
    const link = await createRoom(presenter, baseURL!)
    await open(presenter, link, 'Ada'); await presenter.locator('#join').click()
    await expect(presenter.locator('#roomArea')).toBeVisible()
    await open(viewer, link, 'Rowan'); await viewer.locator('#join').click()
    await expect(viewer.locator('#roomArea')).toBeVisible()
    await openCall(presenter); await openCall(viewer)

    await presenter.locator('#toggleScreen').click()
    await expect(presenter.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')

    await expect(presenter.locator('#screenAudioNote')).toBeVisible()
    await expect(presenter.locator('#screenAudioNote')).toHaveText(
      'No sound is shared. To share sound, share a browser tab and tick Share tab audio.',
    )

    const noAudio = await readDiagnostics(presenter)
    expect(noAudio.me.publishing).toContain('screen')
    expect(noAudio.me.publishing).not.toContain('screen-audio')
    expect(noAudio.me.screenAudio.present).toBe(false)

    // The share still works: the viewer gets the picture regardless.
    const expand = viewer.getByRole('button', { name: 'Expand screen share from Ada' })
    await expect(expand).toBeVisible({ timeout: 60_000 })
    await expect(viewer.locator('#room .participant:not(:has-text("(you)")) audio')).toHaveCount(0)

    await presenter.locator('#toggleScreen').click()
    await expect(presenter.locator('#screenAudioNote')).toBeHidden()
  } finally {
    await a.close(); await b.close()
  }
})
