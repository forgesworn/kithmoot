import { testRelays } from './relays.js'
import { test, expect, _android, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { SYNTHETIC_MIC, inbound, nameCreator, openNewRoomForm, remoteAudioCount, remotePictures } from './browser.js'

const direct = process.env.TURN_E2E_ROUTE === 'direct'
if (process.env.TURN_E2E_ROUTE && !['direct', 'relay'].includes(process.env.TURN_E2E_ROUTE)) {
  throw new Error('TURN_E2E_ROUTE must be direct or relay')
}
const durationSeconds = Number(process.env.TURN_E2E_DURATION_SECONDS ?? 300)
const tlsPort = process.env.TURN_E2E_TLS_PORT ? Number(process.env.TURN_E2E_TLS_PORT) : undefined
if (tlsPort !== undefined && (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535)) {
  throw new Error('TURN_E2E_TLS_PORT must be a valid TCP port')
}
if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
  throw new Error('TURN_E2E_DURATION_SECONDS must be an integer from 1 to 300 (five minutes by default).')
}

/**
 * The regression test for the failure that made this whole TURN deployment
 * necessary: two people on different networks joined a room, saw each other
 * in the roster, and no audio or video ever flowed in either direction.
 *
 * WHY THE EXISTING E2E SUITE DID NOT CATCH IT. test/e2e.spec.ts runs both
 * browser contexts on one machine. ICE succeeds there on host candidates -
 * 127.0.0.1 talking to 127.0.0.1 - so a peer connection comes up whether or
 * not any STUN or TURN server exists at all. Every same-machine test passes
 * against a deployment with no TURN server, which is exactly what happened.
 * The gap is not a missing assertion; it is that a same-machine test cannot
 * reach the code path that fails.
 *
 * WHAT THIS DOES INSTEAD. It cannot manufacture a symmetric NAT, but it does
 * not need to. Setting iceTransportPolicy to 'relay' makes the browser
 * discard host and server-reflexive candidates and gather only relay ones,
 * so the ONLY route to a connection is an allocation on a real TURN server,
 * reached with a real credential. That is the same code path a CGNAT'd phone
 * takes, minus the CGNAT. If media flows under that constraint, TURN works.
 * If it does not, TURN does not work, whatever the server's logs say.
 *
 * It asserts three separate things, because two of them can pass while the
 * thing that matters fails:
 *   1. the credential endpoint answered, and with a usable credential
 *   2. the selected ICE candidate pair is of type 'relay' at both ends -
 *      the actual proof traffic went through coturn rather than round a
 *      loopback shortcut the policy failed to exclude
 *   3. both pages attached remote video and audio, decoded video, and
 *      received RTP bytes. ICE reaching 'connected' only means a path was
 *      negotiated; the original bug was precisely a room that looked
 *      connected and carried no usable media.
 *
 * NOT PART OF `npm test`, and not part of `npm run test:e2e` either. It
 * needs a deployment that actually serves /turn, which `vite preview` does
 * not - see playwright.turn.config.ts, which starts no local server and needs
 * TURN_E2E_BASE_URL set to a deployment you run. Run it with
 * `TURN_E2E_BASE_URL=https://your-host/j/ npm run test:turn`.
 * Set TURN_E2E_TRANSPORT=tcp-tls to exclude UDP and exercise the fallback a
 * restrictive VPN needs. This mirrors how vitest.live.config.ts is kept apart from
 * vitest.config.ts: real network, real infrastructure, on demand.
 */

/** Both peers, and the shape of what the browser reported for each. */
interface RelayEvidence {
  localType: string
  remoteType: string
  relayProtocol: string
  bytesReceived: number
}

/**
 * Forces relay-only ICE and keeps a handle on every RTCPeerConnection the
 * app builds, so getStats can be read back afterwards.
 *
 * Done by wrapping the constructor in an init script rather than by editing
 * the app, because the app must stay exactly as it is published - the point
 * is to test the deployed thing, not a variant of it built for testing. The
 * wrapper adds one field to the configuration the app passes and changes
 * nothing else.
 *
 * A note on why the wrapper does not also inject a TURN server: it must
 * not. If the app fails to obtain a credential, relay-only gathering finds
 * no candidates and the connection never completes - and that failure is
 * the test doing its job. Supplying a fallback here would turn the one
 * assertion that matters into theatre.
 */
async function forceRelayOnly(context: BrowserContext): Promise<void> {
  const transport = process.env.TURN_E2E_TRANSPORT === 'tcp-tls' ? 'tcp-tls' : 'any'
  await context.addInitScript(({ transport, direct, tlsPort }) => {
    const Native = window.RTCPeerConnection
    const created: RTCPeerConnection[] = []
    const trackEvents: { kind: string; id: string }[] = []
    ;(window as unknown as { __kithmootPcs: RTCPeerConnection[] }).__kithmootPcs = created
    // The shared displayed-media assertion reads this name. Keep both names
    // on the same array so its frame and audio-energy checks inspect the
    // relay-only connections created here rather than an empty test hook.
    ;(window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = created
    ;(window as unknown as { __kithmootTrackEvents: { kind: string; id: string }[] }).__kithmootTrackEvents = trackEvents
    // Records what the app asked for, so a failure can say whether the app
    // had a TURN server in its ICE list at all - the difference between
    // "TURN is broken" and "the app never fetched a credential".
    const iceServerLog: RTCIceServer[][] = []
    ;(window as unknown as { __kithmootIceServers: RTCIceServer[][] }).__kithmootIceServers = iceServerLog

    function Patched(this: unknown, config?: RTCConfiguration) {
      iceServerLog.push((config?.iceServers ?? []) as RTCIceServer[])
      const iceServers = transport === 'tcp-tls'
        ? (config?.iceServers ?? []).map(server => ({
            ...server,
            urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url =>
              typeof url === 'string' && url.startsWith('turns:') &&
              (tlsPort === undefined || Number(/^turns:(?:\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?|$)/.exec(url)?.[1] ?? 5349) === tlsPort),
            ),
          })).filter(server => server.urls.length > 0)
        : config?.iceServers
      const pc = new Native({ ...(config ?? {}), iceServers, iceTransportPolicy: direct ? 'all' : 'relay' })
      pc.addEventListener('track', event => trackEvents.push({ kind: event.track.kind, id: event.track.id }))
      created.push(pc)
      return pc
    }
    Patched.prototype = Native.prototype
    window.RTCPeerConnection = Patched as unknown as typeof RTCPeerConnection
  }, { transport, direct, tlsPort })
}

/** Reads back the selected candidate pair and inbound byte count from every
 *  peer connection the page built. Returns one entry per connection that
 *  reported a nominated, succeeded pair. */
async function readRelayEvidence(page: Page): Promise<RelayEvidence[]> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __kithmootPcs: RTCPeerConnection[] }).__kithmootPcs ?? []
    const out: { localType: string; remoteType: string; relayProtocol: string; bytesReceived: number }[] = []
    for (const pc of pcs) {
      const report = await pc.getStats()
      const all: Record<string, unknown>[] = []
      report.forEach((s) => all.push(s as unknown as Record<string, unknown>))

      // A nominated, succeeded candidate-pair is the one actually carrying
      // traffic. Firefox reports `selected` instead; both are checked so
      // this does not silently find nothing on a non-Chromium browser.
      const pair = all.find(
        (s) =>
          s.type === 'candidate-pair' &&
          s.state === 'succeeded' &&
          (s.nominated === true || s.selected === true),
      )
      if (!pair) continue

      const local = all.find((s) => s.id === pair.localCandidateId)
      const remote = all.find((s) => s.id === pair.remoteCandidateId)
      const bytesReceived = all
        .filter((s) => s.type === 'inbound-rtp')
        .reduce((sum, s) => sum + (typeof s.bytesReceived === 'number' ? s.bytesReceived : 0), 0)

      out.push({
        localType: String(local?.candidateType ?? 'unknown'),
        remoteType: String(remote?.candidateType ?? 'unknown'),
        relayProtocol: String(local?.relayProtocol ?? local?.protocol ?? 'unknown'),
        bytesReceived,
      })
    }
    return out
  })
}

/** The live TURN config has Chromium's built-in camera, which is a valid but
 * uniform frame on some hosts. Require a displayed video, decoded frames and
 * audible energy; the synthetic-picture colour-spread check belongs to the
 * local media suite where the source image is controlled. */
async function expectLiveTurnMedia(page: Page, who: string): Promise<void> {
  await expect.poll(async () => (await page.evaluate(remotePictures)).length, {
    message: `${who} has no displayed remote video`, timeout: 90_000,
  }).toBeGreaterThan(0)
  await expect.poll(async () => (await page.evaluate(inbound)).framesDecoded, {
    message: `${who} decoded no video through TURN`, timeout: 90_000,
  }).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(remoteAudioCount), {
    message: `${who} has no remote audio sink`, timeout: 30_000,
  }).toBeGreaterThan(0)
  await expect.poll(async () => (await page.evaluate(inbound)).audioEnergy, {
    message: `${who} received no audio energy`, timeout: 60_000,
  }).toBeGreaterThan(0)
}

/** Enough state to tell a dead transport from a negotiation that omitted
 *  media. Kept in this live test because the production diagnostics redact
 *  addresses and deliberately are not exposed as an application API. */
async function readPeerEvidence(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __kithmootPcs: RTCPeerConnection[] }).__kithmootPcs ?? []
    const connections = await Promise.all(pcs.map(async (pc, index) => {
      const report = await pc.getStats()
      const stats: Record<string, unknown>[] = []
      report.forEach((raw) => {
        const s = raw as unknown as Record<string, unknown>
        if (s.type === 'candidate-pair' && (s.nominated === true || s.selected === true)) {
          stats.push(Object.fromEntries(['type', 'state', 'bytesSent', 'bytesReceived', 'currentRoundTripTime']
            .filter((key) => s[key] !== undefined).map((key) => [key, s[key]])))
        }
        if (s.type === 'inbound-rtp' || s.type === 'outbound-rtp') {
          stats.push(Object.fromEntries(['type', 'kind', 'mid', 'bytesReceived', 'bytesSent', 'packetsReceived',
            'packetsSent', 'packetsLost', 'framesDecoded', 'framesEncoded', 'framesReceived', 'framesSent']
            .filter((key) => s[key] !== undefined).map((key) => [key, s[key]])))
        }
      })
      return {
        index,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState,
        senders: pc.getSenders().map((sender) => sender.track && ({
          kind: sender.track.kind,
          id: sender.track.id,
          readyState: sender.track.readyState,
          enabled: sender.track.enabled,
          muted: sender.track.muted,
        })),
        receivers: pc.getReceivers().map((receiver) => ({
          kind: receiver.track.kind,
          id: receiver.track.id,
          readyState: receiver.track.readyState,
          enabled: receiver.track.enabled,
          muted: receiver.track.muted,
        })),
        transceivers: pc.getTransceivers().map((transceiver) => ({
          mid: transceiver.mid,
          direction: transceiver.direction,
          currentDirection: transceiver.currentDirection,
          sender: transceiver.sender.track?.kind,
          receiver: transceiver.receiver.track.kind,
        })),
        localMedia: pc.localDescription?.sdp.match(/^m=.*$/gm),
        remoteMedia: pc.remoteDescription?.sdp.match(/^m=.*$/gm),
        stats,
      }
    }))
    return {
      trackEvents: (window as unknown as { __kithmootTrackEvents?: unknown }).__kithmootTrackEvents,
      videos: Array.from(document.querySelectorAll('video')).map(video => ({
        parent: video.parentElement?.className, connected: video.isConnected, paused: video.paused,
        time: video.currentTime, size: `${video.videoWidth}x${video.videoHeight}`,
        track: (video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id,
      })),
      audios: Array.from(document.querySelectorAll('audio')).map(audio => ({
        parent: audio.parentElement?.className, connected: audio.isConnected, paused: audio.paused,
        muted: audio.muted, time: audio.currentTime,
        track: (audio.srcObject as MediaStream | null)?.getAudioTracks()[0]?.id,
      })),
      connections,
    }
  })
}

async function readAppDiagnostics(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const collect = (window as unknown as { __kithmootCollectDiagnostics?: () => Promise<string> }).__kithmootCollectDiagnostics
    return collect ? collect() : 'Acceptance diagnostics are unavailable in this release build.'
  })
}

async function newDeviceContext(browser: Browser, baseURL: string, credential?: object, mobile = false): Promise<BrowserContext> {
  // Android-sized touch browser. This covers the responsive web journey;
  // it does not stand in for a physical Android device or its WebRTC stack.
  let context: BrowserContext
  const androidSerial = mobile ? process.env.TURN_E2E_ANDROID_SERIAL : undefined
  if (androidSerial) {
    const devices = await _android.devices()
    const device = devices.find(device => device.serial() === androidSerial)
    for (const other of devices) if (other !== device) await other.close()
    if (!device) throw new Error(`The requested Android test device ${androidSerial} is not attached`)
    device.setDefaultTimeout(45_000)
    try {
      context = await device.launchBrowser({ pkg: 'com.android.chrome', viewport: null, args: [
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
      ] })
    } catch (error) { await device.close(); throw error }
    context.on('close', () => { void device.close() })
  } else context = await browser.newContext(mobile ? {
    viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true,
  } : { viewport: { width: 1440, height: 900 } })
  if (credential) await context.route('**/turn', route => route.fulfill({ json: credential }))
  await context.grantPermissions(['camera', 'microphone'], { origin: new URL(baseURL).origin })
  await forceRelayOnly(context)
  await context.addInitScript(SYNTHETIC_MIC)
  return context
}

async function createRoom(page: Page, baseURL: string, name: string): Promise<string> {
  await page.goto(baseURL)
  // This spec has no local relay process: its default target is the live
  // deployment, so the ordinary Playwright helper's loopback default would
  // be blocked by the deployed CSP and make the test fail before TURN was
  // exercised. An explicit E2E_RELAYS value still overrides the room.
  const relays = process.env.E2E_RELAYS ? testRelays() : undefined
  if (relays) {
    await page.evaluate(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await page.reload()
  }
  await openNewRoomForm(page)
  await nameCreator(page, name)
  await page.locator('#create').click()
  await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
  // The link, not the box it used to sit in. The entry page was rebuilt to
  // put the conversation first and the drawer holding the link stays shut
  // until somebody has gone in, so waiting for it to be on screen would be
  // waiting for something the page deliberately does not do yet.
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  const joinUrl = await share.inputValue()
  expect(joinUrl, 'room creation did not produce a join URL').toContain('#')
  return joinUrl
}

/** Up to the door: a name typed and the way in ready to click. The camera
 *  and microphone are not out here any more - they arrive with the room -
 *  so turning them on is `turnOnMedia`, after the join. */
async function prepareDevice(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
}

/** Camera and microphone on, from inside the room. */
async function turnOnMedia(page: Page): Promise<void> {
  // The camera and microphone are behind the call control in the room's bar
  // now: a message screen carries a header, the conversation and the box to
  // type in, and the camera appears when there is a call to point it at.
  await expect(page.locator('#callToggle')).toBeVisible()
  if (await page.locator('#deviceControls').isHidden()) {
    await page.locator('#callToggle').click()
  }
  await expect(page.locator('#deviceControls')).toBeVisible()
  await page.locator('#toggleCamera').click()
  // Joining switches the microphone on since 1 November 2026; press it only if it is still off.
  await page.waitForTimeout(1500)
  if (await page.locator('#toggleMic').getAttribute('data-on') !== 'true') await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
}

test(`desktop and mobile web carry two-way media for ${durationSeconds}s over ${direct ? 'a direct connection' : process.env.TURN_E2E_TRANSPORT === 'tcp-tls' ? 'TLS TURN' : 'TURN'}`, async ({
  browser,
  baseURL,
}) => {
  test.setTimeout((durationSeconds + 240) * 1000)
  const base = baseURL as string

  // Checked first and asserted, never skipped over. A skip here would be a
  // green run for a deployment with no working credential endpoint, which
  // is the precise failure this test exists to catch.
  const credentialUrl = process.env.TURN_E2E_CREDENTIAL_URL ?? new URL('/turn', base).href
  const credentialResponse = await fetch(credentialUrl, {
    headers: { Origin: new URL(credentialUrl).origin },
  })
  expect(
    credentialResponse.ok,
    `the credential endpoint at ${credentialUrl} did not answer - ` +
      'without it the app has no TURN server and relay-only ICE cannot connect',
  ).toBe(true)
  const credential = (await credentialResponse.json()) as {
    urls?: string[]
    username?: string
    credential?: string
  }
  expect(credential.urls?.length, 'the credential endpoint returned no TURN URLs').toBeGreaterThan(0)
  expect(credential.username, 'the credential endpoint returned no username').toBeTruthy()
  expect(credential.credential, 'the credential endpoint returned no credential').toBeTruthy()

  const injectCredential = new URL(credentialUrl).origin === new URL(base).origin ? undefined : credential
  const contextA = await newDeviceContext(browser, base, injectCredential)
  const contextB = await newDeviceContext(browser, base, injectCredential, true)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const joinUrl = await createRoom(pageA, base, 'Relay A')
    await prepareDevice(pageB, joinUrl, 'Relay B')

    await turnOnMedia(pageA)
    await pageB.locator('#join').click()
    await expect(pageB.locator('#roomArea')).toBeVisible()
    await turnOnMedia(pageB)

    // Each side sees the other. With relay-only forced this cannot happen
    // over a loopback shortcut - the media path is a TURN allocation or
    // there is no media path.
    await expect(pageA.locator('#room .participant')).toHaveCount(2, { timeout: 90_000 })
    await expect(pageB.locator('#room .participant')).toHaveCount(2, { timeout: 90_000 })

    // Candidate pairs and byte counters are plumbing. The reported failure
    // was a person present in the roster with no usable picture or sound, so
    // hold the live TURN path to the same displayed-pixels and decoded-audio
    // gate as the ordinary media journey, in both directions.
    try {
      await expectLiveTurnMedia(pageA, 'device A over TURN')
      await expectLiveTurnMedia(pageB, 'device B over TURN')
    } catch (error) {
      console.log(`  device A peer state: ${JSON.stringify(await readPeerEvidence(pageA), null, 2)}`)
      console.log(`  device B peer state: ${JSON.stringify(await readPeerEvidence(pageB), null, 2)}`)
      console.log(`  device A app state: ${await readAppDiagnostics(pageA)}`)
      console.log(`  device B app state: ${await readAppDiagnostics(pageB)}`)
      throw error
    }

    // The app must actually have had a TURN server to offer. Asserted
    // separately so a failure below can be read as "relay did not work"
    // rather than "there was nothing to relay through".
    // The TURN rung is the LAST rung: the app tries direct first, and only
    // hands ICE the TURN credentials once the direct rung has timed out
    // (DEFAULT_ROUTE_TIMEOUT_MS). Polled, because the tiles above come from
    // the roster and appear seconds before the ladder has moved.
    const sawTurn = () =>
      pageA.evaluate(() => {
        const offered = (window as unknown as { __kithmootIceServers: RTCIceServer[][] }).__kithmootIceServers
        return offered.some((list) =>
          list.some((s) => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
            return urls.some((u) => typeof u === 'string' && u.startsWith('turn'))
          }),
        )
      })
    if (!direct) await expect
      .poll(sawTurn, { message: 'the app never put a turn: server into its ICE configuration', timeout: 60_000 })
      .toBe(true)

    // Media takes a moment to start flowing once ICE settles; poll rather
    // than assert on the first reading, because a zero here a second after
    // connecting means nothing.
    const receivedEvidence = new Map<'A' | 'B', RelayEvidence[]>()
    for (const [label, page] of [
      ['A', pageA],
      ['B', pageB],
    ] as const) {
      await expect
        .poll(
          async () => {
            const evidence = await readRelayEvidence(page)
            if (evidence.some((e) => e.bytesReceived > 0)) receivedEvidence.set(label, evidence)
            return receivedEvidence.has(label)
          },
          {
            timeout: 60_000,
            message: `device ${label} received no RTP bytes - the TURN call is one-way`,
          },
        )
        .toBe(true)
    }

    for (const [label, page] of [
      ['A', pageA],
      ['B', pageB],
    ] as const) {
      const evidence = receivedEvidence.get(label) ?? await readRelayEvidence(page)
      // Printed, not just asserted. When this test fails the useful question
      // is always "what did it use instead", and when it passes the numbers
      // are the record that media genuinely moved - a claim worth being able
      // to read off a CI log rather than infer from a green tick.
      console.log(`  device ${label}: ${JSON.stringify(evidence)}`)
      expect(evidence.length, `device ${label} negotiated no candidate pair at all`).toBeGreaterThan(0)
      for (const pair of evidence) {
        expect(pair.bytesReceived, `device ${label} negotiated TURN but received no media`).toBeGreaterThan(0)
        // The assertion the whole file exists for. 'host' would mean the
        // policy did not take effect and this proved nothing; 'srflx' would
        // mean it connected via STUN and, again, proved nothing about TURN.
        if (direct) {
          expect(pair.localType, `device ${label} unexpectedly used TURN`).not.toBe('relay')
          expect(pair.remoteType, `device ${label} unexpectedly used TURN`).not.toBe('relay')
        } else {
          expect(pair.localType, `device ${label} bypassed TURN locally`).toBe('relay')
          expect(pair.remoteType, `device ${label} bypassed TURN remotely`).toBe('relay')
          if (process.env.TURN_E2E_TRANSPORT === 'tcp-tls') expect(pair.relayProtocol).toBe('tls')
        }
      }
    }

    // Positive counters once only prove a call started. Sample throughout
    // the requested five minutes and require BOTH decoded pictures and
    // audio energy to advance in every interval, in both directions.
    const pages = [pageA, pageB]
    let previous = await Promise.all(pages.map(page => page.evaluate(inbound)))
    const samples: unknown[] = []
    const started = Date.now()
    while (Date.now() - started < durationSeconds * 1000) {
      await pageA.waitForTimeout(Math.min(10_000, durationSeconds * 1000 - (Date.now() - started)))
      const current = await Promise.all(pages.map(page => page.evaluate(inbound)))
      for (const [index, stats] of current.entries()) {
        expect(stats.framesDecoded, `device ${index} video stopped during the call`).toBeGreaterThan(previous[index]!.framesDecoded)
        expect(stats.audioEnergy, `device ${index} audio stopped during the call`).toBeGreaterThan(previous[index]!.audioEnergy)
        const sinks = await pages[index]!.locator('#room .participant audio').evaluateAll(elements => elements.map(element => {
          const audio = element as HTMLAudioElement
          return { paused: audio.paused, muted: audio.muted, volume: audio.volume, time: audio.currentTime }
        }))
        expect(sinks.some(sink => !sink.paused && !sink.muted && sink.volume > 0 && sink.time > 0), `device ${index} has no playing remote sound`).toBe(true)
      }
      const elapsedSeconds = Math.round((Date.now() - started) / 1000)
      samples.push({ elapsedSeconds, current })
      console.log(`  continuous media ${elapsedSeconds}s: ${JSON.stringify(current)}`)
      previous = current
    }
    const evidencePath = test.info().outputPath('five-minute-media.json')
    await writeFile(evidencePath, JSON.stringify({
      durationSeconds, elapsedMs: Date.now() - started, direct, transport: process.env.TURN_E2E_TRANSPORT ?? 'any',
      desktopViewport: pageA.viewportSize(), mobileViewport: pageB.viewportSize(),
      androidDevice: process.env.TURN_E2E_ANDROID_SERIAL ?? null, tlsPort: tlsPort ?? null,
      userAgents: await Promise.all(pages.map(page => page.evaluate(() => navigator.userAgent))), samples,
    }, null, 2))
    await test.info().attach('five-minute-media.json', { path: evidencePath, contentType: 'application/json' })
    for (const [name, page] of [['desktop', pageA], ['mobile', pageB]] as const) {
      const path = test.info().outputPath(`${name}-call.png`)
      await page.screenshot({ path })
      await test.info().attach(`${name}-call.png`, { path, contentType: 'image/png' })
    }
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
