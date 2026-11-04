import { test, expect, chromium, _electron as electron } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { newDeviceContext, openCallSettings, closeSettings, openRoomInfoPage, inbound, INSTRUMENT, SYNTHETIC_MIC } from './browser.js'
import { signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'
// @ts-expect-error - desktop runtime fixtures are plain ESM without declarations.
import { stopIsolatedApp } from '../desktop/test/isolated-app.mjs'
// @ts-expect-error - the desktop main-process policy is plain ESM.
import { HOME as DESKTOP_HOME, ORIGIN as DESKTOP_ORIGIN } from '../desktop/policy.mjs'

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
  const executable = process.env.E2E_NODE_DESKTOP_EXECUTABLE
  if (executable) expect(isAbsolute(executable)).toBe(true)
  const home = executable ? DESKTOP_HOME : baseURL!
  const fixture = await nodeBrowserFixture(executable ? DESKTOP_ORIGIN : new URL(baseURL!).origin, { relayIp, turnPorts: { udpTcp: 34790, tls: 53499 } })
  console.log('Node fixture ready; starting controlled client')
  let desktopApp: Awaited<ReturnType<typeof electron.launch>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let context: Awaited<ReturnType<typeof newDeviceContext>> | undefined
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-cross-'))
  const desktopProfile = join(directory, 'kithmoot-desktop-profile')
  let instrument: ReturnType<typeof spawn> | undefined, nativeLog = '', exit: Promise<number | null> | undefined
  const samples: unknown[] = [], requested: string[] = []
  const proxyFailures: string[] = []
  let finishing = false, failed = false
  try {
    const mediaArgs = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
      '--autoplay-policy=no-user-gesture-required', `--host-resolver-rules=MAP node.example ${relayIp},MAP turn.node.example ${relayIp}`]
    if (executable) {
      desktopApp = await electron.launch({ executablePath: executable,
        args: [...mediaArgs, '--ignore-certificate-errors', `--user-data-dir=${desktopProfile}`],
        env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: desktopProfile } })
      context = desktopApp.context()
      // CDP request interception conflicts with Electron's custom HTTPS
      // handler. Keep that real handler and route only the external fixture
      // through the net.fetch path it already uses.
      await desktopApp.evaluate(({ net, dialog }, { desk, calls }) => {
        const state = { requests: [] as string[], failures: [] as string[], localConsent: false }
        ;(globalThis as typeof globalThis & { __nodeQualification: typeof state }).__nodeQualification = state
        const fetch = net.fetch.bind(net)
        net.fetch = async (input: RequestInfo | URL, options?: RequestInit & { bypassCustomProtocolHandlers?: boolean }) => {
          const request = new Request(input, options), url = new URL(request.url)
          if (url.origin !== 'https://node.example') return fetch(input, options)
          state.requests.push(url.pathname)
          try {
            const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
            return await fetch((url.pathname === '/v1/credentials' ? calls : desk) + url.pathname + url.search,
              { ...options, method: request.method, headers: request.headers, body, signal: request.signal })
          } catch {
            state.failures.push(url.pathname)
            return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })
          }
        }
        const show = dialog.showMessageBox.bind(dialog)
        dialog.showMessageBox = ((...args: unknown[]) => {
          const settings = args.at(-1) as { message?: string }
          if (settings.message === 'Allow connections on your local network?') {
            state.localConsent = true
            return Promise.resolve({ response: 1, checkboxChecked: false })
          }
          return Reflect.apply(show, dialog, args)
        }) as typeof dialog.showMessageBox
      }, { desk: fixture.desk, calls: fixture.calls })
      await context.addInitScript(INSTRUMENT)
      // Synthetic capture avoids operating-system camera/microphone consent
      // and never accesses the owner's physical devices.
      await context.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async constraints => {
          const stream = new MediaStream()
          if (constraints?.video) {
            const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
            const ctx = canvas.getContext('2d')!; let frame = 0
            const draw = () => {
              ctx.fillStyle = '#123047'; ctx.fillRect(0, 0, 640, 360)
              ctx.fillStyle = '#efb64c'; ctx.fillRect((frame++ * 9) % 500, 90, 100, 180)
            }
            draw(); const timer = setInterval(draw, 80)
            const track = canvas.captureStream(12).getVideoTracks()[0]!, stop = track.stop.bind(track)
            track.stop = () => { clearInterval(timer); stop() }; stream.addTrack(track)
          }
          if (constraints?.audio) {
            const ctx = new AudioContext(); await ctx.resume()
            const oscillator = ctx.createOscillator(), gain = ctx.createGain(), destination = ctx.createMediaStreamDestination()
            oscillator.frequency.value = 440; gain.gain.value = 0.3
            oscillator.connect(gain).connect(destination); oscillator.start()
            const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track)
            track.stop = () => { oscillator.stop(); void ctx.close(); stop() }; stream.addTrack(track)
          }
          return stream
        }
      })
    } else {
      browser = await chromium.launch({ args: mediaArgs })
      context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    }
    if (!desktopApp) await context.addInitScript(SYNTHETIC_MIC)
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
    if (!desktopApp) await context.route('https://node.example/**', async route => {
      const path = new URL(route.request().url()).pathname; requested.push(path)
      try {
        const response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path, timeout: 6500 })
        await route.fulfill({ response })
      } catch {
        if (!finishing) {
          proxyFailures.push(path)
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }).catch(() => {})
        }
      }
    })
    const page = desktopApp ? await desktopApp.firstWindow() : await context.newPage()
    const fallbackRequests: string[] = []
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/turn') fallbackRequests.push(url.origin + url.pathname) })
    page.on('console', message => { if (message.type() === 'error') console.log('Browser node:', message.text()) })
    await signInAccount(page, home)
    await openCallSettings(page, 'Your KithMoot node')
    await page.locator('#nodePairingInput').fill(fixture.pairing()); await page.locator('#nodePair').click(); await page.locator('#actionConfirm').click()
    await expect(page.locator('#nodeHost')).toHaveText('node.example'); await closeSettings(page)
    console.log('Controlled keeper paired')
    await page.locator('#homeNewRoom').click(); await page.locator('#roomName').fill('Cross-client node fixture')
    if (await page.locator('#newRoomYourName').isVisible()) await page.locator('#newRoomYourName').fill('Keeper')
    await page.locator('#roomOnNode').check(); await page.locator('#create').click()
    await expect(page.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
    console.log('Controlled node room created')
    await page.locator('#callToggle').click(); await expect(page.locator('#deviceControls')).toBeVisible()
    await page.locator('#toggleCamera').click(); await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    if (await page.locator('#toggleMic').getAttribute('data-on') !== 'true') await page.locator('#toggleMic').click()
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
    console.log('Controlled native guest admitted; waiting for media')
    await expect(page.locator('#chatLog')).toContainText('Native guest receives browser video', { timeout: 120_000 })
    await expect(page.locator('#chatLog')).toContainText('Native guest recovered temporary issuer failure', { timeout: 30_000 })
    await expect.poll(async () => (await page.evaluate(inbound)).framesDecoded, { timeout: 90_000 }).toBeGreaterThan(20)
    // A new node room defaults to profile 2 at both ends. Opening a legacy
    // pair before the authenticated roster capability arrives would otherwise
    // hide the very handover path this qualification needs to exercise.
    await expect.poll(() => page.evaluate(() => {
      const peers = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []
      return peers.filter(peer => peer.connectionState === 'connected').map(peer => peer.getTransceivers().length)
    }), { timeout: 15_000 }).toEqual([4])
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
    const desktopRuntime = desktopApp ? await desktopApp.evaluate(({ app, BrowserWindow }) => {
      const state = (globalThis as typeof globalThis & { __nodeQualification: { requests: string[]; failures: string[]; localConsent: boolean } }).__nodeQualification
      return { ...state, version: app.getVersion(), electron: process.versions.electron,
        webSecurity: BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences().webSecurity }
    }) : undefined
    if (desktopRuntime) {
      requested.push(...desktopRuntime.requests); proxyFailures.push(...desktopRuntime.failures)
      expect(desktopRuntime.version).toBe('0.1.126'); expect(desktopRuntime.webSecurity).toBe(true)
    }
    expect(requested).not.toContain('/turn')
    expect(fallbackRequests).toEqual([])
    expect(proxyFailures).toEqual([])
    const proof = { schema: 'kithmoot-node-cross-client/1', result: 'passed', videoSeconds: 300,
      actualBrowserUi: true, actualDesktopRenderer: !!desktopApp, actualNativeEngine: true, callProfile: 2, temporaryNativeIssuerFailureRecovered: true,
      customPorts: { udpTcp: 34790, tls: 53499 }, selected, samples, fallbackRequests, desktopRuntime,
      syntheticMedia: true, fixtureNetworkRouting: true, actualMacCaptureConsent: false,
      forcedTls443: false, publicCertificate: false, independentNats: false, physicalGrapheneOS: false, removal: true, purge: true }
    const proofPath = info.outputPath('cross-client-proof.json')
    writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n')
    await info.attach('cross-client-proof', { path: proofPath, contentType: 'application/json' })
  } catch (error) {
    failed = true
    // Capture the disposable app's Java/native wait state before force-stop;
    // a blocked signalling thread cannot finish the instrumentation report.
    try {
      const pid = instrument?.exitCode === null ? device('shell', 'pidof', 'dev.forgesworn.kithmoot').trim() : ''
      if (/^[1-9][0-9]*$/.test(pid)) {
        device('shell', 'kill', '-3', pid)
        await new Promise(resolve => setTimeout(resolve, 2000))
        const name = device('shell', 'ls', '-t', '/data/anr').trim().split(/\s+/)[0]
        if (name && /^[A-Za-z0-9_.-]+$/.test(name)) {
          const destination = info.outputPath('native-thread-dump.txt')
          device('pull', `/data/anr/${name}`, destination)
          await info.attach('native-thread-dump', { path: destination, contentType: 'text/plain' })
        }
      }
    } catch { /* Not every emulator permits thread dumps. Preserve the original failure. */ }
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
    finishing = true
    if (instrument?.exitCode === null) { instrument.kill('SIGTERM'); try { device('shell', 'am', 'force-stop', 'dev.forgesworn.kithmoot') } catch {} }
    try { device('shell', 'run-as', 'dev.forgesworn.kithmoot', 'rm', '-f', 'files/node-cross-config.json') } catch {}
    try { device('shell', 'rm', '-f', '/data/local/tmp/kithmoot-node-cross.json') } catch {}
    writeFileSync(info.outputPath('native-media.txt'), nativeLog)
    const cleanupErrors: unknown[] = []
    for (const clean of [() => desktopApp ? stopIsolatedApp(desktopApp, desktopProfile) : context?.close(),
      () => browser?.close(), () => fixture.close(), () => rmSync(directory, { recursive: true, force: true })]) {
      try { await clean() } catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length && !failed) throw new AggregateError(cleanupErrors, 'Cross-client fixture cleanup failed')
  }
})
