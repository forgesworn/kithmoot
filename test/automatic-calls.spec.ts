import { test, expect, type Page } from '@playwright/test'
import { once } from 'node:events'
import { connect as connectTls } from 'node:tls'
import { createRoom, join, open, joinWithMedia, newDeviceContext, turnOnMedia, chooseCallMore, SYNTHETIC_MIC } from './browser.js'
import { RELAY_ONLY_NO_RELAY } from '../app/src/relay-only.js'
import { automaticCallState, observeAutomaticCallErrors } from './automatic-call-state.js'
import { syntheticSource } from './browser-protected-share-fixture.js'

const issuer = `https://localhost:${process.env.E2E_AUTOMATIC_TURN_PORT ?? 7794}`
const observerCpuRate = Number(process.env.E2E_CALL_OBSERVER_CPU_RATE ?? 1)
if (!Number.isInteger(observerCpuRate) || observerCpuRate < 1 || observerCpuRate > 4) throw new Error('Observer CPU rate must be an integer from 1 to 4')

test('issuer requests omit cookies and room information while fresh guests receive distinct logins', async ({ browser, baseURL, request }) => {
  // A browser may pre-open TLS without sending HTTP. That idle connection
  // must not monopolise the local credential facade's only request handler.
  const idle = connectTls({ host: '127.0.0.1', port: Number(new URL(issuer).port), servername: 'localhost', rejectUnauthorized: false })
  idle.on('error', () => {})
  idle.setTimeout(25_000, () => idle.destroy())
  await once(idle, 'secureConnect')
  const contexts = await Promise.all([0, 1].map(() => newDeviceContext(browser, baseURL!)))
  const replies: { username: string; credential: string }[] = []
  const denied: string[] = []
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
      await context.addCookies([{ name: 'issuer-cookie-probe', value: 'must-not-be-sent', url: issuer, secure: true, sameSite: 'None' }])
      await context.addInitScript(() => {
        localStorage.setItem('kithmoot.hide-ip.v1', '1')
        localStorage.setItem('kithmoot.profiles.enabled', 'false')
      })
    }
    const pages = await Promise.all(contexts.map(context => context.newPage()))
    const link = await createRoom(pages[0], baseURL!)
    await turnOnMedia(pages[0])
    await open(pages[1], link, 'Rowan'); await join(pages[1])
    await expect(pages[1].locator('#roomArea')).toBeVisible()
    // Publish media on both sides: an idle/chat-only guest need not request
    // its own transport allocation yet.
    await turnOnMedia(pages[1])
    // Inspect the credentials actually accepted by native WebRTC instead of
    // depending on DevTools retaining a second readable response body.
    await expect.poll(async () => {
      replies.length = 0
      for (const page of pages) {
        const relay = await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
          .flatMap(pc => pc.getConfiguration().iceServers ?? []).find(server => server.username && typeof server.credential === 'string'))
        if (relay?.username && typeof relay.credential === 'string') replies.push({ username: relay.username, credential: relay.credential })
      }
      return replies.length
    }, { timeout: 10_000 }).toBe(2)
    expect(new Set(replies.map(reply => reply.username)).size).toBe(replies.length)
    for (const page of pages) {
      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
      const payload = Buffer.from(link.split('#')[1], 'base64url').toString()
      for (const reply of replies) {
        expect(stored.includes(reply.username) || stored.includes(reply.credential), 'transport login persisted').toBe(false)
        expect(payload.includes(reply.username) || payload.includes(reply.credential), 'transport login entered room link').toBe(false)
      }
    }
    const stats = await (await request.get(`${issuer}/stats`)).json()
    expect(stats.turnBackend).toBe(process.env.E2E_TURN_BACKEND ?? 'coturn')
    if (stats.turnBackend === 'spry') expect(stats.turnBinarySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(stats.distinctLogins).toBeGreaterThanOrEqual(2)
    for (const key of ['cookies', 'authorisation', 'referrer', 'query', 'body']) expect(stats[key], key).toBe(false)
    expect(denied).toEqual([])
    expect(idle.destroyed, 'credentials must arrive while the pre-opened TLS socket remains idle').toBe(false)
    await test.info().attach('automatic-issuer-request-boundary', { contentType: 'application/json', body: JSON.stringify({
      freshBrowserGuests: 2, guestSettingsOrImport: false, distinctTemporaryLogins: replies.length,
      idleTlsSocketDidNotBlockCredentials: true,
      credentialObservation: 'native RTCPeerConnection configuration',
      persistedInLocalOrSessionStorage: false, credentialsInRoomLink: false,
      issuerRequestBoundary: stats, externalRequests: denied,
      separateNetworks: false, publicPkiQualified: false, commercialProviderQualified: false,
    }, null, 2) })
  } finally { idle.destroy(); await Promise.all(contexts.map(context => context.close())) }
})

async function sample(page: Page) {
  return page.evaluate(async () => {
    const rows: { peer: number; frames: number; energy: number; local: string; remote: string; protocol: string; epoch: string; sinkTime: number }[] = []
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
    for (let peer = 0; peer < pcs.length; peer++) {
      const pc = pcs[peer]
      if (pc.connectionState !== 'connected') continue
      const report = await pc.getStats()
      const videoTracks = pc.getReceivers().map(receiver => receiver.track).filter(track => track.kind === 'video')
      const sinkTime = Math.max(0, ...[...document.querySelectorAll<HTMLVideoElement>('#room video')]
        .filter(video => !video.paused && video.checkVisibility() && video.srcObject instanceof MediaStream &&
          video.srcObject.getTracks().some(track => videoTracks.includes(track)))
        .map(video => video.currentTime))
      let frames = 0, energy = 0
      const streams: string[] = []
      report.forEach(stat => {
        if (stat.type !== 'inbound-rtp') return
        streams.push(stat.id)
        if (stat.kind === 'video') frames += stat.framesDecoded ?? 0
        if (stat.kind === 'audio') energy += stat.totalAudioEnergy ?? 0
      })
      report.forEach(stat => {
        if (stat.type !== 'candidate-pair' || !stat.nominated || stat.state !== 'succeeded') return
        const local = report.get(stat.localCandidateId), remote = report.get(stat.remoteCandidateId)
        rows.push({ peer, frames, energy, local: local?.candidateType, remote: remote?.candidateType, protocol: local?.relayProtocol, epoch: streams.sort().join('|'), sinkTime })
      })
    }
    return rows
  })
}

async function movingMedia(page: Page, peers: number) {
  if (peers > 1) await chooseCallMore(page, 'Gallery', 'Layout')
  await expect.poll(async () => (await sample(page)).filter(row => row.frames > 5 && row.energy > 0 && row.sinkTime > 0).length,
    { timeout: 45_000, message: 'every remote participant must supply decoded video, audio and a playing video sink' }).toBe(peers)
  const baseline = new Map((await sample(page)).map(row => [row.peer, row]))
  await expect.poll(async () => (await sample(page)).filter(row => {
    const before = baseline.get(row.peer)
    if (!before || before.epoch !== row.epoch || row.frames < before.frames || row.energy < before.energy || row.sinkTime < before.sinkTime) {
      baseline.set(row.peer, row)
      return false
    }
    return row.frames > before.frames + 2 && row.energy > before.energy && row.sinkTime > before.sinkTime
  }).length, { timeout: 30_000, message: 'stale counters must not pass' }).toBe(peers)
  const result = await sample(page)
  expect(result.every(row => row.local === 'relay' && row.remote === 'relay' && row.protocol === 'tls')).toBe(true)
  return result
}

test('a delayed first camera frame after rejoin keeps its playback sink attached', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => newDeviceContext(browser, baseURL!)))
  const pages: Page[] = []
  try {
    for (const context of contexts) {
      await context.addInitScript(SYNTHETIC_MIC)
      await context.addInitScript(() => {
        localStorage.setItem('kithmoot.hide-ip.v1', '1')
        localStorage.setItem('kithmoot.profiles.enabled', 'false')
      })
    }
    pages.push(...await Promise.all(contexts.map(context => context.newPage())))
    const link = await createRoom(pages[0], baseURL!)
    await turnOnMedia(pages[0]); await joinWithMedia(pages[1], link, 'Rowan')
    for (const page of pages) await movingMedia(page, 1)
    const oldPeerCount = await pages[0].evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length)
    // Defer only the outgoing canvas's first paint on the next page load.
    // Real WebRTC, the owned privacy compositor and its capture track remain
    // intact. No raw camera, ICE configuration or incoming sink is substituted.
    await contexts[1].addInitScript(() => {
      const deadlines = new WeakMap<HTMLCanvasElement, number>()
      const capture = HTMLCanvasElement.prototype.captureStream
      const draw = CanvasRenderingContext2D.prototype.drawImage
      const state = window as unknown as { __firstCameraPaint: { until: number; painted: boolean } }
      HTMLCanvasElement.prototype.captureStream = function(rate?: number) {
        const until = performance.now() + 12_000
        deadlines.set(this, until); state.__firstCameraPaint = { until, painted: false }
        return capture.call(this, rate)
      }
      CanvasRenderingContext2D.prototype.drawImage = function(this: CanvasRenderingContext2D, ...args: unknown[]) {
        const deadline = deadlines.get(this.canvas as HTMLCanvasElement)
        if (deadline !== undefined) {
          if (performance.now() < deadline) return
          state.__firstCameraPaint.painted = true
        }
        Reflect.apply(draw, this, args)
      }
    })
    await pages[1].reload(); await joinWithMedia(pages[1], link, 'Rowan')
    const pending = () => pages[0].evaluate(previous => {
      const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.slice(previous)
      const tracks = pcs.flatMap(pc => pc.getReceivers().map(receiver => receiver.track)).filter(track => track.kind === 'video')
      const video = [...document.querySelectorAll<HTMLVideoElement>('video')].find(el =>
        el.srcObject instanceof MediaStream && el.srcObject.getTracks().some(track => tracks.includes(track)))
      return video ? { insideRoom: !!video.closest('#room'), clock: video.currentTime,
        awaiting: video.classList.contains('awaitingFrame'), width: video.videoWidth } : undefined
    }, oldPeerCount)
    await expect.poll(pending).toBeTruthy()
    await pages[0].waitForTimeout(3500) // exercise several one-second recovery ticks
    const held = await pending()
    const paint = await pages[1].evaluate(() => (window as unknown as { __firstCameraPaint: { painted: boolean } }).__firstCameraPaint)
    expect(paint.painted, 'fixture must still be withholding the first output paint').toBe(false)
    expect(held?.clock).toBe(0)
    expect(held?.width).toBe(0)
    expect(held?.insideRoom, 'a sink with no first frame was parked out of the rendering tree').toBe(true)
    expect(held?.awaiting).toBe(true)
    for (const page of pages) await movingMedia(page, 1)
    await test.info().attach('delayed-first-frame-rejoin', { contentType: 'application/json', body: JSON.stringify({
      firstPaintDelayMs: 12_000, recoveryTicksBeforeFirstPaint: 3, held,
      realPrivacyCompositor: true, sourceSubstituted: false,
      receivedAfterDelay: await Promise.all(pages.map(sample)),
    }, null, 2) })
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('fresh guests automatically obtain separate temporary transport logins and group-call without Settings or files', async ({ browser, baseURL, request }) => {
  const contexts = await Promise.all([0, 1, 2].map(() => newDeviceContext(browser, baseURL!, { viewport: { width: 1920, height: 1080 } })))
  const denied: string[] = []
  const pages: Page[] = []
  let phase = 'create'
  try {
    for (const context of contexts) {
      await context.route('**/*', route => {
        const url = new URL(route.request().url())
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
          denied.push(url.origin); return route.abort('blockedbyclient')
        }
        return route.continue()
      })
      await context.routeWebSocket(/.*/, socket => {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(socket.url()).hostname)) {
          denied.push(new URL(socket.url()).origin); socket.close(); return
        }
        socket.connectToServer()
      })
      await context.addCookies([{ name: 'issuer-cookie-probe', value: 'must-not-be-sent', url: issuer, secure: true, sameSite: 'None' }])
      await context.addInitScript(SYNTHETIC_MIC)
      await context.addInitScript(() => {
        localStorage.setItem('kithmoot.hide-ip.v1', '1')
        localStorage.setItem('kithmoot.profiles.enabled', 'false')
      })
    }
    pages.push(...await Promise.all(contexts.map(context => context.newPage())))
    pages.forEach(observeAutomaticCallErrors)
    const link = await createRoom(pages[0], baseURL!)
    await turnOnMedia(pages[0])
    phase = 'one-to-one'
    await joinWithMedia(pages[1], link, 'Rowan')
    const oneToOne = await Promise.all(pages.slice(0, 2).map(page => movingMedia(page, 1)))
    await joinWithMedia(pages[2], link, 'PeerC')
    phase = 'initial group'
    const group = []
    for (const page of pages) group.push(await movingMedia(page, 2))
    const logins = []
    for (const page of pages) {
      const configs = await page.evaluate(() => {
        const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
        const login = pcs.flatMap(pc => pc.getConfiguration().iceServers ?? []).find(server => server.username)
        return { policy: pcs.filter(pc => pc.connectionState === 'connected').map(pc => pc.getConfiguration().iceTransportPolicy),
          username: login?.username, credential: login?.credential, saved: localStorage.getItem('kithmoot.call-relay.v1'),
          persisted: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }) }
      })
      expect(configs.policy.every(policy => policy === 'relay')).toBe(true)
      expect(configs.saved).toBeNull()
      expect(configs.username).toMatch(/^\d+:km-[a-f0-9]{16}$/)
      expect(configs.credential).toBeTruthy()
      expect(configs.persisted).not.toContain(configs.username!)
      expect(configs.persisted).not.toContain(configs.credential!)
      expect(link).not.toContain(configs.username!)
      const payload = Buffer.from(link.split('#')[1], 'base64url').toString()
      expect(payload).not.toContain(configs.username!)
      expect(payload).not.toContain(configs.credential!)
      expect(payload).not.toContain(issuer)
      logins.push(configs.username)
    }
    expect(new Set(logins).size).toBe(3)
    if (observerCpuRate > 1) for (const page of pages.slice(0, 2)) {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: observerCpuRate })
    }
    // A fresh rejoin asks the independent issuer again; no saved login to import.
    const rejoined = []
    for (let cycle = 1; cycle <= 3; cycle++) {
      await pages[2].reload()
      phase = `rejoin ${cycle}`
      await joinWithMedia(pages[2], link, 'PeerC')
      const peers = []
      for (const page of pages) peers.push(await movingMedia(page, 2))
      rejoined.push({ cycle, peers })
    }
    await pages[2].locator('#chatInput').fill('Automatic transport; participant room keys')
    await pages[2].locator('#chatInput').press('Enter')
    for (const page of pages.slice(0, 2)) await expect(page.locator('#chatLog')).toContainText('Automatic transport; participant room keys')
    const stats = await (await request.get(`${issuer}/stats`)).json()
    expect(stats.requests).toBeGreaterThanOrEqual(4)
    expect(stats.distinctLogins).toBeGreaterThanOrEqual(4)
    for (const key of ['cookies', 'authorisation', 'referrer', 'query', 'body']) expect(stats[key], key).toBe(false)
    expect(denied).toEqual([])
    await test.info().attach('automatic-independent-guest-transport', { contentType: 'application/json', body: JSON.stringify({
      model: 'independently operated static app with build-selected issuer; all fixtures local',
      guestsConfiguredRelay: false, fileImportUsed: false, realTurnRestAuthentication: true,
      turnBackend: stats.turnBackend,
      issuerImplementation: 'server/turn-credentials.mjs', ttlSeconds: 3600,
      observerCpuRate,
      separateBrowserLogins: true, credentialsInLocalOrSessionStorage: false,
      issuerRequestBoundary: stats, oneToOne, group, rejoined,
      externalRequests: denied, separateNetworks: false, publicPkiQualified: false,
      independentRealOperatorsQualified: false, publicProviderSelected: false,
      forgeSwornWebsiteProviderSelection: false, legalExemptionEstablished: false,
    }, null, 2) })
  } catch (error) {
    await test.info().attach('bounded-automatic-call-failure', { contentType: 'application/json', body: JSON.stringify({ phase, observerCpuRate,
      peers: await Promise.all(pages.map(async page => ({ media: await sample(page), state: await automaticCallState(page),
        sinks: await page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('#room video')].map(video => ({
          connected: video.isConnected, paused: video.paused, visible: video.checkVisibility(),
          offPage: video.hasAttribute('data-gallery-off-page'), time: video.currentTime,
          tracks: video.srcObject instanceof MediaStream ? video.srcObject.getTracks().map(track => ({
            kind: track.kind, state: track.readyState, muted: track.muted, enabled: track.enabled,
          })) : [],
        }))),
      })).map(result => result.catch(() => ({ unavailable: true })))),
    }, null, 2) })
    throw error
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('callers receive protected screen pixels through the selected TURN backend', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => newDeviceContext(browser, baseURL!)))
  const denied: string[] = []
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
    const [sender, receiver] = await Promise.all(contexts.map(context => context.newPage()))
    const link = await createRoom(sender, baseURL!)
    await turnOnMedia(sender); await joinWithMedia(receiver, link, 'Rowan')
    for (const page of [sender, receiver]) await movingMedia(page, 1)
    const pending = sender.waitForEvent('popup')
    await chooseCallMore(sender, 'Share with redaction')
    const popup = await pending; await syntheticSource(popup)
    await popup.getByRole('button', { name: 'Choose a window or tab' }).click()
    await expect(popup.getByRole('button', { name: 'Start protected sharing' })).toBeEnabled()
    await popup.getByRole('button', { name: 'Hide a region', exact: true }).click()
    await popup.getByRole('button', { name: 'Start protected sharing' }).click()
    await expect(sender.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    const share = receiver.locator('video.screenPreview').first()
    await expect(share).toBeVisible({ timeout: 45_000 })
    const pixels = () => share.evaluate((video: HTMLVideoElement) => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18
      const ctx = canvas.getContext('2d')!; ctx.drawImage(video, 0, 0, 32, 18)
      return { centre: [...ctx.getImageData(16, 9, 1, 1).data], edge: [...ctx.getImageData(2, 2, 1, 1).data] }
    })
    await expect.poll(async () => (await pixels()).edge[1]).toBeGreaterThan(130)
    const decodedPixels = await pixels()
    expect(decodedPixels.centre[0]).toBeLessThan(80)
    for (const page of [sender, receiver]) await movingMedia(page, 1)
    await sender.locator('#toggleScreen').click()
    await expect.poll(() => popup.isClosed()).toBe(true)
    expect(denied).toEqual([])
    await test.info().attach('protected-share-selected-turn', { contentType: 'application/json', body: JSON.stringify({
      turnBackend: process.env.E2E_TURN_BACKEND ?? 'coturn', generatedMediaOnly: true,
      realOsCapturePicker: false, decodedPixels, selectedTransport: 'relay/relay TLS',
      externalRequests: denied, separateNetworks: false, installedArchyPackage: false,
    }, null, 2) })
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('issuer refusal preserves chat and refuses a relay-only call without creating a peer', async ({ browser, baseURL, request }) => {
  expect((await request.post(`${issuer}/refuse`)).ok()).toBe(true)
  const context = await newDeviceContext(browser, baseURL!)
  try {
    await context.addInitScript(() => {
      localStorage.setItem('kithmoot.hide-ip.v1', '1')
      localStorage.setItem('kithmoot.profiles.enabled', 'false')
    })
    const page = await context.newPage()
    await createRoom(page, baseURL!)
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#callToggle').click()
    await expect(page.locator('#status')).toContainText(RELAY_ONLY_NO_RELAY)
    expect(await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length)).toBe(0)
    await page.locator('#chatInput').fill('Room chat survives issuer refusal')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Room chat survives issuer refusal')
  } finally {
    await context.close()
    expect((await request.post(`${issuer}/resume`)).ok()).toBe(true)
  }
})
