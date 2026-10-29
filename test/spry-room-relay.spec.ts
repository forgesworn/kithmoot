import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRoom, join, open, newDeviceContext, openRoomInfoPage, turnOnMedia, SYNTHETIC_MIC } from './browser.js'
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

interface Device { context: BrowserContext; page: Page; denied: string[]; spryPosts: Map<string, number>; signers: Map<string, Set<string>> }

/** A fresh browser profile: no pairing, no relay settings, no imported file.
 *  Hide my IP address is on unless `hideIp` is false. */
async function device(browser: Browser, baseURL: string, hideIp = true): Promise<Device> {
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
  await context.addInitScript(hide => {
    // Hide my IP address on calls: relay-only ICE, chosen on this device.
    if (hide) localStorage.setItem('kithmoot.hide-ip.v1', '1')
    localStorage.setItem('kithmoot.profiles.enabled', 'false')
  }, hideIp)
  const page = await context.newPage()
  const spryPosts = new Map<string, number>()
  // Who signed each Spry request: a credential request's signer is the
  // device's room Spry key, the spryKey its roster entry announces.
  const signers = new Map<string, Set<string>>()
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().startsWith(ENDPOINT + '/v1/')) return
    const path = new URL(request.url()).pathname
    spryPosts.set(path, (spryPosts.get(path) ?? 0) + 1)
    try {
      const signer = JSON.parse(Buffer.from(String(request.headers().authorization).slice(6), 'base64').toString()).pubkey
      if (typeof signer === 'string') signers.set(path, new Set([...(signers.get(path) ?? []), signer]))
    } catch { /* unsigned */ }
  })
  return { context, page, denied, spryPosts, signers }
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

/** With Hide my IP address on, another member's relay is used only after a
 *  one-time question naming them (the same for an `https:` relay as for a
 *  built-in one). The wording is fixed; the name is whoever hosts it. */
const relayChoice = (page: Page) => page.getByRole('alertdialog', { name: /^Use .+'s relay\?$/ })
async function answerRelayChoice(page: Page, name: string | undefined, button: 'Use relay' | 'Not now' = 'Use relay') {
  const dialog = relayChoice(page)
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  // A host who has left no longer has a name on the roster: the key stands in.
  if (name) {
    await expect(dialog).toHaveAccessibleName(`Use ${name}'s relay?`)
    await expect(dialog).toContainText(`${name} will see your address; others won't.`)
  } else await expect(dialog).toContainText(/will see your address; others won't\./)
  await dialog.getByRole('button', { name: button }).click()
}

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
const registeredOnNode = async (request: APIRequestContext, key: string) =>
  (await (await request.get(`${FACADE}/fixture/registered?k=${key}`)).json()).registered as boolean
/** The room's grant token, as a device that holds it saved it. */
const savedToken = (page: Page) => page.evaluate(() => {
  const offers = JSON.parse(localStorage.getItem('kithmoot.spry-rooms.v1') ?? '{}') as Record<string, { token: string }>
  return Object.values(offers)[0]?.token
})
const credentialSigner = (d: Device) => [...(d.signers.get('/v1/credentials') ?? [])][0]
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
    // Hide my IP address is on: the creator is named once before their relay is used.
    const asked = answerRelayChoice(b.page, 'Ada')
    await turnOnMedia(b.page)
    await asked
    expect(JSON.parse(await stored(b.page, 'kithmoot.spry-consent.v1') ?? '[]'), 'the choice is remembered for the creator').toHaveLength(1)
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

    // The owner's app registered the guest's room Spry key, and its own, and
    // sealed the grant: nobody here is an older client.
    expect(a.spryPosts.get('/v1/grants/devices') ?? 0, 'owner registrations').toBeGreaterThanOrEqual(1)
    expect(b.spryPosts.get('/v1/grants/devices') ?? 0, 'a guest never registers').toBe(0)
    expect(await registeredOnNode(request, credentialSigner(b)!), 'guest key registered').toBe(true)
    expect(await registeredOnNode(request, credentialSigner(a)!), 'owner key registered').toBe(true)
    expect(stats.sealed, 'grant sealed').toBe(true)
    // A copy of the token in a browser that never joined the room is refused.
    const token = await savedToken(b.page)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await (await request.post(`${FACADE}/fixture/leak`, { data: { token } })).json()).status, 'leaked token refused').toBe(403)

    await test.info().attach('spry-room-relay-guest', { contentType: 'application/json', body: JSON.stringify({
      guestHadPairing: false, guestHadRelaySettings: false, guestImportedFile: false,
      guestCredentialRequests: b.spryPosts.get('/v1/credentials'), guestGrantRequests: 0,
      guestRegistered: true, sealed: true, leakedTokenStatus: 403,
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
    const issued = b.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/credentials' && response.status() === 200, { timeout: 60_000 })
    const askedB = answerRelayChoice(b.page, 'Ada')
    await b.page.locator('#callToggle').click()
    await askedB
    await issued
    expect(await request.post(`${FACADE}/fixture/${lose === 'revoke' ? 'revoke' : 'stop-node'}`).then(r => r.ok())).toBe(true)

    await open(c.page, link, 'Cleo'); await join(c.page)
    await expect(c.page.locator('#roomArea')).toBeVisible()
    // Asked and agreed, so the refusal comes from the relay itself.
    const askedC = answerRelayChoice(c.page, 'Ada')
    await c.page.locator('#callToggle').click()
    await askedC
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

test('a member vouches a newcomer in while the owner is away, and without Hide my IP it calls through the room\'s relay via a marked copy; with it, the copy is ignored', async ({ browser, baseURL, request }) => {
  // The owner and Rowan have Hide my IP address on; Rowan agreed to use the
  // owner's relay, so Rowan keeps the offer in the room as a marked copy.
  // With the owner gone, Cleo (Hide my IP off) is vouched in and calls through
  // the copy; Dev (Hide my IP on) cannot be told whose relay it is, so is
  // refused rather than asked about the wrong member.
  const [a, b, c, d] = await Promise.all([true, true, false, true].map(hide => device(browser, baseURL!, hide)))
  expect((await request.post(`${FACADE}/fixture/reset`)).ok()).toBe(true)
  try {
    await pairThisBrowser(a.page, baseURL!, request)
    const link = await createRoom(a.page, baseURL!)
    await open(b.page, link, 'Rowan'); await join(b.page)
    const issued = b.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/credentials' && response.status() === 200, { timeout: 60_000 })
    const askedB = answerRelayChoice(b.page, 'Ada')
    await turnOnMedia(b.page)
    await askedB
    await issued
    await expect.poll(async () => (await fixtureStats(request)).sealed, { timeout: 30_000 }).toBe(true)
    // The owner goes away, and with it every registrar.
    await a.context.close()

    const vouched = b.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/grants/vouch' && response.status() === 200, { timeout: 60_000 })
    await open(c.page, link, 'Cleo'); await join(c.page)
    await expect(c.page.locator('#roomArea')).toBeVisible()
    await vouched
    const relayed = c.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/credentials' && response.status() === 200, { timeout: 60_000 })
    await turnOnMedia(c.page)
    await relayed
    await expect(relayChoice(c.page)).toHaveCount(0)
    const rows = await movingRelayedMedia(c.page, 1)
    for (const row of rows) {
      // Rowan is relay-only, so the far end of every leg is Rowan's relay candidate.
      expect(row.servers.some(server => server.urls.some(url => TURN_URL.test(url)) && server.username && SPRY_USERNAME.test(server.username)), 'Cleo holds the room relay\'s login').toBe(true)
      expect(row.remote).toBe('relay')
    }
    expect(await stored(c.page, 'kithmoot.spry-consent.v1'), 'Cleo was never asked').toBeNull()
    expect(c.spryPosts.get('/v1/grants/vouch') ?? 0, 'the newcomer does not vouch for itself').toBe(0)
    expect(c.spryPosts.get('/v1/grants') ?? 0, 'the newcomer holds no grant').toBe(0)

    // Hide my IP on, the host away, only a copy left: no question, no relay.
    await open(d.page, link, 'Dev'); await join(d.page)
    await d.page.locator('#callToggle:visible').click()
    await expect(d.page.locator('#status')).toContainText(RELAY_ONLY_NO_RELAY, { timeout: 30_000 })
    await expect(relayChoice(d.page)).toHaveCount(0)
    expect(await d.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length), 'nothing went direct').toBe(0)
    expect(d.spryPosts.get('/v1/credentials') ?? 0, 'the relay was never contacted').toBe(0)
    expect(await stored(d.page, 'kithmoot.spry-consent.v1')).toBeNull()
    expect([...b.denied, ...c.denied, ...d.denied]).toEqual([])
    await test.info().attach('spry-room-relay-vouch', { contentType: 'application/json', body: JSON.stringify({
      ownerOnline: false, newcomerHideMyIp: false, viaMarkedCopy: true, voucherVouches: b.spryPosts.get('/v1/grants/vouch'),
      newcomerCredentialRequests: c.spryPosts.get('/v1/credentials'), hideMyIpGuestRefused: true,
    }, null, 2) })
  } finally { await Promise.all([b, c, d].map(x => x.context.close())); await a.context.close().catch(() => {}) }
})

test('in a room they did not make, paired members call through their own relays, and share only after the one-tap choice', async ({ browser, baseURL, request }) => {
  // The room's maker has no Spry; two paired members join it. Everyone has
  // Hide my IP address on.
  const [maker, paired, other] = await Promise.all([0, 1, 2].map(() => device(browser, baseURL!)))
  expect((await request.post(`${FACADE}/fixture/reset`)).ok()).toBe(true)
  try {
    await pairThisBrowser(paired.page, baseURL!, request)
    await pairThisBrowser(other.page, baseURL!, request)
    const link = await createRoom(maker.page, baseURL!)
    for (const [d, name] of [[paired, 'Rowan'], [other, 'Sam']] as const) { await open(d.page, link, name); await join(d.page) }

    // Each paired member's own calls go through its own node, relay only.
    await Promise.all([turnOnMedia(paired.page), turnOnMedia(other.page)])
    const rows = await movingRelayedMedia(paired.page, 1)
    for (const row of rows) {
      expect(row.policy).toBe('relay')
      expect([row.local, row.remote]).toEqual(['relay', 'relay'])
      expect(row.url).toMatch(TURN_URL)
    }
    expect(paired.spryPosts.get('/v1/grants') ?? 0, 'its own grant').toBeGreaterThanOrEqual(1)
    // Nothing of theirs reached the maker, who has nothing to call through.
    await maker.page.locator('#callToggle').click()
    await expect(maker.page.locator('#status')).toContainText(RELAY_ONLY_NO_RELAY, { timeout: 30_000 })
    expect(maker.spryPosts.size, 'the maker never contacted the node').toBe(0)
    expect(await maker.page.evaluate(() => localStorage.getItem('kithmoot.spry-rooms.v1'))).toBeNull()

    await openRoomInfoPage(paired.page, 'Privacy and connection')
    const row = paired.page.locator('#spryShareRow')
    await expect(row).toBeVisible()
    const toggle = row.getByRole('button', { name: 'Share my call relay here' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(row.locator('#spryShareNote')).toHaveText('Rooms you make use your call relay automatically. Turn this on to let everyone here use it too.')
    await paired.page.screenshot({ path: test.info().outputPath('spry-share-row-off.png') })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(row.locator('#spryShareNote')).toHaveText('Everyone in this room can make calls through your call relay.')
    await paired.page.screenshot({ path: test.info().outputPath('spry-share-row-on.png') })
    expect(await paired.page.evaluate(() => localStorage.getItem('kithmoot.spry-share.v1'))).toContain(':')

    // Now the maker calls through it, registered by the paired member's app.
    const relayed = maker.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/credentials' && response.status() === 200, { timeout: 60_000 })
    // The maker has Hide my IP address on: asked once, by the sharing member's name.
    const asked = answerRelayChoice(maker.page, 'Rowan')
    await maker.page.locator('#callToggle').click()
    await asked
    await relayed
    expect(await registeredOnNode(request, credentialSigner(maker)!), 'maker registered').toBe(true)

    // Off again: the shared grant is withdrawn, and a fresh one kept for itself.
    const grantsBefore = paired.spryPosts.get('/v1/grants') ?? 0
    const removed = paired.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/grants/remove' && response.status() === 200, { timeout: 30_000 })
    const regranted = paired.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/grants' && response.status() === 200, { timeout: 60_000 })
    await toggle.click()
    // Only a 200 from the node, which answers it after dropping the grant and its keys.
    await removed
    await regranted
    expect(paired.spryPosts.get('/v1/grants') ?? 0).toBe(grantsBefore + 1)
    expect((await fixtureStats(request)).removeRequests, 'one removal').toBe(1)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(paired.page.locator('#status')).toContainText('Your call relay is no longer shared in this room.')
    expect(await paired.page.evaluate(() => localStorage.getItem('kithmoot.spry-share.v1'))).toBeNull()
    expect([...maker.denied, ...paired.denied, ...other.denied]).toEqual([])
  } finally { await Promise.all([maker, paired, other].map(d => d.context.close())) }
})

test('a Hide my IP guest who says Not now is not sent to a member\'s https relay, and a guest without it is not asked', async ({ browser, baseURL, request }) => {
  const [a, b, c] = await Promise.all([true, true, false].map(hide => device(browser, baseURL!, hide)))
  expect((await request.post(`${FACADE}/fixture/reset`)).ok()).toBe(true)
  try {
    await pairThisBrowser(a.page, baseURL!, request)
    const link = await createRoom(a.page, baseURL!)
    await open(b.page, link, 'Rowan'); await join(b.page)
    const asked = answerRelayChoice(b.page, 'Ada', 'Not now')
    await b.page.locator('#callToggle').click()
    await asked
    await expect(b.page.locator('#status')).toContainText(RELAY_ONLY_NO_RELAY, { timeout: 30_000 })
    expect(await b.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length), 'nothing went direct').toBe(0)
    expect(b.spryPosts.get('/v1/credentials') ?? 0, 'the relay was never contacted').toBe(0)
    expect(await stored(b.page, 'kithmoot.spry-consent.v1')).toBeNull()

    // Without Hide my IP address the relay is used as before, unasked.
    await open(c.page, link, 'Sam'); await join(c.page)
    const used = c.page.waitForResponse(response => response.url() === ENDPOINT + '/v1/credentials' && response.status() === 200, { timeout: 60_000 })
    await c.page.locator('#callToggle').click()
    await used
    await expect(relayChoice(c.page)).toHaveCount(0)
    expect(await stored(c.page, 'kithmoot.spry-consent.v1')).toBeNull()
    expect([...a.denied, ...b.denied, ...c.denied]).toEqual([])
  } finally { await Promise.all([a, b, c].map(d => d.context.close())) }
})
