import { test, expect, chromium } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { newDeviceContext, openCallSettings, closeSettings, openRoomInfoPage, inbound } from './browser.js'
import { signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'

// Explicit disposable-emulator qualification only. No public trust/NAT claim.
test('browser keeper and native guest sustain local relay video both ways and revoke', async ({ baseURL }, info) => {
  test.skip(process.env.E2E_NODE_CROSS_CLIENT !== 'local-only', 'explicit private local cross-client qualification')
  test.setTimeout(600_000)
  const serial = process.env.E2E_NODE_ANDROID_SERIAL!, adb = process.env.E2E_NODE_ADB!
  const relayIp = process.env.E2E_NODE_NATIVE_RELAY_IP!, apk = process.env.E2E_NODE_ANDROID_APK!, testApk = process.env.E2E_NODE_ANDROID_TEST_APK!
  expect(serial).toMatch(/^emulator-[0-9]{4,5}$/)
  for (const file of [adb, apk, testApk]) expect(isAbsolute(file)).toBe(true)
  expect(Object.values(networkInterfaces()).flat().some(a => a?.family === 'IPv4' && a.address === relayIp)).toBe(true)
  const device = (...args: string[]) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60_000 })
  expect(device('shell', 'getprop', 'ro.hardware').trim()).toMatch(/^(ranchu|goldfish)$/)
  expect(device('shell', 'pm', 'list', 'packages', 'com.google.android.gms').trim()).toBe('')
  device('install', '-r', apk); device('install', '-r', testApk)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { relayIp, turnPorts: { udpTcp: 34790, tls: 53499 } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let context: Awaited<ReturnType<typeof newDeviceContext>> | undefined
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-cross-'))
  let instrument: ReturnType<typeof spawn> | undefined, nativeLog = '', exit: Promise<number | null> | undefined
  const samples: unknown[] = [], requested: string[] = []
  try {
    browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required', `--host-resolver-rules=MAP node.example ${relayIp},MAP turn.node.example ${relayIp}`] })
    context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    await context.addInitScript(() => {
      const w = window as unknown as { __nodeIce: unknown[] }; w.__nodeIce = []
      const Base = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Base {
        constructor(configuration?: RTCConfiguration) {
          super(configuration)
          this.addEventListener('icecandidateerror', event => w.__nodeIce.push({ kind: 'error', code: event.errorCode, url: event.url, text: event.errorText }))
          this.addEventListener('icecandidate', event => { if (event.candidate) w.__nodeIce.push({ kind: 'candidate', type: event.candidate.type, protocol: event.candidate.protocol }) })
        }
      }
    })
    const key = generateSecretKey()
    await context.exposeFunction('nodeTestPublicKey', () => getPublicKey(key))
    await context.exposeFunction('nodeTestSign', (value: EventTemplate) => finalizeEvent(value, key))
    await context.addInitScript(() => {
      const w = window as typeof window & { nodeTestPublicKey(): Promise<string>; nodeTestSign(value: unknown): Promise<unknown> }
      Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.nodeTestPublicKey(), signEvent: (value: unknown) => w.nodeTestSign(value) } })
    })
    const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
    await context.addInitScript(({ node, accountRelay }) => {
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const value = String(url)
          super(value === 'wss://node.example/events' ? node : value.startsWith('wss://') && !value.includes('localhost') ? accountRelay : value, protocols)
        }
      }
    }, { node: fixture.websocket, accountRelay: accountRelay.href })
    await context.route('https://node.example/**', async route => {
      const path = new URL(route.request().url()).pathname; requested.push(path)
      const response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path })
      await route.fulfill({ response })
    })
    const page = await context.newPage()
    const fallbackRequests: string[] = []
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/turn') fallbackRequests.push(url.origin + url.pathname) })
    page.on('console', message => { if (message.type() === 'error') console.log('Browser node:', message.text()) })
    await signInAccount(page, baseURL!)
    await openCallSettings(page, 'Your KithMoot node')
    await page.locator('#nodePairingInput').fill(fixture.pairing()); await page.locator('#nodePair').click(); await page.locator('#actionConfirm').click()
    await expect(page.locator('#nodeHost')).toHaveText('node.example'); await closeSettings(page)
    await page.locator('#homeNewRoom').click(); await page.locator('#roomName').fill('Cross-client node fixture')
    if (await page.locator('#newRoomYourName').isVisible()) await page.locator('#newRoomYourName').fill('Keeper')
    await page.locator('#roomOnNode').check(); await page.locator('#create').click()
    await expect(page.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
    await page.locator('#callToggle').click(); await expect(page.locator('#deviceControls')).toBeVisible()
    await page.locator('#toggleCamera').click(); await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    const config = join(directory, 'native.json')
    writeFileSync(config, JSON.stringify({ v: 1, ...fixture.native, browserLink: page.url() }), { mode: 0o600, flag: 'wx' })
    device('shell', 'run-as', 'dev.forgesworn.kithmoot', 'mkdir', '-p', 'files')
    device('push', config, '/data/local/tmp/kithmoot-node-cross.json')
    device('shell', 'run-as', 'dev.forgesworn.kithmoot', 'cp', '/data/local/tmp/kithmoot-node-cross.json', 'files/node-cross-config.json')
    device('shell', 'run-as', 'dev.forgesworn.kithmoot', 'chmod', '600', 'files/node-cross-config.json')
    device('shell', 'rm', '/data/local/tmp/kithmoot-node-cross.json')
    instrument = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class',
      'dev.forgesworn.kithmoot.node.NodeNativeMediaTest#browserKeeperAndNativeGuestExchangeRelayMedia', '-e', 'nodeConfig',
      '/data/user/0/dev.forgesworn.kithmoot/files/node-cross-config.json', 'dev.forgesworn.kithmoot.test/androidx.test.runner.AndroidJUnitRunner'], { stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [instrument.stdout, instrument.stderr]) stream?.on('data', chunk => { if (nativeLog.length < 2_000_000) nativeLog += String(chunk) })
    exit = new Promise((resolve, reject) => { instrument!.once('error', reject); instrument!.once('exit', resolve) })
    await expect(page.locator('.approvalCard.knock')).toBeVisible({ timeout: 30_000 })
    await page.locator('.approvalCard.knock').getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(page.locator('#chatLog')).toContainText('Native guest receives browser video', { timeout: 120_000 })
    await expect.poll(async () => (await page.evaluate(inbound)).framesDecoded, { timeout: 90_000 }).toBeGreaterThan(20)
    const videoCounters = () => page.evaluate(async () => {
      const values: Record<string, number> = {}
      const peers = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []
      for (const [index, peer] of peers.entries()) {
        const stats = await peer.getStats().catch(() => null)
        stats?.forEach(row => { if (row.type === 'inbound-rtp' && row.kind === 'video')
          values[`${index}:${row.id}:${row.ssrc}`] = row.framesDecoded ?? 0 })
      }
      return values
    })
    let previous = await videoCounters(), totalFrames = 0
    const started = performance.now()
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(30_000)
      const received = await page.evaluate(inbound)
      const counters = await videoCounters()
      // libwebrtc can reset a counter while keeping its stats id and SSRC
      // during renegotiation. Count fresh frames in the new counter epoch.
      const resets = Object.entries(counters).filter(([key, frames]) => previous[key] !== undefined && frames < previous[key]).length
      const newFrames = Object.entries(counters).reduce((sum, [key, frames]) => {
        const before = previous[key] ?? 0
        return sum + (frames < before ? frames : frames - before)
      }, 0)
      expect(newFrames, 'video must arrive in every 30 second interval, including after ICE renewal').toBeGreaterThan(0)
      previous = counters; totalFrames += newFrames
      samples.push({ seconds: Math.floor((performance.now() - started) / 1000), ...received, newFrames, counterResets: resets, cumulativeNewFrames: totalFrames })
      console.log(`Browser/native media sample ${i + 1}/10: ${received.framesDecoded} browser frames`)
    }
    await expect(page.locator('#chatLog')).toContainText('Native guest completed 300 seconds of browser video', { timeout: 45_000 })
    const selected = await page.evaluate(async () => {
      const peers = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? []
      return Promise.all(peers.filter(pc => pc.connectionState !== 'closed').map(async pc => {
        const stats = await pc.getStats(); const pairs: unknown[] = []
        stats.forEach(row => { if (row.type === 'candidate-pair' && row.nominated && row.state === 'succeeded') {
          const local = stats.get(row.localCandidateId), remote = stats.get(row.remoteCandidateId)
          pairs.push({ local: local?.candidateType, remote: remote?.candidateType, protocol: local?.protocol, relayProtocol: local?.relayProtocol, url: local?.url })
        } })
        return { policy: pc.getConfiguration().iceTransportPolicy, urls: (pc.getConfiguration().iceServers ?? []).flatMap(server => typeof server.urls === 'string' ? [server.urls] : server.urls), pairs }
      }))
    })
    expect(selected.length).toBeGreaterThan(0)
    for (const peer of selected) {
      expect(peer.policy).toBe('relay'); expect(peer.pairs.length).toBeGreaterThan(0)
      expect([...peer.urls].sort()).toEqual(['turn:node.example:34790?transport=udp', 'turn:node.example:34790?transport=tcp', 'turns:node.example:53499?transport=tcp', 'turns:turn.node.example:443?transport=tcp'].sort())
      for (const pair of peer.pairs as { local: string; remote: string }[]) { expect(pair.local).toBe('relay'); expect(pair.remote).toBe('relay') }
    }
    await openRoomInfoPage(page, 'Privacy and connection'); await page.locator('#roomInfoBack').click()
    await page.locator('#hostPanel > summary').click(); await page.locator('#hostList').getByRole('button', { name: 'Remove', exact: true }).click()
    await page.locator('#actionConfirm').click(); await expect.poll(() => fixture.ledger.active().length).toBe(1)
    await expect.poll(() => nativeLog, { timeout: 45_000 }).toMatch(/^OK \(1 test\)$/m)
    expect(await exit).toBe(0)
    await page.locator('#endRoom').click(); await page.locator('#actionConfirm').click()
    await expect.poll(() => fixture.ledger.rooms().length).toBe(0)
    await expect.poll(async () => (await fixture.relay.status()).rooms).toBe(0)
    expect(requested).not.toContain('/turn')
    expect(fallbackRequests).toEqual([])
    const proof = { schema: 'kithmoot-node-cross-client/1', result: 'passed', videoSeconds: 300,
      actualBrowserUi: true, actualNativeEngine: true, customPorts: { udpTcp: 34790, tls: 53499 }, selected, samples, fallbackRequests,
      forcedTls443: false, publicCertificate: false, independentNats: false, physicalGrapheneOS: false, removal: true, purge: true }
    const proofPath = info.outputPath('cross-client-proof.json')
    writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n')
    await info.attach('cross-client-proof', { path: proofPath, contentType: 'application/json' })
  } catch (error) {
    const page = context?.pages()[0]
    if (page) {
      const diagnostic = await page.evaluate(async () => {
        const w = window as unknown as { __pcs?: RTCPeerConnection[]; __nodeIce?: unknown[] }
        const peers = await Promise.all((w.__pcs ?? []).map(async pc => {
          const candidates: unknown[] = []; const stats = await pc.getStats().catch(() => null)
          stats?.forEach(row => { if (['local-candidate', 'remote-candidate', 'candidate-pair', 'outbound-rtp', 'inbound-rtp'].includes(row.type))
            candidates.push({ type: row.type, candidateType: row.candidateType, protocol: row.protocol, state: row.state, nominated: row.nominated, kind: row.kind, framesEncoded: row.framesEncoded, framesDecoded: row.framesDecoded, bytesSent: row.bytesSent, bytesReceived: row.bytesReceived }) })
          return { state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, policy: pc.getConfiguration().iceTransportPolicy, candidates }
        }))
        return { ice: w.__nodeIce, peers }
      }).catch(() => ({ unavailable: true }))
      console.log('Cross-client ICE diagnostic:', JSON.stringify(diagnostic))
      await info.attach('ice-diagnostic', { body: JSON.stringify(diagnostic), contentType: 'application/json' })
    }
    throw error
  } finally {
    if (instrument?.exitCode === null) { instrument.kill('SIGTERM'); try { device('shell', 'am', 'force-stop', 'dev.forgesworn.kithmoot') } catch {} }
    try { device('shell', 'run-as', 'dev.forgesworn.kithmoot', 'rm', '-f', 'files/node-cross-config.json') } catch {}
    try { device('shell', 'rm', '-f', '/data/local/tmp/kithmoot-node-cross.json') } catch {}
    writeFileSync(info.outputPath('native-media.txt'), nativeLog)
    rmSync(directory, { recursive: true, force: true })
    await context?.close(); await browser?.close(); await fixture.close()
  }
})
