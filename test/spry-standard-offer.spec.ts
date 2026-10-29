import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { createRoom, join, open, newDeviceContext, turnOnMedia, SYNTHETIC_MIC } from './browser.js'
import { RELAY_ONLY_NO_RELAY } from '../app/src/relay-only.js'

/**
 * A member runs the built-in call relay (`spry-node supervised`, spry-turn
 * S2) and a guest with no Spry of their own uses it: the guest's app sees
 * another member's standard `spry:` offer in the room, redeems it over the
 * encrypted control channel and calls through it. With Hide my IP address on,
 * the guest is first asked once, by the host's name, because the host will
 * see their address; the answer is remembered on that device for that host.
 *
 * Everything runs on loopback against test/spry-supervised-fixture.mjs; see
 * playwright.spry-standard-offer.config.ts for what it needs.
 */

const FIXTURE = `http://127.0.0.1:${process.env.E2E_SPRY_FIXTURE_PORT ?? 7797}`
const CONTROL_HOST = 'control.example'
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']
// The node binds and advertises 127.0.0.1; only this acceptance build admits it.
const TURN_URL = /^turn:127\.0\.0\.1:\d{4,5}\?transport=(udp|tcp)$/
const SPRY_USERNAME = /^\d{1,12}:[a-f0-9]{24}$/
const HOST_NAME = 'Ada'
// The host's participant key, fixed so the spec knows whom the guest's choice names.
const HOST_PARTICIPANT_SECRET = bytesToHex(new Uint8Array(32).fill(41))
const HOST_PARTICIPANT = getPublicKey(hexToBytes(HOST_PARTICIPANT_SECRET))
const PAIRING_SECRET = process.env.E2E_SPRY_PAIRING_SECRET ?? ''

interface Device { context: BrowserContext; page: Page; denied: string[]; control: string[] }

async function device(browser: Browser, baseURL: string, { hideIp = true, host }: { hideIp?: boolean; host?: { endpoint: string; id: string } } = {}): Promise<Device> {
  const context = await newDeviceContext(browser, baseURL, { viewport: { width: 1280, height: 800 } })
  const denied: string[] = [], control: string[] = []
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!LOOPBACK.includes(url.hostname)) { denied.push(url.origin); return route.abort('blockedbyclient') }
    return route.continue()
  })
  await context.routeWebSocket(/.*/, socket => {
    const { hostname, origin } = new URL(socket.url())
    // The node's control relay: every socket to it is a Spry control request.
    if (hostname === CONTROL_HOST) { control.push(origin); socket.connectToServer(); return }
    if (!LOOPBACK.includes(hostname)) { denied.push(origin); socket.close(); return }
    socket.connectToServer()
  })
  await context.addInitScript(SYNTHETIC_MIC)
  await context.addInitScript(({ hide, pairing, participant, pairingSecret, hostParticipant }) => {
    if (hide) localStorage.setItem('kithmoot.hide-ip.v1', '1')
    localStorage.setItem('kithmoot.profiles.enabled', 'false')
    // The host's app holds its own node's pairing, as the desktop app will.
    if (pairing) {
      localStorage.setItem('kithmoot.participant', participant)
      localStorage.setItem('kithmoot.spry-pairing.v1', JSON.stringify({ v: 1, endpoint: pairing.endpoint, id: pairing.id, secretKey: pairingSecret, participant: hostParticipant }))
    }
  }, { hide: hideIp, pairing: host, participant: HOST_PARTICIPANT_SECRET, pairingSecret: PAIRING_SECRET, hostParticipant: HOST_PARTICIPANT })
  const page = await context.newPage()
  return { context, page, denied, control }
}

const pairing = async (request: APIRequestContext) => (await request.get(`${FIXTURE}/fixture/pairing`)).json() as Promise<{ endpoint: string; id: string }>
const stored = (page: Page, key: string) => page.evaluate(k => localStorage.getItem(k), key)
const choice = (page: Page) => page.getByRole('alertdialog', { name: `Use ${HOST_NAME}'s relay?` })

interface Row { policy: string; servers: { urls: string[]; username?: string }[]; frames: number; audioBytes: number; videoBytes: number; sentBytes: number; local?: string; remote?: string; protocol?: string; url?: string }
async function sample(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const rows: Row[] = []
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) {
      if (pc.connectionState !== 'connected') continue
      const config = pc.getConfiguration(), report = await pc.getStats()
      let frames = 0, audioBytes = 0, videoBytes = 0, sentBytes = 0
      let pair: RTCStats | undefined
      report.forEach(stat => {
        if (stat.type === 'inbound-rtp' && stat.kind === 'video') { frames += stat.framesDecoded ?? 0; videoBytes += stat.bytesReceived ?? 0 }
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') audioBytes += stat.bytesReceived ?? 0
        if (stat.type === 'outbound-rtp') sentBytes += stat.bytesSent ?? 0
        if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = report.get(stat.selectedCandidatePairId)
      })
      const local = pair ? report.get((pair as unknown as { localCandidateId: string }).localCandidateId) : undefined
      const remote = pair ? report.get((pair as unknown as { remoteCandidateId: string }).remoteCandidateId) : undefined
      rows.push({ policy: config.iceTransportPolicy ?? 'all', frames, audioBytes, videoBytes, sentBytes,
        servers: (config.iceServers ?? []).map(server => ({ urls: [server.urls].flat(), username: server.username })),
        local: local?.candidateType, remote: remote?.candidateType, protocol: local?.relayProtocol, url: local?.url })
    }
    return rows
  })
}

/** Media moving on the one remote leg, relay to relay through the node. */
async function relayedThroughNode(page: Page, who: string): Promise<Row> {
  let rows: Row[] = []
  await expect.poll(async () => { rows = await sample(page); return rows.filter(row => row.frames > 5 && row.audioBytes > 0 && row.local && row.remote).length },
    { timeout: 60_000, message: `${who}: decoded video and received audio over a selected pair` }).toBe(1)
  const [row] = rows
  expect(row.policy, `${who} iceTransportPolicy`).toBe('relay')
  expect(row.servers.length, `${who} ICE servers`).toBeGreaterThan(0)
  for (const server of row.servers) {
    for (const url of server.urls) expect(url, `${who} ICE URL`).toMatch(TURN_URL)
    expect(server.username, `${who} username`).toMatch(SPRY_USERNAME)
  }
  expect([row.local, row.remote], `${who} selected pair`).toEqual(['relay', 'relay'])
  expect(row.url, `${who} relay candidate server`).toMatch(TURN_URL)
  expect(row.sentBytes, `${who} sent bytes`).toBeGreaterThan(0)
  return row
}

test('a guest with Hide my IP address is asked once by name, then calls through a member\'s built-in relay, relay only', async ({ browser, baseURL, request }) => {
  const host = await device(browser, baseURL!, { host: await pairing(request) })
  const guest = await device(browser, baseURL!)
  try {
    const link = await createRoom(host.page, baseURL!, undefined, HOST_NAME)
    await turnOnMedia(host.page)
    // The host's own calls use its own relay, with no question.
    await expect(choice(host.page)).toHaveCount(0)
    expect(host.control.length, 'the host reached its node over control').toBeGreaterThan(0)

    await open(guest.page, link, 'Rowan')
    await join(guest.page)
    await expect(guest.page.locator('#callToggle:visible')).toBeVisible()
    await guest.page.locator('#callToggle:visible').click()
    const dialog = choice(guest.page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog).toContainText(`${HOST_NAME} will see your address; others won't.`)
    expect(guest.control, 'nothing is sent to the member\'s relay before the choice').toEqual([])
    await guest.page.screenshot({ path: test.info().outputPath('member-relay-choice.png') })
    await dialog.getByRole('button', { name: 'Use relay' }).click()
    await expect(guest.page.locator('#deviceControls')).toBeVisible({ timeout: 30_000 })
    await turnOnMedia(guest.page)

    const [hostRow, guestRow] = await Promise.all([relayedThroughNode(host.page, 'host'), relayedThroughNode(guest.page, 'guest')])
    expect(guestRow.servers.find(server => server.username)!.username).not.toBe(hostRow.servers.find(server => server.username)!.username)
    expect(guest.control.length, 'the guest redeemed over control').toBeGreaterThan(0)
    expect(await stored(guest.page, 'kithmoot.spry-pairing.v1'), 'the guest stays unpaired').toBeNull()
    expect(JSON.parse(await stored(guest.page, 'kithmoot.spry-consent.v1') ?? '[]')).toEqual([expect.stringMatching(new RegExp(`^[0-9a-f]{64}:${HOST_PARTICIPANT}$`))])

    // Remembered for this host: leaving and joining again asks nothing.
    await guest.page.locator('#leaveCall').click()
    await expect(guest.page.locator('#deviceControls')).toBeHidden({ timeout: 30_000 })
    await guest.page.locator('#callToggle:visible').click()
    await expect(guest.page.locator('#deviceControls')).toBeVisible({ timeout: 30_000 })
    await expect(choice(guest.page)).toHaveCount(0)
    await turnOnMedia(guest.page)
    await relayedThroughNode(guest.page, 'guest, again')
    expect([...host.denied, ...guest.denied]).toEqual([])

    const stats = await (await request.get(`${FIXTURE}/fixture/stats`)).json()
    await test.info().attach('spry-standard-offer-guest', { contentType: 'application/json', body: JSON.stringify({
      hideMyIp: true, askedOnce: true, rememberedForHost: true, relayOnly: true, selectedPair: 'relay/relay',
      guestProtocol: guestRow.protocol, hostProtocol: hostRow.protocol, nodeUrls: stats.urls, nodeBinarySha256: stats.nodeBinarySha256,
      externalRequests: [...host.denied, ...guest.denied], loopbackOnly: true, separateNetworks: false, physicalDevices: false,
    }, null, 2) })
  } finally { await Promise.all([host, guest].map(d => d.context.close())) }
})

test('a guest with Hide my IP address who says Not now is refused, never sent direct, and never reaches the relay', async ({ browser, baseURL, request }) => {
  const host = await device(browser, baseURL!, { host: await pairing(request) })
  const guest = await device(browser, baseURL!)
  try {
    const link = await createRoom(host.page, baseURL!, undefined, HOST_NAME)
    await open(guest.page, link, 'Cleo')
    await join(guest.page)
    await guest.page.locator('#callToggle:visible').click()
    const dialog = choice(guest.page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await expect(guest.page.locator('#status')).toContainText(RELAY_ONLY_NO_RELAY, { timeout: 30_000 })
    expect(await guest.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length), 'no peer connection, so nothing went direct').toBe(0)
    expect(guest.control, 'the guest never contacted the member\'s relay').toEqual([])
    expect(await stored(guest.page, 'kithmoot.spry-consent.v1')).toBeNull()
    expect([...host.denied, ...guest.denied]).toEqual([])
  } finally { await Promise.all([host, guest].map(d => d.context.close())) }
})

test('a guest without Hide my IP address uses a member\'s built-in relay without being asked', async ({ browser, baseURL, request }) => {
  const host = await device(browser, baseURL!, { host: await pairing(request) })
  const guest = await device(browser, baseURL!, { hideIp: false })
  try {
    const link = await createRoom(host.page, baseURL!, undefined, HOST_NAME)
    await turnOnMedia(host.page)
    await open(guest.page, link, 'Sam')
    await join(guest.page)
    await turnOnMedia(guest.page)
    await expect(choice(guest.page)).toHaveCount(0)
    // The node's credential reaches the guest's connection; its address is in
    // the call's own candidates anyway, so nothing more is revealed.
    await expect.poll(() => guest.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
      .flatMap(pc => (pc.getConfiguration().iceServers ?? []).flatMap(server => [server.urls].flat()))), { timeout: 60_000 })
      .toEqual(expect.arrayContaining([expect.stringMatching(TURN_URL)]))
    expect(guest.control.length, 'the guest redeemed over control').toBeGreaterThan(0)
    expect(await stored(guest.page, 'kithmoot.spry-consent.v1')).toBeNull()
    expect([...host.denied, ...guest.denied]).toEqual([])
  } finally { await Promise.all([host, guest].map(d => d.context.close())) }
})
