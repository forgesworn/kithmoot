import { test, expect, chromium, _electron as electron, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { tmpdir } from 'node:os'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { newDeviceContext, openCallSettings, closeSettings, openRoomInfoPage, turnOnMedia, remotePictures, inbound, SYNTHETIC_MIC, join, openNewRoomForm } from './browser.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { nodeBrowserFixture } from './node-browser-fixture.js'
import { openRoomUrl } from './relays.js'
import { readNodeRoom, signNodeRoom, parseNodeRoomLink, encodeNodeRoomLink } from '@forgesworn/fold-kit/node-room'
import { localIdentity } from '../src/identity.js'
import { buildGrant } from '../src/group-grants.js'
import { claimKithmootNode, enrolNodeRoom, nodeCallFactory, parseKithmootNodePairingLink, postNodeGrant, queryNodeAccess } from '../src/kithmoot-node.js'
import { deriveRoom } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { roomInvitation, deriveInvitationId } from '../src/invitation.js'
import { createDeviceCredential, verifyDeviceCredential } from '../src/credential.js'
import { memoryDeviceStore, deviceKeyFor, storeKeptAdmission } from '../app/src/device-store.js'
import { prepareExistingBrowserNodeRoom, acceptExistingBrowserNodeRoom } from '../app/src/existing-node-room.js'

test('new rooms default to the paired account node and synchronise admission controls', async ({ browser, baseURL }, info) => {
  const key = generateSecretKey(), owner = getPublicKey(key)
  const context = await accountDevice(browser, baseURL!, key)
  try {
    const page = await context.newPage(), enrolRequests: string[] = []
    page.on('request', request => { if (new URL(request.url()).pathname === '/node/v1/enrol') enrolRequests.push(request.url()) })
    await signInAccount(page, baseURL!)
    await openNewRoomForm(page)
    await expect(page.locator('#roomOnNodeRow')).toBeHidden()
    await expect(page.locator('#roomOnNode')).not.toBeChecked()
    await expect(page.locator('#roomAsk')).toBeEnabled()
    await page.locator('#roomAsk').check()
    await page.locator('#cancelNewRoom').click()

    // Existing pairing belongs to this account; opening the sheet must not enrol a room.
    await page.evaluate(pair => localStorage.setItem('kithmoot.node-pair.v1.' + pair.owner, JSON.stringify(pair)), {
      v: 1, owner, origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()),
    })
    await openNewRoomForm(page)
    await expect(page.locator('#roomOnNodeRow')).toBeVisible()
    await expect(page.locator('#roomOnNode')).toBeChecked()
    await expect(page.locator('#roomOnNodeHint')).toBeVisible()
    await expect(page.locator('#roomAsk')).toBeDisabled()
    await expect(page.locator('#roomAsk')).not.toBeChecked()
    await expect(page.locator('#roomWhenEnds')).toBeDisabled()
    await expect(page.locator('#roomWhenEnds')).toHaveValue('destruct')
    await page.screenshot({ path: info.outputPath('paired-node-default.png') })

    await page.locator('#roomOnNode').uncheck()
    await expect(page.locator('#roomOnNodeHint')).toBeHidden()
    await expect(page.locator('#roomAsk')).toBeEnabled()
    await expect(page.locator('#roomWhenEnds')).toBeEnabled()
    await page.locator('#cancelNewRoom').click()
    await openNewRoomForm(page)
    await expect(page.locator('#roomOnNode')).toBeChecked()
    await expect(page.locator('#roomAsk')).toBeDisabled()
    await page.locator('#cancelNewRoom').click()

    await page.evaluate(owner => localStorage.removeItem('kithmoot.node-pair.v1.' + owner), owner)
    await openNewRoomForm(page)
    await expect(page.locator('#roomOnNodeRow')).toBeHidden()
    await expect(page.locator('#roomOnNode')).not.toBeChecked()
    await expect(page.locator('#roomAsk')).toBeEnabled()
    expect(enrolRequests).toEqual([])
  } finally { await context.close() }
})

for (const retainedVisitor of [false, true]) {
  test(`a hosted invite reconnects its saved account after signer failure (${retainedVisitor ? 'retained visitor' : 'no visitor'})`, async ({ browser, baseURL }) => {
    const accountKey = generateSecretKey(), account = getPublicKey(accountKey)
    const room = getPublicKey(generateSecretKey()), at = Math.floor(Date.now() / 1000)
    const link = encodeNodeRoomLink(baseURL!, signNodeRoom({ authoritySk: generateSecretKey(), room,
      origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), endsAt: at + 3600, now: at }), at)
    let failRestore = false, restoreAttempted = false
    let requestedCredential: Event | undefined
    const context = await accountDevice(browser, baseURL!, accountKey, true, async () => {
      if (failRestore) { restoreAttempted = true; throw Error('The saved signer is temporarily unavailable') }
    }, undefined, {
      encrypt: async (peer, text) => encrypt(text, getConversationKey(accountKey, peer)),
      sign: async template => {
        const event = finalizeEvent(template, accountKey)
        if (template.tags.some(tag => tag[0] === 'd' && tag[1] === room)
          && template.tags.some(tag => tag[0] === 'device')) requestedCredential = event
        return event
      },
    })
    try {
      const page = await context.newPage()
      await signInAccount(page, baseURL!)
      const visitor = retainedVisitor ? Buffer.from(generateSecretKey()).toString('hex') : null
      await page.evaluate(value => {
        if (value) localStorage.setItem('kithmoot.participant', value)
        else localStorage.removeItem('kithmoot.participant')
      }, visitor)
      failRestore = true
      await page.goto('about:blank'); await page.goto(link)
      await expect.poll(() => restoreAttempted).toBe(true)
      const reconnect = page.getByRole('button', { name: /Browser extension/ })
      const ask = page.getByRole('button', { name: 'Ask to join', exact: true })
      await expect(reconnect.or(ask)).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('kithmoot.participant'))).toBe(visitor)
      await expect(reconnect).toBeVisible()
      await expect(ask).toBeHidden()
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kithmoot.node-device.v1.')))).toEqual([])

      if (retainedVisitor) {
        await page.locator('dialog[open] button[data-choice="cancel"]').click()
        await expect(page.locator('#retryArrival')).toBeVisible()
        await expect(ask).toBeHidden()
        expect(requestedCredential).toBeUndefined()
        expect(await page.evaluate(() => localStorage.getItem('kithmoot.participant'))).toBe(visitor)
        await page.locator('#retryArrival').click()
        await expect(reconnect).toBeVisible()
      }
      failRestore = false
      await reconnect.click()
      await expect(ask).toBeVisible()
      await ask.click()
      await expect.poll(() => requestedCredential?.pubkey).toBe(account)
      const proof = verifyDeviceCredential(requestedCredential!, { roomId: room, now: Math.floor(Date.now() / 1000) })
      expect(proof.ok && proof.participant).toBe(account)
      await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kithmoot.node-device.v1.'))))
        .toEqual([`kithmoot.node-device.v1.${account}.${room}`])
      expect(await page.evaluate(() => localStorage.getItem('kithmoot.participant'))).toBe(visitor)
      expect(await page.evaluate(() => localStorage.getItem('kithmoot.last-nostr-account'))).toBe(account)
    } finally { await context.close() }
  })
}


test('a saved activated node route waits for account restoration and never falls back to ordinary room relays', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'chromium', 'one real browser is enough for this startup routing regression')
  const at = Math.floor(Date.now() / 1000), accountKey = generateSecretKey(), owner = localIdentity(accountKey)
  const secret = generateSecretKey(), authoritySk = generateSecretKey(), deviceSk = generateSecretKey()
  const roomId = deriveRoom(secret).roomId, authority = getPublicKey(authoritySk)
  const invitation = roomInvitation(generateSecretKey(), authority, true)
  const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { invitation, relays: [relay.href], iceUrls: [] })
  const credential = await createDeviceCredential({ identity: owner, devicePubkey: getPublicKey(deviceSk), roomId,
    now: () => at, expiresAt: at + 3600 })
  const source = { authority, authoritySk, secret, deviceSk, credential, participant: owner.pubkey,
    epoch: 0, destruct: false, startsAt: at, link, name: 'Retained node route', removed: [],
    devices: [{ device: getPublicKey(deviceSk), participant: owner.pubkey, credential }] }
  // Create genuine signed custody with the production adapters. Only the
  // enrolment/grant acknowledgements are synthetic; there is no live node.
  const prepared = await prepareExistingBrowserNodeRoom(memoryDeviceStore(), {
    v: 1, origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), owner: owner.pubkey,
  }, owner, source, { now: () => at, fetcher: (async (url: string | URL | Request) => new Response(
    JSON.stringify(String(url).endsWith('/node/v1/enrol') ? { enrolled: true } : { accepted: true }),
    { headers: { 'content-type': 'application/json' } },
  )) as typeof fetch })
  const store = memoryDeviceStore()
  deviceKeyFor(store, roomId, at, () => deviceSk)
  // This browser is a retained member, not the original invitation owner.
  acceptExistingBrowserNodeRoom(store, prepared.state.node, { ...source, authoritySk: undefined }, prepared.state.grant!, at, true)
  storeKeptAdmission(store, deriveInvitationId(invitation), { secret, persistent: true, epoch: 0 }, at)
  let restoring = false, gate = Promise.resolve(), release = () => {}
  const context = await accountDevice(browser, baseURL!, accountKey, true, async () => { restoring = true; await gate })
  const nodePaths: string[] = [], nodeSigners: string[] = []
  await context.route('https://node.example/**', async route => {
    const headers = { 'Access-Control-Allow-Origin': new URL(baseURL!).origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
    nodePaths.push(new URL(route.request().url()).pathname)
    const auth = route.request().headers().authorization
    if (auth?.startsWith('Nostr ')) nodeSigners.push(JSON.parse(Buffer.from(auth.slice(6), 'base64').toString()).pubkey)
    await route.fulfill({ status: 403, contentType: 'application/json', headers, body: '{}' })
  })
  await context.addInitScript(tags => {
    const win = window as typeof window & { __savedNodeOrdinaryFrames: number }
    win.__savedNodeOrdinaryFrames = 0
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      override send(data: Parameters<WebSocket['send']>[0]) {
        if (typeof data === 'string') try {
          const frame = JSON.parse(data)
          const filters = frame[0] === 'REQ' ? frame.slice(2) : []
          if (filters.some((filter: Record<string, unknown>) => Array.isArray(filter['#d']) && filter['#d'].some(tag => tags.includes(String(tag))))) win.__savedNodeOrdinaryFrames++
          if (frame[0] === 'EVENT' && frame[1]?.tags?.some((tag: string[]) => tag[0] === 'd' && tags.includes(tag[1]!))) win.__savedNodeOrdinaryFrames++
        } catch { /* Non-room frames are unrelated to this routing check. */ }
        super.send(data)
      }
    }
  }, [roomId, deriveInvitationId(invitation)])
  const page = await context.newPage()
  const roomFrames = () => page.evaluate(() => (window as unknown as { __savedNodeOrdinaryFrames: number }).__savedNodeOrdinaryFrames)
  try {
    await signInAccount(page, baseURL!)
    await page.evaluate(entries => { for (const [key, value] of entries) localStorage.setItem(key!, value!) }, store.keys().map(key => [key, store.get(key)]))
    restoring = false; gate = new Promise<void>(resolve => { release = resolve })
    await page.goto('about:blank'); await page.goto(link)
    await expect.poll(() => restoring).toBe(true)
    await expect(page.locator('#join')).toBeVisible()
    await page.locator('#join').click()
    await expect(page.locator('#status')).toContainText('Reconnecting your sign-in')
    // Give an incorrectly eager ordinary lookup time to reach its socket
    // while the account is deliberately still waiting on the signer.
    await page.waitForTimeout(300)
    expect(nodePaths).toEqual([])
    expect(await roomFrames(), 'ordinary invitation/room traffic must wait for the saved identity').toBe(0)
    release()
    await expect.poll(() => nodePaths).toEqual(['/node/v1/access'])
    await expect(page.locator('#status')).toContainText('Your KithMoot node refused this request.')
    await expect(page.locator('#chatInput')).toBeHidden()
    expect(nodeSigners).toEqual([getPublicKey(deviceSk)])
    expect(await roomFrames(), 'a refused private node must not fall back to ordinary room relays').toBe(0)
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.participant'))).toBeNull()
    const keys = await page.evaluate(({ room, participant }) => ({
      original: JSON.parse(localStorage.getItem('kithmoot.device.' + room)!).sk,
      node: localStorage.getItem('kithmoot.node-device.v1.' + participant + '.' + room),
    }), { room: roomId, participant: owner.pubkey })
    expect(keys).toEqual({ original: Buffer.from(deviceSk).toString('hex'), node: Buffer.from(deviceSk).toString('hex') })
    await info.attach('saved-node-route-refusal', { contentType: 'application/json', body: JSON.stringify({
      delayedAccountRestore: true, persistentMemberInvitation: true, nodePaths, ordinaryRoomFrames: await roomFrames(),
      privateNodeRefused: true, ordinaryRoomOpened: false, deviceKeyPreserved: true, visitorKeyCreated: false,
      realNodeOrMediaProof: false,
    }) })
  } finally { release(); await context.close() }
})

test('a paired owner admits a guest without typing, exchanges chat and moving call media and closes the node room', async ({ baseURL, browserName }, info) => {
  test.skip(!process.env.E2E_NODE_SPRY_BINARY || !process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked Spry and private Shelter candidate executables')
  test.skip(browserName !== 'chromium', 'native node media qualification uses Chromium')
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { turnPorts: { udpTcp: 34790, tls: 53499 } }), contexts: BrowserContext[] = [], requests: string[] = []
  let browser: Browser | undefined
  let failNextCredential = false
  let initialGuestFailures = 0
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
        if (!owner && path === '/node/v1/access' && initialGuestFailures === 0) {
          initialGuestFailures++
          return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(baseURL!).origin }, body: '{}' })
        }
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
    await openNewRoomForm(keeper)
    await keeper.locator('#roomName').fill('Node room')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Keeper')
    await expect(keeper.locator('#roomOnNode')).toBeChecked()
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
    expect(initialGuestFailures).toBe(1)
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
    // An online event rotates node credentials and native transports. Even
    // with video track notifications suppressed above, the replacement must
    // take over the visible receiver and survive the old connection closing.
    const beforeRotation = await Promise.all([keeper, guest].map(page => page.evaluate(() => {
      const peers = (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers
      return { count: peers.length, connected: peers.flatMap((pc, index) => pc.connectionState === 'connected' ? [index] : []) }
    })))
    await keeper.evaluate(() => window.dispatchEvent(new Event('online')))
    for (const [i, page] of [keeper, guest].entries()) {
      await expect.poll(() => page.evaluate(before => {
        const peers = (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers
        return peers.slice(before.count).some(pc => pc.connectionState === 'connected') &&
          before.connected.every(index => peers[index]!.signalingState === 'closed')
      }, beforeRotation[i]!), { message: 'Credential rotation must complete and retire the old transport', timeout: 20000 }).toBe(true)
      await expect.poll(async () => (await page.evaluate(remotePictures)).length).toBeGreaterThan(0)
      const first = (await page.evaluate(remotePictures))[0]!
      await expect.poll(async () => (await page.evaluate(remotePictures))[0]?.hash,
        { message: 'Visible video must advance after the retired connection closes', timeout: 10000 }).not.toBe(first.hash)
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
    for (const page of [keeper, guest]) await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __nodePeers: RTCPeerConnection[] }).__nodePeers.every(pc =>
        pc.signalingState === 'closed' || pc.getSenders().every(sender => !sender.track || sender.track.readyState === 'ended')))).toBe(true)
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

test('node peer replacements retain primary TURN candidates within the existing allocation quotas', async ({ baseURL, browserName }, info) => {
  test.skip(!process.env.E2E_NODE_SPRY_BINARY || !process.env.E2E_NODE_SHELTER_BINARY, 'requires checked Spry and Shelter executables')
  test.skip(browserName !== 'chromium', 'native allocation qualification uses Chromium')
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin)
  const managed: Awaited<ReturnType<typeof nodeCallFactory>>[] = []
  let browser: Browser | undefined
  try {
    const fetcher = ((url: string, init: RequestInit) => fetch((new URL(url).pathname === '/v1/credentials' ? fixture.calls : fixture.desk) + new URL(url).pathname, init)) as typeof fetch
    const ownerSk = generateSecretKey(), owner = localIdentity(ownerSk), at = Math.floor(Date.now() / 1000)
    const pair = await claimKithmootNode(parseKithmootNodePairingLink(fixture.pairing()), owner, { fetcher })
    const room = '33'.repeat(32), node = readNodeRoom(signNodeRoom({ authoritySk: ownerSk, room, serviceKey: pair.serviceKey, origin: pair.origin, now: at }), at)!
    await enrolNodeRoom(pair, node, owner, { fetcher })
    // Capture the actual factory configuration, then give it to native peers
    // in Chromium. No room keys or browser globals enter the Node factory.
    class ConfigurationPeer extends EventTarget {
      signalingState = 'stable'
      constructor(readonly configuration: RTCConfiguration) { super() }
      close() { this.signalingState = 'closed' }
    }
    for (let device = 0; device < 3; device++) {
      const identity = localIdentity(generateSecretKey()), grantId = String(device + 1).padStart(32, '0')
      const grant = buildGrant({ authoritySk: ownerSk, roomId: room, device: identity.pubkey, server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'], grantId, createdAt: at, expiration: at + 3600 })
      await postNodeGrant(node, grant, owner, { fetcher })
      managed.push(await nodeCallFactory(node, identity, () => queryNodeAccess(node, grantId, identity, { fetcher }),
        { fetcher, PeerConnection: ConfigurationPeer as unknown as typeof RTCPeerConnection }))
    }
    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1,MAP turn.node.example 127.0.0.1', '--allow-loopback-in-peer-connection'] })
    const page = await browser.newPage()
    const batches = []
    for (let batch = 0; batch < 2; batch++) {
      if (batch) await Promise.all(managed.map(call => call.reconnect()))
      const configurations = managed.map(call => {
        const peer = call.factory() as unknown as ConfigurationPeer
        const configuration = structuredClone(peer.configuration); peer.close(); return configuration
      })
      // Keep the first allocations alive to represent leases that have not
      // timed out on the old route. The fixture's quotas are unchanged.
      const rows = await page.evaluate(async configurations => {
        const held = window as unknown as { __allocationPeers?: RTCPeerConnection[] }
        held.__allocationPeers ??= []
        const rows: Array<{ primary: number; quotaErrors: number; ports: number[] }> = []
        for (const configuration of configurations) for (let peer = 0; peer < 2; peer++) {
          // UDP/TCP alone make quota exhaustion deterministic. TLS/media
          // qualification is covered separately; the fixture CA is local.
          const pc = new RTCPeerConnection({ ...configuration, iceServers: configuration.iceServers!.map(server => ({ ...server,
            urls: [server.urls].flat().filter(url => url.startsWith('turn:')) })) })
          held.__allocationPeers.push(pc)
          const row = { primary: 0, quotaErrors: 0, ports: [] as number[] }; rows.push(row)
          pc.onicecandidate = event => { if (event.candidate) {
            if (event.candidate.sdpMid === '0') row.primary++
            row.ports.push(Number(event.candidate.candidate.split(' ')[5]))
          } }
          pc.onicecandidateerror = event => { if (event.errorCode === 486 || event.errorCode === 508) row.quotaErrors++ }
          for (const kind of ['audio', 'video', 'video', 'audio'] as const) pc.addTransceiver(kind, { direction: 'sendrecv' })
          await pc.setLocalDescription(await pc.createOffer())
        }
        await new Promise(resolve => setTimeout(resolve, 6000))
        return rows
      }, configurations)
      batches.push(rows)
      console.log('Node allocation batch:', batch, JSON.stringify(rows))
      expect(rows.every(row => row.primary > 0), 'Every replacement needs a candidate on its primary bundled transport').toBe(true)
      expect(rows.every(row => row.quotaErrors === 0), 'The existing server quota must accommodate this replacement batch').toBe(true)
    }
    await info.attach('native-allocation-batches.json', { body: JSON.stringify(batches, null, 2), contentType: 'application/json' })
  } finally {
    for (const call of managed) call.close()
    await browser?.close(); await fixture.close()
  }
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
    await turnOnMedia(keeper)
    for (const guest of guests) {
      // Join the host's advertised call explicitly. Starting another call
      // before its advert arrives would test call discovery instead.
      await expect(guest.locator('#callToggle')).toHaveAttribute('aria-label', 'Join call')
      await turnOnMedia(guest)
    }
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


// Real supervisor, device proof and private relay; synthetic TURN credentials
// make this deliberately chat-only. Native/physical media are separate gates.
test('three concurrent account devices and a peer move an existing room onto its node without changing room or device identity', async ({ baseURL, browserName }, info) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'concurrent room transition qualification')
  test.setTimeout(240_000)
  const desktopExecutable = process.env.E2E_MIGRATION_DESKTOP_EXECUTABLE
  const androidSerial = process.env.E2E_MIGRATION_ANDROID_SERIAL
  const adb = process.env.E2E_MIGRATION_ADB
  if (androidSerial) expect(androidSerial).toMatch(/^emulator-[0-9]{4,5}$/)
  const desktopHome = 'https://kithmoot.forgesworn.dev/j/'
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true,
    sourceRelayPort: androidSerial ? Number(process.env.E2E_RELAY_PORT) : undefined,
    additionalOrigins: desktopExecutable ? [new URL(desktopHome).origin] : [], turnPorts: { udpTcp: 34790, tls: 53499 } })
  expect(fixture.chatOnly).toBe(true)
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], ownerKey = generateSecretKey()
  const scratch = mkdtempSync(joinPath(tmpdir(), 'kithmoot-existing-node-'))
  let desktopApp: Awaited<ReturnType<typeof electron.launch>> | undefined, native: ChildProcess | undefined, nativeLog = ''
  const deviceCommand = (...args: string[]) => execFileSync(adb!, ['-s', androidSerial!, ...args], { encoding: 'utf8', timeout: 60_000 })
  const clientLink = (page: Page, url: string) => desktopApp && page.context() === desktopApp.context() ? desktopHome + new URL(url).hash : url
  try {
    async function device(key: Uint8Array, desktop = false) {
      let context: BrowserContext
      if (desktop) {
        const profile = joinPath(scratch, 'desktop-profile')
        desktopApp = await electron.launch({ executablePath: desktopExecutable!, args: [
          '--ignore-certificate-errors', `--user-data-dir=${profile}`, '--host-resolver-rules=MAP node.example 127.0.0.1'],
          env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })
        context = desktopApp.context()
        await desktopApp.evaluate(({ net, dialog }, { desk, calls }) => {
          const fetch = net.fetch.bind(net)
          net.fetch = async (input: RequestInfo | URL, options?: RequestInit & { bypassCustomProtocolHandlers?: boolean }) => {
            const request = new Request(input, options), url = new URL(request.url)
            if (url.origin !== 'https://node.example') return fetch(input, options)
            const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
            return fetch((url.pathname === '/v1/credentials' ? calls : desk) + url.pathname,
              { ...options, method: request.method, headers: request.headers, body })
          }
          const show = dialog.showMessageBox.bind(dialog)
          dialog.showMessageBox = ((...args: unknown[]) => {
            if ((args.at(-1) as { message?: string }).message === 'Allow connections on your local network?') return Promise.resolve({ response: 1, checkboxChecked: false })
            return Reflect.apply(show, dialog, args)
          }) as typeof dialog.showMessageBox
        }, { desk: fixture.desk, calls: fixture.calls })
      } else context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1100, height: 860 } })
      contexts.push(context)
      await context.exposeFunction('migrationPublicKey', () => getPublicKey(key))
      await context.exposeFunction('migrationSign', (template: EventTemplate) => finalizeEvent(template, key))
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, relay }) => {
        const w = window as typeof window & { migrationPublicKey(): Promise<string>; migrationSign(value: unknown): Promise<unknown>; __migrationAuth: unknown[] }
        Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.migrationPublicKey(), signEvent: (value: unknown) => w.migrationSign(value) } })
        const Native = window.WebSocket; w.__migrationAuth = []
        window.WebSocket = class extends Native {
          private readonly nodeSocket: boolean
          constructor(url: string | URL, protocols?: string | string[]) {
            const target = String(url), privateNode = target === 'wss://node.example/events'
            super(privateNode ? node : target.startsWith('wss://') && !target.includes('localhost') ? relay : target, protocols)
            this.nodeSocket = privateNode
          }
          override send(data: Parameters<WebSocket['send']>[0]) {
            if (this.nodeSocket && typeof data === 'string') { try { const frame = JSON.parse(data); if (frame[0] === 'AUTH') w.__migrationAuth.push(frame[1]) } catch {} }
            super.send(data)
          }
        }
      }, { node: fixture.websocket, relay: accountRelay.href })
      if (!desktop) await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname
        const response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path })
        await route.fulfill({ response })
      })
      await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
      const page = desktopApp && desktop ? await desktopApp.firstWindow() : await context.newPage()
      page.on('pageerror', error => console.error('migration page:', error.message))
      page.on('console', message => { if (message.type() === 'error') console.error('migration app:', message.text()) })
      await signInAccount(page, desktop ? desktopHome : baseURL!)
      return page
    }
    const keeper = await device(ownerKey)
    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing())
    await keeper.locator('#nodePair').click(); await keeper.locator('#actionConfirm').click()
    await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(keeper)
    await keeper.locator('#homeNewRoom').click()
    await keeper.locator('#roomName').fill('Existing shared chat')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Keeper')
    await keeper.locator('#create').click()
    await expect(keeper.locator('#chatInput')).toBeVisible()
    await expect.poll(() => keeper.locator('#shareUrl').inputValue()).not.toBe('')
    const originalLink = await keeper.locator('#shareUrl').inputValue()
    expect(parseNodeRoomLink(originalLink, Math.floor(Date.now() / 1000))).toBeNull()
    const pages = [keeper]
    for (const key of [ownerKey, ownerKey, generateSecretKey()]) {
      const page = await device(key, !!desktopExecutable && pages.length === 1); pages.push(page)
      await openRoomUrl(page, clientLink(page, originalLink))
      if (await page.locator('#displayName').isVisible()) await page.locator('#displayName').fill('Member')
      await join(page); await expect(page.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
    }
    const before = await Promise.all(pages.map(page => page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(key => key.startsWith('kithmoot.device.'))
      return Object.fromEntries(keys.map(key => [key, JSON.parse(localStorage.getItem(key)!).sk]))
    })))
    for (const held of before) expect(Object.keys(held).length).toBeGreaterThan(0)
    for (let i = 0; i < pages.length; i++) {
      await pages[i]!.locator('#chatInput').fill(`Before move from device ${i}`); await pages[i]!.locator('#chatInput').press('Enter')
    }
    for (const page of pages) await expect(page.locator('#chatLog')).toContainText('Before move from device 3')
    if (androidSerial) {
      expect(adb).toBeTruthy()
      expect(deviceCommand('shell', 'getprop', 'ro.hardware').trim()).toMatch(/^(ranchu|goldfish)$/)
      const source = await keeper.evaluate(() => (window as unknown as { __kithmootMigrationFixture(): { secret: string; authority: string } }).__kithmootMigrationFixture())
      const path = joinPath(scratch, 'native.json')
      writeFileSync(path, JSON.stringify({ ...fixture.native, ...source, ownerKey: Buffer.from(ownerKey).toString('hex') }), { mode: 0o600 })
      deviceCommand('shell', 'run-as', 'dev.forgesworn.kithmoot', 'mkdir', '-p', 'files')
      deviceCommand('push', path, '/data/local/tmp/kithmoot-existing-node.json')
      deviceCommand('shell', 'run-as', 'dev.forgesworn.kithmoot', 'cp', '/data/local/tmp/kithmoot-existing-node.json', 'files/node-cross-config.json')
      deviceCommand('shell', 'rm', '/data/local/tmp/kithmoot-existing-node.json')
      native = spawn(adb!, ['-s', androidSerial, 'shell', 'am', 'instrument', '-w', '-e', 'class',
        'dev.forgesworn.kithmoot.node.ExistingNodeInteropTest', '-e', 'nodeConfig', '/data/user/0/dev.forgesworn.kithmoot/files/node-cross-config.json',
        'dev.forgesworn.kithmoot.test/androidx.test.runner.AndroidJUnitRunner'])
      for (const stream of [native.stdout, native.stderr]) stream?.on('data', chunk => { nativeLog = (nativeLog + String(chunk)).slice(-200_000) })
      await expect(keeper.locator('#chatLog')).toContainText('Android before move', { timeout: 60_000 })
    }
    await openRoomInfoPage(keeper, 'Privacy and connection')
    await expect(keeper.locator('#moveRoomToNode')).toBeEnabled()
    await keeper.screenshot({ path: info.outputPath('existing-room-node-control.png') })
    await keeper.locator('#moveRoomToNode').click()
    await expect.poll(() => fixture.ledger.rooms().length).toBe(1)
    const room = fixture.ledger.rooms()[0]!
    expect(room.existing).toBe(true)
    await keeper.waitForTimeout(2000)
    console.log('Migration state:', await Promise.all(pages.map(page => page.evaluate(() =>
      (window as unknown as { __kithmootNodeMigrationState?(): unknown }).__kithmootNodeMigrationState?.() ?? { productionDesktop: true }))))
    for (const page of pages) {
      await expect.poll(async () => parseNodeRoomLink(await page.locator('#shareUrl').inputValue(), Math.floor(Date.now() / 1000))?.room, { timeout: 60_000 }).toBe(room.room)
      await expect(page.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('#attachToggle')).toBeVisible()
      await expect(page.locator('#chatLog')).toContainText('Before move from device 3')
    }
    expect(fixture.ledger.devices()).toHaveLength(androidSerial ? 5 : 4)
    for (let i = 0; i < pages.length; i++) {
      await pages[i]!.locator('#chatInput').fill(`After move from device ${i}`); await pages[i]!.locator('#chatInput').press('Enter')
    }
    for (const page of pages) for (let i = 0; i < pages.length; i++) await expect(page.locator('#chatLog')).toContainText(`After move from device ${i}`)
    if (androidSerial) for (const page of pages) await expect(page.locator('#chatLog')).toContainText('Android after move', { timeout: 60_000 })
    for (let i = 0; i < pages.length; i++) {
      expect(await pages[i]!.evaluate(keys => Object.fromEntries(Object.keys(keys).map(key => [key, JSON.parse(localStorage.getItem(key)!).sk])), before[i]!)).toEqual(before[i])
    }
    for (const page of pages.slice(1)) {
      const auth = await page.evaluate(() => (window as unknown as { __migrationAuth: Array<{ tags: string[][] }> }).__migrationAuth)
      expect(auth.length).toBeGreaterThan(0)
      expect(auth.every(event => event.tags.some(tag => tag[0] === 'mode' && tag[1] === 'room'))).toBe(true)
    }
    // A fresh profile has no local archive or public room link. Its copy of
    // the pre-move conversation must come from the private node itself.
    const fresh = await device(generateSecretKey())
    await openRoomUrl(fresh, await keeper.locator('#shareUrl').inputValue())
    await fresh.locator('#actionConfirm').click()
    await expect(keeper.locator('.approvalCard.knock')).toBeVisible()
    await keeper.locator('.approvalCard.knock').getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(fresh.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
    for (let i = 0; i < pages.length; i++) await expect(fresh.locator('#chatLog')).toContainText(`Before move from device ${i}`)
    await keeper.context().close()
    if (androidSerial) {
      await pages[3]!.locator('#chatInput').fill('Keeper offline; reconnect Android'); await pages[3]!.locator('#chatInput').press('Enter')
      await expect(pages[3]!.locator('#chatLog')).toContainText('Android returned with original identity', { timeout: 60_000 })
      await expect.poll(() => nativeLog, { timeout: 30_000 }).toMatch(/^OK \(1 test\)$/m)
    }
    await openRoomUrl(pages[2]!, originalLink); await join(pages[2]!)
    await expect(pages[2]!.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
    await pages[2]!.locator('#chatInput').fill('Returned through the original bookmark'); await pages[2]!.locator('#chatInput').press('Enter')
    await expect(pages[3]!.locator('#chatLog')).toContainText('Returned through the original bookmark')
  } finally {
    native?.kill('SIGTERM')
    if (androidSerial && adb) { try { deviceCommand('shell', 'am', 'force-stop', 'dev.forgesworn.kithmoot') } catch {} }
    writeFileSync(info.outputPath('native-existing-migration.txt'), nativeLog)
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await desktopApp?.close().catch(() => {}); await browser.close(); await fixture.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})
