import { test, expect } from '@playwright/test'
import { createServer } from 'node:https'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCertificate } from '@vitejs/plugin-basic-ssl'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { createRumor, createSeal } from 'nostr-tools/nip59'
import { Relay } from 'nostr-tools/relay'
import { verifyEventUncached } from '../src/verify.js'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { openNewRoomForm, openRoomInfoPage, openSettings, nameCreator, join as joinDoor } from './browser.js'
import { TEST_RELAY_WS } from './relays.js'

// The same signed kind-21236 response inside a kind-29999 gift wrap that
// My Signet sends. Keep identity approval and the live signer handshake
// separate: an approval without a handoff must not become a signing account.
for (const liveSigner of [false, true]) test(`Signet approval ${liveSigner ? 'connects a live signer and signs a room join' : 'explains a missing signing connection'}`, async ({ browser, baseURL }) => {
  const user = generateSecretKey(), endpoint = generateSecretKey()
  const pubkey = getPublicKey(user), endpointPubkey = getPublicKey(endpoint)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const server = await Relay.connect(TEST_RELAY_WS)
  const signedKinds: number[] = []
  const serving = server.subscribe([{ kinds: [24133], '#p': [endpointPubkey] }], {
    onevent: async event => {
      const conversation = getConversationKey(endpoint, event.pubkey)
      const request = JSON.parse(decrypt(event.content, conversation))
      const reply = request.method === 'connect' ? { result: 'ack' }
        : request.method === 'get_public_key' ? { result: pubkey }
        : request.method === 'ping' ? { result: 'pong' }
        : request.method === 'sign_event' ? (() => {
          const template = JSON.parse(request.params[0]); signedKinds.push(template.kind)
          return { result: JSON.stringify(finalizeEvent(template, user)) }
        })() : { error: 'Unsupported fixture method' }
      await server.publish(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', event.pubkey]],
        content: encrypt(JSON.stringify({ id: request.id, ...reply }), conversation) }, endpoint))
    },
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(url => url.href !== relay.href, socket => socket.close())
  await context.addInitScript(relay => {
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }))
  }, relay.href)
  try {
    const page = await context.newPage()
    await page.goto(baseURL! + '?signin=nostr')
    await page.locator('[data-choice="remote-signet"]').click()
    const link = page.locator('#signet-login-open-signet')
    await expect(link).toBeVisible()
    const request = new URL(await link.getAttribute('href') ?? '')
    const challenge = request.searchParams.get('challenge')!, origin = request.searchParams.get('origin')!
    const authEvent = finalizeEvent({ kind: 21236, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', challenge], ['origin', origin]], content: '' }, user)
    const response = { type: 'signet-auth-response', requestId: challenge, authEvent,
      ...(liveSigner ? { bunkerUri: `bunker://${endpointPubkey}?relay=${encodeURIComponent(relay.href)}` } : {}) }
    const recipient = request.searchParams.get('sessionPubkey')!
    const rumor = createRumor({ kind: 29999, created_at: Math.floor(Date.now() / 1000),
      tags: [['session', challenge], ['status', 'approved']], content: JSON.stringify(response) }, user)
    const seal = createSeal(rumor, user, recipient), outer = generateSecretKey()
    // Signet auth uses a recent outer timestamp so the consumer's short
    // response subscription matches it; ordinary DM wraps can be much older.
    await server.publish(finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipient]],
      content: encrypt(JSON.stringify(seal), getConversationKey(outer, recipient)) }, outer))
    if (!liveSigner) {
      await expect(page.locator('#status')).toContainText('Your identity was approved, but a signing connection was not established.')
      await expect(page.locator('#homeSignIn')).toBeVisible()
      expect(signedKinds).toEqual([])
      expect(await page.evaluate(() => localStorage.getItem('signet:login.pubkey'))).toBeNull()
    } else {
      await expect(page.locator('#signet-login-dialog')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => localStorage.getItem('signet:login.pubkey'))).toBe(pubkey)
      await expect(page.locator('#homeSignIn')).toBeHidden()
      await openNewRoomForm(page)
      await page.locator('#roomName').fill('Signet signing fixture')
      await nameCreator(page, 'Ada')
      await page.locator('#create').click()
      await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
      await expect.poll(() => signedKinds.length).toBeGreaterThan(0)
      expect(await page.evaluate(() => localStorage.getItem('signet:login.pubkey'))).toBe(pubkey)
    }
  } finally { await context.close(); serving.close(); server.close() }
})

test('relay settings show activity outside account sync and keep the chosen order for Signet', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const preferred = 'wss://preferred.example/'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(url => url.href !== relay.href, socket => {
    if (socket.url() !== preferred) { socket.close(); return }
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'REQ') socket.send(JSON.stringify(['EOSE', frame[1]]))
    })
  })
  await context.addInitScript(({ relay, preferred }) => {
    if (localStorage.getItem('relay-order-seeded')) return
    localStorage.setItem('relay-order-seeded', '1')
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [
      { url: relay, read: true, write: true }, { url: preferred, read: true, write: true },
    ] }))
  }, { relay: relay.href, preferred })
  try {
    const page = await context.newPage()
    await page.goto(encodeJoinUrl(baseURL!, generateRoomSecret(), [relay.href]))
    await page.locator('#displayName').fill('Relay tester'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const openDefaults = async () => {
      await openRoomInfoPage(page, 'Privacy and connection')
      await page.locator('#roomRelaySettings').click()
      await page.locator('#relayScope').selectOption('default')
      await expect(page.locator('#relayScope')).toHaveValue('default')
    }
    await openDefaults()
    const row = page.locator('#relayList .relayRow').filter({ hasText: relay.href })
    await expect(row.locator('.relayHealth')).toContainText('Not in use here · Connected elsewhere in KithMoot')
    await expect(row.locator('.relayHealth')).not.toContainText('Account authenticated')
    await page.getByRole('button', { name: `Move ${preferred} up`, exact: true }).click()
    await expect(page.locator('#relayList .relayAddress')).toHaveText([preferred, relay.href])
    await expect(page.getByRole('button', { name: `Move ${preferred} up`, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: `Move ${preferred} down`, exact: true })).toBeFocused()
    await page.locator('#relaySave').click()
    await expect(page.locator('#relaySettingsStatus')).toContainText('Saved on this device')
    await page.reload(); await joinDoor(page)
    await expect(page.locator('#roomArea')).toBeVisible()
    await openDefaults()
    await expect(page.locator('#relayList .relayAddress')).toHaveText([preferred, relay.href])
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
      expect(await page.locator('#relaySettings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    await page.locator('#relaySettingsClose').click()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(baseURL! + '?signin=nostr')
    await page.locator('[data-choice="remote-signet"]').click()
    await expect(page.locator('#signet-login-open-signet')).toBeVisible()
    const handoff = new URL(await page.locator('#signet-login-open-signet').getAttribute('href') ?? '')
    expect(handoff.searchParams.get('relay')).toBe(preferred)
    await page.locator('#signet-login-dialog [data-action="cancel"]').click()
  } finally { await context.close() }
})

test('relay settings enforce read-only traffic, show health and persist additions and removals', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const readRelay = 'wss://read-only.example/'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(url => url.href !== relay.href && url.href !== readRelay, ws => ws.close())
  const readFrames: unknown[][] = []
  let closedReads = 0
  await context.routeWebSocket(readRelay, ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as unknown[]; readFrames.push(frame)
      if (frame[0] === 'REQ') ws.send(JSON.stringify(['EOSE', frame[1]]))
    })
    ws.onClose(() => { closedReads++ })
  })
  try {
    const page = await context.newPage()
    await page.goto(encodeJoinUrl(baseURL!, generateRoomSecret(), [relay.href]))
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const open = async () => { await openRoomInfoPage(page, 'Privacy and connection'); await page.locator('#roomRelaySettings').click() }
    await open()
    await expect(page.locator('#relayList .relayHealth')).toContainText('Connected')
    await page.locator('#relayUrl').fill(readRelay)
    await page.locator('#relayMode').selectOption('read')
    await page.getByRole('button', { name: 'Add relay', exact: true }).click()
    await page.locator('#relaySave').click()
    await expect(page.locator('#relaySettingsStatus')).toContainText('Saved on this device')
    const readRow = page.locator('#relayList .relayRow').filter({ hasText: readRelay })
    await expect(readRow.locator('.relayHealth')).toContainText('Connected')
    await expect.poll(() => readFrames.some(frame => frame[0] === 'REQ')).toBe(true)
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.locator('#relaySettings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/kithmoot-relays-320-${test.info().project.name}.png` })
    await page.locator('#relaySettingsClose').click()
    // A relay marked as a box of the circle by hand is a circle relay: with
    // both relays marked the next message shows as sheltered, and unmarking
    // one puts it back to public. The mark survives a reload.
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/public/)
    await open()
    await page.getByLabel(`${relay.href} is a box of my circle`).check()
    await page.getByLabel(`${readRelay} is a box of my circle`).check()
    await expect(page.locator('#relaySettingsStatus')).toContainText('Marked as a box of your circle')
    await page.locator('#relaySettingsClose').click()
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/Encrypted · circle relay/)
    await page.reload(); await joinDoor(page)
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/Encrypted · circle relay/)
    await open()
    await expect(page.getByLabel(`${relay.href} is a box of my circle`)).toBeChecked()
    await page.getByLabel(`${relay.href} is a box of my circle`).uncheck()
    await page.getByLabel(`${readRelay} is a box of my circle`).uncheck()
    await page.locator('#relaySettingsClose').click()
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/public/)
    await page.locator('#chatInput').fill('Only write to the writable relay')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Only write to the writable relay')
    expect(readFrames.filter(frame => frame[0] === 'EVENT')).toEqual([])
    await open()
    await expect(page.locator('#relayList .relayRow').filter({ hasText: relay.href }).locator('.relayHealth')).toContainText('Last accepted write')
    await page.locator('#relayReconnect').click()
    await expect(readRow.locator('.relayHealth')).toContainText('Connected')
    await page.reload(); await joinDoor(page)
    await expect(page.locator('#roomArea')).toBeVisible()
    await open()
    await expect(readRow.locator('select')).toHaveValue('read')
    const beforeRemove = closedReads
    await readRow.getByRole('button', { name: `Remove ${readRelay}`, exact: true }).click()
    await page.locator('#relaySave').click()
    await expect(page.locator('#relayList .relayRow')).toHaveCount(1)
    await expect.poll(() => closedReads).toBeGreaterThan(beforeRemove)
    await page.reload(); await joinDoor(page); await open()
    await expect(page.locator('#relayList .relayRow')).toHaveCount(1)
    await page.locator('#relayScope').selectOption('default')
    while (await page.locator('#relayList .relayRow').count()) await page.locator('#relayList .relayRow').first().getByRole('button', { name: /^Remove / }).click()
    for (const [url, mode] of [[relay.href, 'both'], [readRelay, 'read']]) {
      await page.locator('#relayUrl').fill(url!)
      await page.locator('#relayMode').selectOption(mode!)
      await page.getByRole('button', { name: 'Add relay', exact: true }).click()
    }
    await page.locator('#relaySave').click()
    await expect(page.locator('#relaySettingsStatus')).toContainText('Saved on this device')
    await page.goto(baseURL!)
    await openNewRoomForm(page)
    await page.locator('#roomName').fill('Default relay fixture')
    await nameCreator(page, 'Ada')
    await page.locator('#create').click()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await open(); await expect(readRow.locator('select')).toHaveValue('read')
    await page.reload(); await joinDoor(page); await open()
    await expect(readRow.locator('select')).toHaveValue('read')
    expect(readFrames.filter(frame => frame[0] === 'EVENT')).toEqual([])
  } finally { await context.close() }
})

test('relay identity permission is explicit, names the chosen account and is withdrawn on sign-out', async ({ browser, baseURL }) => {
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  const certificateDirectory = await mkdtemp(join(tmpdir(), 'relay-auth-'))
  const certificate = await getCertificate(certificateDirectory)
  const server = createServer({ key: certificate, cert: certificate })
  const sockets = new WebSocketServer({ server })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local relay listener')
  const origin = `wss://127.0.0.1:${address.port}`
  const keeper = `${origin}/events`, ordinary = `${origin}/ordinary`
  const signed: Event[] = [], received: { url: string; frame: unknown[] }[] = []
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.exposeFunction('testPublicKey', () => pubkey)
  await context.exposeFunction('testSign', (template: Parameters<typeof finalizeEvent>[0]) => { const event = finalizeEvent(template, key); signed.push(event); return event })
  await context.exposeFunction('testEncrypt', (peer: string, text: string) => encrypt(text, getConversationKey(key, peer)))
  await context.exposeFunction('testDecrypt', (peer: string, text: string) => decrypt(text, getConversationKey(key, peer)))
  await context.addInitScript(({ keeper, ordinary, origin }) => {
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        // Keep profile lookups local too, while exercising real browser sockets.
        super(new URL(url).origin === origin ? url : `${origin}/blocked`, protocols)
      }
    }
    const testWindow = window as typeof window & {
      testPublicKey(): Promise<string>; testSign(template: unknown): Promise<unknown>;
      testEncrypt(peer: string, text: string): Promise<string>; testDecrypt(peer: string, text: string): Promise<string>;
    }
    Object.defineProperty(window, 'nostr', { configurable: true, value: {
      getPublicKey: () => testWindow.testPublicKey(), signEvent: (event: unknown) => testWindow.testSign(event),
      nip44: { encrypt: (peer: string, text: string) => testWindow.testEncrypt(peer, text), decrypt: (peer: string, text: string) => testWindow.testDecrypt(peer, text) },
    } })
    if (location.protocol === 'https:') localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [
      { url: keeper, read: true, write: true }, { url: ordinary, read: true, write: false },
    ] }))
  }, { keeper, ordinary, origin })
  // Actual TLS sockets exercise cancellation without a mocked socket's
  // send-after-close race. Synthetic traffic never leaves loopback.
  sockets.on('connection', (socket, request) => {
    if (request.url === '/blocked') { socket.close(); return }
    const challenge = getPublicKey(generateSecretKey()), url = origin + request.url
    let authenticated = false
    socket.send(JSON.stringify(['AUTH', challenge]))
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as unknown[]
      received.push({ url, frame })
      if (frame[0] === 'AUTH') {
        const auth = frame[1] as Event
        authenticated = auth.pubkey === pubkey && auth.kind === 22242 && verifyEventUncached(auth) &&
          JSON.stringify(auth.tags) === JSON.stringify([['relay', url], ['challenge', challenge]])
        socket.send(JSON.stringify(['OK', auth.id, authenticated, authenticated ? '' : 'restricted: keeper required']))
      } else if (frame[0] === 'REQ') {
        socket.send(JSON.stringify(url === keeper && !authenticated
          ? ['CLOSED', frame[1], 'auth-required: keeper required'] : ['EOSE', frame[1]]))
      } else if (frame[0] === 'EVENT') {
        socket.send(JSON.stringify(['OK', (frame[1] as Event).id, url !== keeper || authenticated, '']))
      }
    })
  })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  try {
    const page = await context.newPage()
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(baseURL + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    expect(signed.filter(event => event.kind === 22242)).toHaveLength(0)
    await openSettings(page, 'Account')
    await expect(page.locator('#signOut')).toBeVisible()
    await openSettings(page, 'Connections')
    await page.locator('#defaultRelaySettings').click()
    const row = page.locator('.relayRow').filter({ hasText: keeper })
    await row.getByRole('button', { name: `Use signed-in account with ${keeper}` }).click()
    await expect(page.locator('#actionDescription')).toContainText(npubEncode(pubkey))
    await expect(page.locator('#actionDescription')).toContainText(keeper)
    await page.locator('#actionCancel').click()
    expect(signed.filter(event => event.kind === 22242)).toHaveLength(0)
    await row.getByRole('button', { name: `Use signed-in account with ${keeper}` }).click()
    await page.locator('#actionConfirm').click()
    await expect(row.locator('.relayHealth')).toContainText('Account authenticated')
    expect(signed.filter(event => event.kind === 22242).length).toBeGreaterThan(0)
    expect(received.filter(entry => entry.frame[0] === 'AUTH').every(entry => entry.url === keeper)).toBe(true)
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.locator('#relaySettings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/kithmoot-relay-auth-320-${test.info().project.name}.png` })
    await row.getByRole('button', { name: `Stop identifying with ${keeper}` }).click()
    await expect(row.locator('.relayHealth')).toContainText('permission withdrawn')
    await row.getByRole('button', { name: `Use signed-in account with ${keeper}` }).click()
    await page.locator('#actionConfirm').click()
    await expect(row.locator('.relayHealth')).toContainText('Account authenticated')
    await page.locator('#relaySettingsClose').click()
    await openSettings(page, 'Account')
    await page.locator('#signOut').click()
    await expect(page.locator('#signOut')).toBeHidden()
    await openSettings(page, 'Connections')
    await page.locator('#defaultRelaySettings').click()
    await expect(row.locator('.relayHealth')).toContainText('permission withdrawn')
    await expect(row.getByRole('button', { name: `Use signed-in account with ${keeper}` })).toBeDisabled()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.relays.v1'))).not.toContain(pubkey)
    expect(errors).toEqual([])
  } finally {
    await context.close()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(certificateDirectory, { recursive: true, force: true })
  }
})

test('the call relay password has an eye button that shows and hides it', async ({ page, baseURL }) => {
  await page.goto(baseURL!)
  await openSettings(page, 'Connections')
  await page.getByText('Other call relays', { exact: true }).click()
  // Found by its exact label: the eye sits beside the field, not inside its name.
  const password = page.getByLabel('Relay password', { exact: true })
  const eye = page.getByRole('button', { name: 'Show relay password', exact: true })
  await password.fill('synthetic-relay-password')
  await expect(password).toHaveAttribute('type', 'password')
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  await eye.click()
  await expect(password).toHaveAttribute('type', 'text')
  await expect(password).toHaveValue('synthetic-relay-password')
  await expect(password).toBeFocused()
  await expect(eye).toHaveAttribute('aria-pressed', 'true')
  await expect(eye).toHaveAttribute('title', 'Hide relay password')
  await eye.click()
  await expect(password).toHaveAttribute('type', 'password')
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
})
