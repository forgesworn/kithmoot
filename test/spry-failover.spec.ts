import { test, expect, type Page } from '@playwright/test'
import type { CallRelay, CallRelayLogin } from '../app/src/call-relay.js'
import { syntheticSource } from './browser-protected-share-fixture.js'
import { chooseCallMore, closeSettings, createRoom, joinWithMedia, newDeviceContext, openCallSettings, SYNTHETIC_MIC } from './browser.js'

const api = 'http://127.0.0.1:' + (process.env.E2E_SPRY_FAILOVER_PORT ?? 7797)
type Profile = CallRelay & { standby: CallRelayLogin }
type FixtureStats = { binarySha256: string; connections: [number, number] }

async function fixture<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(api + path, { method })
  expect(response.ok, 'local Spry fixture ' + path).toBe(true)
  return response.json() as Promise<T>
}

async function saveApprovedRelays(page: Page, profile: Profile): Promise<void> {
  await openCallSettings(page, 'Relay server')
  await page.getByLabel('Connection file', { exact: true }).setInputFiles({
    name: 'synthetic-spry-relays.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(profile)),
  })
  await expect(page.locator('#callRelayStatus')).toContainText('File imported')
  await expect(page.getByLabel('Addresses', { exact: true })).toHaveValue(profile.urls.join(', '))
  await expect(page.getByLabel('Standby addresses', { exact: true })).toHaveValue(profile.standby.urls.join(', '))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('#callRelayStatus')).toContainText('Saved.')
  await closeSettings(page)
}

async function selectedMedia(page: Page, login: CallRelayLogin) {
  return page.evaluate(async expected => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
    for (let index = pcs.length - 1; index >= 0; index--) {
      const pc = pcs[index]
      if (pc.connectionState !== 'connected') continue
      const config = pc.getConfiguration()
      const [server, extra] = config.iceServers ?? []
      if (config.iceTransportPolicy !== 'relay' || !server || extra ||
          [server.urls].flat().join(',') !== expected.urls.join(',') ||
          server.username !== expected.username || server.credential !== expected.credential) continue
      const stats = await pc.getStats()
      const transport = [...stats.values()].find(stat => stat.type === 'transport' && stat.selectedCandidatePairId)
      const pair = transport && stats.get(transport.selectedCandidatePairId)
      if (pair?.state !== 'succeeded' || !pair.nominated) continue
      const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId)
      if (local?.candidateType !== 'relay' || remote?.candidateType !== 'relay' ||
          local.relayProtocol !== 'tls' || !expected.urls.includes(local.url)) continue
      let frames = 0, audioEnergy = 0
      const streams: string[] = []
      for (const stat of stats.values()) {
        if (stat.type !== 'inbound-rtp') continue
        streams.push(stat.id)
        if (stat.kind === 'video') frames += stat.framesDecoded ?? 0
        if (stat.kind === 'audio') audioEnergy += stat.totalAudioEnergy ?? 0
      }
      return { allocation: local.url + '/' + local.address + ':' + local.port, epoch: index + '/' + streams.sort().join('/'), frames, audioEnergy }
    }
    return undefined
  }, login)
}

async function waitForMedia(page: Page, login: CallRelayLogin, since: number, audio: boolean) {
  let baseline: Awaited<ReturnType<typeof selectedMedia>>
  let allocation = ''
  let videoMs: number | undefined
  let audioMs: number | undefined
  await expect.poll(async () => {
    const sample = await selectedMedia(page, login)
    if (!sample) return false
    if (!baseline || sample.epoch !== baseline.epoch || sample.allocation !== baseline.allocation) {
      baseline = sample
      allocation = sample.allocation
      videoMs = undefined
      audioMs = undefined
      return false
    }
    if (videoMs === undefined && sample.frames > baseline.frames + 2) videoMs = Math.ceil(performance.now() - since)
    if (audio && audioMs === undefined && sample.audioEnergy > baseline.audioEnergy) audioMs = Math.ceil(performance.now() - since)
    return videoMs !== undefined && (!audio || audioMs !== undefined)
  }, { timeout: 50_000, intervals: [100, 200, 300], message: 'selected approved TLS allocation with fresh decoded media' }).toBe(true)
  return { allocation, videoMs, audioMs }
}

async function chat(sender: Page, receiver: Page, message: string): Promise<void> {
  await sender.locator('#chatInput').fill(message)
  await sender.locator('#chatInput').press('Enter')
  await expect(receiver.locator('#chatLog')).toContainText(message)
}

async function startProtectedShare(sender: Page): Promise<void> {
  const pending = sender.waitForEvent('popup')
  await chooseCallMore(sender, 'Share with redaction')
  const popup = await pending
  await syntheticSource(popup)
  // This check isolates microphone mute from the separate share-audio control.
  await popup.evaluate(() => {
    const { raw } = window as unknown as { raw: MediaStream }
    for (const track of raw.getAudioTracks()) raw.removeTrack(track)
  })
  await popup.getByRole('button', { name: 'Choose a window or tab' }).click()
  await popup.getByRole('button', { name: 'Hide a region', exact: true }).click()
  await popup.getByRole('button', { name: 'Start protected sharing' }).click()
  await expect(sender.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
}

async function expectProtectedShare(receiver: Page): Promise<void> {
  const remote = receiver.locator('video.screenPreview').first()
  await expect(remote).toBeVisible()
  const before = await remote.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)
  await expect.poll(() => remote.evaluate((video: HTMLVideoElement, before) => {
    if (!video.videoWidth || video.getVideoPlaybackQuality().totalVideoFrames <= before + 2) return false
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18
    const context = canvas.getContext('2d')!
    context.drawImage(video, 0, 0, 32, 18)
    return context.getImageData(2, 2, 1, 1).data[1] > 130 && context.getImageData(16, 9, 1, 1).data[0] < 80
  }, before), { message: 'fresh remote share frames must show permitted green pixels and keep the red marker masked' }).toBe(true)
}

for (const fault of ['stop', 'blackhole'] as const) {
  test('same-room relay-only call recovers through an approved Spry standby after ' + fault, async ({ browser, baseURL }) => {
    await fixture('/reset', 'POST')
    const profiles = await Promise.all([0, 1].map(index => fixture<Profile>('/login/' + index)))
    const logins = profiles.flatMap(({ username, standby }) => [username, standby.username])
    expect(new Set(logins).size).toBe(4)
    const contexts = await Promise.all(profiles.map(() => newDeviceContext(browser, baseURL!, { serviceWorkers: 'block' })))
    const denied = new Set<string>()
    try {
      for (const context of contexts) {
        await context.route('**/*', route => {
          const url = new URL(route.request().url())
          if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
            denied.add(url.origin)
            return route.abort('blockedbyclient')
          }
          return route.continue()
        })
        await context.routeWebSocket(/.*/, socket => {
          const url = new URL(socket.url())
          if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) socket.connectToServer()
          else { denied.add(url.origin); socket.close() }
        })
        await context.addInitScript(SYNTHETIC_MIC)
        await context.addInitScript(() => {
          localStorage.setItem('kithmoot.hide-ip.v1', '1')
          localStorage.setItem('kithmoot.profiles.enabled', 'false')
        })
      }
      const [ada, rowan] = await Promise.all(contexts.map(context => context.newPage()))
      const pages = [ada, rowan]
      await Promise.all(pages.map(page => page.goto(baseURL!)))
      await Promise.all(pages.map((page, index) => saveApprovedRelays(page, profiles[index])))
      expect((await fixture<FixtureStats>('/stats')).connections).toEqual([0, 0])
      const link = await createRoom(ada, baseURL!)
      await joinWithMedia(ada, link, 'Ada')
      await joinWithMedia(rowan, link, 'Rowan')
      const primary = await Promise.all(pages.map((page, index) => waitForMedia(page, profiles[index], performance.now(), true)))
      const pageStarts = await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)))
      const roomLinks = await Promise.all(pages.map(page => page.locator('#shareUrl').inputValue()))
      for (const roomLink of roomLinks) {
        const payload = Buffer.from(roomLink.split('#')[1], 'base64url').toString()
        for (const { urls, credential } of profiles.flatMap(profile => [profile, profile.standby])) {
          expect(payload.includes(credential) || payload.includes(urls[0]), 'room link contains a device relay login').toBe(false)
        }
      }
      await startProtectedShare(ada)
      await expectProtectedShare(rowan)
      const muted = fault === 'blackhole'
      if (muted) {
        await ada.locator('#toggleMic').click()
        await expect(ada.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
      }
      expect((await fixture<FixtureStats>('/stats')).connections[1]).toBe(0)

      const failedAt = performance.now()
      await fixture('/' + fault, 'POST')
      const recovered = Promise.all(pages.map((page, index) => waitForMedia(page, profiles[index].standby, failedAt, !muted || index === 0)))
      const chatDuringOutage = chat(ada, rowan, 'Chat continues during a Spry outage')
      const [standby] = await Promise.all([recovered, chatDuringOutage])
      for (const [index, result] of standby.entries()) expect(result.allocation).not.toBe(primary[index].allocation)
      const stats = await fixture<FixtureStats>('/stats')
      expect(stats.connections[1]).toBeGreaterThanOrEqual(2)
      await expectProtectedShare(rowan)
      let unmuteAudioMs: number | undefined
      if (muted) {
        await expect(ada.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
        expect(await ada.evaluate(() =>
          (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
            .filter(pc => pc.connectionState === 'connected')
            .every(pc => pc.getSenders().every(({ track }) => track?.kind !== 'audio' || !track.enabled)),
        )).toBe(true)
        const silence = await selectedMedia(rowan, profiles[1].standby)
        await waitForMedia(rowan, profiles[1].standby, failedAt, false)
        const after = await selectedMedia(rowan, profiles[1].standby)
        expect(after!.audioEnergy).toBe(silence!.audioEnergy)
        const unmutedAt = performance.now()
        await ada.locator('#toggleMic').click()
        await expect(ada.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
        unmuteAudioMs = (await waitForMedia(rowan, profiles[1].standby, unmutedAt, true)).audioMs
      }
      await chat(rowan, ada, 'Same room after automatic recovery')
      for (const [index, page] of pages.entries()) {
        await expect(page.locator('#roomArea')).toBeVisible()
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageStarts[index])
        expect(await page.locator('#shareUrl').inputValue()).toBe(roomLinks[index])
        const profile = profiles[index]
        expect(await page.evaluate(approved =>
          (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.every(pc => {
            const config = pc.getConfiguration()
            const [server, extra] = config.iceServers ?? []
            return config.iceTransportPolicy === 'relay' && !!server && !extra && approved.some(login =>
              [server.urls].flat().join(',') === login.urls.join(',') &&
              server.username === login.username && server.credential === login.credential)
          }), [profile, profile.standby])).toBe(true)
      }
      expect([...denied]).toEqual([])
      const recovery = standby.map(({ audioMs, videoMs }) => ({ audioMs, videoMs }))
      const evidence = { fault, spryBinarySha256: stats.binarySha256, recovery, muteDuringOutage: muted, unmuteAudioMs }
      await test.info().attach('spry-failover', { contentType: 'application/json', body: JSON.stringify(evidence) })
      console.log('Local Spry failover', JSON.stringify(evidence))
    } finally {
      await Promise.all(contexts.map(context => context.close()))
    }
  })
}
