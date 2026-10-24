import { test, expect, type Page } from '@playwright/test'
import { createRoom, inbound, joinWithMedia, newDeviceContext, openSettings, closeSettings, remoteAudioCount, remotePictures, SYNTHETIC_MIC } from './browser.js'
import { callRelayPeerConnection } from '../app/src/call-relay.js'

interface Relay { urls: string[]; username: string; credential: string }

test('configured URI alternatives work in the real browser constructor and retain relay-only privacy', async ({ page }) => {
  // Execute the implementation itself in each browser. About:blank has no
  // application CSP; this evaluates only our own source, with synthetic login.
  const result = await page.evaluate(source => {
    const create = globalThis.eval(`(${source})`) as (config: RTCConfiguration) => RTCPeerConnection
    const pc = create({ iceTransportPolicy: 'relay', iceServers: [{
      urls: ['turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp', 'turns:relay.example:5349'],
      username: 'compat-test', credential: 'synthetic-compat-password',
    }] })
    try {
      const config = pc.getConfiguration()
      return { policy: config.iceTransportPolicy, urls: config.iceServers?.flatMap(server => [server.urls].flat()), username: config.iceServers?.[0].username }
    } finally { pc.close() }
  }, callRelayPeerConnection.toString())
  expect(result.policy).toBe('relay')
  expect(result.urls).toEqual(expect.arrayContaining(['turn:relay.example:3478', 'turns:relay.example:5349']))
  expect(result.username).toBe('compat-test')
})

async function configure(page: Page, relay: Relay) {
  await openSettings(page, 'Connections')
  await page.getByText('Other call relays', { exact: true }).click()
  await page.getByLabel('Relay addresses', { exact: true }).fill(relay.urls.join(', '))
  await page.getByLabel('Relay username', { exact: true }).fill(relay.username)
  await page.getByLabel('Relay password', { exact: true }).fill(relay.credential)
  await page.getByRole('button', { name: 'Save call relay', exact: true }).click()
  await expect(page.locator('#callRelayStatus')).toContainText('Call relay saved')
  await closeSettings(page)
}

test('an existing room carries two-way audio and video through a private relay configured in Settings', async ({ browser, baseURL }) => {
  const api = `http://127.0.0.1:${process.env.E2E_TURN_FIXTURE_PORT ?? 7788}`
  const relays = await Promise.all(['you', 'friend'].map(async who => {
    const response = await fetch(`${api}/${who}`)
    expect(response.ok).toBe(true)
    return response.json() as Promise<Relay>
  }))
  const contexts = await Promise.all([newDeviceContext(browser, baseURL!), newDeviceContext(browser, baseURL!)])
  try {
    for (const context of contexts) {
      await context.route('**/turn', route => route.fulfill({ status: 410, body: 'Shared relay closed' }))
      await context.addInitScript(SYNTHETIC_MIC)
      // Discard direct candidates: a same-machine shortcut cannot pass this test.
      await context.addInitScript(() => {
        const Native = window.RTCPeerConnection
        function RelayOnly(this: unknown, config?: RTCConfiguration) {
          return new Native({ ...config, iceTransportPolicy: 'relay' })
        }
        RelayOnly.prototype = Native.prototype
        window.RTCPeerConnection = RelayOnly as unknown as typeof RTCPeerConnection
      })
    }
    const pages = await Promise.all(contexts.map(context => context.newPage()))
    // Create first, configure later: no new invitation or room is required.
    const link = await createRoom(pages[0], baseURL!, undefined, 'You')
    await pages[1].goto(baseURL!)
    for (let i = 0; i < 2; i++) await configure(pages[i], relays[i])
    await pages[0].reload()
    for (let i = 0; i < 2; i++) await joinWithMedia(pages[i], link, i === 0 ? 'You' : 'Friend')
    for (const page of pages) {
      try {
        await expect.poll(async () => (await page.evaluate(remotePictures)).length, { timeout: 90_000 }).toBeGreaterThan(0)
      } catch (error) {
        for (const peer of pages) console.log(await peer.evaluate(async () => {
          return Promise.all((window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.map(async pc => {
            const stats: unknown[] = []
            ;(await pc.getStats()).forEach(stat => {
              if (['candidate-pair', 'local-candidate', 'remote-candidate', 'inbound-rtp'].includes(stat.type)) stats.push(stat)
            })
            return { state: pc.connectionState, ice: pc.iceConnectionState, stats }
          }))
        }))
        throw error
      }
      await expect.poll(async () => (await page.evaluate(inbound)).framesDecoded, { timeout: 60_000 }).toBeGreaterThan(0)
      await expect.poll(async () => (await page.evaluate(inbound)).audioEnergy, { timeout: 60_000 }).toBeGreaterThan(0)
      expect(await page.evaluate(remoteAudioCount)).toBeGreaterThan(0)
      const evidence = await page.evaluate(async () => {
        const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
        const out: { local: string; remote: string; bytes: number }[] = []
        for (const pc of pcs) {
          const report = await pc.getStats()
          report.forEach(stat => {
            if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
              out.push({ local: report.get(stat.localCandidateId)?.candidateType,
                remote: report.get(stat.remoteCandidateId)?.candidateType, bytes: stat.bytesReceived })
            }
          })
        }
        return out
      })
      expect(evidence.some(pair => pair.local === 'relay' && pair.remote === 'relay' && pair.bytes > 0)).toBe(true)
      // Sharing this room must not disclose this device's relay password.
      const shared = await page.locator('#shareUrl').inputValue()
      const payload = JSON.stringify(JSON.parse(Buffer.from(shared.split('#')[1], 'base64url').toString()))
      for (const relay of relays) expect(payload).not.toContain(relay.credential)
    }
    // Saved credentials survive a reload, can be edited and explicitly removed.
    const refused = await pages[1].evaluate(async relay => {
      const pc = new RTCPeerConnection({ iceServers: [{ ...relay, credential: 'deliberately-wrong-test-password' }], iceTransportPolicy: 'relay' })
      let candidates = 0
      const gathered = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 15_000)
        pc.onicecandidate = event => {
          if (event.candidate?.type === 'relay') candidates++
          if (!event.candidate) { clearTimeout(timer); resolve(true) }
        }
      })
      pc.createDataChannel('authentication-check')
      await pc.setLocalDescription(await pc.createOffer())
      const complete = await gathered
      pc.close()
      return { complete, candidates }
    }, relays[1])
    expect(refused).toEqual({ complete: true, candidates: 0 })
    await pages[1].reload()
    await openSettings(pages[1], 'Connections')
    await expect(pages[1].getByLabel('Relay username', { exact: true })).toHaveValue('friend')
    await pages[1].screenshot({ path: test.info().outputPath('call-relay-settings.png') })
    await pages[1].getByRole('button', { name: 'Remove call relay', exact: true }).click()
    expect(await pages[1].evaluate(() => localStorage.getItem('kithmoot.call-relay.v1'))).toBeNull()
  } finally { await Promise.all(contexts.map(context => context.close())) }
})
