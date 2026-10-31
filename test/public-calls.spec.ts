import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join as fileJoin } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { chooseCallMore, closeSettings, createRoom, joinWithMedia, newDeviceContext, openCallSettings, openSettings, SYNTHETIC_MIC } from './browser.js'
import { parseCallRelayProfile } from '../app/src/call-relay-profile.js'
import type { CallRelay } from '../app/src/call-relay.js'
import { syntheticSource } from './browser-protected-share-fixture.js'
import { automaticCallState, observeAutomaticCallErrors } from './automatic-call-state.js'

type Transport = 'udp' | 'tcp' | 'tls'
function account(transport: Transport, participant: number): CallRelay {
  const directory = process.env.E2E_PUBLIC_CALL_PROFILES!
  if (!isAbsolute(directory) || (statSync(directory).mode & 0o077)) throw new Error('Profiles require an absolute private directory')
  const path = fileJoin(directory, `${transport}-${participant}.json`)
  if ((statSync(path).mode & 0o077) || statSync(path).size > 16384) throw new Error('Invalid private profile file')
  const relay = parseCallRelayProfile(readFileSync(path, 'utf8'))
  relay.urls = relay.urls.filter(url => transport === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') && url.endsWith(`?transport=${transport}`))
  if (relay.urls.length !== 1) throw new Error('Each live profile must supply exactly one URL for this transport')
  return relay
}

async function configure(page: Page, relay: CallRelay, check = false) {
  await openCallSettings(page, 'Relay server')
  await page.getByLabel('Connection file', { exact: true }).setInputFiles({
    name: 'private-operator-profile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(relay)),
  })
  await expect(page.locator('#callRelayStatus')).toContainText('File imported')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('#callRelayStatus')).toContainText('Saved. Leave and reopen a room to use it.')
  if (check) {
    await page.locator('#callRelayCheck').click()
    await expect(page.locator('#callRelayStatus')).toContainText('Test data passed', { timeout: 20_000 })
  }
  await closeSettings(page)
}

async function sample(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __pcs: RTCPeerConnection[];
      __publicCallAudio?: { context: AudioContext; analysers: Map<string, AnalyserNode> };
    }
    if (!w.__publicCallAudio) w.__publicCallAudio = { context: new AudioContext(), analysers: new Map() }
    const audio = w.__publicCallAudio
    if (audio.context.state === 'suspended') await audio.context.resume()
    const rows = []
    for (const [peer, pc] of w.__pcs.entries()) {
      if (pc.connectionState !== 'connected') continue
      let rms = 0
      for (const receiver of pc.getReceivers()) {
        const track = receiver.track
        if (track.kind !== 'audio' || track.readyState !== 'live') continue
        let analyser = audio.analysers.get(track.id)
        if (!analyser) {
          analyser = audio.context.createAnalyser()
          const input = audio.context.createMediaStreamSource(new MediaStream([track]))
          const silent = audio.context.createGain(); silent.gain.value = 0
          input.connect(analyser); analyser.connect(silent); silent.connect(audio.context.destination)
          audio.analysers.set(track.id, analyser)
        }
        const pcm = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(pcm)
        rms = Math.max(rms, Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length))
      }
      const report = await pc.getStats(), stats = [...report.values()]
      const pair = stats.find(stat => stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded')
      if (!pair) continue
      const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId)
      const video = stats.filter(stat => stat.type === 'inbound-rtp' && stat.kind === 'video')
      const sound = stats.filter(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio')
      const tracks = pc.getReceivers().map(receiver => receiver.track)
      const audioSinkTime = Math.max(0, ...[...document.querySelectorAll<HTMLAudioElement>('#room audio')]
        .filter(element => !element.paused && !element.muted && element.volume > 0 && element.srcObject instanceof MediaStream &&
          element.srcObject.getTracks().some(track => tracks.includes(track))).map(element => element.currentTime))
      const sinkTime = Math.max(0, ...[...document.querySelectorAll<HTMLVideoElement>('#room video')]
        .filter(element => !element.paused && element.checkVisibility() && element.srcObject instanceof MediaStream &&
          element.srcObject.getTracks().some(track => tracks.includes(track))).map(element => element.currentTime))
      rows.push({ peer, local: local?.candidateType, remote: remote?.candidateType, protocol: local?.relayProtocol,
        policy: pc.getConfiguration().iceTransportPolicy, localPort: local?.port, remotePort: remote?.port,
        frames: video.reduce((sum, stat) => sum + (stat.framesDecoded ?? 0), 0),
        audioBytes: sound.reduce((sum, stat) => sum + (stat.bytesReceived ?? 0), 0), rms, sinkTime, audioSinkTime,
        epoch: [...video, ...sound].map(stat => stat.id).sort().join('|') })
    }
    return rows
  })
}

async function moving(page: Page, peers: number, transport: Transport) {
  if (peers > 1) await chooseCallMore(page, 'Gallery', 'Layout')
  await expect.poll(async () => (await sample(page)).filter(row => row.frames > 5 && row.audioBytes > 0 && row.rms > .001 && row.sinkTime > 0 && row.audioSinkTime > 0).length,
    { timeout: 60_000, message: 'each participant must deliver decoded video, PCM audio and visible playback' }).toBeGreaterThanOrEqual(peers)
  const baseline = new Map((await sample(page)).map(row => [row.peer, row]))
  await expect.poll(async () => (await sample(page)).filter(row => {
    const previous = baseline.get(row.peer)
    if (!previous || previous.epoch !== row.epoch || row.frames < previous.frames || row.audioBytes < previous.audioBytes) {
      baseline.set(row.peer, row); return false
    }
    return row.frames > previous.frames + 2 && row.audioBytes > previous.audioBytes && row.rms > .001 && row.sinkTime > previous.sinkTime && row.audioSinkTime > previous.audioSinkTime
  }).length, { timeout: 45_000, message: 'fresh media must keep arriving from every participant' }).toBeGreaterThanOrEqual(peers)
  const rows = await sample(page)
  expect(rows.every(row => row.local === 'relay' && row.remote === 'relay' && row.protocol === transport && row.policy === 'relay')).toBe(true)
  return rows.map(({ epoch: _epoch, ...row }) => row)
}

for (const transport of ['udp', 'tcp', 'tls'] as const) {
  test(`private profiles carry real KithMoot calls through public TURN/${transport}`, async ({ browser, baseURL }) => {
    const count = transport === 'tls' ? 3 : 2
    const accounts = Array.from({ length: count }, (_, i) => account(transport, i))
    const contexts = await Promise.all(accounts.map(() => newDeviceContext(browser, baseURL!, { viewport: { width: 1920, height: 1080 } })))
    const pages: Page[] = [], denied: string[] = [], phases: unknown[] = []
    let phase = 'configure'
    try {
      for (const context of contexts) {
        await context.route('**/*', route => {
          if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname)) {
            denied.push('non-loopback HTTP'); return route.abort('blockedbyclient')
          }
          return route.continue()
        })
        await context.routeWebSocket(/.*/, socket => {
          if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(socket.url()).hostname)) {
            denied.push('non-loopback WebSocket'); socket.close(); return
          }
          socket.connectToServer()
        })
        await context.addInitScript(SYNTHETIC_MIC)
        await context.addInitScript(() => {
          localStorage.setItem('kithmoot.hide-ip.v1', '1')
          localStorage.setItem('kithmoot.profiles.enabled', 'false')
        })
      }
      pages.push(...await Promise.all(contexts.map(context => context.newPage())))
      pages.forEach(observeAutomaticCallErrors)
      const link = await createRoom(pages[0], baseURL!)
      for (let i = 0; i < count; i++) {
        if (i) await pages[i].goto(baseURL!)
        await configure(pages[i], accounts[i], i === 0)
      }
      await pages[0].reload()
      await joinWithMedia(pages[0], link, 'Ada'); await joinWithMedia(pages[1], link, 'Rowan')
      phase = 'one-to-one'
      phases.push({ phase, peers: await Promise.all(pages.slice(0, 2).map(page => moving(page, 1, transport))) })
      if (count === 3) {
        await joinWithMedia(pages[2], link, 'PeerC')
        phase = 'group'
        phases.push({ phase, peers: await Promise.all(pages.map(page => moving(page, 2, transport))) })
        phase = 'protected-area-share'
        const pending = pages[0].waitForEvent('popup')
        await chooseCallMore(pages[0], 'Share an area')
        const popup = await pending; await syntheticSource(popup)
        await popup.getByRole('button', { name: 'Choose a window or tab' }).click()
        await popup.getByRole('button', { name: 'Hide a region', exact: true }).click()
        const grip = popup.getByRole('button', { name: 'Resize shared area', exact: true })
        await grip.press('ArrowLeft'); await grip.press('ArrowUp')
        await popup.getByRole('button', { name: 'Start protected sharing' }).click()
        const pixels = (page: Page) => page.locator('video.screenPreview').first().evaluate((video: HTMLVideoElement) => {
          const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18
          const ctx = canvas.getContext('2d')!; ctx.drawImage(video, 0, 0, 32, 18)
          return { width: video.videoWidth, centre: [...ctx.getImageData(16, 9, 1, 1).data], edge: [...ctx.getImageData(2, 2, 1, 1).data] }
        })
        for (const receiver of pages.slice(1)) {
          await expect(receiver.locator('video.screenPreview').first()).toBeVisible({ timeout: 45_000 })
          await expect.poll(async () => (await pixels(receiver)).edge[1]).toBeGreaterThan(130)
          const received = await pixels(receiver)
          expect(received.centre[0]).toBeLessThan(80); expect(received.width).toBeLessThan(640)
        }
        const visible = await Promise.all(pages.slice(1).map(pixels))
        await popup.getByRole('button', { name: 'Hide my share', exact: true }).click()
        for (const receiver of pages.slice(1)) await expect.poll(async () => (await pixels(receiver)).edge[1]).toBeLessThan(80)
        expect(await popup.evaluate(() => (window as unknown as { raw: MediaStream }).raw.getAudioTracks()[0].enabled)).toBe(false)
        await popup.getByRole('button', { name: 'Show my share', exact: true }).click()
        for (const receiver of pages.slice(1)) await expect.poll(async () => (await pixels(receiver)).edge[1]).toBeGreaterThan(130)
        await popup.evaluate(() => { (window as unknown as { sourceCanvas: HTMLCanvasElement }).sourceCanvas.width = 800 })
        await expect(popup.locator('#status')).toContainText('source changed')
        for (const receiver of pages.slice(1)) await expect.poll(async () => (await pixels(receiver)).edge[1]).toBeLessThan(80)
        await popup.getByRole('button', { name: 'Show my share', exact: true }).click()
        for (const receiver of pages.slice(1)) await expect.poll(async () => (await pixels(receiver)).edge[1]).toBeLessThan(80)
        await popup.getByRole('button', { name: 'Confirm changed source', exact: true }).click()
        for (const receiver of pages.slice(1)) await expect.poll(async () => (await pixels(receiver)).edge[1]).toBeGreaterThan(130)
        phases.push({ phase, receivedPixels: visible, hideResume: true, sourceChangeCoveredUntilConfirmed: true })
        await pages[0].locator('#toggleScreen').click()
        await expect.poll(() => popup.isClosed()).toBe(true)
        phases.push({ phase: 'after-share', peers: await Promise.all(pages.map(page => moving(page, 2, transport))) })
        for (let cycle = 1; cycle <= 2; cycle++) {
          phase = `rejoin-${cycle}`
          await pages[0].reload(); await joinWithMedia(pages[0], link, 'Ada')
          phases.push({ phase, peers: await Promise.all(pages.map(page => moving(page, 2, transport))) })
        }
      }
      const payload = Buffer.from(link.split('#')[1], 'base64url').toString()
      expect(accounts.some(relay => payload.includes(relay.credential) || payload.includes(relay.username) || relay.urls.some(url => payload.includes(url)))).toBe(false)
      expect(denied).toEqual([])
      await test.info().attach('public-app-call', { contentType: 'application/json', body: JSON.stringify({
        transport, profileImportViaSettings: true, deviceRelayTest: true, generatedMediaOnly: true,
        certificateBypass: false, signalling: 'local test relay', media: 'external operator TURN', phases,
        credentialsInRoomLink: false, externalHttpOrWebSocketRequests: denied,
        oneClientMachine: true, physicalGrapheneOS: false, realOsPicker: false,
      }, null, 2) })
    } catch (error) {
      await test.info().attach('public-app-call-failure', { contentType: 'application/json', body: JSON.stringify({
        transport, phase, completedPhases: phases,
        media: await Promise.all(pages.map(page => sample(page).catch(() => []))),
        state: await Promise.all(pages.map(page => automaticCallState(page).catch(() => ({ unavailable: true })))),
      }, null, 2) })
      throw error
    } finally { await Promise.all(contexts.map(context => context.close())) }
  })
}
