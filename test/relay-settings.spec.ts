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
import { verifyEventUncached } from '../src/verify.js'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'

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
    const open = async () => { await page.locator('#roomMenu').click(); await page.locator('#roomRelaySettings').click() }
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
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/sheltered/)
    await page.reload(); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#laneNote .chip.lane')).toHaveText(/sheltered/)
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
    await page.reload(); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await open()
    await expect(readRow.locator('select')).toHaveValue('read')
    const beforeRemove = closedReads
    await readRow.getByRole('button', { name: `Remove ${readRelay}`, exact: true }).click()
    await page.locator('#relaySave').click()
    await expect(page.locator('#relayList .relayRow')).toHaveCount(1)
    await expect.poll(() => closedReads).toBeGreaterThan(beforeRemove)
    await page.reload(); await page.locator('#join').click(); await open()
    await expect(page.locator('#relayList .relayRow')).toHaveCount(1)
    await page.locator('#relayScope').selectOption('default')
    while (await page.locator('#relayList .relayRow').count()) await page.locator('#relayList .relayRow button').first().click()
    for (const [url, mode] of [[relay.href, 'both'], [readRelay, 'read']]) {
      await page.locator('#relayUrl').fill(url!)
      await page.locator('#relayMode').selectOption(mode!)
      await page.getByRole('button', { name: 'Add relay', exact: true }).click()
    }
    await page.locator('#relaySave').click()
    await expect(page.locator('#relaySettingsStatus')).toContainText('Saved on this device')
    await page.goto(baseURL!)
    await page.locator('#roomName').fill('Default relay fixture')
    await page.locator('#create').click()
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await open(); await expect(readRow.locator('select')).toHaveValue('read')
    await page.reload(); await page.locator('#join').click(); await open()
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
    await expect(page.locator('#signOut')).toBeVisible()
    expect(signed.filter(event => event.kind === 22242)).toHaveLength(0)
    await page.locator('#roomSettings > summary').click()
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
    await page.locator('#signOut').click()
    await expect(page.locator('#signOut')).toBeHidden()
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
