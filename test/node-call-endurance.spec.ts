import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { generateSecretKey, getPublicKey, finalizeEvent, type EventTemplate } from 'nostr-tools/pure'
import { newDeviceContext, openCallSettings, closeSettings, openNewRoomForm, turnOnMedia, SYNTHETIC_MIC } from './browser.js'
import { signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'
import { writeFileSync } from 'node:fs'
import { localIdentity } from '../src/identity.js'
import { buildGrant } from '../src/group-grants.js'
import { readNodeRoom, signNodeRoom } from '@forgesworn/fold-kit/node-room'
import { claimKithmootNode, enrolNodeRoom, nodeTurnCredentials, parseKithmootNodePairingLink, postNodeGrant, queryNodeAccess } from '../src/kithmoot-node.js'
// @ts-expect-error - raw STUN wire fixture is plain ESM.
import { turnWire } from './node-turn-wire.mjs'

// Opt-in, disposable local node only. These seven browser devices model six
// people, including two signed-in devices belonging to the creator. Synthetic
// capture and loopback TURN do not establish native-device or Internet quality.
const duration = Number(process.env.E2E_NODE_ENDURANCE_SECONDS ?? 120)
if (!Number.isInteger(duration) || duration < 120 || duration > 10_800) throw Error('Endurance duration must be 120..10800 seconds')

test('the configured node has enough authenticated TURN allocations for seven devices', async ({ baseURL }, info) => {
  test.skip(process.env.E2E_NODE_ENDURANCE !== 'local-only', 'explicit disposable local node qualification')
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { relayPortCount: 256, aggregateBytesPerSecond: 2000000 })
  const clients: Array<{ close(): void }> = []
  const results: Array<{ device: number; peer: number; type: number }> = []
  try {
    const fetcher = ((url: string, init: RequestInit) => fetch((new URL(url).pathname === '/v1/credentials' ? fixture.calls : fixture.desk) + new URL(url).pathname, init)) as typeof fetch
    const key = generateSecretKey(), owner = localIdentity(key), at = Math.floor(Date.now() / 1000)
    const pair = await claimKithmootNode(parseKithmootNodePairingLink(fixture.pairing()), owner, { fetcher })
    const room = '44'.repeat(32), node = readNodeRoom(signNodeRoom({ authoritySk: key, room, serviceKey: pair.serviceKey, origin: pair.origin, now: at }), at)!
    await enrolNodeRoom(pair, node, owner, { fetcher })
    for (let device = 0; device < 7; device++) {
      const identity = localIdentity(generateSecretKey()), grantId = String(device + 1).padStart(32, '0')
      const grant = buildGrant({ authoritySk: key, roomId: room, device: identity.pubkey, server: 'node.example',
        scopes: ['turn', 'relay-read', 'relay-write'], grantId, createdAt: at, expiration: at + 3600 })
      await postNodeGrant(node, grant, owner, { fetcher })
      const access = await queryNodeAccess(node, grantId, identity, { fetcher })
      expect(access.state).toBe('active')
      if (access.state !== 'active') throw Error('Missing fixture device access')
      const login = await nodeTurnCredentials(node, access, identity, { fetcher })
      for (let peer = 0; peer < 6; peer++) {
        const client = await turnWire({ protocol: 'udp', port: 3478 }); clients.push(client)
        const answer = await client.authenticate(login)
        results.push({ device, peer, type: answer.type })
      }
    }
    expect(results.filter(result => result.type === 0x0103), 'Seven full-mesh devices need at least 42 simultaneous allocations, before fallback or renewal').toHaveLength(42)
  } finally {
    const evidence = info.outputPath('turn-capacity.json'); writeFileSync(evidence, JSON.stringify(results, null, 2))
    await info.attach('turn-capacity.json', { path: evidence, contentType: 'application/json' })
    for (const client of clients) client.close()
    await fixture.close()
  }
})

interface ConnectionSample {
  local: string; remote: string; frames: number; energy: number; audio: number
  localType?: string; remoteType?: string; policy?: string
}
interface DeviceSample {
  connections: ConnectionSample[]; pictures: Array<{ track: string; hash: number; time: number }>; publicRoomWrites: number
  states: Array<{ connection: string; ice: string; gathering: string }>; iceErrors: Array<{ code: number; url: string; text: string }>
}

/** Each connection is bound to its opposite device by the SDP origin, rather
 * than summing traffic and allowing one healthy participant to hide a dead one. */
async function sample(): Promise<DeviceSample> {
  const state = window as unknown as { __pcs: RTCPeerConnection[]; __publicRoomWrites: number; __iceErrors: Array<{ code: number; url: string; text: string }> }
  const connections: ConnectionSample[] = []
  for (const pc of state.__pcs) {
    if (pc.connectionState !== 'connected') continue
    let report: RTCStatsReport
    try { report = await pc.getStats() } catch { continue }
    if (pc.connectionState !== 'connected') continue
    const row: ConnectionSample = {
      local: /^o=\S+ (\S+)/m.exec(pc.localDescription?.sdp ?? '')?.[1] ?? '',
      remote: /^o=\S+ (\S+)/m.exec(pc.remoteDescription?.sdp ?? '')?.[1] ?? '',
      frames: 0, energy: 0, audio: 0, policy: pc.getConfiguration().iceTransportPolicy,
    }
    report.forEach(value => {
      if (value.type === 'inbound-rtp') {
        if (value.kind === 'video') row.frames += value.framesDecoded ?? 0
        if (value.kind === 'audio') { row.energy += value.totalAudioEnergy ?? 0; row.audio += value.packetsReceived ?? 0 }
      }
      if (value.type === 'transport' && value.selectedCandidatePairId) {
        const pair = report.get(value.selectedCandidatePairId)
        row.localType = report.get(pair?.localCandidateId)?.candidateType
        row.remoteType = report.get(pair?.remoteCandidateId)?.candidateType
      }
    })
    connections.push(row)
  }
  const pictures: DeviceSample['pictures'] = []
  for (const video of document.querySelectorAll<HTMLVideoElement>('#room .participant video')) {
    if (video.closest('.participant')?.querySelector('h3')?.textContent?.includes('(you)')) continue
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0]
    if (!track || !video.videoWidth) continue
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24
    const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0, 32, 24)
    let hash = 0
    for (const value of context.getImageData(0, 0, 32, 24).data) hash = (hash * 31 + value) >>> 0
    pictures.push({ track: track.id, hash, time: video.currentTime })
  }
  return { connections, pictures, publicRoomWrites: state.__publicRoomWrites,
    states: state.__pcs.map(pc => ({ connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState })),
    iceErrors: state.__iceErrors }
}

test('seven node devices sustain every directed call pair through renewal, toggles and reconnect', async ({ baseURL }, info) => {
  test.skip(process.env.E2E_NODE_ENDURANCE !== 'local-only', 'explicit disposable local node qualification')
  expect(process.env.E2E_NODE_SPRY_BINARY).toBeTruthy(); expect(process.env.E2E_NODE_SHELTER_BINARY).toBeTruthy()
  test.setTimeout((duration + 600) * 1000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, {
    turnPorts: { udpTcp: 34790, tls: 53499 }, relayPortCount: 256, aggregateBytesPerSecond: 2000000,
  })
  const browser = await chromium.launch({ args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-loopback-in-peer-connection',
    '--host-resolver-rules=MAP node.example 127.0.0.1,MAP turn.node.example 127.0.0.1',
  ] }).catch(async error => { await fixture.close(); throw error })
  const contexts: BrowserContext[] = [], pages: Page[] = [], errors: string[] = []
  const checkpoints: unknown[] = [{ allocationPorts: 256, perCredentialAllocations: 32, tcpConnections: 256, aggregateBytesPerSecond: 2000000 }]
  const ownerKey = generateSecretKey()
  const credentials = Array.from({ length: 7 }, () => 0)
  try {
    function watch(page: Page, index: number) {
      page.on('pageerror', error => {
        // Context init scripts also run in about:blank, where media/storage
        // do not exist. Only errors from the actual app are qualification errors.
        if (page.url().startsWith(new URL(baseURL!).origin + '/')) errors.push(`device ${index}: ${error.message}`)
      })
    }
    async function device(index: number) {
      const context = await newDeviceContext(browser, baseURL!, {
        ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 860 },
      })
      contexts.push(context); await context.addInitScript(SYNTHETIC_MIC)
      await context.addInitScript(() => {
        const state = window as unknown as { __iceErrors: Array<{ code: number; url: string; text: string }> }; state.__iceErrors = []
        const Base = window.RTCPeerConnection
        window.RTCPeerConnection = class extends Base {
          constructor(configuration?: RTCConfiguration) {
            // Resolve only the synthetic ICE hostnames for this local run, after
            // the app has validated the original signed node/credential URLs.
            // Username, password, ports, protocols and relay policy are retained.
            const resolve = (url: string) => url.replace(/^(stun:|turn:|turns:)(?:turn\.)?node\.example(?=:)/,
              (_match, scheme: string) => `${scheme}127.0.0.1`)
            super(configuration && { ...configuration, iceServers: configuration.iceServers?.map(server => ({ ...server,
              urls: typeof server.urls === 'string' ? resolve(server.urls) : server.urls.map(resolve),
            })) })
            this.addEventListener('icecandidateerror', event => state.__iceErrors.push({ code: event.errorCode, url: event.url, text: event.errorText.slice(0, 200) }))
          }
        }
      })
      await context.grantPermissions(['camera', 'microphone', 'local-network-access'], { origin: new URL(baseURL!).origin })
      if (index < 2) {
        await context.exposeFunction('endurancePublicKey', () => getPublicKey(ownerKey))
        await context.exposeFunction('enduranceSign', (value: EventTemplate) => finalizeEvent(value, ownerKey))
        await context.addInitScript(() => {
          const state = window as unknown as { endurancePublicKey(): Promise<string>; enduranceSign(event: unknown): Promise<unknown> }
          Object.defineProperty(window, 'nostr', { configurable: true, value: {
            getPublicKey: () => state.endurancePublicKey(), signEvent: (event: unknown) => state.enduranceSign(event),
          } })
        })
      }
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, accountRelay }) => {
        const Base = window.WebSocket
        const state = window as unknown as { __publicRoomWrites: number; __nodeSockets: WebSocket[] }
        state.__publicRoomWrites = 0; state.__nodeSockets = []
        window.WebSocket = class extends Base {
          readonly node: boolean
          constructor(url: string | URL, protocols?: string | string[]) {
            const value = String(url), isNode = value === 'wss://node.example/events'
            // All ordinary account relays are also confined to the local fixture.
            if (!value.startsWith('wss://')) throw Error('Unexpected non-TLS fixture socket')
            super(isNode ? node : value.includes('localhost') ? value : accountRelay, protocols)
            this.node = isNode
            if (isNode) state.__nodeSockets.push(this)
          }
          override send(data: Parameters<WebSocket['send']>[0]): void {
            if (!this.node && typeof data === 'string') {
              const value = JSON.parse(data)
              if (value[0] === 'EVENT' && value[1]?.kind === 1460) state.__publicRoomWrites++
            }
            super.send(data)
          }
        }
      }, { node: fixture.websocket, accountRelay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/v1/credentials') credentials[index]!++
        await route.fulfill({ response: await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path }) })
      })
      const page = await context.newPage()
      watch(page, index)
      pages.push(page)
      return page
    }
    const keeper = await device(0)
    console.log('Node endurance: fixture ready; signing in creator')
    await signInAccount(keeper, baseURL!); await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing()); await keeper.locator('#nodePair').click()
    await keeper.locator('#actionConfirm').click(); await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(keeper); await openNewRoomForm(keeper)
    await keeper.locator('#roomName').fill('Disposable seven-device endurance')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Creator')
    await expect(keeper.locator('#roomOnNode')).toBeChecked(); await keeper.locator('#create').click()
    await expect(keeper.locator('#chatInput')).toBeVisible()
    const link = keeper.url()
    console.log('Node endurance: creator room open')
    for (let index = 1; index < 7; index++) {
      let page = await device(index)
      if (index === 1) {
        await signInAccount(page, baseURL!)
        // Open the invite in a fresh tab of this signed-in profile. A goto
        // differing only by a hash is a same-document navigation and does not
        // exercise the application's initial invite loader.
        await page.close(); page = await contexts[index]!.newPage(); watch(page, index); pages[index] = page
      }
      await page.goto(link)
      await expect.poll(async () => await page.locator('#chatInput').isVisible() || await page.locator('#actionConfirm').isVisible(), {
        message: `Device ${index} must open its saved access or offer the join confirmation`, timeout: 30000,
      }).toBe(true)
      if (await page.locator('#actionConfirm').isVisible()) await page.locator('#actionConfirm').click()
      if (index > 1) {
        const card = keeper.locator('.approvalCard.knock')
        await expect(card).toHaveCount(1)
        await card.getByRole('button', { name: 'Let in', exact: true }).click()
      }
      await expect(page.locator('#chatInput')).toBeVisible({ timeout: 30000 })
      console.log(`Node endurance: device ${index} admitted`)
    }
    await turnOnMedia(keeper)
    for (const page of pages.slice(1)) {
      await expect(page.locator('#callToggle')).toHaveAttribute('aria-label', 'Join call')
      await turnOnMedia(page)
    }
    console.log('Node endurance: all devices joined the call')
    // Two microphones belonging to one person must not feed back. The creator
    // explicitly takes its microphone and listening roles through the usual controls.
    if (await keeper.locator('#claimMic').isVisible()) await keeper.locator('#claimMic').click()
    if (await keeper.locator('#listenHere').isVisible()) await keeper.locator('#listenHere').click()
    if (await keeper.locator('#toggleMic').getAttribute('data-on') !== 'true') await keeper.locator('#toggleMic').click()
    await expect(keeper.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    // Capture may remain primed on the second device. Its role indicator,
    // rather than another mic click (which takes the role back), proves mute.
    await expect(pages[1]!.locator('#claimMic')).toBeVisible()

    let monitor = 0
    const snapshot = () => Promise.all(pages.map(page => page.evaluate(sample)))
    async function matrix(label: string) {
      let before: DeviceSample[] = [], after: DeviceSample[] = []
      for (let attempt = 0; attempt < 4; attempt++) {
        await expect.poll(async () => (await snapshot()).map(value => value.connections.length), {
          message: `${label}: every device needs six connected remote devices`, timeout: 60000,
        }).toEqual(Array(7).fill(6))
        before = await snapshot(); await keeper.waitForTimeout(2500); after = await snapshot()
        // Credential renewal may replace a native connection between samples.
        // Obtain a fresh stable window; counters from different connections
        // cannot be subtracted. Media failures within a stable window still fail.
        const stable = after.every((device, index) => device.connections.length === 6 && device.connections.every(row =>
          before[index]!.connections.some(old => old.local === row.local && old.remote === row.remote)))
        if (stable) break
        checkpoints.push({ label, measurementTransition: attempt + 1 })
        if (attempt === 3) throw Error(`${label}: native connections did not settle for measurement`)
      }
      for (let receiver = 0; receiver < 7; receiver++) {
        expect(after[receiver]!.publicRoomWrites, `${label}: device ${receiver} sent room traffic outside its node`).toBe(0)
        for (let sender = 0; sender < 7; sender++) {
          if (receiver === sender) continue
          const localSessions = new Set(after[sender]!.connections.map(row => row.local))
          const current = after[receiver]!.connections.filter(row => localSessions.has(row.remote))
          expect(current, `${label}: ${sender} -> ${receiver} must identify exactly one connection`).toHaveLength(1)
          const row = current[0]!, previous = before[receiver]!.connections.find(old => old.local === row.local && old.remote === row.remote)
          expect(previous, `${label}: ${sender} -> ${receiver} replaced its connection during measurement`).toBeDefined()
          expect(row.policy).toBe('relay'); expect(row.localType).toBe('relay'); expect(row.remoteType).toBe('relay')
          expect(row.frames, `${label}: ${sender} -> ${receiver} video stopped`).toBeGreaterThan(previous!.frames)
          // Device 1 is the creator's second, deliberately muted microphone.
          // All speaking-device packets arrive, including at the deliberately
          // muted second monitor. Audible energy follows the selected monitor.
          if (sender > 1 || sender === 0 && receiver > 1) {
            expect(row.audio, `${label}: ${sender} -> ${receiver} audio transport stopped`).toBeGreaterThan(previous!.audio)
            if (receiver > 1 || receiver === monitor)
              expect(row.energy, `${label}: ${sender} -> ${receiver} audio stopped`).toBeGreaterThan(previous!.energy)
          }
        }
        const advancing = after[receiver]!.pictures.filter(picture => before[receiver]!.pictures.some(old =>
          old.track === picture.track && picture.hash !== old.hash && picture.time > old.time))
        expect(advancing.length, `${label}: device ${receiver} has no moving rendered remote picture`).toBeGreaterThan(0)
      }
      checkpoints.push({ label, elapsedSeconds: Math.round((Date.now() - started) / 1000), credentials: [...credentials], samples: after })
      console.log(`Node endurance: ${label}; 42 directed video connections, relay/relay throughout`)
    }
    const started = Date.now()
    await matrix('initial')
    await pages[1]!.locator('#listenHere').click(); monitor = 1
    await expect(keeper.locator('#listenHere')).toBeVisible()
    await matrix('sound-on-second-device')
    await keeper.locator('#listenHere').click(); monitor = 0
    await expect(pages[1]!.locator('#listenHere')).toBeVisible()
    await matrix('sound-on-creator')
    // The creator's second camera can stop and resume without dropping the call.
    await pages[1]!.locator('#toggleCamera').click()
    await expect(pages[1]!.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')
    await pages[1]!.locator('#toggleCamera').click()
    await expect(pages[1]!.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await matrix('camera-resumed')
    const beforeReconnect = credentials[6]!
    await contexts[6]!.setOffline(true); await keeper.waitForTimeout(3000); await contexts[6]!.setOffline(false)
    await expect.poll(() => credentials[6]!, { timeout: 30000 }).toBeGreaterThan(beforeReconnect)
    await matrix('network-restored')
    while (Date.now() - started < duration * 1000) {
      await keeper.waitForTimeout(Math.min(30_000, duration * 1000 - (Date.now() - started)))
      await matrix('sustained')
    }
    if (duration >= 600) expect(credentials.every(count => count >= 2), 'Every device must exercise credential renewal').toBe(true)
    for (const [index, page] of pages.entries()) {
      await page.locator('#chatInput').fill(`Endurance device ${index} is still here`); await page.locator('#chatInput').press('Enter')
    }
    for (const page of pages) for (let index = 0; index < 7; index++)
      await expect(page.locator('#chatLog')).toContainText(`Endurance device ${index} is still here`)
    expect(errors).toEqual([])
    for (const page of pages) await page.getByRole('button', { name: 'Leave call', exact: true }).click()
    checkpoints.push({ finished: true, durationSeconds: (Date.now() - started) / 1000, credentials })
  } finally {
    checkpoints.push({ screens: await Promise.all(pages.map(page => page.locator('body').innerText({ timeout: 5000 }).catch(() => 'unavailable'))) })
    checkpoints.push({ finalSamples: await Promise.all(pages.map(page => page.evaluate(sample).catch(() => null))) })
    const evidence = info.outputPath('node-endurance.json')
    writeFileSync(evidence, JSON.stringify({ checkpoints, errors }, null, 2))
    await info.attach('node-endurance.json', { path: evidence, contentType: 'application/json' })
    await Promise.allSettled(contexts.map(context => context.close()))
    try { await browser.close() } finally { await fixture.close(); ownerKey.fill(0) }
  }
})
