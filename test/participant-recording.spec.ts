import { test, expect, type Page } from '@playwright/test'
import { encodeRoomLink } from '../src/link.js'
import { generateRoomSecret } from '../src/room.js'
import { newDeviceContext, open, openCall, openRoomDetails, turnOnMedia, leaveToChats } from './browser.js'
import { testRelaysFor } from './relays.js'

test.use({ trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true } })

for (const privateChat of [false, true]) {
  test(`either person can record independently in ${privateChat ? 'a private one-to-one chat' : 'a room without a creator key'}`, async ({ browser, baseURL }, info) => {
    test.skip(!['chromium', 'chromium-desktop'].includes(info.project.name), 'Synthetic capture needs Chromium')
    const contexts = await Promise.all([0, 1].map(() => newDeviceContext(browser, baseURL!,
      privateChat ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } })))
    try {
      const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
      const url = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] })
      for (const [page, name] of [[a!, 'Ada'], [b!, 'Bob']] as const) {
        await open(page, url, name); await page.locator('#join').click()
        await expect(page.locator('#roomArea')).toBeVisible()
      }
      if (privateChat) {
        await openRoomDetails(b!)
        await b!.getByRole('button', { name: /^Message Ada privately/ }).click()
        await expect(a!.locator('#chatLog')).toContainText('started a private conversation with you')
        await b!.getByRole('button', { name: /^Message Ada privately/ }).click()
        await expect(b!.locator('#roomTitle')).toHaveText('Ada')
        await a!.locator('#chatLog .system').getByRole('button', { name: 'Open Bob' }).click()
        await expect(a!.locator('#roomTitle')).toHaveText('Bob')
      }
      await turnOnMedia(a!)
      await expect(b!.locator('#callToggle')).toHaveText('Join call')
      await turnOnMedia(b!)
      const record = async (page: Page) => {
        await openCall(page)
        await expect(page.locator('#recordToggle')).toBeEnabled()
        await expect(page.locator('#recordingAuthorityHint')).toBeHidden()
        await page.locator('#recordToggle').click()
        await page.locator('input[name="recording-layout"][value="audio"]').check()
        await page.locator('#actionConfirm').click()
        await expect(page.locator('#recordingBannerText')).toContainText('You are recording')
      }
      await record(a!)
      await expect(b!.locator('#recordingBannerText')).toContainText('Ada')
      await record(b!)
      await expect(a!.locator('#recordToggle')).toHaveAttribute('aria-label', 'Stop recording')
      await expect(b!.locator('#recordToggle')).toHaveAttribute('aria-label', 'Stop recording')
      await a!.waitForTimeout(1600)
      await a!.locator('#recordingStop').click()
      await expect(a!.locator('#recordingReady')).toBeVisible()
      await expect(a!.locator('#recordingBannerText')).toContainText('Bob')
      await expect(b!.locator('#recordingBannerText')).toContainText('You are recording')
      await b!.locator('#recordingStop').click()
      await expect(b!.locator('#recordingReady')).toBeVisible()
      for (const page of [a!, b!]) {
        await expect(page.locator('#recordingBanner')).toBeHidden()
        // Decode saved bytes from both devices: an enabled button and notice
        // alone do not prove either participant captured the call.
        const duration = await page.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
          const bytes = await (await fetch(link.href)).arrayBuffer(), context = new AudioContext()
          try { return (await context.decodeAudioData(bytes)).duration }
          finally { await context.close() }
        })
        expect(duration).toBeGreaterThan(0.5)
      }
    } finally { await Promise.all(contexts.map(context => context.close())) }
  })
}

for (const phone of [false, true]) {
  for (const leave of [false, true]) {
    test(`a delayed recording stop receipt cannot hold ${leave ? 'call shutdown' : 'the saved clip'} (${phone ? 'touch phone' : 'desktop'})`, async ({ browser, baseURL }, info) => {
      test.skip(!['chromium', 'chromium-desktop'].includes(info.project.name), 'Synthetic capture needs Chromium')
      const context = await newDeviceContext(browser, baseURL!, phone
        ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } }
        : { viewport: { width: 1440, height: 900 } })
      let holdReceipts = false
      const held: Array<() => void> = []
      for (const relay of testRelaysFor(baseURL!) ?? []) {
        await context.routeWebSocket(relay, ws => {
          const upstream = ws.connectToServer()
          ws.onMessage(raw => upstream.send(raw))
          upstream.onMessage(raw => {
            if (holdReceipts && JSON.parse(String(raw))[0] === 'OK') held.push(() => ws.send(raw))
            else ws.send(raw)
          })
        })
      }
      await context.addInitScript(() => {
        const tracks: MediaStreamTrack[] = []
        ;(window as unknown as { __capturedTracks: MediaStreamTrack[] }).__capturedTracks = tracks
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async constraints => {
          const stream = await original(constraints)
          tracks.push(...stream.getTracks())
          return stream
        }
      })
      try {
        const page = await context.newPage()
        const url = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Receipt test', relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] })
        await open(page, url, 'Ada'); await page.locator('#join').click()
        await expect(page.locator('#roomArea')).toBeVisible()
        await turnOnMedia(page)
        await page.locator('#recordToggle').click()
        await page.locator('input[name="recording-layout"][value="audio"]').check()
        await page.locator('#actionConfirm').click()
        await expect(page.locator('#recordingBannerText')).toContainText('You are recording')
        await page.waitForTimeout(1600)
        if (leave) {
          await leaveToChats(page)
          await expect(page.locator('#callDock')).toBeVisible()
        }
        holdReceipts = true
        await page.locator(leave ? '#callDockLeave' : '#recordingStop').click()
        await expect.poll(() => held.length).toBeGreaterThan(0)
        if (leave) {
          await expect(page.locator('#callDock')).toBeHidden({ timeout: 2000 })
          await expect.poll(() => page.evaluate(() => {
            const tracks = (window as unknown as { __capturedTracks: MediaStreamTrack[] }).__capturedTracks
            return tracks.length >= 2 && tracks.every(track => track.readyState === 'ended')
          }), { timeout: 2000 }).toBe(true)
        }
        // Read the actual local file while the relay's receipt is still held.
        await expect(page.locator('#recordingSave')).toHaveAttribute('href', /^blob:/, { timeout: 2000 })
        const duration = await page.locator('#recordingSave').evaluate(async (link: HTMLAnchorElement) => {
          const bytes = await (await fetch(link.href)).arrayBuffer(), audio = new AudioContext()
          try { return (await audio.decodeAudioData(bytes)).duration }
          finally { await audio.close() }
        })
        expect(duration).toBeGreaterThan(0.5)
      } finally {
        holdReceipts = false
        for (const send of held) send()
        await context.close()
      }
    })
  }
}
