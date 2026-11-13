import { test, expect, chromium, _electron as electron, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { tmpdir } from 'node:os'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
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

test('a member device closed during a move follows on its own while the owner only has the app open, and nothing it sent waiting is lost', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'room transition qualification')
  test.setTimeout(420_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34790, tls: 53499 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = []
  try {
    async function device(key: Uint8Array): Promise<Page> {
      const context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1100, height: 860 } })
      contexts.push(context)
      await context.exposeFunction('migrationPublicKey', () => getPublicKey(key))
      await context.exposeFunction('migrationSign', (template: EventTemplate) => finalizeEvent(template, key))
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, relay }) => {
        const w = window as typeof window & { migrationPublicKey(): Promise<string>; migrationSign(value: unknown): Promise<unknown> }
        Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.migrationPublicKey(), signEvent: (value: unknown) => w.migrationSign(value) } })
        const Native = window.WebSocket
        window.WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            const target = String(url)
            super(target === 'wss://node.example/events' ? node : target.startsWith('wss://') && !target.includes('localhost') ? relay : target, protocols)
          }
        }
      }, { node: fixture.websocket, relay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname
        await route.fulfill({ response: await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path }) })
      })
      await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
      const page = await context.newPage()
      page.on('pageerror', error => console.error('straggler page:', error.message))
      await signInAccount(page, baseURL!)
      return page
    }
    // The room is older than the node, as a room moved later is.
    let keeper = await device(generateSecretKey())
    await keeper.locator('#homeNewRoom').click()
    await keeper.locator('#roomName').fill('Straggler chat')
    if (await keeper.locator('#newRoomYourName').isVisible()) await keeper.locator('#newRoomYourName').fill('Keeper')
    await keeper.locator('#create').click()
    await expect(keeper.locator('#chatInput')).toBeVisible()
    await expect.poll(() => keeper.locator('#shareUrl').inputValue()).not.toBe('')
    const originalLink = await keeper.locator('#shareUrl').inputValue()
    expect(parseNodeRoomLink(originalLink, Math.floor(Date.now() / 1000))).toBeNull()

    const member = await device(generateSecretKey())
    await openRoomUrl(member, originalLink)
    if (await member.locator('#displayName').isVisible()) await member.locator('#displayName').fill('Member')
    await join(member); await expect(member.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
    await member.locator('#chatInput').fill('Before the move'); await member.locator('#chatInput').press('Enter')
    await expect(keeper.locator('#chatLog')).toContainText('Before the move')
    // The member's device goes quiet long enough to drop off the roster, so
    // the move cannot hand it a grant: only a keeper can let it in later.
    const memberContext = member.context()
    await member.close()
    await keeper.waitForTimeout(115_000)

    await openCallSettings(keeper, 'Your KithMoot node')
    await keeper.locator('#nodePairingInput').fill(fixture.pairing())
    await keeper.locator('#nodePair').click(); await keeper.locator('#actionConfirm').click()
    await expect(keeper.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(keeper)
    await openRoomInfoPage(keeper, 'Privacy and connection')
    await expect(keeper.locator('#moveRoomToNode')).toBeEnabled()
    await keeper.locator('#moveRoomToNode').click()
    await expect.poll(() => fixture.ledger.rooms().length).toBe(1)
    const room = fixture.ledger.rooms()[0]!
    await expect.poll(async () => parseNodeRoomLink(await keeper.locator('#shareUrl').inputValue(), Math.floor(Date.now() / 1000))?.room, { timeout: 60_000 }).toBe(room.room)
    const devicesAfterMove = fixture.ledger.devices().length

    // Nobody who can let it in is online: the member's device says what it
    // waits for, and what it writes waits instead of going to the old relays.
    const keeperContext = keeper.context()
    await keeper.close()
    const returning = await memberContext.newPage()
    await openRoomUrl(returning, originalLink)
    if (await returning.locator('#join').isVisible()) await join(returning)
    await expect(returning.locator('#status')).toContainText('This room has moved to node.example', { timeout: 60_000 })
    await returning.locator('#chatInput').fill('Written while waiting'); await returning.locator('#chatInput').press('Enter')
    await expect(returning.locator('#outbox')).toContainText('Waiting to move', { timeout: 30_000 })

    // The owner only opens the app. No room, no prompt, no link.
    keeper = await keeperContext.newPage()
    await keeper.goto(baseURL!)
    await expect.poll(async () => parseNodeRoomLink(await returning.locator('#shareUrl').inputValue(), Math.floor(Date.now() / 1000))?.room, { timeout: 120_000 }).toBe(room.room)
    expect(fixture.ledger.devices().length).toBe(devicesAfterMove + 1)
    await expect(returning.locator('#outbox')).not.toContainText('Waiting to move', { timeout: 60_000 })
    await openRoomUrl(keeper, originalLink)
    await expect(keeper.locator('#chatLog')).toContainText('Written while waiting', { timeout: 60_000 })
    await returning.locator('#chatInput').fill('After following'); await returning.locator('#chatInput').press('Enter')
    await expect(keeper.locator('#chatLog')).toContainText('After following')
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
})

async function sharedOwnerStraggler(baseURL: string, makerStays: boolean): Promise<void> {
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34790, tls: 53499 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = []
  try {
    // A signer that can encrypt, so the account's room bookmarks sync between its devices.
    async function device(key: Uint8Array): Promise<Page> {
      const context = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1100, height: 860 } })
      contexts.push(context)
      await context.exposeFunction('migrationPublicKey', () => getPublicKey(key))
      await context.exposeFunction('migrationSign', (template: EventTemplate) => finalizeEvent(template, key))
      await context.exposeFunction('migrationEncrypt', (peer: string, text: string) => encrypt(text, getConversationKey(key, peer)))
      await context.exposeFunction('migrationDecrypt', (peer: string, text: string) => decrypt(text, getConversationKey(key, peer)))
      const accountRelay = new URL('/__test-relay', baseURL!); accountRelay.protocol = 'wss:'
      await context.addInitScript(({ node, relay }) => {
        const w = window as typeof window & { migrationPublicKey(): Promise<string>; migrationSign(value: unknown): Promise<unknown>
          migrationEncrypt(peer: string, text: string): Promise<string>; migrationDecrypt(peer: string, text: string): Promise<string> }
        Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.migrationPublicKey(), signEvent: (value: unknown) => w.migrationSign(value),
          nip44: { encrypt: (peer: string, text: string) => w.migrationEncrypt(peer, text), decrypt: (peer: string, text: string) => w.migrationDecrypt(peer, text) } } })
        const Native = window.WebSocket
        window.WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            const target = String(url)
            super(target === 'wss://node.example/events' ? node : target.startsWith('wss://') && !target.includes('localhost') ? relay : target, protocols)
          }
        }
      }, { node: fixture.websocket, relay: accountRelay.href })
      await context.route('https://node.example/**', async route => {
        const path = new URL(route.request().url()).pathname
        await route.fulfill({ response: await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path }) })
      })
      await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
      const page = await context.newPage()
      page.on('pageerror', error => console.error('shared owner page:', error.message))
      await signInAccount(page, baseURL!)
      return page
    }
    const ownerKey = generateSecretKey(), owner = getPublicKey(ownerKey)
    const maker = await device(ownerKey)
    await maker.locator('#homeNewRoom').click()
    await maker.locator('#roomName').fill('Shared owner chat')
    if (await maker.locator('#newRoomYourName').isVisible()) await maker.locator('#newRoomYourName').fill('Maker')
    await maker.locator('#create').click()
    await expect(maker.locator('#chatInput')).toBeVisible()
    await expect.poll(() => maker.locator('#shareUrl').inputValue()).not.toBe('')
    const originalLink = await maker.locator('#shareUrl').inputValue()
    await expect(maker.locator('#roomSyncStatus')).toContainText('accepted by a relay', { timeout: 60_000 })

    const member = await device(generateSecretKey())
    await openRoomUrl(member, originalLink)
    if (await member.locator('#displayName').isVisible()) await member.locator('#displayName').fill('Member')
    await join(member); await expect(member.locator('#chatInput')).toBeVisible({ timeout: 30_000 })
    await member.locator('#chatInput').fill('Before the move'); await member.locator('#chatInput').press('Enter')
    await expect(maker.locator('#chatLog')).toContainText('Before the move')

    // The same account on another device: its bookmark brings the room and, now, its owner key.
    const second = await device(ownerKey)
    await expect(second.locator('#roomSyncStatus')).toContainText(/loaded|Up to date: 1 room/, { timeout: 60_000 })
    await openRoomUrl(second, originalLink)
    await expect(second.locator('#roomArea:visible, #join:visible').first()).toBeVisible({ timeout: 60_000 })
    if (await second.locator('#displayName').isVisible()) await second.locator('#displayName').fill('Second')
    await join(second)
    await expect(second.locator('#chatLog')).toContainText('Before the move', { timeout: 60_000 })

    const memberContext = member.context()
    await member.close()
    await maker.waitForTimeout(115_000)

    await openCallSettings(maker, 'Your KithMoot node')
    await maker.locator('#nodePairingInput').fill(fixture.pairing())
    await maker.locator('#nodePair').click(); await maker.locator('#actionConfirm').click()
    await expect(maker.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(maker)
    await openRoomInfoPage(maker, 'Privacy and connection')
    await maker.locator('#moveRoomToNode').click()
    await expect.poll(() => fixture.ledger.rooms().length).toBe(1)
    const room = fixture.ledger.rooms()[0]!
    // The second device follows, and keeps the room's owner key on the node.
    await expect.poll(async () => parseNodeRoomLink(await second.locator('#shareUrl').inputValue(), Math.floor(Date.now() / 1000))?.room, { timeout: 120_000 }).toBe(room.room)
    const keeps = () => second.evaluate(([p, r]) => typeof JSON.parse(localStorage.getItem(`kithmoot.node-room.v1.${p}.${r}`) ?? '{}').authoritySk === 'string', [owner, room.room])
    await expect.poll(keeps).toBe(true)
    if (!makerStays) {
      // As a desktop that followed the move before keys were shared: no key,
      // no shared copy, no journal, nothing cached. The account's record
      // brings the key back on the next start.
      await second.goto(baseURL!)
      await second.evaluate(([p, r]) => {
        const key = `kithmoot.node-room.v1.${p}.${r}`, held = JSON.parse(localStorage.getItem(key)!)
        delete held.authoritySk; localStorage.setItem(key, JSON.stringify(held))
        for (const name of Object.keys(localStorage)) if (name.startsWith('kithmoot.room-owner.v1.') || name === `kithmoot.node-keeper.v1.${p}.${r}` || name.startsWith(`kithmoot.bookmarks.${p}.`)) localStorage.removeItem(name)
      }, [owner, room.room])
      expect(await keeps()).toBe(false)
      await second.reload()
      await expect.poll(keeps, { timeout: 60_000 }).toBe(true)
    }
    const devicesAfterMove = fixture.ledger.devices().length

    // Without makerStays the device that made and moved the room is gone;
    // with it, both of the owner's devices keep the room at once. The second
    // only has the app open.
    if (makerStays) await maker.goto(baseURL!)
    else await maker.context().close()
    await second.goto(baseURL!)
    const returning = await memberContext.newPage()
    await openRoomUrl(returning, originalLink)
    if (await returning.locator('#join').isVisible()) await join(returning)
    await expect.poll(async () => parseNodeRoomLink(await returning.locator('#shareUrl').inputValue(), Math.floor(Date.now() / 1000))?.room, { timeout: 180_000 }).toBe(room.room)
    expect(fixture.ledger.devices().length).toBe(devicesAfterMove + 1)
    await returning.locator('#chatInput').fill('Let in by the other device'); await returning.locator('#chatInput').press('Enter')
    await openRoomUrl(second, originalLink)
    await expect(second.locator('#chatLog')).toContainText('Let in by the other device', { timeout: 60_000 })
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
}

test('the owner\'s second device takes up a moved room\'s key from the account and lets a straggler in once the first device is gone', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'room transition qualification')
  test.setTimeout(480_000)
  await sharedOwnerStraggler(baseURL!, false)
})

test('with two of the owner\'s devices keeping a moved room at once, a straggler still gets in', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'room transition qualification')
  test.setTimeout(480_000)
  await sharedOwnerStraggler(baseURL!, true)
})

/** A browser device signed in as `key`, with a signer that can encrypt so the
 *  account's room bookmarks sync between its devices, its node traffic sent
 *  to `fixture`, and every node HTTP status written to `log`. */
async function ownerSyncDevice(browser: Browser, baseURL: string, fixture: Awaited<ReturnType<typeof nodeBrowserFixture>>, key: Uint8Array,
  contexts: BrowserContext[], label: string, log: string[]): Promise<Page> {
  const context = await newDeviceContext(browser, baseURL, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1100, height: 860 } })
  contexts.push(context)
  await context.exposeFunction('ownerPublicKey', () => getPublicKey(key))
  await context.exposeFunction('ownerSign', (template: EventTemplate) => finalizeEvent(template, key))
  await context.exposeFunction('ownerEncrypt', (peer: string, text: string) => encrypt(text, getConversationKey(key, peer)))
  await context.exposeFunction('ownerDecrypt', (peer: string, text: string) => decrypt(text, getConversationKey(key, peer)))
  const accountRelay = new URL('/__test-relay', baseURL); accountRelay.protocol = 'wss:'
  await context.addInitScript(({ node, relay }) => {
    const w = window as typeof window & { ownerPublicKey(): Promise<string>; ownerSign(value: unknown): Promise<unknown>
      ownerEncrypt(peer: string, text: string): Promise<string>; ownerDecrypt(peer: string, text: string): Promise<string> }
    Object.defineProperty(window, 'nostr', { configurable: true, value: { getPublicKey: () => w.ownerPublicKey(), signEvent: (value: unknown) => w.ownerSign(value),
      nip44: { encrypt: (peer: string, text: string) => w.ownerEncrypt(peer, text), decrypt: (peer: string, text: string) => w.ownerDecrypt(peer, text) } } })
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const target = String(url)
        super(target === 'wss://node.example/events' ? node : target.startsWith('wss://') && !target.includes('localhost') ? relay : target, protocols)
      }
    }
  }, { node: fixture.websocket, relay: accountRelay.href })
  await context.route('https://node.example/**', async route => {
    const path = new URL(route.request().url()).pathname
    const response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path })
    log.push(`${label} ${route.request().method()} ${path} ${response.status()}${response.ok() ? '' : ' ' + (await response.text()).slice(0, 160)}`)
    await route.fulfill({ response })
  })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const page = await context.newPage()
  page.on('pageerror', error => console.error(`${label} page:`, error.message))
  await signInAccount(page, baseURL)
  return page
}

test('the owner\'s second device lets itself into a room its account made on the node with no other device of theirs online', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(300_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34792, tls: 53501 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], log: string[] = []
  try {
    const ownerKey = generateSecretKey()
    const maker = await ownerSyncDevice(browser, baseURL!, fixture, ownerKey, contexts, 'maker', log)
    await openCallSettings(maker, 'Your KithMoot node')
    await maker.locator('#nodePairingInput').fill(fixture.pairing())
    await maker.locator('#nodePair').click(); await maker.locator('#actionConfirm').click()
    await expect(maker.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(maker)
    await maker.locator('#homeNewRoom').click()
    await maker.locator('#roomName').fill('Kept alone')
    await expect(maker.locator('#roomOnNode')).toBeChecked()
    if (await maker.locator('#newRoomYourName').isVisible()) await maker.locator('#newRoomYourName').fill('Maker')
    await maker.locator('#create').click()
    await expect(maker.locator('#chatInput')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => maker.locator('#shareUrl').inputValue()).not.toBe('')
    const link = await maker.locator('#shareUrl').inputValue()
    // The maker closes as soon as the room is on the account, owner key and
    // secret with it, and before it has posted the room's name to the node:
    // as on 12 November, when the owner's phone then showed "Untitled room".
    await expect(maker.locator('#roomSyncStatus')).toContainText(/accepted by a relay|Up to date: 1 room/, { timeout: 60_000 })
    // Every device of the owner's that could let it in is gone.
    log.push('--- maker closes')
    await maker.close()

    const second = await ownerSyncDevice(browser, baseURL!, fixture, ownerKey, contexts, 'second', log)
    await expect(second.locator('#roomSyncStatus')).toContainText(/loaded|Up to date/, { timeout: 60_000 })
    const listed = second.getByRole('button', { name: 'Open Kept alone' })
    await expect(listed).toBeVisible({ timeout: 60_000 })
    await second.waitForTimeout(15_000)
    log.push('--- second opens the room from its list')
    await listed.click()
    await expect(second.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await expect(second.getByRole('alertdialog', { name: 'Ask to join this room?' })).toHaveCount(0)
    // The name comes from the account's list: the node told this device none.
    await expect(second.locator('#roomTitle')).toHaveText('Kept alone')
    await second.locator('#chatInput').fill('Let in without anyone'); await second.locator('#chatInput').press('Enter')

    // A guest the second device lets in sees the name, which only a device
    // keeping the room can have posted.
    const guestContext = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1100, height: 860 } })
    contexts.push(guestContext)
    await guestContext.addInitScript(({ node }) => {
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) { super(String(url) === 'wss://node.example/events' ? node : url, protocols) }
      }
    }, { node: fixture.websocket })
    await guestContext.route('https://node.example/**', async route => {
      const path = new URL(route.request().url()).pathname
      await route.fulfill({ response: await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path }) })
    })
    const guest = await guestContext.newPage()
    await openRoomUrl(guest, link)
    if (await guest.locator('#displayName').isVisible()) await guest.locator('#displayName').fill('Guest')
    await guest.getByRole('button', { name: 'Ask to join' }).click({ timeout: 60_000 })
    await second.getByRole('button', { name: 'Let in' }).click({ timeout: 60_000 })
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await expect(guest.locator('#roomTitle')).toHaveText('Kept alone', { timeout: 90_000 })

    // The maker's device comes back and reads what the second device sent.
    const back = await contexts[0].newPage()
    await openRoomUrl(back, link)
    await expect(back.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await expect(back.locator('#chatLog')).toContainText('Let in without anyone', { timeout: 60_000 })
  } catch (error) {
    for (const page of [contexts[1]?.pages()[0]].filter(Boolean)) {
      log.push('--- second status: ' + await page!.locator('#status, #arrivalTitle, #arrivalLead').allInnerTexts().catch(() => []))
    }
    throw error
  } finally {
    console.log('node requests:\n' + log.join('\n'))
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
})

test('the owner\'s second device opens a room its account made on the node', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(300_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34790, tls: 53499 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], log: string[] = []
  try {
    const ownerKey = generateSecretKey()
    const maker = await ownerSyncDevice(browser, baseURL!, fixture, ownerKey, contexts, 'maker', log)
    await openCallSettings(maker, 'Your KithMoot node')
    await maker.locator('#nodePairingInput').fill(fixture.pairing())
    await maker.locator('#nodePair').click(); await maker.locator('#actionConfirm').click()
    await expect(maker.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(maker)
    await maker.locator('#homeNewRoom').click()
    await maker.locator('#roomName').fill('Made on the node')
    await expect(maker.locator('#roomOnNode')).toBeChecked()
    if (await maker.locator('#newRoomYourName').isVisible()) await maker.locator('#newRoomYourName').fill('Maker')
    await maker.locator('#create').click()
    await expect(maker.locator('#chatInput')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => maker.locator('#shareUrl').inputValue()).not.toBe('')
    const link = await maker.locator('#shareUrl').inputValue()
    expect(parseNodeRoomLink(link, Math.floor(Date.now() / 1000))).not.toBeNull()
    // Nobody gets into a room on a node on the link alone, and the empty room says so.
    await expect(maker.locator('#emptyRoom .emptyRoomNote')).toHaveText('People with the link ask to join, and you let them in.')

    // The same account on another device, as the owner's M4 desktop was.
    const second = await ownerSyncDevice(browser, baseURL!, fixture, ownerKey, contexts, 'second', log)
    await expect(second.locator('#roomSyncStatus')).toContainText(/loaded|Up to date/, { timeout: 60_000 })
    // As on the owner's M4: the room arrives in the list from the account,
    // with its owner key, and is opened from there.
    const listed = second.getByRole('button', { name: 'Open Made on the node' })
    await expect(listed).toBeVisible({ timeout: 60_000 })
    await second.waitForTimeout(15_000)
    log.push('--- second opens the room from its list')
    await listed.click()
    // The account's own room: no stranger's "Ask to join" for its owner.
    await expect(second.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await expect(second.getByRole('alertdialog', { name: 'Ask to join this room?' })).toHaveCount(0)
    await second.locator('#chatInput').fill('From my other device'); await second.locator('#chatInput').press('Enter')
    await expect(maker.locator('#chatLog')).toContainText('From my other device', { timeout: 60_000 })

    // A guest let in by the maker sees the room's name, which a room on a
    // node's link cannot carry.
    const guestContext = await newDeviceContext(browser, baseURL!, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1100, height: 860 } })
    contexts.push(guestContext)
    await guestContext.addInitScript(({ node }) => {
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) { super(String(url) === 'wss://node.example/events' ? node : url, protocols) }
      }
    }, { node: fixture.websocket })
    await guestContext.route('https://node.example/**', async route => {
      const path = new URL(route.request().url()).pathname
      await route.fulfill({ response: await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path }) })
    })
    const guest = await guestContext.newPage()
    await openRoomUrl(guest, link)
    if (await guest.locator('#displayName').isVisible()) await guest.locator('#displayName').fill('Guest')
    await guest.getByRole('button', { name: 'Ask to join' }).click({ timeout: 60_000 })
    await maker.getByRole('button', { name: 'Let in' }).click({ timeout: 60_000 })
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await expect(guest.locator('#roomTitle')).toHaveText('Made on the node', { timeout: 90_000 })

    // With both of the owner's devices keeping the room, the second leaves
    // for its start page and opens the room again: the name it took from the
    // account's list and posted leaves the room readable there.
    await second.goto(baseURL!)
    await guest.locator('#chatInput').fill('While you were away'); await guest.locator('#chatInput').press('Enter')
    await openRoomUrl(second, link)
    await expect(second.locator('#chatLog')).toContainText('While you were away', { timeout: 60_000 })
    await expect(second.locator('#roomTitle')).toHaveText('Made on the node')
  } catch (error) {
    for (const page of [contexts[1]?.pages()[0]].filter(Boolean)) {
      log.push('--- second status: ' + await page!.locator('#status, #arrivalTitle, #arrivalLead').allInnerTexts().catch(() => []))
    }
    throw error
  } finally {
    console.log('node requests:\n' + log.join('\n'))
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
})

/**
 * The owner's second device lets itself into the account's node room, but its
 * own grant goes unacknowledged: lost before it reaches the node, or reaching
 * it with the reply lost. The other device keeps the room open throughout.
 * Neither device's journal may then stop it reopening the room.
 */
async function ownerReopensAfterAnUnacknowledgedGrant(baseURL: string, lost: 'request' | 'reply'): Promise<void> {
  const fixture = await nodeBrowserFixture(new URL(baseURL).origin, { chatOnly: true, turnPorts: { udpTcp: 34790, tls: 53499 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], log: string[] = [], name = lost === 'request' ? 'Lost request' : 'Lost reply'
  const bothWays = async (maker: Page, second: Page, tag: string) => {
    await expect(second.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await second.locator('#chatInput').fill(`${tag} from second`); await second.locator('#chatInput').press('Enter')
    await expect(maker.locator('#chatLog')).toContainText(`${tag} from second`, { timeout: 60_000 })
    await maker.locator('#chatInput').fill(`${tag} from maker`); await maker.locator('#chatInput').press('Enter')
    await expect(second.locator('#chatLog')).toContainText(`${tag} from maker`, { timeout: 60_000 })
  }
  const reopen = async (page: Page) => {
    await page.reload()
    const listed = page.getByRole('button', { name: `Open ${name}` })
    await expect(listed).toBeVisible({ timeout: 60_000 }); await listed.click()
    await expect(page.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
  }
  try {
    const ownerKey = generateSecretKey()
    const maker = await ownerSyncDevice(browser, baseURL, fixture, ownerKey, contexts, 'maker', log)
    await openCallSettings(maker, 'Your KithMoot node')
    await maker.locator('#nodePairingInput').fill(fixture.pairing())
    await maker.locator('#nodePair').click(); await maker.locator('#actionConfirm').click()
    await expect(maker.locator('#nodeHost')).toHaveText('node.example')
    await closeSettings(maker)
    await maker.locator('#homeNewRoom').click()
    await maker.locator('#roomName').fill(name)
    await expect(maker.locator('#roomOnNode')).toBeChecked()
    if (await maker.locator('#newRoomYourName').isVisible()) await maker.locator('#newRoomYourName').fill('Maker')
    await maker.locator('#create').click()
    await expect(maker.locator('#chatInput')).toBeVisible({ timeout: 60_000 })

    const second = await ownerSyncDevice(browser, baseURL, fixture, ownerKey, contexts, 'second', log)
    await expect(second.locator('#roomSyncStatus')).toContainText(/loaded|Up to date/, { timeout: 60_000 })
    const listed = second.getByRole('button', { name: `Open ${name}` })
    await expect(listed).toBeVisible({ timeout: 60_000 })
    await second.waitForTimeout(15_000)
    let unacknowledged = 0
    await contexts[1].route('https://node.example/groups/v1/events', async route => {
      if (unacknowledged++ > 0) { await route.fallback(); return }
      if (lost === 'reply') {
        const response = await route.fetch({ url: fixture.desk + '/groups/v1/events' })
        log.push(`second POST /groups/v1/events ${response.status()}, reply lost by the test`)
      } else log.push('second POST /groups/v1/events lost by the test')
      await route.fulfill({ status: 503, body: '' })
    })
    log.push('--- second opens the room from its list')
    await listed.click()
    if (lost === 'request') {
      // The maker lets it in instead, under a grant of the maker's own.
      await bothWays(maker, second, 'First')
      log.push('--- second reopens')
      await reopen(second)
      // It replayed its own grant, and the node refused it for the maker's.
      expect(log.some(line => line.startsWith('second POST /groups/v1/events 409') && line.includes('device-already-granted'))).toBe(true)
      await bothWays(maker, second, 'Again')
    } else {
      // The node already holds the second device's own grant, so it refuses
      // the maker's. The maker's room must still reopen, and so must the
      // second device's, under the grant the node does hold.
      await expect.poll(() => log.some(line => line.startsWith('maker POST /groups/v1/events 409') && line.includes('device-already-granted')), { timeout: 90_000 }).toBe(true)
      log.push('--- maker reopens')
      await reopen(maker)
      log.push('--- second reopens')
      await reopen(second)
      await bothWays(maker, second, 'Again')
    }
    expect(unacknowledged).toBeGreaterThan(0)
  } catch (error) {
    for (const [label, page] of [['maker', contexts[0]?.pages()[0]], ['second', contexts[1]?.pages()[0]]] as const) {
      if (page) log.push(`--- ${label} status: ` + await page.locator('#status, #arrivalTitle, #arrivalLead').allInnerTexts().catch(() => []))
    }
    throw error
  } finally {
    console.log(`node requests (${name}):\n` + log.join('\n'))
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
}

test('the owner\'s second device reopens a node room after its own grant never reached the node', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(420_000)
  await ownerReopensAfterAnUnacknowledgedGrant(baseURL!, 'request')
})

test('both of the owner\'s devices reopen a node room after the reply to one\'s own grant was lost', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(420_000)
  await ownerReopensAfterAnUnacknowledgedGrant(baseURL!, 'reply')
})

/** A browser with no account, routed to the test node, as a guest's phone. */
async function nodeGuest(browser: Browser, baseURL: string, fixture: Awaited<ReturnType<typeof nodeBrowserFixture>>, contexts: BrowserContext[], log: string[]): Promise<Page> {
  const context = await newDeviceContext(browser, baseURL, { ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1100, height: 860 } })
  contexts.push(context)
  await context.addInitScript(({ node }) => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) { super(String(url) === 'wss://node.example/events' ? node : url, protocols) }
    }
  }, { node: fixture.websocket })
  await context.route('https://node.example/**', async route => {
    const path = new URL(route.request().url()).pathname
    const response = await route.fetch({ url: (path === '/v1/credentials' ? fixture.calls : fixture.desk) + path })
    log.push(`guest ${route.request().method()} ${path} ${response.status()}${response.ok() ? '' : ' ' + (await response.text()).slice(0, 160)}`)
    await route.fulfill({ response })
  })
  const page = await context.newPage()
  page.on('pageerror', error => console.error('guest page:', error.message))
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') log.push(`guest console ${message.type()}: ${message.text().slice(0, 300)}`) })
  return page
}

async function ownerWithNodeRoom(browser: Browser, baseURL: string, fixture: Awaited<ReturnType<typeof nodeBrowserFixture>>,
  contexts: BrowserContext[], log: string[], name: string, key = generateSecretKey()): Promise<{ owner: Page; link: string }> {
  const owner = await ownerSyncDevice(browser, baseURL, fixture, key, contexts, 'owner', log)
  await openCallSettings(owner, 'Your KithMoot node')
  await owner.locator('#nodePairingInput').fill(fixture.pairing())
  await owner.locator('#nodePair').click(); await owner.locator('#actionConfirm').click()
  await expect(owner.locator('#nodeHost')).toHaveText('node.example')
  await closeSettings(owner)
  await owner.locator('#homeNewRoom').click()
  await owner.locator('#roomName').fill(name)
  await expect(owner.locator('#roomOnNode')).toBeChecked()
  if (await owner.locator('#newRoomYourName').isVisible()) await owner.locator('#newRoomYourName').fill('Owner')
  await owner.locator('#create').click()
  await expect(owner.locator('#chatInput')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => owner.locator('#shareUrl').inputValue()).not.toBe('')
  return { owner, link: await owner.locator('#shareUrl').inputValue() }
}

// 11 November: a guest knocked while the owner's screen showed another page,
// and waited a minute with nobody told.
test('a guest who knocks on a node room while its owner is on the start page is let in from there', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(300_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34794, tls: 53503 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], log: string[] = []
  try {
    const { owner, link } = await ownerWithNodeRoom(browser, baseURL!, fixture, contexts, log, 'Knock from afar')
    await owner.locator('#appHome').click()
    await expect(owner.getByRole('button', { name: 'Open Knock from afar' })).toBeVisible({ timeout: 60_000 })

    const guest = await nodeGuest(browser, baseURL!, fixture, contexts, log)
    await openRoomUrl(guest, link)
    if (await guest.locator('#displayName').isVisible()) await guest.locator('#displayName').fill('Guest')
    await guest.getByRole('button', { name: 'Ask to join' }).click({ timeout: 60_000 })

    const card = owner.locator('#awayKnocks .approvalCard.knock')
    await expect(card).toContainText('wants to join Knock from afar', { timeout: 60_000 })
    await expect(card).toContainText('Guest')
    await expect(card).toContainText('Letting them in opens the room.')
    log.push('--- owner lets them in from the start page')
    // A guest's device asks the open room for its key, so yes opens the room,
    // and the room lets them in without asking the owner a second time.
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(owner.locator('#roomTitle')).toHaveText('Knock from afar', { timeout: 60_000 })
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await expect(owner.locator('.approvalCard.knock')).toHaveCount(0)
    await guest.locator('#chatInput').fill('Hello from outside'); await guest.locator('#chatInput').press('Enter')
    await expect(owner.locator('#chatLog')).toContainText('Hello from outside', { timeout: 60_000 })
    await owner.locator('#chatInput').fill('Welcome in'); await owner.locator('#chatInput').press('Enter')
    await expect(guest.locator('#chatLog')).toContainText('Welcome in', { timeout: 60_000 })
  } finally {
    console.log('node requests:\n' + log.join('\n'))
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
})

test('a knock on a node room while its owner is in another room names its room, and opening that room keeps it', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(300_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34796, tls: 53505 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], log: string[] = []
  try {
    const { owner, link } = await ownerWithNodeRoom(browser, baseURL!, fixture, contexts, log, 'Knocked on')
    await owner.locator('#appHome').click()
    await owner.locator('#homeNewRoom').click({ timeout: 60_000 })
    await owner.locator('#roomName').fill('Somewhere else')
    await owner.locator('#create').click()
    await expect(owner.locator('#roomTitle')).toHaveText('Somewhere else', { timeout: 60_000 })

    const guest = await nodeGuest(browser, baseURL!, fixture, contexts, log)
    await openRoomUrl(guest, link)
    if (await guest.locator('#displayName').isVisible()) await guest.locator('#displayName').fill('Guest')
    await guest.getByRole('button', { name: 'Ask to join' }).click({ timeout: 60_000 })

    // Not above this room's conversation, as if it were for this room.
    const away = owner.locator('#awayKnocks .approvalCard.knock')
    await expect(away).toContainText('wants to join Knocked on', { timeout: 60_000 })
    await expect(owner.locator('#approvals .approvalCard.knock')).toHaveCount(0)
    await away.getByRole('button', { name: 'Open room', exact: true }).click()
    await expect(owner.locator('#roomTitle')).toHaveText('Knocked on', { timeout: 60_000 })
    // The room's own keeper takes the knock over: one card, now above its conversation.
    const here = owner.locator('#approvals .approvalCard.knock')
    await expect(here).toHaveCount(1, { timeout: 60_000 })
    await expect(away).toHaveCount(0)
    await here.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await guest.locator('#chatInput').fill('In at last'); await guest.locator('#chatInput').press('Enter')
    await expect(owner.locator('#chatLog')).toContainText('In at last', { timeout: 60_000 })
  } finally {
    console.log('node requests:\n' + log.join('\n'))
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
})

// 13 November: a node room made from inside another kept the old room's
// conversation under the new room's title, then turned back into the old room.
test('a node room started from inside another node room is the room on screen: its guest, its chat and its rename', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(300_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34800, tls: 53509 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], log: string[] = []
  try {
    const { owner, link: first } = await ownerWithNodeRoom(browser, baseURL!, fixture, contexts, log, 'First on the node')
    await owner.locator('#chatInput').fill('said in the first node room'); await owner.locator('#chatInput').press('Enter')
    await expect(owner.locator('#chatLog')).toContainText('said in the first node room', { timeout: 60_000 })

    log.push('--- owner starts a second node room from inside the first')
    await owner.locator('#newMenuButton').click()
    await owner.getByRole('menuitem', { name: 'New room' }).click()
    await owner.locator('#roomName').fill('Second on the node')
    await expect(owner.locator('#roomOnNode')).toBeChecked()
    await owner.locator('#create').click()
    await expect(owner.locator('#roomTitle')).toHaveText('Second on the node', { timeout: 60_000 })
    await expect(owner.locator('#chatInput')).toBeEditable({ timeout: 60_000 })
    await expect(owner.locator('#chatLog')).not.toContainText('said in the first node room')
    const second = await owner.locator('#shareUrl').inputValue()
    expect(second).not.toBe(first)
    expect(parseNodeRoomLink(second, Math.floor(Date.now() / 1000))?.room).not.toBe(parseNodeRoomLink(first, Math.floor(Date.now() / 1000))?.room)

    const guest = await nodeGuest(browser, baseURL!, fixture, contexts, log)
    await openRoomUrl(guest, second)
    if (await guest.locator('#displayName').isVisible()) await guest.locator('#displayName').fill('Guest')
    await guest.getByRole('button', { name: 'Ask to join' }).click({ timeout: 60_000 })
    const card = owner.locator('#approvals .approvalCard.knock')
    await expect(card).toHaveCount(1, { timeout: 60_000 })
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await expect(guest.locator('#roomTitle')).toHaveText('Second on the node', { timeout: 60_000 })
    await guest.locator('#chatInput').fill('the guest is in the second room'); await guest.locator('#chatInput').press('Enter')
    await expect(owner.locator('#chatLog')).toContainText('the guest is in the second room', { timeout: 60_000 })
    await owner.locator('#chatInput').fill('the owner answers in the second room'); await owner.locator('#chatInput').press('Enter')
    await expect(guest.locator('#chatLog')).toContainText('the owner answers in the second room', { timeout: 60_000 })
    await expect(guest.locator('#chatLog')).not.toContainText('said in the first node room')
    await expect(owner.locator('#roomTitle')).toHaveText('Second on the node')

    log.push('--- owner renames the second room')
    await openRoomInfoPage(owner, 'Name and picture')
    await expect(owner.locator('#roomRename')).toBeVisible({ timeout: 60_000 })
    await owner.locator('#roomRenameInput').fill('Second renamed')
    await owner.locator('#roomRenameSave').click()
    for (const page of [owner, guest]) await expect(page.locator('#roomTitle')).toHaveText('Second renamed', { timeout: 60_000 })
  } finally {
    console.log('node requests:\n' + log.join('\n'))
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
})

// The owner keeps several devices signed in, and every one of them keeps the room.
test('with two of the owner\'s devices on their start pages, a yes on one lets the guest in and a second yes does no harm', async ({ baseURL, browserName }) => {
  test.skip(!process.env.E2E_NODE_SHELTER_BINARY, 'requires the checked private native relay executable')
  test.skip(browserName !== 'chromium', 'one browser is enough for this flow')
  test.setTimeout(420_000)
  const fixture = await nodeBrowserFixture(new URL(baseURL!).origin, { chatOnly: true, turnPorts: { udpTcp: 34798, tls: 53507 } })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP node.example 127.0.0.1'] })
  const contexts: BrowserContext[] = [], log: string[] = []
  try {
    const key = generateSecretKey()
    const { owner, link } = await ownerWithNodeRoom(browser, baseURL!, fixture, contexts, log, 'Two keepers', key)
    await expect(owner.locator('#roomSyncStatus')).toContainText(/accepted by a relay|Up to date: 1 room/, { timeout: 60_000 })
    const second = await ownerSyncDevice(browser, baseURL!, fixture, key, contexts, 'second', log)
    const listed = second.getByRole('button', { name: 'Open Two keepers' })
    await expect(listed).toBeVisible({ timeout: 60_000 })
    await second.waitForTimeout(15_000)
    await listed.click()
    await expect(second.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await second.locator('#appHome').click()
    await owner.locator('#appHome').click()
    await expect(owner.getByRole('button', { name: 'Open Two keepers' })).toBeVisible({ timeout: 60_000 })
    await expect(second.getByRole('button', { name: 'Open Two keepers' })).toBeVisible({ timeout: 60_000 })

    const guest = await nodeGuest(browser, baseURL!, fixture, contexts, log)
    await openRoomUrl(guest, link)
    if (await guest.locator('#displayName').isVisible()) await guest.locator('#displayName').fill('Guest')
    await guest.getByRole('button', { name: 'Ask to join' }).click({ timeout: 60_000 })
    const ownerCard = owner.locator('#awayKnocks .approvalCard.knock'), secondCard = second.locator('#awayKnocks .approvalCard.knock')
    await expect(ownerCard).toContainText('wants to join Two keepers', { timeout: 60_000 })
    await expect(secondCard).toContainText('wants to join Two keepers', { timeout: 60_000 })

    await ownerCard.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#chatInput')).toBeVisible({ timeout: 90_000 })
    await guest.locator('#chatInput').fill('In through the first'); await guest.locator('#chatInput').press('Enter')
    await expect(owner.locator('#chatLog')).toContainText('In through the first', { timeout: 60_000 })
    for (const wait of [5_000, 30_000, 40_000]) {
      await second.waitForTimeout(wait)
      log.push(`--- second device's card after a further ${wait / 1000} s: ${await secondCard.count()}`)
    }
    // A second yes from the other device, as the owner might give it.
    if (await secondCard.count()) {
      log.push('--- second device says yes too')
      await secondCard.getByRole('button', { name: 'Let in', exact: true }).click()
      await expect(second.locator('#roomTitle')).toHaveText('Two keepers', { timeout: 60_000 })
      await second.waitForTimeout(20_000)
    }
    await guest.locator('#chatInput').fill('Still here'); await guest.locator('#chatInput').press('Enter')
    await expect(owner.locator('#chatLog')).toContainText('Still here', { timeout: 60_000 })
    await owner.locator('#chatInput').fill('Glad you are'); await owner.locator('#chatInput').press('Enter')
    await expect(guest.locator('#chatLog')).toContainText('Glad you are', { timeout: 60_000 })
  } finally {
    console.log('node requests:\n' + log.join('\n'))
    await Promise.all(contexts.map(context => context.close().catch(() => {})))
    await browser.close(); await fixture.close()
  }
})
