import { test, expect, type Page } from '@playwright/test'
import { createRoom, join, open, openCall, joinWithMedia, newDeviceContext, turnOnMedia, chooseCallMore, SYNTHETIC_MIC } from './browser.js'
import { RELAY_ONLY_NO_RELAY } from '../app/src/relay-only.js'

const issuer = `https://localhost:${process.env.E2E_AUTOMATIC_TURN_PORT ?? 7794}`

test('issuer requests omit cookies and room information while fresh guests receive distinct logins', async ({ browser, baseURL, request }) => {
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
      context.on('response', async response => {
        if (response.url() !== `${issuer}/turn` || !response.ok()) return
        try { replies.push(await response.json()) } catch { /* the count assertion catches unread replies */ }
      })
      await context.addCookies([{ name: 'issuer-cookie-probe', value: 'must-not-be-sent', url: issuer, secure: true, sameSite: 'None' }])
      await context.addInitScript(() => {
        localStorage.setItem('kithmoot.hide-ip.v1', '1')
        localStorage.setItem('kithmoot.profiles.enabled', 'false')
      })
    }
    const pages = await Promise.all(contexts.map(context => context.newPage()))
    const link = await createRoom(pages[0], baseURL!)
    await openCall(pages[0])
    await open(pages[1], link, 'Rowan'); await join(pages[1])
    await expect(pages[1].locator('#roomArea')).toBeVisible()
    // Enter the call; chat-only participation need not ask for TURN access.
    await openCall(pages[1])
    await expect.poll(() => replies.length).toBeGreaterThanOrEqual(2)
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
    expect(stats.distinctLogins).toBeGreaterThanOrEqual(2)
    for (const key of ['cookies', 'authorisation', 'referrer', 'query', 'body']) expect(stats[key], key).toBe(false)
    expect(denied).toEqual([])
    await test.info().attach('automatic-issuer-request-boundary', { contentType: 'application/json', body: JSON.stringify({
      freshBrowserGuests: 2, guestSettingsOrImport: false, distinctTemporaryLogins: replies.length,
      persistedInLocalOrSessionStorage: false, credentialsInRoomLink: false,
      issuerRequestBoundary: stats, externalRequests: denied,
      separateNetworks: false, publicPkiQualified: false, commercialProviderQualified: false,
    }, null, 2) })
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

async function sample(page: Page) {
  return page.evaluate(async () => {
    const rows: { peer: number; frames: number; energy: number; local: string; remote: string; protocol: string; epoch: string }[] = []
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
    for (let peer = 0; peer < pcs.length; peer++) {
      const pc = pcs[peer]
      if (pc.connectionState !== 'connected') continue
      const report = await pc.getStats()
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
        rows.push({ peer, frames, energy, local: local?.candidateType, remote: remote?.candidateType, protocol: local?.relayProtocol, epoch: streams.sort().join('|') })
      })
    }
    return rows
  })
}

async function movingMedia(page: Page, peers: number) {
  if (peers > 1) await chooseCallMore(page, 'Gallery', 'Layout')
  await expect.poll(async () => (await sample(page)).filter(row => row.frames > 5 && row.energy > 0).length,
    { timeout: 45_000, message: 'every remote participant must supply decoded video and audio' }).toBe(peers)
  const baseline = new Map((await sample(page)).map(row => [row.peer, row]))
  await expect.poll(async () => (await sample(page)).filter(row => {
    const before = baseline.get(row.peer)
    if (!before || before.epoch !== row.epoch || row.frames < before.frames || row.energy < before.energy) {
      baseline.set(row.peer, row)
      return false
    }
    return row.frames > before.frames + 2 && row.energy > before.energy
  }).length, { timeout: 30_000, message: 'stale counters must not pass' }).toBe(peers)
  const result = await sample(page)
  expect(result.every(row => row.local === 'relay' && row.remote === 'relay' && row.protocol === 'tls')).toBe(true)
  return result
}

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
    // A fresh rejoin asks the independent issuer again; no saved login to import.
    await pages[2].reload()
    phase = 'rejoin'
    await joinWithMedia(pages[2], link, 'PeerC')
    const rejoined = []
    for (const page of pages) rejoined.push(await movingMedia(page, 2))
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
      guestsConfiguredRelay: false, fileImportUsed: false, realCoturnRestAuthentication: true,
      issuerImplementation: 'server/turn-credentials.mjs', ttlSeconds: 3600,
      separateBrowserLogins: true, credentialsInLocalOrSessionStorage: false,
      issuerRequestBoundary: stats, oneToOne, group, rejoined,
      externalRequests: denied, separateNetworks: false, publicPkiQualified: false,
      independentRealOperatorsQualified: false, publicProviderSelected: false,
      forgeSwornWebsiteProviderSelection: false, legalExemptionEstablished: false,
    }, null, 2) })
  } catch (error) {
    await test.info().attach('bounded-automatic-call-failure', { contentType: 'application/json', body: JSON.stringify({ phase,
      peers: await Promise.all(pages.map(async page => ({ media: await sample(page),
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
