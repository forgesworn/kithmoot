import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { generateSecretKey, getPublicKey, finalizeEvent, type EventTemplate } from 'nostr-tools/pure'
import { newDeviceContext, openCallSettings, closeSettings, openNewRoomForm, SYNTHETIC_MIC } from './browser.js'
import { signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'
import { writeFileSync } from 'node:fs'
import { localIdentity } from '../src/identity.js'
import { buildGrant } from '../src/group-grants.js'
import { readNodeRoom, signNodeRoom } from '@forgesworn/fold-kit/node-room'
import { claimKithmootNode, enrolNodeRoom, nodeTurnCredentials, parseKithmootNodePairingLink, postNodeGrant, queryNodeAccess } from '../src/kithmoot-node.js'
// @ts-expect-error - raw STUN wire fixture is plain ESM.
import { turnWire } from './node-turn-wire.mjs'

// Opt-in, disposable local node on the `tiny` profile: eight relay ports.
// Raw TURN clients on a separate scratch room hold ports so that the two
// browser devices meet a full node, then the test lets them go.
const COPY = "This node has no more room for calls. Space frees up when someone leaves a call."
const TURN = { udpTcp: 34780, tls: 53489 }

test('a full node says so instead of showing a silent call', async ({ baseURL }, info) => {
  test.skip(process.env.E2E_NODE_CALLS_FULL !== 'local-only', 'explicit disposable local node check')
  test.setTimeout(300_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { turnPorts: TURN, relayPortCount: 8 })
  const browser = await chromium.launch({ args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection',
    '--host-resolver-rules=MAP node.example 127.0.0.1,MAP turn.node.example 127.0.0.1',
  ] }).catch(async error => { await fixture.close(); throw error })
  const contexts: BrowserContext[] = [], pages: Page[] = [], errors: string[] = [], evidence: unknown[] = []
  const held: Array<{ close(): void }> = []
  const ownerKey = generateSecretKey(), owner = localIdentity(ownerKey)
  const fetcher = ((url: string, init: RequestInit) => fetch((new URL(url).pathname === '/v1/credentials' ? fixture.calls : fixture.desk) + new URL(url).pathname, init)) as typeof fetch
  const iceErrors = (page: Page) => page.evaluate(() => (window as unknown as { __iceErrors: unknown[] }).__iceErrors)
  try {
    // The scratch room and its device take ports exactly as a second call would.
    const at = Math.floor(Date.now() / 1000)
    const pair = await claimKithmootNode(parseKithmootNodePairingLink(fixture.pairing()), owner, { fetcher })
    const scratch = '55'.repeat(32), node = readNodeRoom(signNodeRoom({ authoritySk: ownerKey, room: scratch, serviceKey: pair.serviceKey, origin: pair.origin, turnPorts: TURN, now: at }), at)!
    await enrolNodeRoom(pair, node, owner, { fetcher })
    const other = localIdentity(generateSecretKey()), grantId = '9'.repeat(32)
    await postNodeGrant(node, buildGrant({ authoritySk: ownerKey, roomId: scratch, device: other.pubkey, server: 'node.example',
      scopes: ['turn', 'relay-read', 'relay-write'], grantId, createdAt: at, expiration: at + 3600 }), owner, { fetcher })
    const access = await queryNodeAccess(node, grantId, other, { fetcher })
    if (access.state !== 'active') throw Error('Missing scratch device access')
    const login = await nodeTurnCredentials(node, access, other, { fetcher })
    async function hold(count: number) {
      for (let index = 0; index < count; index++) {
        const client = await turnWire({ protocol: 'udp', port: TURN.udpTcp }); held.push(client)
        expect((await client.authenticate(login)).type, 'scratch allocation').toBe(0x0103)
      }
    }
    function release() { for (const client of held.splice(0)) client.close() }

    async function device(index: number) {
      const context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 860 } })
      contexts.push(context); await context.addInitScript(SYNTHETIC_MIC)
      await context.addInitScript(() => {
        const state = window as unknown as { __iceErrors: Array<{ code: number; url: string; text: string }>; __pcs: RTCPeerConnection[] }; state.__iceErrors = []; state.__pcs = []
        const Base = window.RTCPeerConnection
        window.RTCPeerConnection = class extends Base {
          constructor(configuration?: RTCConfiguration) {
            // Only the synthetic hostname is resolved. The error event gets its
            // original URL back, as a real node's error would carry it.
            const original = new Map<string, string>()
            const resolve = (url: string) => {
              const local = url.replace(/^(stun:|turn:|turns:)(?:turn\.)?node\.example(?=:)/, (_match, scheme: string) => `${scheme}127.0.0.1`)
              original.set(local, url); return local
            }
            super(configuration && { ...configuration, iceServers: configuration.iceServers?.map(server => ({ ...server,
              urls: typeof server.urls === 'string' ? resolve(server.urls) : server.urls.map(resolve) })) })
            state.__pcs.push(this)
            this.addEventListener('icecandidateerror', event => {
              const url = original.get(event.url)
              if (url) Object.defineProperty(event, 'url', { value: url })
              state.__iceErrors.push({ code: event.errorCode, url: event.url, text: event.errorText.slice(0, 200) })
            })
          }
        }
      })
      await context.grantPermissions(['camera', 'microphone', 'local-network-access'], { origin: new URL(baseURL!).origin })
      if (index === 0) {
        await context.exposeFunction('fullPublicKey', () => getPublicKey(ownerKey))
        await context.exposeFunction('fullSign', (value: EventTemplate) => finalizeEvent(value, ownerKey))
        await context.addInitScript(() => {
          const state = window as unknown as { fullPublicKey(): Promise<string>; fullSign(event: unknown): Promise<unknown> }
          Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => state.fullPublicKey(), signEvent: (event: unknown) => state.fullSign(event) } })
        })
      }
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, accountRelay }) => {
        const Base = window.WebSocket
        window.WebSocket = class extends Base {
          constructor(url: string | URL, protocols?: string | string[]) {
            const value = String(url)
            super(value === 'wss://node.example/events' ? node : value.includes('localhost') ? value : accountRelay, protocols)
          }
        }
      }, { node: fixture.websocket, accountRelay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname
        await route.fulfill({ response: await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path }) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => { if (page.url().startsWith(new URL(baseURL!).origin + '/')) errors.push(`device ${index}: ${error.message}`) })
      pages.push(page); return page
    }

    const keeper = await device(0)
    await signInAccount(keeper, baseURL!); await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing()); await keeper.locator('#nodePair').click()
    await keeper.locator('#actionConfirm').click(); await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(keeper); await openNewRoomForm(keeper)
    await keeper.locator('#roomName').fill('Calls full check')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Creator')
    await expect(keeper.locator('#roomOnNode')).toBeChecked(); await keeper.locator('#create').click()
    await expect(keeper.locator('#chatInput')).toBeVisible()
    const guest = await device(1)
    await guest.goto(keeper.url())
    await expect.poll(async () => await guest.locator('#chatInput').isVisible() || await guest.locator('#actionConfirm').isVisible(), { timeout: 30000 }).toBe(true)
    if (await guest.locator('#actionConfirm').isVisible()) await guest.locator('#actionConfirm').click()
    const card = keeper.locator('.approvalCard.knock')
    await expect(card).toHaveCount(1); await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 30000 })

    // 1. Seven of eight ports held: the call starts while the node still has
    // a port, the relay refuses the rest with 486, and each refused device
    // says so at once rather than after the grace a bystander waits.
    await hold(7)
    await keeper.locator('#callToggle:visible').click(); await expect(keeper.locator('#deviceControls')).toBeVisible()
    const joined = Date.now()
    await guest.locator('#callToggle:visible').click(); await expect(guest.locator('#deviceControls')).toBeVisible()
    const shown: number[] = []
    await Promise.all([keeper, guest].map(async (page, index) => {
      await expect(page.locator('#nodeCallsFullNote')).toBeVisible({ timeout: 30000 })
      shown[index] = Date.now() - joined
      await expect(page.locator('#nodeCallsFullNote')).toHaveText(COPY)
    }))
    const refused = await Promise.all(pages.map(async page => (await iceErrors(page) as Array<{ code: number; url: string }>)
      .some(error => error.code === 486 && error.url.startsWith('turn:node.example:'))))
    expect(refused.some(Boolean), 'a device must meet the relay limit').toBe(true)
    for (const [index, wasRefused] of refused.entries())
      if (wasRefused) expect(shown[index], `device ${index} was refused and must say so before the grace`).toBeLessThan(5000)
    evidence.push({ step: 'refused in call', shownAfterMillis: shown, refused, capacity: fixture.supervisor!.callCapacity(), relay: await fixture.relayMetrics(), iceErrors: await Promise.all(pages.map(iceErrors)) })
    await keeper.screenshot({ path: info.outputPath('in-call-full.png') })
    for (const page of [keeper, guest]) await page.getByRole('button', { name: 'Leave call', exact: true }).click()
    for (const page of [keeper, guest]) await expect(page.locator('#nodeCallsFullNote')).toBeHidden()

    // 2. Every port held: the node reports full and a new call is refused
    // before the in-call view opens.
    await hold(1)
    await expect.poll(() => fixture.supervisor!.callCapacity()?.full, { timeout: 30000 }).toBe(true)
    // Each device reads the node's answer on its 5 s access refresh.
    await guest.waitForTimeout(11000)
    await guest.locator('#callToggle:visible').click()
    await expect(guest.locator('#status')).toContainText(COPY, { timeout: 10000 })
    await expect(guest.locator('#deviceControls')).toBeHidden()
    await guest.screenshot({ path: info.outputPath('start-refused.png') })
    evidence.push({ step: 'start refused', capacity: fixture.supervisor!.callCapacity() })

    // 3. The other call ends: the same two devices now connect, no note.
    release()
    await expect.poll(() => fixture.supervisor!.callCapacity()?.full, { timeout: 30000 }).toBe(false)
    await guest.waitForTimeout(6000)
    for (const page of [keeper, guest]) { await page.locator('#callToggle:visible').click(); await expect(page.locator('#deviceControls')).toBeVisible() }
    for (const page of [keeper, guest]) await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.some(pc => pc.connectionState === 'connected')), { timeout: 60000 }).toBe(true)
    await guest.waitForTimeout(6000)
    for (const page of [keeper, guest]) await expect(page.locator('#nodeCallsFullNote')).toBeHidden()
    evidence.push({ step: 'released', capacity: fixture.supervisor!.callCapacity(), relay: await fixture.relayMetrics() })
    expect(errors).toEqual([])
  } finally {
    evidence.push({ final: true, capacity: fixture.supervisor?.callCapacity(), relay: await fixture.relayMetrics().catch(() => null),
      iceErrors: await Promise.all(pages.map(page => iceErrors(page).catch(() => null))) })
    evidence.push({ screens: await Promise.all(pages.map(page => page.locator('body').innerText({ timeout: 5000 }).catch(() => 'unavailable'))) })
    const file = info.outputPath('node-calls-full.json'); writeFileSync(file, JSON.stringify({ evidence, errors }, null, 2))
    await info.attach('node-calls-full.json', { path: file, contentType: 'application/json' })
    for (const client of held) client.close()
    await Promise.allSettled(contexts.map(context => context.close()))
    try { await browser.close() } finally { await fixture.close(); ownerKey.fill(0) }
  }
})
