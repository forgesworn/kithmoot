import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRoom, join, open, newDeviceContext, turnOnMedia, SYNTHETIC_MIC } from './browser.js'
import { RELAY_ONLY_NO_RELAY } from '../app/src/relay-only.js'
import { SHARED_RELAY_UNAVAILABLE } from '../src/spry.js'

/**
 * One member runs Spry and pairs KithMoot with it; everyone in that member's
 * rooms uses it, including a guest who has no Spry, no relay settings and no
 * file to import. The paired member's client publishes a room grant in the
 * encrypted room descriptor, and the guest redeems it for its own short-lived
 * credential. spry-pairing.spec.ts covers the pairing screens against a stub,
 * and automatic-calls.spec.ts covers a deployment's login service; this spec
 * drives the real standard-profile node end to end.
 *
 * Everything runs on loopback against test/spry-room-relay-fixture.mjs. See
 * playwright.spry-room-relay.config.ts for what it needs.
 */

const FACADE = `https://localhost:${process.env.E2E_SPRY_FACADE_PORT ?? 7795}`
const HOST = process.env.E2E_SPRY_HOST ?? 'spry-node.example'
const ENDPOINT = `https://${HOST}:${process.env.E2E_SPRY_FACADE_PORT ?? 7795}`
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']
// What a standard-profile node advertises, and the only TURN URLs the client
// accepts from an https: offer (src/spry.ts, spryCredentials).
const TURN_URL = new RegExp(`^turn:${HOST.replaceAll('.', '\\.')}:3478\\?transport=(udp|tcp)$`)
const SPRY_USERNAME = /^\d{1,12}:[a-f0-9]{24}$/
// With Hide my IP on and no usable relay, the client refuses to call. A guest
// whose shared relay fails is told so, never pointed at a pairing it does not
// have; a room with no relay at all gives RELAY_ONLY_NO_RELAY. Either is a
// refusal, and neither is a direct call.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const REFUSAL = new RegExp(`${escape(SHARED_RELAY_UNAVAILABLE)}|${escape(RELAY_ONLY_NO_RELAY)}`)

interface Device { context: BrowserContext; page: Page; denied: string[]; spryPosts: Map<string, number> }

/** A fresh browser profile: no pairing, no relay settings, no imported file. */
async function device(browser: Browser, baseURL: string): Promise<Device> {
  const context = await newDeviceContext(browser, baseURL, { viewport: { width: 1280, height: 800 } })
  const denied: string[] = []
  const allowed = [...LOOPBACK, HOST]
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!allowed.includes(url.hostname)) { denied.push(url.origin); return route.abort('blockedbyclient') }
    return route.continue()
  })
  await context.routeWebSocket(/.*/, socket => {
    if (!LOOPBACK.includes(new URL(socket.url()).hostname)) { denied.push(new URL(socket.url()).origin); socket.close(); return }
    socket.connectToServer()
  })
  await context.addInitScript(SYNTHETIC_MIC)
  await context.addInitScript(() => {
    // Hide my IP address on calls: relay-only ICE, chosen on this device.
    localStorage.setItem('kithmoot.hide-ip.v1', '1')
    localStorage.setItem('kithmoot.profiles.enabled', 'false')
  })
  const page = await context.newPage()
  const spryPosts = new Map<string, number>()
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().startsWith(ENDPOINT + '/v1/')) return
    const path = new URL(request.url()).pathname
    spryPosts.set(path, (spryPosts.get(path) ?? 0) + 1)
  })
  return { context, page, denied, spryPosts }
}

/** The member's own pairing, through the same pairing link and screen a real one uses. */
async function pairThisBrowser(page: Page, baseURL: string, request: APIRequestContext) {
  const { hash } = await (await request.post(`${FACADE}/fixture/pairing`)).json()
  await page.goto(baseURL + hash)
  const dialog = page.getByRole('dialog', { name: 'Where do you want to pair Spry?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Pair this browser', exact: true }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('kithmoot.spry-pairing.v1'))).toBeTruthy()
}

const stored = (page: Page, key: string) => page.evaluate(k => localStorage.getItem(k), key)

interface Row {
  peer: number; policy: string; servers: { urls: string[]; username?: string }[]
  frames: number; energy: number; audioBytes: number; videoBytes: number; sentBytes: number
  local?: string; remote?: string; protocol?: string; url?: string; epoch: string
}

async function sample(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const rows: Row[] = []
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
    for (let peer = 0; peer < pcs.length; peer++) {
      const pc = pcs[peer]
      if (pc.connectionState !== 'connected') continue
      const config = pc.getConfiguration()
      const report = await pc.getStats()
      let frames = 0, energy = 0, audioBytes = 0, videoBytes = 0, sentBytes = 0
      const streams: string[] = []
      report.forEach(stat => {
        if (stat.type === 'inbound-rtp') {
          streams.push(stat.id)
          if (stat.kind === 'video') { frames += stat.framesDecoded ?? 0; videoBytes += stat.bytesReceived ?? 0 }
          if (stat.kind === 'audio') { energy += stat.totalAudioEnergy ?? 0; audioBytes += stat.bytesReceived ?? 0 }
        }
        if (stat.type === 'outbound-rtp') sentBytes += stat.bytesSent ?? 0
      })
      const base = {
        peer, frames, energy, audioBytes, videoBytes, sentBytes, epoch: streams.sort().join('|'),
        policy: config.iceTransportPolicy ?? 'all',
        servers: (config.iceServers ?? []).map(server => ({ urls: [server.urls].flat(), username: server.username })),
      }
      // The pair the transport is using now; during an ICE restart there is none.
      let pair: RTCStats | undefined
      report.forEach(stat => {
        if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = report.get(stat.selectedCandidatePairId)
      })
      const local = pair ? report.get((pair as unknown as { localCandidateId: string }).localCandidateId) : undefined
      const remote = pair ? report.get((pair as unknown as { remoteCandidateId: string }).remoteCandidateId) : undefined
      rows.push({ ...base, local: local?.candidateType, remote: remote?.candidateType, protocol: local?.relayProtocol, url: local?.url })
    }
    return rows
  })
}

/** Decoded video and audio energy advance on every remote leg, over the relay. */
async function movingRelayedMedia(page: Page, peers: number) {
  await expect.poll(async () => (await sample(page)).filter(row => row.frames > 5 && row.energy > 0 && row.audioBytes > 0 && row.videoBytes > 0).length,
    { timeout: 60_000, message: 'every remote participant must supply decoded video, audio energy and received bytes' }).toBe(peers)
  const baseline = new Map((await sample(page)).map(row => [row.peer, row]))
  await expect.poll(async () => (await sample(page)).filter(row => {
    const before = baseline.get(row.peer)
    if (!before || before.epoch !== row.epoch) { baseline.set(row.peer, row); return false }
    return row.frames > before.frames + 2 && row.energy > before.energy && row.audioBytes > before.audioBytes && row.videoBytes > before.videoBytes
  }).length, { timeout: 30_000, message: 'stale counters must not pass' }).toBe(peers)
  let rows: Row[] = []
  await expect.poll(async () => { rows = await sample(page); return rows.filter(row => row.local && row.remote).length },
    { timeout: 20_000, message: 'every leg must report a selected candidate pair' }).toBe(peers)
  return rows
}

const fixtureStats = async (request: APIRequestContext) => (await request.get(`${FACADE}/fixture/stats`)).json()
const seenByNode = async (request: APIRequestContext, username: string) =>
  (await (await request.post(`${FACADE}/fixture/username-seen?u=${encodeURIComponent(username)}`)).json()).seen as boolean

test('an unpaired guest joins by link and calls through the creator\'s Spry node, relay only', async ({ browser, baseURL, request }) => {
  const a = await device(browser, baseURL!), b = await device(browser, baseURL!)
  expect((await request.post(`${FACADE}/fixture/reset`)).ok()).toBe(true)
  try {
    await pairThisBrowser(a.page, baseURL!, request)
    const link = await createRoom(a.page, baseURL!)
    await turnOnMedia(a.page)

    // The guest: fresh browser, no pairing, no relay settings, nothing imported.
    await open(b.page, link, 'Rowan')
    expect(await stored(b.page, 'kithmoot.spry-pairing.v1')).toBeNull()
    expect(await stored(b.page, 'kithmoot.call-relay.v1')).toBeNull()
    await join(b.page)
    await turnOnMedia(b.page)
    expect(await stored(b.page, 'kithmoot.spry-pairing.v1'), 'the guest must stay unpaired').toBeNull()
    expect(await stored(b.page, 'kithmoot.call-relay.v1'), 'the guest must have no relay settings').toBeNull()

    const [aMedia, bMedia] = await Promise.all([movingRelayedMedia(a.page, 1), movingRelayedMedia(b.page, 1)])

    // Both peer connections are relay-only and use only the node's own TURN
    // URLs: no STUN, no other relay, no direct path to fall back on.
    const logins: string[] = []
    for (const [who, rows] of [['creator', aMedia], ['guest', bMedia]] as const) {
      for (const row of rows) {
        expect(row.policy, `${who} iceTransportPolicy`).toBe('relay')
        expect(row.servers.length, `${who} ICE servers`).toBeGreaterThan(0)
        for (const server of row.servers) {
          expect(server.urls.length).toBeGreaterThan(0)
          for (const url of server.urls) expect(url, `${who} ICE URL`).toMatch(TURN_URL)
          expect(server.username, `${who} username`).toMatch(SPRY_USERNAME)
        }
        // The selected candidate pair is relay/relay through the node.
        expect([row.local, row.remote], `${who} selected pair`).toEqual(['relay', 'relay'])
        // The browser flag blocks non-proxied UDP, so the allocation is TCP.
        expect(row.protocol, `${who} relay protocol`).toBe('tcp')
        expect(row.url, `${who} relay candidate server`).toMatch(TURN_URL)
        expect(row.sentBytes, `${who} sent bytes`).toBeGreaterThan(0)
        expect(row.audioBytes + row.videoBytes, `${who} received bytes`).toBeGreaterThan(0)
        logins.push(row.servers.find(server => server.username)!.username!)
      }
    }
    // Each side holds its own credential, and the node issued both.
    expect(new Set(logins).size).toBe(2)
    for (const username of logins) expect(await seenByNode(request, username), 'username issued by the node').toBe(true)

    // The guest asked the node for its own credential, and never held, claimed
    // or asked for a grant of its own.
    expect(b.spryPosts.get('/v1/credentials') ?? 0, 'guest credential requests').toBeGreaterThanOrEqual(1)
    expect(b.spryPosts.get('/v1/grants') ?? 0, 'guest grant requests').toBe(0)
    expect(b.spryPosts.get('/v1/pairings/claim') ?? 0, 'guest pairing claims').toBe(0)
    expect(a.spryPosts.get('/v1/pairings/claim') ?? 0, 'creator pairing claims').toBe(1)
    expect(a.spryPosts.get('/v1/grants') ?? 0, 'creator grant requests').toBeGreaterThanOrEqual(1)

    const stats = await fixtureStats(request)
    expect(stats.nodeBinarySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(stats.distinctClaimSigners).toBe(1)
    expect(stats.distinctGrantSigners).toBe(1)
    expect(stats.distinctCredentialSigners, 'creator and guest are different devices').toBeGreaterThanOrEqual(2)
    for (const key of ['cookies', 'referrer', 'query']) expect(stats[key], key).toBe(false)
    expect(a.denied).toEqual([])
    expect(b.denied).toEqual([])

    await test.info().attach('spry-room-relay-guest', { contentType: 'application/json', body: JSON.stringify({
      guestHadPairing: false, guestHadRelaySettings: false, guestImportedFile: false,
      guestCredentialRequests: b.spryPosts.get('/v1/credentials'), guestGrantRequests: 0,
      distinctCredentialSigners: stats.distinctCredentialSigners, distinctUsernames: logins.length,
      relayOnly: true, selectedPair: 'relay/relay', relayProtocol: 'tcp',
      creator: aMedia.map(({ frames, energy, audioBytes, videoBytes, sentBytes }) => ({ frames, energy, audioBytes, videoBytes, sentBytes })),
      guest: bMedia.map(({ frames, energy, audioBytes, videoBytes, sentBytes }) => ({ frames, energy, audioBytes, videoBytes, sentBytes })),
      nodeBinarySha256: stats.nodeBinarySha256, relayBinarySha256: stats.relayBinarySha256,
      externalRequests: [...a.denied, ...b.denied],
      separateNetworks: false, publicPkiQualified: false, physicalDevices: false,
    }, null, 2) })
  } finally { await Promise.all([a, b].map(d => d.context.close())) }
})

/**
 * A room whose Spry offer a guest can no longer redeem. The first guest proves
 * the offer worked; then the node loses the grant (the owner removes the
 * pairing) or goes away, and a second, fresh guest tries to call.
 */
async function refusedCall(browser: Browser, baseURL: string, request: APIRequestContext, lose: 'revoke' | 'stop') {
  const [a, b, c] = await Promise.all([0, 1, 2].map(() => device(browser, baseURL)))
  try {
    await pairThisBrowser(a.page, baseURL, request)
    const link = await createRoom(a.page, baseURL)
    await open(b.page, link, 'Rowan'); await join(b.page)
    const issued = b.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/credentials' && response.status() === 200, { timeout: 30_000 })
    await b.page.locator('#callToggle').click()
    await issued
    expect(await request.post(`${FACADE}/fixture/${lose === 'revoke' ? 'revoke' : 'stop-node'}`).then(r => r.ok())).toBe(true)

    await open(c.page, link, 'Cleo'); await join(c.page)
    await expect(c.page.locator('#roomArea')).toBeVisible()
    await c.page.locator('#callToggle').click()
    await expect(c.page.locator('#status')).toContainText(REFUSAL, { timeout: 30_000 })
    const refusal = await c.page.locator('#status').innerText()
    expect(refusal, 'a guest is not pointed at a pairing it does not have').not.toMatch(/pairing|Connections/)
    // No peer connection was created, so nothing can have gone direct.
    expect(await c.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length)).toBe(0)
    expect(c.spryPosts.get('/v1/credentials') ?? 0, 'the refused guest did ask the node').toBeGreaterThanOrEqual(1)
    expect(await stored(c.page, 'kithmoot.spry-pairing.v1')).toBeNull()
    // Room chat survives the refusal.
    await c.page.locator('#chatInput').fill('Chat survives a refused relay')
    await c.page.locator('#chatInput').press('Enter')
    await expect(a.page.locator('#chatLog')).toContainText('Chat survives a refused relay')
    expect([...a.denied, ...b.denied, ...c.denied]).toEqual([])
    await test.info().attach(`spry-room-relay-refusal-${lose}`, { contentType: 'application/json', body: JSON.stringify({
      reason: lose === 'revoke' ? 'owner removed the pairing' : 'node stopped', relayOnly: true,
      guestPeerConnections: 0, guestStatus: refusal, chatSurvived: true,
    }, null, 2) })
  } finally {
    await Promise.all([a, b, c].map(d => d.context.close()))
    if (lose === 'stop') await request.post(`${FACADE}/fixture/start-node`)
  }
}

test('a relay-only guest is refused, not sent direct, when the owner has removed the pairing', async ({ browser, baseURL, request }) => {
  await refusedCall(browser, baseURL!, request, 'revoke')
})

test('a relay-only guest is refused, not sent direct, when the node is down', async ({ browser, baseURL, request }) => {
  await refusedCall(browser, baseURL!, request, 'stop')
})
