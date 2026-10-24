import { test, expect, type Page } from '@playwright/test'
import { chooseCallMore, createRoom, inbound, join, joinWithMedia, newDeviceContext, openSettings, closeSettings, SYNTHETIC_MIC } from './browser.js'
import type { CallRelay } from '../app/src/call-relay.js'
import { RELAY_ONLY_NO_RELAY } from '../app/src/relay-only.js'

const api = `http://127.0.0.1:${process.env.E2E_INDEPENDENT_TURN_PORT ?? 7793}`

async function account(instance: 'alpha' | 'beta', participant: number): Promise<CallRelay> {
  const response = await fetch(`${api}/${instance}/${participant}`)
  expect(response.ok).toBe(true)
  return response.json() as Promise<CallRelay>
}

async function configure(page: Page, relay: CallRelay, importFile = false): Promise<void> {
  await openSettings(page, 'Connections')
  if (importFile) {
    await page.getByLabel('Call relay connection file', { exact: true }).setInputFiles({
      name: 'synthetic-call-relay.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(relay)),
    })
    await expect(page.locator('#callRelayStatus')).toContainText('File imported for review')
    await expect(page.getByLabel('Relay addresses', { exact: true })).toHaveValue(relay.urls.join(', '))
  } else {
    await page.getByLabel('Relay addresses', { exact: true }).fill(relay.urls.join(', '))
    await page.getByLabel('Relay username', { exact: true }).fill(relay.username)
    await page.getByLabel('Relay password', { exact: true }).fill(relay.credential)
  }
  await page.getByRole('button', { name: 'Save call relay', exact: true }).click()
  await expect(page.locator('#callRelayStatus')).toContainText('Call relay saved')
  await closeSettings(page)
}

async function pairs(page: Page) {
  return page.evaluate(async () => {
    const out: { peer: number; local: string; remote: string; relayProtocol: string; bytes: number; frames: number; audioEnergy: number; mediaEpoch: string }[] = []
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
    for (let peer = 0; peer < pcs.length; peer++) {
      const pc = pcs[peer]
      if (pc.connectionState !== 'connected') continue
      const report = await pc.getStats()
      let frames = 0, audioEnergy = 0
      const streams: string[] = []
      report.forEach(stat => {
        if (stat.type !== 'inbound-rtp') return
        streams.push(stat.id)
        if (stat.kind === 'video') frames += stat.framesDecoded ?? 0
        if (stat.kind === 'audio') audioEnergy += stat.totalAudioEnergy ?? 0
      })
      report.forEach(stat => {
        if (stat.type !== 'candidate-pair' || stat.state !== 'succeeded' || !stat.nominated) return
        const local = report.get(stat.localCandidateId), remote = report.get(stat.remoteCandidateId)
        out.push({ peer, local: local?.candidateType, remote: remote?.candidateType,
          relayProtocol: local?.relayProtocol, bytes: stat.bytesReceived, frames, audioEnergy, mediaEpoch: streams.sort().join('|') })
      })
    }
    return out
  })
}

async function media(page: Page, peers: number, relay: CallRelay): Promise<void> {
  if (peers > 1) {
    // Decoding all cameras requires displaying all cameras. Off-page gallery
    // sinks are deliberately paused by the product; they are not transport loss.
    await chooseCallMore(page, 'Gallery', 'Layout')
    await expect(page.locator('#room video[data-gallery-off-page]')).toHaveCount(0)
  }
  await expect.poll(async () => (await page.evaluate(inbound)).videoStreams, { timeout: 60_000 }).toBeGreaterThanOrEqual(peers)
  await expect.poll(async () => (await page.evaluate(inbound)).framesDecoded).toBeGreaterThan(5 * peers)
  await expect.poll(async () => (await page.evaluate(inbound)).audioEnergy).toBeGreaterThan(0)
  await expect.poll(async () => (await pairs(page)).filter(pair => pair.bytes > 0).length).toBeGreaterThanOrEqual(peers)
  await expect.poll(async () => (await pairs(page)).filter(pair => pair.frames > 5 && pair.audioEnergy > 0).length,
    { timeout: 30_000, message: 'each remote participant must supply decoded video and audio energy' }).toBeGreaterThanOrEqual(peers)
  // Rebuilding a peer or replacing an RTP stream resets its counters. Establish
  // a new baseline for that epoch, then still require fresh video AND audio.
  const baseline = new Map((await pairs(page)).map(pair => [pair.peer, pair]))
  await expect.poll(async () => (await pairs(page)).filter(pair => {
    const previous = baseline.get(pair.peer)
    if (!previous || previous.mediaEpoch !== pair.mediaEpoch || pair.frames < previous.frames || pair.audioEnergy < previous.audioEnergy) {
      baseline.set(pair.peer, pair)
      return false
    }
    return pair.frames > previous.frames + 2 && pair.audioEnergy > previous.audioEnergy
  }).length, { timeout: 30_000, message: 'every peer must still deliver new video and audio; stale RTP counters cannot pass' }).toBeGreaterThanOrEqual(peers)
  const selected = await pairs(page)
  expect(selected.every(pair => pair.local === 'relay' && pair.remote === 'relay' && pair.relayProtocol === 'tls')).toBe(true)
  const configuration = await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.map(pc => ({
    policy: pc.getConfiguration().iceTransportPolicy,
    urls: (pc.getConfiguration().iceServers ?? []).flatMap(server => [server.urls].flat()),
  })))
  expect(configuration.length).toBeGreaterThan(0)
  for (const config of configuration) {
    expect(config.policy).toBe('relay')
    expect(config.urls.length).toBeGreaterThan(0)
    expect(config.urls).toEqual(relay.urls)
    expect(config.urls.every(url => url.startsWith('turns:') && url.endsWith('?transport=tcp'))).toBe(true)
  }
}

test('participants use separate TLS call servers, group-call and replace a failed server without replacing the room', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1, 2].map(() => newDeviceContext(browser, baseURL!, {
    viewport: { width: 1920, height: 1080 },
  })))
  const denied: string[] = []
  const pages: Page[] = []
  let phase = 'create'
  const completedPhases: { phase: string; pairs: Awaited<ReturnType<typeof pairs>>[] }[] = []
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
        const url = new URL(socket.url())
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
          denied.push(url.origin); socket.close(); return
        }
        socket.connectToServer()
      })
      await context.addInitScript(SYNTHETIC_MIC)
      // Use the person's real product privacy setting, not a patched ICE factory.
      await context.addInitScript(() => {
        localStorage.setItem('kithmoot.hide-ip.v1', '1')
        localStorage.setItem('kithmoot.profiles.enabled', 'false')
      })
    }
    pages.push(...await Promise.all(contexts.map(context => context.newPage())))
    const link = await createRoom(pages[0], baseURL!)
    // Negative control: an unconfigured local app must not quietly pass via host ICE.
    await pages[0].locator('#callToggle').click()
    await expect(pages[0].locator('#status')).toContainText(RELAY_ONLY_NO_RELAY)
    expect(await pages[0].evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length)).toBe(0)
    await Promise.all(pages.slice(1).map(page => page.goto(baseURL!)))
    const initial = await Promise.all([account('alpha', 0), account('beta', 1), account('beta', 2)])
    for (let i = 0; i < pages.length; i++) await configure(pages[i], initial[i], i > 0)
    // The creator joined before choosing a server. Reopening applies that choice.
    await pages[0].reload()
    await joinWithMedia(pages[0], link, 'Ada')
    await joinWithMedia(pages[1], link, 'Rowan')
    phase = 'one-to-one'
    await media(pages[0], 1, initial[0]); await media(pages[1], 1, initial[1])
    const oneToOne = await Promise.all(pages.slice(0, 2).map(pairs))
    completedPhases.push({ phase, pairs: oneToOne })
    await joinWithMedia(pages[2], link, 'PeerC')
    phase = 'initial group'
    for (let i = 0; i < pages.length; i++) await media(pages[i], 2, initial[i])
    const group = await Promise.all(pages.map(pairs))
    completedPhases.push({ phase, pairs: group })
    for (const page of pages) {
      expect(await page.evaluate(() => '__kithmootCollectDiagnostics' in window)).toBe(false)
      const shared = await page.locator('#shareUrl').inputValue()
      const payload = Buffer.from(shared.split('#')[1], 'base64url').toString()
      for (const relay of initial) {
        expect(payload.includes(relay.credential), 'room link leaked a transport password').toBe(false)
        expect(payload.includes(relay.urls[0]), 'room link depends on a device transport choice').toBe(false)
      }
    }
    expect((await fetch(`${api}/stop/alpha`, { method: 'POST' })).ok).toBe(true)
    // Chat/admission survive the transport outage; the two beta peers still call.
    await pages[0].locator('#chatInput').fill('Transport outage does not remove room membership')
    await pages[0].locator('#chatInput').press('Enter')
    for (const page of pages.slice(1)) await expect(page.locator('#chatLog')).toContainText('Transport outage does not remove room membership')
    const before = await pages[1].evaluate(inbound)
    await expect.poll(async () => (await pages[1].evaluate(inbound)).framesDecoded).toBeGreaterThan(before.framesDecoded + 5)
    // A fresh connection cannot use the stopped allocation or direct candidates.
    await pages[0].reload(); await join(pages[0])
    await expect(pages[0].locator('#roomArea')).toBeVisible()
    const replacement = await account('beta', 0)
    await configure(pages[0], replacement)
    await pages[0].reload(); await joinWithMedia(pages[0], link, 'Ada')
    phase = 'restored group'
    for (let i = 0; i < pages.length; i++) await media(pages[i], 2, i === 0 ? replacement : initial[i])
    const restored = await Promise.all(pages.map(pairs))
    completedPhases.push({ phase, pairs: restored })
    for (let cycle = 0; cycle < 3; cycle++) {
      phase = `repeat reconnect ${cycle + 1}`
      await pages[0].reload(); await joinWithMedia(pages[0], link, 'Ada')
      for (let i = 0; i < pages.length; i++) await media(pages[i], 2, i === 0 ? replacement : initial[i])
      completedPhases.push({ phase, pairs: await Promise.all(pages.map(pairs)) })
    }
    await pages[0].locator('#chatInput').fill('Same room after participant-chosen transport replacement')
    await pages[0].locator('#chatInput').press('Enter')
    for (const page of pages.slice(1)) await expect(page.locator('#chatLog')).toContainText('Same room after participant-chosen transport replacement')
    expect(denied).toEqual([])
    await test.info().attach('independent-call-connectivity', { contentType: 'application/json', body: JSON.stringify({
      transport: 'TLS over TCP only from browsers to TURN; UDP between TURN instances',
      publisherRuntimeAvailable: false, instanceCount: 2, participants: 3,
      oneToOne, group, restored, chatDuringTransportOutage: true, roomLinkReplaced: false,
      providerReplacement: 'explicit device Settings then reopen; not automatic failover',
      subsequentReconnectCycles: 3,
      directCandidatesAllowed: false, externalRequests: denied,
      separateNetworks: false, publicCertificateQualified: false, publicProviderSelected: false,
      guestSetupRemoved: false, legalExemptionEstablished: false,
      guestConfiguration: 'separate provider login file imported and explicitly saved; no manual server/password entry for guests',
    }, null, 2) })
  } catch (error) {
    await test.info().attach('bounded-failure-state', { contentType: 'application/json', body: JSON.stringify({ phase, completedPhases,
      peers: await Promise.all(pages.map(async page => ({
        pairs: await pairs(page),
        states: await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.map(pc => ({
          connection: pc.connectionState, ice: pc.iceConnectionState, signalling: pc.signalingState,
          sending: pc.getSenders().map(s => ({ kind: s.track?.kind, state: s.track?.readyState, enabled: s.track?.enabled })),
          receiving: pc.getReceivers().map(r => ({ kind: r.track.kind, state: r.track.readyState, muted: r.track.muted,
            sinks: [...document.querySelectorAll<HTMLMediaElement>('video,audio')].filter(el => el.srcObject instanceof MediaStream && el.srcObject.getTracks().includes(r.track))
              .map(el => ({ connected: el.isConnected, paused: el.paused, offPage: el.hasAttribute('data-gallery-off-page'), visible: el.checkVisibility(), currentTime: el.currentTime,
                ancestors: [el, el.parentElement, el.parentElement?.parentElement, el.parentElement?.parentElement?.parentElement]
                  .filter((node): node is HTMLElement => node instanceof HTMLElement)
                  .map(node => ({ tag: node.tagName, id: node.id, classes: node.className, display: getComputedStyle(node).display,
                    visibility: getComputedStyle(node).visibility, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
              })),
          })),
          transceivers: pc.getTransceivers().map(t => ({ mid: t.mid, direction: t.direction, currentDirection: t.currentDirection })),
        }))),
      })).map(promise => promise.catch(() => ({ unavailable: true })))),
    }, null, 2) })
    throw error
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('connection files need review and saving; relay checks exchange real data, refuse bad credentials and cancel cleanly', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  await context.addInitScript(() => {
    localStorage.setItem('kithmoot.profiles.enabled', 'false')
    const state = window as unknown as { __relayCheckCaptures: number }
    state.__relayCheckCaptures = 0
    const refuseCapture = async () => { state.__relayCheckCaptures++; throw new Error('Relay check must not capture media') }
    navigator.mediaDevices.getUserMedia = refuseCapture
    navigator.mediaDevices.getDisplayMedia = refuseCapture
  })
  const page = await context.newPage()
  const external: string[] = []
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { external.push(url.origin); return route.abort() }
    return route.continue()
  })
  await context.routeWebSocket(/.*/, socket => {
    const url = new URL(socket.url())
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { external.push(url.origin); socket.close(); return }
    socket.connectToServer()
  })
  try {
    await page.goto(baseURL!)
    await openSettings(page, 'Connections')
    const relay = await account('beta', 0)
    const file = page.getByLabel('Call relay connection file', { exact: true })
    const upload = (value: unknown) => file.setInputFiles({ name: 'synthetic-call-relay.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
    const pcs = () => page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length)
    const before = await pcs()
    await upload(relay)
    await expect(page.locator('#callRelayStatus')).toContainText('File imported for review')
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.call-relay.v1'))).toBeNull()
    expect(await pcs()).toBe(before)
    await page.getByRole('button', { name: 'Test saved call relay', exact: true }).click()
    await expect(page.locator('#callRelayStatus')).toHaveText('Save a call relay before testing it.')
    expect(await pcs()).toBe(before)
    await page.getByRole('button', { name: 'Save call relay', exact: true }).click()
    const saved = await page.evaluate(() => localStorage.getItem('kithmoot.call-relay.v1'))
    await upload({ ...relay, secret: 'synthetic-root-key-not-for-import' })
    await expect(page.locator('#callRelayStatus')).toContainText('not a supported call relay file')
    expect(await page.locator('#callRelayStatus').textContent()).not.toContain('synthetic-root-key')
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.call-relay.v1'))).toBe(saved)
    await expect(page.getByLabel('Relay password', { exact: true })).toHaveValue(relay.credential)
    await file.setInputFiles({ name: 'oversize.json', mimeType: 'application/json', buffer: Buffer.alloc(16_385, 'x') })
    await expect(page.locator('#callRelayStatus')).toContainText('not a supported call relay file')
    expect(await pcs()).toBe(before)
    await page.getByRole('button', { name: 'Test saved call relay', exact: true }).click()
    await expect(page.locator('#callRelayStatus')).toContainText('Test data passed through', { timeout: 20_000 })
    const successful = await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.map(pc => ({
      policy: pc.getConfiguration().iceTransportPolicy, closed: pc.connectionState === 'closed',
    })))
    expect(successful.length).toBe(before + 2)
    expect(successful.every(pc => pc.policy === 'relay' && pc.closed)).toBe(true)
    // Altering the review form must not test the previous hidden/saved endpoint.
    await page.getByLabel('Relay password', { exact: true }).fill('synthetic-wrong-password')
    await page.getByRole('button', { name: 'Test saved call relay', exact: true }).click()
    await expect(page.locator('#callRelayStatus')).toContainText('Save the changes before testing')
    expect(await pcs()).toBe(before + 2)
    await page.getByRole('button', { name: 'Save call relay', exact: true }).click()
    await page.getByRole('button', { name: 'Test saved call relay', exact: true }).click()
    await expect(page.locator('#callRelayStatus')).toContainText('relay test did not complete', { timeout: 20_000 })
    expect(await page.locator('#callRelayStatus').textContent()).not.toContain('synthetic-wrong-password')
    await page.getByRole('button', { name: 'Test saved call relay', exact: true }).click()
    await expect.poll(pcs).toBe(before + 6)
    await closeSettings(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.every(pc => pc.connectionState === 'closed'))).toBe(true)
    expect(await page.evaluate(() => (document.querySelector('#callRelayPassword') as HTMLInputElement).value)).toBe('')
    expect(await page.locator('#callRelayStatus').textContent()).toBe('Relay test stopped.')
    expect(await page.evaluate(() => (window as unknown as { __relayCheckCaptures: number }).__relayCheckCaptures)).toBe(0)
    expect(external).toEqual([])
    await test.info().attach('call-relay-import-and-check', { contentType: 'application/json', body: JSON.stringify({
      importContactsServer: false, explicitSaveRequired: true, rootFieldsRefused: true, oversizeRefused: true,
      relayOnlyDataRoundTrip: true, testPeersClosed: true, unsavedChangesNotTested: true,
      badCredentialRefused: true, settingsCloseCancels: true, mediaQualified: false,
      noAutomaticProvider: true, publicProviderSelected: false, legalExemptionEstablished: false,
    }) })
  } finally { await context.close() }
})
