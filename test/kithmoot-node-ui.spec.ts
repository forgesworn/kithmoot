import { test, expect, chromium, type Browser, type BrowserContext } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { newDeviceContext, openCallSettings, closeSettings, openRoomInfoPage, turnOnMedia, remotePictures, inbound, SYNTHETIC_MIC } from './browser.js'
import { signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'

test('a paired owner admits a guest without typing, exchanges chat and moving call media and closes the node room', async ({ baseURL, browserName }, info) => {
  test.skip(!process.env.E2E_NODE_SPRY_BINARY || !process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked Spry and private Shelter candidate executables')
  test.skip(browserName !== 'chromium', 'native node media qualification uses Chromium')
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { turnPorts: { udpTcp: 34790, tls: 53499 } }), contexts: BrowserContext[] = [], requests: string[] = []
  let browser: Browser | undefined
  let failNextCredential = false
  try {
    const mediaBrowser = browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
      '--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP node.example 127.0.0.1,MAP turn.node.example 127.0.0.1'] })
    async function device(owner = false) {
      const context = await newDeviceContext(mediaBrowser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 860 } }); contexts.push(context)
      await context.addInitScript(SYNTHETIC_MIC)
      await context.addInitScript(() => {
        // A browser can omit the video track notification after a rapid
        // rebuild. The receiver still exists and must be recovered from the
        // connection registry, rather than leaving a permanently empty tile.
        const Base = window.RTCPeerConnection
        const peers: RTCPeerConnection[] = []
        ;(window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers = peers
        window.RTCPeerConnection = class extends Base {
          constructor(configuration?: RTCConfiguration) {
            super(configuration)
            peers.push(this)
            this.addEventListener('track', event => { if (event.track.kind === 'video') event.stopImmediatePropagation() })
          }
        }
      })
      if (owner) {
        const key = generateSecretKey()
        await context.exposeFunction('nodeTestPublicKey', () => getPublicKey(key))
        await context.exposeFunction('nodeTestSign', (value: EventTemplate) => finalizeEvent(value, key))
        await context.addInitScript(() => {
          const w = window as typeof window & { nodeTestPublicKey(): Promise<string>; nodeTestSign(value: unknown): Promise<unknown> }
          Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.nodeTestPublicKey(), signEvent: (value: unknown) => w.nodeTestSign(value) } })
        })
      }
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, accountRelay }) => {
        const Native = window.WebSocket
        const state = window as unknown as { __nodeSockets: Array<WebSocket & { dropFrames: boolean }> }
        state.__nodeSockets = []
        window.WebSocket = class extends Native {
          dropFrames = false
          constructor(url: string | URL, protocols?: string | string[]) {
            const value = String(url)
            super(value === 'wss://node.example/events' ? node : value.startsWith('wss://') && !value.includes('localhost') ? accountRelay : value, protocols)
            if (value === 'wss://node.example/events') {
              state.__nodeSockets.push(this)
              this.addEventListener('message', event => { if (this.dropFrames) event.stopImmediatePropagation() })
            }
          }
          override send(data: Parameters<WebSocket['send']>[0]): void { if (!this.dropFrames) super.send(data) }
        }
      }, { node: fixture.websocket, accountRelay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname; requests.push(path)
        if (path === '/v1/credentials' && failNextCredential) {
          failNextCredential = false
          return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(baseURL!).origin }, body: '{}' })
        }
        const response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path })
        await route.fulfill({ response })
      })
      const page = await context.newPage()
      page.on('pageerror', error => console.error('node browser error:', error.message))
      page.on('console', message => { if (message.type() === 'error') console.error('node app:', message.text()) })
      return page
    }
    const keeper = await device(true)
    await signInAccount(keeper, baseURL!)
    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing())
    await keeper.locator('#nodePair').click()
    await expect(keeper.locator('#actionDialog')).toContainText('node.example')
    expect(requests).toEqual([])
    await keeper.locator('#actionConfirm').click()
    await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await keeper.locator('#nodeCheck').click()
    await expect(keeper.locator('#nodeFacts')).toContainText('Version 0.1.0-rc.1')
    await keeper.screenshot({ path: info.outputPath('node-settings.png') })
    await keeper.setViewportSize({ width: 390, height: 844 })
    await keeper.screenshot({ path: info.outputPath('node-settings-phone.png') })
    expect(await keeper.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await keeper.setViewportSize({ width: 1280, height: 860 })
    await closeSettings(keeper)
    await keeper.locator('#homeNewRoom').click()
    await keeper.locator('#roomName').fill('Node room')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Keeper')
    await keeper.locator('#roomOnNode').check()
    await keeper.locator('#create').click()
    await expect(keeper.locator('#chatInput')).toBeVisible({ timeout: 30000 })
    const beforeReconnect = requests.filter(path => path === '/v1/credentials').length
    failNextCredential = true
    await keeper.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => requests.filter(path => path === '/v1/credentials').length, { timeout: 15000 }).toBeGreaterThanOrEqual(beforeReconnect + 2)
    await expect(keeper.locator('#chatInput')).toBeVisible()
    await expect(keeper.locator('#status')).toContainText('restored')
    const link = keeper.url()
    expect(requests).toContain('/node/v1/enrol'); expect(requests).toContain('/v1/credentials')
    const guest = await device()
    await guest.goto(link)
    await guest.locator('#actionConfirm').click()
    await expect(guest.locator('#nodeWaiting')).toBeVisible()
    await expect(keeper.locator('.approvalCard.knock')).toBeVisible()
    await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 30000 })
    await expect(guest.locator('#attachToggle')).toBeHidden()
    await guest.locator('#chatInput').fill('A private node message')
    await guest.locator('#chatInput').press('Enter')
    await expect(keeper.locator('#chatLog')).toContainText('A private node message')
    await turnOnMedia(keeper); await turnOnMedia(guest)
    for (const page of [keeper, guest]) {
      await expect.poll(() => page.evaluate(() => (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers
        .some(peer => peer.connectionState === 'connected' && peer.getTransceivers().length === 4)),
        { message: 'An ordinary node invite must negotiate fixed media slots without a query switch', timeout: 20000 }).toBe(true)
      await expect.poll(async () => (await page.evaluate(remotePictures)).length,
        { message: 'Node call must attach a decoded remote video to its visible tile', timeout: 20000 }).toBeGreaterThan(0)
      const first = (await page.evaluate(remotePictures))[0]!
      await page.waitForTimeout(2000)
      await expect.poll(async () => (await page.evaluate(remotePictures))[0]?.hash,
        { message: 'Node call must show moving remote pixels', timeout: 10000 }).not.toBe(first.hash)
      await expect.poll(async () => (await page.evaluate(inbound)).audioEnergy,
        { message: 'Node call must play the synthetic remote microphone', timeout: 15000 }).toBeGreaterThan(0)
      await page.locator('#room .participant').evaluateAll(tiles => {
        for (const tile of tiles) if (!tile.querySelector('h3')?.textContent?.includes('(you)')) for (const video of tile.querySelectorAll('video')) video.remove()
      })
      await expect.poll(async () => (await page.evaluate(remotePictures)).length,
        { message: 'Node receiver recovery must restore a detached remote video sink', timeout: 15000 }).toBeGreaterThan(0)
    }
    const beforeSilentSocket = await guest.evaluate(() => {
      const sockets = (window as unknown as { __nodeSockets: Array<WebSocket & { dropFrames: boolean }> }).__nodeSockets
      for (const socket of sockets) socket.dropFrames = true
      return sockets.length
    })
    expect(beforeSilentSocket).toBeGreaterThan(0)
    const socketRecoveryStarted = Date.now()
    await expect.poll(() => guest.evaluate(() => (window as unknown as { __nodeSockets: WebSocket[] }).__nodeSockets.length),
      { message: 'A silent signalling socket must be replaced while the node HTTP API stays reachable', timeout: 20000 }).toBeGreaterThan(beforeSilentSocket)
    console.log(`Node signalling recovered after ${Date.now() - socketRecoveryStarted} ms`)
    await guest.locator('#chatInput').fill('Signalling recovered without another admission')
    await guest.locator('#chatInput').press('Enter')
    await expect(keeper.locator('#chatLog')).toContainText('Signalling recovered without another admission')
    for (const page of [keeper, guest]) await expect.poll(async () => (await page.evaluate(remotePictures)).length).toBeGreaterThan(0)
    for (const page of [keeper, guest]) await page.getByRole('button', { name: 'Leave call', exact: true }).click()
    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodeUnpair').click(); await keeper.locator('#actionConfirm').click()
    await expect(keeper.locator('#nodeUnpaired')).toBeVisible()
    expect(fixture.ledger.rooms()).toHaveLength(1); expect(fixture.ledger.active()).toHaveLength(2)
    await closeSettings(keeper)
    await openRoomInfoPage(keeper, 'Privacy and connection')
    await expect(keeper.locator('#roomFilesLine')).toHaveText('Files are off in this hosted room.')
    await keeper.locator('#roomInfoBack').click()
    await expect(keeper.locator('#infoNodeHost')).toHaveText('node.example')
    await keeper.screenshot({ path: info.outputPath('node-hosted-on.png') })
    await keeper.locator('#hostPanel > summary').click()
    await keeper.locator('#hostList').getByRole('button', { name: 'Remove', exact: true }).click()
    await keeper.locator('#actionConfirm').click()
    await expect.poll(() => fixture.ledger.active().length).toBe(1)
    await expect.poll(() => guest.evaluate(() => Object.keys(localStorage).filter(k => /^kithmoot\.node-(?:room|device|access|keeper)\./.test(k)).length)).toBe(0)
    expect(fixture.ledger.rooms()).toHaveLength(1)
    expect((await fixture.relay.status()).rooms).toBe(1)
    await guest.context().close()
    await keeper.locator('#roomSheetClose').click()
    const declined = await device()
    await declined.goto(link); await declined.locator('#actionConfirm').click()
    await expect(declined.locator('#nodeWaiting')).toBeVisible()
    await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(keeper.locator('.approvalCard.knock')).toHaveCount(0)
    await expect(declined.locator('#nodeWaiting')).toBeVisible()
    await expect(declined.locator('#chatInput')).toBeHidden()
    await declined.context().close()
    const remaining = await device()
    await remaining.goto(link); await remaining.locator('#actionConfirm').click()
    await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(remaining.locator('#chatInput')).toBeVisible()
    await openRoomInfoPage(keeper, 'Privacy and connection'); await keeper.locator('#roomInfoBack').click()
    await keeper.locator('#endRoom').click()
    await keeper.locator('#actionConfirm').click()
    await expect.poll(() => fixture.ledger.rooms().length).toBe(0)
    await expect.poll(async () => (await fixture.relay.status()).rooms).toBe(0)
    await expect.poll(() => remaining.evaluate(() => Object.keys(localStorage).filter(k => /^kithmoot\.node-(?:room|device|access|keeper)\./.test(k)).length)).toBe(0)
    await expect.poll(() => keeper.evaluate(() => Object.keys(localStorage).filter(k => /^kithmoot\.node-(?:room|device|access|keeper)\./.test(k)).length)).toBe(0)
    await expect.poll(() => keeper.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.node-operation.v1.')).length)).toBe(1)
    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.getByRole('button', { name: 'Check closure', exact: true }).click()
    await expect(keeper.locator('#nodeOperations')).toContainText('Node confirmed: room access revoked and stored messages purged.')
    expect(await keeper.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('kithmoot.node-operation.v1.')).length)).toBe(0)
    expect(requests).not.toContain('/turn')
  } finally { for (const context of contexts) await context.close(); await browser?.close(); await fixture.close() }
})

test('one disconnected participant does not replace a healthy participant connection', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SPRY_BINARY || !process.env.E2E_NODE_SHELTER_BINARY, 'requires checked Spry and Shelter executables')
  test.skip(browserName !== 'chromium', 'native node media qualification uses Chromium')
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { turnPorts: { udpTcp: 34790, tls: 53499 } })
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output',
    '--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP node.example 127.0.0.1,MAP turn.node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = []
  try {
    async function device(owner = false) {
      const context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 860 } })
      contexts.push(context); await context.addInitScript(SYNTHETIC_MIC)
      await context.grantPermissions(['camera', 'microphone', 'local-network-access'], { origin: new URL(baseURL!).origin })
      await context.addInitScript(() => {
        const Base = window.RTCPeerConnection, peers: RTCPeerConnection[] = []
        ;(window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers = peers
        window.RTCPeerConnection = class extends Base {
          constructor(configuration?: RTCConfiguration) { super(configuration); peers.push(this) }
        }
      })
      if (owner) {
        const key = generateSecretKey()
        await context.exposeFunction('nodeTestPublicKey', () => getPublicKey(key))
        await context.exposeFunction('nodeTestSign', (value: EventTemplate) => finalizeEvent(value, key))
        await context.addInitScript(() => {
          const w = window as typeof window & { nodeTestPublicKey(): Promise<string>; nodeTestSign(value: unknown): Promise<unknown> }
          Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.nodeTestPublicKey(), signEvent: (value: unknown) => w.nodeTestSign(value) } })
        })
      }
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, accountRelay }) => {
        const Base = window.WebSocket
        window.WebSocket = class extends Base {
          constructor(url: string | URL, protocols?: string | string[]) {
            const value = String(url)
            super(value === 'wss://node.example/events' ? node : value.startsWith('wss://') && !value.includes('localhost') ? accountRelay : value, protocols)
          }
        }
      }, { node: fixture.websocket, accountRelay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname
        await route.fulfill({ response: await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path }) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => console.error('peer recovery browser:', error.message))
      page.on('console', message => { if (message.type() === 'error') console.error('peer recovery app:', message.text()) })
      return page
    }
    const keeper = await device(true)
    await signInAccount(keeper, baseURL!); await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing()); await keeper.locator('#nodePair').click()
    await keeper.locator('#actionConfirm').click(); await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(keeper); await keeper.locator('#homeNewRoom').click()
    await keeper.locator('#roomName').fill('Participant recovery')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Host')
    await keeper.locator('#roomOnNode').check(); await keeper.locator('#create').click()
    await expect(keeper.locator('#chatInput')).toBeVisible({ timeout: 30000 })
    const guests = []
    for (let i = 0; i < 2; i++) {
      const guest = await device(); guests.push(guest)
      await guest.goto(keeper.url()); await guest.locator('#actionConfirm').click()
      await expect(keeper.locator('.approvalCard.knock')).toBeVisible()
      await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Let in', exact: true }).click()
      await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 30000 })
    }
    for (const page of [keeper, ...guests]) await turnOnMedia(page)
    const fingerprints = () => (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers.flatMap((pc, index) => {
      if (pc.connectionState !== 'connected') return []
      const fingerprint = (sdp?: string) => /a=fingerprint:([^\r\n]+)/.exec(sdp ?? '')?.[1]
      return [{ index, local: fingerprint(pc.localDescription?.sdp), remote: fingerprint(pc.remoteDescription?.sdp) }]
    })
    await expect.poll(async () => (await keeper.evaluate(fingerprints)).length, { timeout: 25000 }).toBe(2)
    const guestPeers = await guests[0]!.evaluate(fingerprints)
    const keeperPeers = await keeper.evaluate(fingerprints)
    const healthy = keeperPeers.find(pc => guestPeers.some(other => other.local === pc.remote && other.remote === pc.local))!
    expect(healthy).toBeDefined()
    const failed = keeperPeers.find(pc => pc.index !== healthy.index)!
    const counters = async (index: number) => {
      const pc = (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers[index]!
      const stats = await pc.getStats(); let video = 0, audio = 0
      stats.forEach(row => { if (row.type === 'inbound-rtp') { video += row.framesDecoded ?? 0; audio += row.kind === 'audio' ? row.packetsReceived ?? 0 : 0 } })
      return { state: pc.signalingState, video, audio }
    }
    await expect.poll(async () => (await keeper.evaluate(counters, healthy.index)).video).toBeGreaterThan(0)
    const before = await keeper.evaluate(counters, healthy.index)
    // Exercise the native failure event without changing this browser's whole
    // network. A remote participant can lose its route while others stay up.
    await keeper.evaluate(index => {
      const pc = (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers[index]!
      Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'disconnected' })
      pc.dispatchEvent(new Event('connectionstatechange'))
    }, failed.index)
    await expect.poll(() => keeper.evaluate(index => (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers[index]!.signalingState, failed.index)).toBe('closed')
    expect((await keeper.evaluate(counters, healthy.index)).state, 'recovering one participant closed the healthy native connection').not.toBe('closed')
    await keeper.waitForTimeout(2000)
    const after = await keeper.evaluate(counters, healthy.index)
    expect(after.state).not.toBe('closed'); expect(after.video).toBeGreaterThan(before.video); expect(after.audio).toBeGreaterThan(before.audio)
    console.log('Healthy participant kept the same native connection with advancing audio/video during another pair recovery.')
    for (const page of [keeper, ...guests]) await page.getByRole('button', { name: 'Leave call', exact: true }).click()
    await openRoomInfoPage(keeper, 'Privacy and connection'); await keeper.locator('#roomInfoBack').click()
    await keeper.locator('#endRoom').click(); await keeper.locator('#actionConfirm').click()
    await expect.poll(() => fixture.ledger.rooms().length).toBe(0)
  } finally {
    for (const context of contexts) await context.close()
    await browser.close(); await fixture.close()
  }
})
