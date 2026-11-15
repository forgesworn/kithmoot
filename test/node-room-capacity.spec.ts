import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { generateSecretKey, getPublicKey, finalizeEvent, type EventTemplate } from 'nostr-tools/pure'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { newDeviceContext, openCallSettings, closeSettings, openNewRoomForm, turnOnMedia, SYNTHETIC_MIC } from './browser.js'
import { signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'
import { localIdentity, type ParticipantIdentity } from '../src/identity.js'
import { buildGrant } from '../src/group-grants.js'
import { readNodeRoom, signNodeRoom } from '@forgesworn/fold-kit/node-room'
import { claimKithmootNode, enrolNodeRoom, nodeTurnCredentials, parseKithmootNodePairingLink, postNodeGrant, queryNodeAccess,
  KithmootNodeError, type NodeDeviceAccess } from '../src/kithmoot-node.js'

// Opt-in, disposable local node only. Nothing here touches a live host, a
// public relay or a real room. Synthetic capture and loopback TURN do not
// establish native-device or Internet quality, and one machine runs the node,
// the browsers and the test, so CPU and memory figures are upper bounds on
// what the node alone would use.
//
// E2E_NODE_CAPACITY=local-only          enable
// E2E_NODE_CAPACITY_PROFILE             full (512 ports, default), thirtytwo (the shipped default), tiny (8)
// E2E_NODE_CAPACITY_BYTES               aggregate relay bytes per second (default 2000000)
// E2E_NODE_CAPACITY_STEPS               concurrent call counts, comma separated (default 2,4,8)
// E2E_NODE_CAPACITY_REST_SECONDS        idle sampling time (default 360, so credentials renew)
// E2E_NODE_CAPACITY_OUT                 absolute directory for the JSON evidence (default: test output)
const enabled = process.env.E2E_NODE_CAPACITY === 'local-only'
const profile = process.env.E2E_NODE_CAPACITY_PROFILE ?? 'full'
const PROFILES: Record<string, number> = { full: 512, thirtytwo: 32, tiny: 8 }
if (!(profile in PROFILES)) throw Error('Unknown capacity profile')
const bandwidth = Number(process.env.E2E_NODE_CAPACITY_BYTES ?? 2000000)
const steps = (process.env.E2E_NODE_CAPACITY_STEPS ?? '2,4,8').split(',').map(Number)
if (steps.some(step => !Number.isInteger(step) || step < 1 || step > 32)) throw Error('Invalid call counts')
const restSeconds = Number(process.env.E2E_NODE_CAPACITY_REST_SECONDS ?? 360)
const turnPorts = { udpTcp: Number(process.env.E2E_NODE_CAPACITY_TURN_PORT ?? 34891), tls: Number(process.env.E2E_NODE_CAPACITY_TLS_PORT ?? 53599) }
const relayPortFirst = Number(process.env.E2E_NODE_CAPACITY_RELAY_FIRST ?? 49800)

function evidence(name: string, value: unknown, info: { outputPath(name: string): string; attach(name: string, options: { path: string; contentType: string }): Promise<void> }) {
  const directory = process.env.E2E_NODE_CAPACITY_OUT
  let path: string
  if (directory) { mkdirSync(directory, { recursive: true }); path = join(directory, name) } else path = info.outputPath(name)
  writeFileSync(path, JSON.stringify(value, null, 2))
  return info.attach(name, { path, contentType: 'application/json' })
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]! * 10) / 10
}
const summary = (values: number[]) => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100) })

/** macOS ps prints cumulative CPU as [H:]M:SS.cc. */
function cpuSeconds(text: string) {
  const parts = text.split(':').map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}
interface ProcessRow { pid: number; name: string; rssKb: number; cpu: number }
/** The given processes and everything they started, such as spry-turn under spry-node. */
function processes(roots: Array<number | undefined>): ProcessRow[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' }).trim().split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    return match ? [{ pid: +match[1]!, ppid: +match[2]!, rssKb: +match[3]!, cpu: cpuSeconds(match[4]!), name: basename(match[5]!) }] : []
  })
  const wanted = new Set(roots.filter((pid): pid is number => pid !== undefined))
  for (let grew = true; grew;) { grew = false; for (const row of rows) if (!wanted.has(row.pid) && wanted.has(row.ppid)) { wanted.add(row.pid); grew = true } }
  return rows.filter(row => wanted.has(row.pid)).map(({ pid, name, rssKb, cpu }) => ({ pid, name, rssKb, cpu }))
}
function resourceSampler(roots: Array<number | undefined>) {
  let previous: { at: number; rows: Map<number, ProcessRow>; worker: number } | undefined
  return () => {
    const at = Date.now(), rows = processes(roots), usage = process.cpuUsage(), worker = (usage.user + usage.system) / 1e6
    const seconds = previous ? (at - previous.at) / 1000 : 0
    const result = {
      processes: rows.map(row => ({ name: row.name, pid: row.pid, rssMb: Math.round(row.rssKb / 1024 * 10) / 10,
        cpuPercent: previous?.rows.has(row.pid) && seconds > 0 ? Math.round((row.cpu - previous.rows.get(row.pid)!.cpu) / seconds * 1000) / 10 : null })),
      // The supervisor, ledger, desk and TLS bridge run inside the test worker.
      workerRssMb: Math.round(process.memoryUsage().rss / 1048576 * 10) / 10,
      workerCpuPercent: previous && seconds > 0 ? Math.round((worker - previous.worker) / seconds * 1000) / 10 : null,
    }
    previous = { at, rows: new Map(rows.map(row => [row.pid, row])), worker }
    return result
  }
}

/** Every simulated device has its own source address, as real devices do. The
 * desk limits one source to 120 requests a minute; without this the loopback
 * fixture would put every device behind one address. */
function fetcherFor(fixture: Awaited<ReturnType<typeof nodeBrowserFixture>>, source: string) {
  return ((url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname, headers = new Headers(init.headers)
    headers.set('x-forwarded-for', source)
    return fetch((path === '/v1/credentials' ? fixture.calls : fixture.desk) + path, { ...init, headers })
  }) as typeof fetch
}
const refusal = (error: unknown) => error instanceof KithmootNodeError ? { status: error.status, reason: error.reason, code: error.code ?? null }
  : { message: error instanceof Error ? error.message : String(error) }

test('idle scale: 64 hosted rooms with two to four granted devices each and no calls', async ({ baseURL }, info) => {
  test.skip(!enabled, 'explicit disposable local node qualification')
  expect(process.env.E2E_NODE_SPRY_BINARY).toBeTruthy(); expect(process.env.E2E_NODE_SHELTER_BINARY).toBeTruthy()
  test.setTimeout((restSeconds + 1500) * 1000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { maxRooms: 64, relayPortCount: PROFILES[profile], relayPortFirst,
    aggregateBytesPerSecond: bandwidth, turnPorts, heartbeatMs: 2000 })
  const log: Record<string, unknown> = { profile, ports: PROFILES[profile], bandwidth, maxRooms: 64, heartbeatMs: 2000 }
  const diagnostics = fixture.diagnostics(), sampler = resourceSampler(diagnostics.pids)
  // Records every supervisor to backend call and its outcome, so a children-pending refusal can be traced to the child that refused.
  const backendCalls: Array<{ at: number; backend: string; call: string; outcome: string }> = []
  const traceStart = performance.now()
  for (const [backend, target] of [['spry', fixture.supervisor.calls], ['shelter', fixture.supervisor.relay]] as const) {
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
      const original = (target as unknown as Record<string, unknown>)[name]
      if (name === 'constructor' || typeof original !== 'function') continue
      ;(target as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        try { const value = await (original as (...a: unknown[]) => unknown).apply(target, args); backendCalls.push({ at: Math.round(performance.now() - traceStart), backend, call: name, outcome: 'ok' }); return value }
        catch (error) { backendCalls.push({ at: Math.round(performance.now() - traceStart), backend, call: name, outcome: String((error as { reason?: string; code?: string; message?: string }).code ?? (error as { message?: string }).message) }); throw error }
      }
    }
  }
  const paceMs = Number(process.env.E2E_NODE_CAPACITY_PACE_MS ?? 0)
  try {
    const key = generateSecretKey(), owner = localIdentity(key), at = Math.floor(Date.now() / 1000)
    const ownerFetch = fetcherFor(fixture, '10.9.0.1')
    log.resourcesEmpty = sampler()
    const pair = await claimKithmootNode(parseKithmootNodePairingLink(fixture.pairing()), owner, { fetcher: ownerFetch })
    const devices: Array<{ room: string; node: NonNullable<ReturnType<typeof readNodeRoom>>; identity: ParticipantIdentity; grantId: string; source: string }> = []
    const enrolMs: number[] = [], grantMs: number[] = [], accessMs: number[] = [], credentialMs: number[] = [], failures: unknown[] = []
    const enrolByRoom: number[] = []
    const started = performance.now()
    for (let index = 0; index < 64; index++) {
      const room = (index + 1).toString(16).padStart(2, '0').repeat(32).slice(0, 64)
      const node = readNodeRoom(signNodeRoom({ authoritySk: key, room, serviceKey: pair.serviceKey, origin: pair.origin, ...(pair.turnPorts ? { turnPorts: pair.turnPorts } : {}), now: at }), at)!
      const roomFetch = fetcherFor(fixture, `10.1.${index}.1`)
      const pace = () => paceMs ? new Promise(r => setTimeout(r, paceMs)) : undefined
      await pace()
      let began = performance.now()
      try { await enrolNodeRoom(pair, node, owner, { fetcher: roomFetch }) } catch (error) { failures.push({ step: 'enrol', index, ...refusal(error) }); continue }
      enrolMs.push(performance.now() - began); enrolByRoom.push(performance.now() - began)
      const count = 2 + index % 3
      for (let slot = 0; slot < count; slot++) {
        const identity = localIdentity(generateSecretKey()), grantId = (index * 8 + slot + 1).toString(16).padStart(32, '0'), source = `10.2.${index}.${slot + 1}`
        const grant = buildGrant({ authoritySk: key, roomId: room, device: identity.pubkey, server: 'node.example',
          scopes: ['turn', 'relay-read', 'relay-write'], grantId, createdAt: at, expiration: at + 3600 })
        await pace()
        began = performance.now()
        try { await postNodeGrant(node, grant, owner, { fetcher: roomFetch }) } catch (error) { failures.push({ step: 'grant', index, slot, ...refusal(error) }); continue }
        grantMs.push(performance.now() - began)
        devices.push({ room, node, identity, grantId, source })
      }
    }
    log.setup = { seconds: Math.round((performance.now() - started) / 100) / 10, rooms: 64, devices: devices.length, failures,
      enrolMs: summary(enrolMs), enrolFirstEight: summary(enrolByRoom.slice(0, 8)), enrolLastEight: summary(enrolByRoom.slice(-8)), grantMs: summary(grantMs) }
    log.resourcesAfterSetup = sampler()
    log.paceMs = paceMs
    const refusedCalls = backendCalls.filter(c => c.outcome !== 'ok')
    log.backendTrace = { total: backendCalls.length, byCall: Object.fromEntries([...new Set(backendCalls.map(c => c.backend + '.' + c.call))].map(k => [k, backendCalls.filter(c => c.backend + '.' + c.call === k).length])),
      firstRefusals: refusedCalls.slice(0, 5), refusedCount: refusedCalls.length, refusedByOutcome: refusedCalls.reduce<Record<string, number>>((acc, c) => { const k = c.backend + '.' + c.call + ':' + c.outcome; acc[k] = (acc[k] ?? 0) + 1; return acc }, {}) }
    // The 65th room is refused by the ledger cap before anything is projected.
    try {
      const room = 'ff'.repeat(32)
      await enrolNodeRoom(pair, readNodeRoom(signNodeRoom({ authoritySk: key, room, serviceKey: pair.serviceKey, origin: pair.origin, ...(pair.turnPorts ? { turnPorts: pair.turnPorts } : {}), now: at }), at)!, owner, { fetcher: fetcherFor(fixture, '10.1.200.1') })
      log.roomSixtyFive = 'accepted'
    } catch (error) { log.roomSixtyFive = refusal(error) }

    // Reach ready, then time a forced reconcile and a mutation at full size.
    const readyAt = performance.now()
    await expect.poll(async () => (await fixture.supervisor.ownerStatus()).ready, { timeout: 60000, intervals: [200] }).toBe(true)
    log.readyAfterSetupMs = Math.round(performance.now() - readyAt)
    log.ownerStatus = await fixture.supervisor.ownerStatus()
    const ticks: number[] = []
    for (let tick = 0; tick < 5; tick++) { const began = performance.now(); await fixture.supervisor.tick(); ticks.push(performance.now() - began) }
    log.forcedTickMs = summary(ticks)
    {
      const room = devices[0]!, identity = localIdentity(generateSecretKey()), grantId = 'aa'.repeat(16)
      const grant = buildGrant({ authoritySk: key, roomId: room.room, device: identity.pubkey, server: 'node.example',
        scopes: ['turn', 'relay-read', 'relay-write'], grantId, createdAt: at, expiration: at + 3600 })
      const began = performance.now(); await postNodeGrant(room.node, grant, owner, { fetcher: fetcherFor(fixture, '10.1.0.1') })
      log.mutationAtFullSizeMs = Math.round(performance.now() - began)
      devices.push({ ...room, identity, grantId, source: '10.2.0.9' })
    }
    log.relayAfterSetup = await fixture.relayMetrics()
    log.shelterAfterSetup = await fixture.relay.status()
    log.ledgerHealth = { rooms: fixture.ledger.rooms().length, devices: fixture.ledger.devices().length }

    // At rest. Credentials last five minutes, so a six minute window sees every
    // device renew once. Each cycle polls access and issues credentials.
    const rest: unknown[] = [], credentialIssuedAt: number[] = []
    const pollRound = async (label: string, all: boolean) => {
      const chosen = all ? devices : devices.filter((_value, index) => index % 6 === 0)
      const bad: unknown[] = []
      for (let offset = 0; offset < chosen.length; offset += 16) await Promise.all(chosen.slice(offset, offset + 16).map(async device => {
        const fetcher = fetcherFor(fixture, device.source)
        let began = performance.now(), access: NodeDeviceAccess
        try { access = await queryNodeAccess(device.node, device.grantId, device.identity, { fetcher }) } catch (error) { bad.push({ step: 'access', ...refusal(error) }); return }
        accessMs.push(performance.now() - began)
        if (access.state !== 'active') { bad.push({ step: 'access', state: access.state }); return }
        began = performance.now()
        try { const login = await nodeTurnCredentials(device.node, access, device.identity, { fetcher }); credentialMs.push(performance.now() - began); credentialIssuedAt.push(login.expiresAt) }
        catch (error) { bad.push({ step: 'credentials', ...refusal(error) }) }
      }))
      return { label, devicesPolled: chosen.length, problems: bad.length, firstProblems: bad.slice(0, 3) }
    }
    const restStart = Date.now()
    rest.push(await pollRound('t0 all devices', true))
    let credentialsRenewedAll = false
    while (Date.now() - restStart < restSeconds * 1000) {
      await new Promise(resolve => setTimeout(resolve, Math.min(30000, restSeconds * 1000 - (Date.now() - restStart))))
      const elapsed = Math.round((Date.now() - restStart) / 1000)
      const renew = !credentialsRenewedAll && elapsed >= 300
      if (renew) credentialsRenewedAll = true
      const round = await pollRound(`t+${elapsed}s ${renew ? 'all devices (past the five minute credential lifetime)' : 'one in six'}`, renew)
      const began = performance.now(); const status = await fixture.supervisor.ownerStatus()
      rest.push({ ...round, elapsed, ownerStatusMs: Math.round(performance.now() - began), ready: status.ready, turnReady: status.turnReady, relayReady: status.relayReady,
        resources: sampler(), relay: await fixture.relayMetrics() })
    }
    log.rest = rest
    log.accessPollMs = summary(accessMs); log.credentialMs = summary(credentialMs)
    log.finalRelay = await fixture.relayMetrics(); log.finalOwnerStatus = await fixture.supervisor.ownerStatus()
    log.finalShelter = await fixture.relay.status()
    log.stderr = fixture.diagnostics().stderr
    console.log('Idle scale: ' + JSON.stringify({ setup: log.setup, ready: log.readyAfterSetupMs, ticks: log.forcedTickMs, access: log.accessPollMs, credentials: log.credentialMs }))
  } finally {
    await evidence(`node-capacity-idle-${profile}.json`, log, info)
    await fixture.close()
  }
})

interface Row { local: string; remote: string; frames: number; energy: number; audio: number; videoPackets: number; bytes: number; sentAudio: number; localType?: string; remoteType?: string; policy?: string }
interface Sample { audioSenders: Array<{ ready?: string; enabled?: boolean; muted?: boolean; connection: string }>; connections: Row[]; states: Array<{ connection: string; ice: string }>; iceErrors: Array<{ code: number; url: string; text: string }> }

async function sample(): Promise<Sample> {
  const state = window as unknown as { __pcs: RTCPeerConnection[]; __iceErrors: Sample['iceErrors'] }
  const connections: Row[] = []
  for (const pc of state.__pcs) {
    if (pc.connectionState !== 'connected') continue
    let report: RTCStatsReport
    try { report = await pc.getStats() } catch { continue }
    const row: Row = {
      local: /^o=\S+ (\S+)/m.exec(pc.localDescription?.sdp ?? '')?.[1] ?? '',
      remote: /^o=\S+ (\S+)/m.exec(pc.remoteDescription?.sdp ?? '')?.[1] ?? '',
      frames: 0, energy: 0, audio: 0, videoPackets: 0, bytes: 0, sentAudio: 0, policy: pc.getConfiguration().iceTransportPolicy,
    }
    report.forEach(value => {
      if (value.type === 'inbound-rtp') {
        row.bytes += value.bytesReceived ?? 0
        if (value.kind === 'video') { row.frames += value.framesDecoded ?? 0; row.videoPackets += value.packetsReceived ?? 0 }
        if (value.kind === 'audio') { row.energy += value.totalAudioEnergy ?? 0; row.audio += value.packetsReceived ?? 0 }
      }
      if (value.type === 'outbound-rtp' && value.kind === 'audio') row.sentAudio += value.packetsSent ?? 0
      if (value.type === 'transport' && value.selectedCandidatePairId) {
        const pair = report.get(value.selectedCandidatePairId)
        row.localType = report.get(pair?.localCandidateId)?.candidateType
        row.remoteType = report.get(pair?.remoteCandidateId)?.candidateType
      }
    })
    connections.push(row)
  }
  const audioSenders = state.__pcs.flatMap(pc => pc.getSenders().filter(sender => sender.track?.kind === 'audio').map(sender => ({ ready: sender.track?.readyState, enabled: sender.track?.enabled, muted: sender.track?.muted, connection: pc.connectionState })))
  return { audioSenders, connections, states: state.__pcs.map(pc => ({ connection: pc.connectionState, ice: pc.iceConnectionState })), iceErrors: state.__iceErrors }
}

test(`concurrent calls: ${steps.join(', ')} two-person calls in separate rooms (${profile} profile)`, async ({ baseURL }, info) => {
  test.skip(!enabled, 'explicit disposable local node qualification')
  expect(process.env.E2E_NODE_SPRY_BINARY).toBeTruthy(); expect(process.env.E2E_NODE_SHELTER_BINARY).toBeTruthy()
  test.setTimeout(3 * 3600 * 1000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { maxRooms: 64, relayPortCount: PROFILES[profile], relayPortFirst,
    aggregateBytesPerSecond: bandwidth, turnPorts, heartbeatMs: 2000 })
  const diagnostics = fixture.diagnostics(), sampler = resourceSampler(diagnostics.pids)
  const browser = await chromium.launch({ args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection',
    '--host-resolver-rules=MAP node.example 127.0.0.1,MAP turn.node.example 127.0.0.1',
  ] }).catch(async error => { await fixture.close(); throw error })
  const contexts: BrowserContext[] = [], errors: string[] = []
  let fixtureRetries = 0
  const nodeResponses = new Map<string, number>(), nodeProblems: Array<{ device: string; path: string; status: number }> = []
  const log: Record<string, unknown> = { profile, ports: PROFILES[profile], bandwidth, steps, maxRooms: 64 }
  const results: unknown[] = []; log.results = results
  const ownerKey = generateSecretKey()
  try {
    async function device(name: string, source: string, creator: boolean) {
      const context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 960, height: 700 } })
      contexts.push(context); await context.addInitScript(SYNTHETIC_MIC)
      await context.addInitScript(() => {
        const state = window as unknown as { __iceErrors: Sample['iceErrors'] }; state.__iceErrors = []
        const Base = window.RTCPeerConnection
        window.RTCPeerConnection = class extends Base {
          constructor(configuration?: RTCConfiguration) {
            const resolve = (url: string) => url.replace(/^(stun:|turn:|turns:)(?:turn\.)?node\.example(?=:)/, (_match, scheme: string) => `${scheme}127.0.0.1`)
            super(configuration && { ...configuration, iceServers: configuration.iceServers?.map(server => ({ ...server,
              urls: typeof server.urls === 'string' ? resolve(server.urls) : server.urls.map(resolve) })) })
            this.addEventListener('icecandidateerror', event => state.__iceErrors.push({ code: event.errorCode, url: event.url, text: event.errorText.slice(0, 200) }))
          }
        }
      })
      await context.grantPermissions(['camera', 'microphone', 'local-network-access'], { origin: new URL(baseURL!).origin })
      if (creator) {
        await context.exposeFunction('capacityPublicKey', () => getPublicKey(ownerKey))
        await context.exposeFunction('capacitySign', (value: EventTemplate) => finalizeEvent(value, ownerKey))
        await context.addInitScript(() => {
          const state = window as unknown as { capacityPublicKey(): Promise<string>; capacitySign(event: unknown): Promise<unknown> }
          Object.defineProperty(window, 'nostr', { configurable: true, value: {
            getPublicKey: () => state.capacityPublicKey(), signEvent: (event: unknown) => state.capacitySign(event),
          } })
        })
      }
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, accountRelay }) => {
        const Base = window.WebSocket
        window.WebSocket = class extends Base {
          constructor(url: string | URL, protocols?: string | string[]) {
            const value = String(url)
            if (!value.startsWith('wss://')) throw Error('Unexpected non-TLS fixture socket')
            super(value === 'wss://node.example/events' ? node : value.includes('localhost') ? value : accountRelay, protocols)
          }
        }
      }, { node: fixture.websocket, accountRelay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname
        // Fixture fault: the desk closes idle keep-alive sockets after 5 s and the harness client can reuse one that has just closed
        // (ECONNRESET before any byte was handled). Retried and counted so it is never mistaken for a node result.
        let response: Awaited<ReturnType<typeof route.fetch>> | undefined
        for (let attempt = 0; !response; attempt++) {
          try { response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path, headers: { ...request.headers(), 'x-forwarded-for': source } }) }
          catch (error) { if (attempt >= 3 || !/ECONNRESET/.test(String(error))) throw error; fixtureRetries++ }
        }
        const bucket = `${path} ${response.status()}`; nodeResponses.set(bucket, (nodeResponses.get(bucket) ?? 0) + 1)
        if (response.status() >= 400 && nodeProblems.length < 40) nodeProblems.push({ device: name, path, status: response.status() })
        await route.fulfill({ response })
      })
      const page = await context.newPage()
      page.on('pageerror', error => { if (page.url().startsWith(new URL(baseURL!).origin + '/')) errors.push(`${name}: ${error.message}`) })
      return page
    }

    const keeper = await device('keeper', '10.8.0.1', true)
    await signInAccount(keeper, baseURL!); await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing()); await keeper.locator('#nodePair').click()
    await keeper.locator('#actionConfirm').click(); await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(keeper)

    const calls: Array<{ room: number; pages: [Page, Page]; started: boolean; names: [string, string] }> = []
    async function addRoom(index: number) {
      await openNewRoomForm(keeper)
      await keeper.locator('#roomName').fill(`Capacity room ${index + 1}`)
      if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Creator')
      await expect(keeper.locator('#roomOnNode')).toBeChecked(); await keeper.locator('#create').click()
      await expect(keeper.locator('#chatInput')).toBeVisible()
      const link = keeper.url(), pages: Page[] = []
      for (let guest = 0; guest < 2; guest++) {
        const page = await device(`room${index + 1}-guest${guest + 1}`, `10.3.${index}.${guest + 1}`, false)
        await page.goto(link)
        await expect.poll(async () => await page.locator('#chatInput').isVisible() || await page.locator('#actionConfirm').isVisible(), { timeout: 30000 }).toBe(true)
        if (await page.locator('#actionConfirm').isVisible()) await page.locator('#actionConfirm').click()
        const card = keeper.locator('.approvalCard.knock')
        await expect(card).toHaveCount(1, { timeout: 30000 })
        await card.getByRole('button', { name: 'Let in', exact: true }).click()
        await expect(page.locator('#chatInput')).toBeVisible({ timeout: 30000 })
        pages.push(page)
      }
      calls.push({ room: index + 1, pages: [pages[0]!, pages[1]!], started: false, names: [`room${index + 1}-guest1`, `room${index + 1}-guest2`] })
    }

    const snapshot = (list: typeof calls) => Promise.all(list.flatMap(call => call.pages).map(page => page.evaluate(sample)))
    // A call is proven when each guest receives the other's relayed audio and
    // video over a relay/relay pair, counters rising across the window.
    const judge = (list: typeof calls, before: Sample[], after: Sample[]) => list.map((call, position) => {
      const [a, b] = [position * 2, position * 2 + 1] as const
      const sessions = (value: Sample) => new Set(value.connections.map(row => row.local))
      const direction = (receiver: number, sender: number) => {
        const rows = after[receiver]!.connections.filter(row => sessions(after[sender]!).has(row.remote))
        const moved = rows.some(row => { const old = before[receiver]!.connections.find(prior => prior.local === row.local && prior.remote === row.remote)
          return !!old && row.frames > old.frames && row.audio > old.audio && row.energy > old.energy })
        const deltas = rows.map(row => { const old = before[receiver]!.connections.find(prior => prior.local === row.local && prior.remote === row.remote)
          const sending = after[sender]!.connections.find(candidate => candidate.local === row.remote && candidate.remote === row.local)
          const sendingOld = before[sender]!.connections.find(prior => prior.local === row.remote && prior.remote === row.local)
          return old ? { senderAudioPacketsSent: sending && sendingOld ? sending.sentAudio - sendingOld.sentAudio : 'unknown', frames: row.frames - old.frames, audioPackets: row.audio - old.audio, energy: Math.round((row.energy - old.energy) * 1e4) / 1e4, videoPackets: row.videoPackets - old.videoPackets, bytes: row.bytes - old.bytes } : 'new session' })
        return { deltas, connected: rows.length > 0, relayRelay: rows.length > 0 && rows.every(row => row.policy === 'relay' && row.localType === 'relay' && row.remoteType === 'relay'), moved }
      }
      const one = direction(a, b), two = direction(b, a)
      return { room: call.room, aHearsB: one, bHearsA: two, ok: one.connected && two.connected && one.relayRelay && two.relayRelay && one.moved && two.moved }
    })

    let created = 0
    for (const step of steps) {
      const began = performance.now()
      while (created < step) await addRoom(created++)
      const fresh = calls.filter(call => !call.started), setupSeconds = Math.round((performance.now() - began) / 100) / 10
      const before0 = await fixture.relayMetrics(), startedAt = performance.now()
      const joins = await Promise.allSettled(fresh.flatMap(call => call.pages).map(page => turnOnMedia(page)))
      for (const call of fresh) call.started = true
      const joinFailures = joins.filter(value => value.status === 'rejected').length
      const active = calls.slice(0, step)
      // Wait for every call to show a connection on both sides, or give up.
      const connectedAt = new Map<number, number>()
      const deadline = Date.now() + 60000
      while (Date.now() < deadline && connectedAt.size < active.length) {
        const values = await snapshot(active)
        active.forEach((call, position) => {
          if (!connectedAt.has(call.room) && values[position * 2]!.connections.length > 0 && values[position * 2 + 1]!.connections.length > 0)
            connectedAt.set(call.room, Math.round((performance.now() - startedAt) / 100) / 10)
        })
        await keeper.waitForTimeout(500)
      }
      const windowSeconds = 10
      const beforeSample = await snapshot(active), beforeMetrics = await fixture.relayMetrics(), clockBefore = Date.now()
      await keeper.waitForTimeout(windowSeconds * 1000)
      const afterSample = await snapshot(active), afterMetrics = await fixture.relayMetrics(), clock = (Date.now() - clockBefore) / 1000
      const verdicts = judge(active, beforeSample, afterSample)
      const numeric = (value: unknown) => Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'number'))
      const delta = Object.fromEntries(Object.entries(numeric(afterMetrics?.metrics)).map(([name, value]) =>
        [name, Math.round(((value as number) - ((numeric(beforeMetrics?.metrics)[name] as number | undefined) ?? 0)) * 100) / 100]))
      const record: Record<string, unknown> = { calls: step, newCalls: fresh.length, setupSeconds, joinFailures,
        connectSeconds: Object.fromEntries(connectedAt), allConnected: connectedAt.size === active.length,
        callsOk: verdicts.filter(verdict => verdict.ok).length, verdicts, windowSeconds: clock,
        relayBefore: beforeMetrics, relayAfter: afterMetrics, relayDeltaOverWindow: delta,
        ownerStatus: await fixture.supervisor.ownerStatus(), resources: sampler(),
        iceErrors: afterSample.map((value, position) => value.iceErrors.length ? { page: active[Math.floor(position / 2)]!.names[position % 2], errors: value.iceErrors } : null).filter(Boolean),
        pageStates: afterSample.map((value, position) => ({ page: active[Math.floor(position / 2)]!.names[position % 2], states: value.states })),
        fixtureSocketRetries: fixtureRetries, nodeResponses: Object.fromEntries(nodeResponses), nodeProblems: [...nodeProblems], preCallMetrics: before0 }
      results.push(record)
      console.log(`Capacity ${profile}: K=${step} callsOk=${record.callsOk} connected=${record.allConnected} joinFailures=${joinFailures}`)
      if (record.callsOk !== step) {
        // Settling check: wait, then judge a second window, so a call still negotiating is told apart from one that never carries media.
        await keeper.waitForTimeout(30000)
        const recheckBefore = await snapshot(active), recheckMetricsBefore = await fixture.relayMetrics()
        await keeper.waitForTimeout(10000)
        const recheckAfter = await snapshot(active), recheckMetricsAfter = await fixture.relayMetrics()
        const recheckVerdicts = judge(active, recheckBefore, recheckAfter)
        record.recheck = { afterSeconds: 30, callsOk: recheckVerdicts.filter(verdict => verdict.ok).length, notOk: recheckVerdicts.filter(verdict => !verdict.ok).map(verdict => verdict.room),
          audioSendersPerPage: recheckAfter.map((value, position) => ({ page: active[Math.floor(position / 2)]!.names[position % 2], senders: value.audioSenders })),
          peerConnectionsPerPage: recheckAfter.map((value, position) => ({ page: active[Math.floor(position / 2)]!.names[position % 2], total: value.states.length, connected: value.states.filter(state => state.connection === 'connected').length })),
          udpForwardedBytesPerSecond: Math.round((((recheckMetricsAfter?.metrics as Record<string, number> | undefined)?.udpForwardedBytes ?? 0) - ((recheckMetricsBefore?.metrics as Record<string, number> | undefined)?.udpForwardedBytes ?? 0)) / 10) }
        // First failure: what a browser shows and what the node knows.
        const screens = await Promise.all(active.flatMap(call => call.pages).map(async (page, position) => ({
          page: active[Math.floor(position / 2)]!.names[position % 2],
          text: await page.locator('body').innerText({ timeout: 5000 }).catch(() => 'unavailable'),
          callToggle: await page.locator('#callToggle').getAttribute('aria-label').catch(() => null) })))
        record.screens = screens
        record.serverSide = { stderr: fixture.diagnostics().stderr, ownerStatus: await fixture.supervisor.ownerStatus(), supervisor: fixture.supervisor.status(),
          shelter: await fixture.relay.status().catch(() => null), relay: await fixture.relayMetrics().catch(() => null) }
        for (const [position, call] of active.entries()) if (!verdicts[position]!.ok) await call.pages[0].screenshot({ path: info.outputPath(`failed-call-${call.room}.png`) }).catch(() => {})
        log.firstFailure = { calls: step }
        break
      }
    }
    log.errors = errors
    log.fixtureDirectory = 'removed on close'
  } finally {
    log.stderr = fixture.diagnostics().stderr
    await evidence(`node-capacity-calls-${profile}-${bandwidth}.json`, log, info)
    await Promise.allSettled(contexts.map(context => context.close()))
    try { await browser.close() } finally { await fixture.close(); ownerKey.fill(0) }
  }
})
