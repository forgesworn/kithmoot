import { openSettings, closeSettings } from './browser.js'
import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import { Relay, type Subscription } from 'nostr-tools/relay'
import { base64urlnopad } from '@scure/base'
import { witnessDaemon } from './mls-witness-daemon.js'

const binary = process.env.BOTHYD, relay = process.env.LAB_RELAY, control = process.env.BOX_CONTROL
test.skip(!binary || !relay || !control, 'Set BOTHYD, LAB_RELAY and BOX_CONTROL for the disposable bunker room lab.')

// Real NIP-46 messages and the installed Signet client, with a disposable
// fixture signer/provision peer. This is never physical Heartwood approval.
async function fixtureBunker() {
  const user = generateSecretKey(), bunker = generateSecretKey(), child = generateSecretKey()
  const methods = new Set<string>(), diagnostics = { events: 0, invalidSignatures: 0, invalidRequests: 0 }
  const pending = new Set<Promise<void>>()
  let connection: Relay | undefined, client: string | undefined, subscription: Subscription | undefined, closing = false
  async function close() {
    closing = true
    const failures: unknown[] = []
    try {
      try { subscription?.close() } catch (error) { failures.push(error) }
      while (pending.size) await Promise.allSettled([...pending])
      try { connection?.close() } catch (error) { failures.push(error) }
    } finally { user.fill(0); bunker.fill(0); child.fill(0) }
    if (failures.length) throw new AggregateError(failures, 'Fixture bunker cleanup failed')
  }
  try {
    connection = await Relay.connect('ws://127.0.0.1:7892')
    let subscribed!: () => void
    const subscriptionReady = new Promise<void>(resolve => { subscribed = resolve })
    async function respond(event: Parameters<typeof verifyEvent>[0]) {
      diagnostics.events++
      if (!verifyEvent(event)) { diagnostics.invalidSignatures++; return }
      const key = getConversationKey(bunker, event.pubkey)
      try {
        const request = JSON.parse(decrypt(event.content, key))
        if (typeof request.id !== 'string' || typeof request.method !== 'string' || !Array.isArray(request.params)) throw new Error('Invalid fixture request')
        let result: string | undefined, error: string | undefined
        try {
          if (request.method === 'connect') {
            if (request.params[0] !== getPublicKey(bunker) || request.params[1] !== '' || (client && client !== event.pubkey)) throw new Error('Fixture connection refused')
            client = event.pubkey; result = 'ack'
          } else {
            if (event.pubkey !== client) throw new Error('Fixture client refused')
            if (request.method === 'ping') result = 'pong'
            else if (request.method === 'get_public_key') result = getPublicKey(user)
            else if (request.method === 'sign_event') result = JSON.stringify(finalizeEvent(JSON.parse(request.params[0]), user))
            else if (request.method === 'nip44_encrypt' || request.method === 'nip44_decrypt') {
              const conversation = getConversationKey(user, request.params[0])
              try { result = request.method === 'nip44_encrypt' ? encrypt(request.params[1], conversation) : decrypt(request.params[1], conversation) }
              finally { conversation.fill(0) }
            }
            else if (request.method === 'heartwood_provision_rendezvous') {
              const [device, index, nonce, expires] = request.params
              if (device !== event.pubkey || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(expires) || base64urlnopad.decode(nonce).length !== 16) throw new Error('Invalid fixture provisioning request')
              const fields = { v: 1, p: getPublicKey(user), d: device, rz: getPublicKey(child), u: 'rendezvous', i: index, n: nonce, e: expires }
              const childKey = getConversationKey(child, device)
              try { result = JSON.stringify({ ...fields, c: encrypt(JSON.stringify({ ...fields, k: base64urlnopad.encode(child) }), childKey) }) }
              finally { childKey.fill(0) }
            } else if (request.method === 'switch_relays') result = 'null'
            else if (request.method === 'logout') result = 'ack'
            else throw new Error('Unsupported fixture method')
          }
          methods.add(request.method)
        } catch { diagnostics.invalidRequests++; error = 'Fixture request refused' }
        await connection!.publish(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', event.pubkey]], content: encrypt(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }), key) }, bunker))
      } catch { diagnostics.invalidRequests++ } finally { key.fill(0) }
    }
    subscription = connection.subscribe([{ kinds: [24133], '#p': [getPublicKey(bunker)] }], {
      oneose: subscribed,
      onevent: event => { if (closing) return; const work = respond(event); pending.add(work); void work.finally(() => pending.delete(work)) },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([subscriptionReady, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture subscription timed out')), 10_000) })]) }
    finally { clearTimeout(timer) }
    return { pubkey: getPublicKey(user), bunker: getPublicKey(bunker), methods, diagnostics, close }
  } catch (error) { await close(); throw error }
}

async function settings(page: Page) { await openSettings(page) }
async function openDetails(page: Page, id: string) {
  const details = page.locator(id)
  if (!await details.evaluate(e => (e as HTMLDetailsElement).open)) await details.locator('summary').first().click()
}
async function witnessSettings(page: Page) { await openSettings(page, 'Connections'); await page.locator('#mlsWitnessSettingsOpen').click() }
async function roomSettings(page: Page) { await openSettings(page, 'Connections'); await page.locator('#mlsRoomDevelopmentOpen').click(); await expect(page.locator('#mlsRoomDevelopment')).toBeVisible() }

test('fresh bunker login provisions its actual browser device and creates a witnessed room through full-app controls', async ({ context, page, baseURL }) => {
  test.setTimeout(360_000)
  const daemon = await witnessDaemon(binary!, relay!)
  const bunker = await fixtureBunker().catch(async error => { await daemon.cleanup(); throw error })
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const frames = { sockets: 0, sent: 0, received: 0, errors: 0 }
  page.on('websocket', socket => { frames.sockets++; socket.on('framesent', () => frames.sent++); socket.on('framereceived', () => frames.received++); socket.on('socketerror', () => frames.errors++) })
  try {
    await context.addInitScript(relayUrl => {
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const text = String(url), local = `wss://${location.host}`
          const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev', 'wss://relay.nostr.net']
          const target = defaults.includes(text.replace(/\/$/, '')) ? `${local}/__test-relay` : text
          if (!target.startsWith(local + '/') && target !== relayUrl) throw new Error('External relay blocked by lab')
          super(target, protocols)
        }
      }
    }, relay!)
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin ? route.continue() : route.abort())
    // The external fixture operator uses default Link WASM; no service is
    // injected into the app's private room owner or Signet account.
    const admin = (await build({ entryPoints: ['test/mls-room-bunker-operator.browser-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'FixtureOperator', define: { 'import.meta.env.BASE_URL': '"/j/"' } })).outputFiles[0].text
    await context.route('**/fixture-room-operator.js', route => route.fulfill({ contentType: 'text/javascript', body: admin }))
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await page.getByRole('button', { name: /Paste bunker URI/ }).click()
    const uri = `bunker://${bunker.bunker}?relay=${encodeURIComponent(new URL('/__test-relay', baseURL!).href.replace(/^https:/, 'wss:'))}`
    await page.evaluate(uri => {
      const input = document.getElementById('signet-login-bunker-input') as HTMLTextAreaElement
      input.value = uri
      // Registered after Signet's handler, which captures the URI synchronously.
      document.querySelector('#signet-login-dialog [data-action="connect"]')!.addEventListener('click', () => { input.value = '' }, { once: true })
    }, uri)
    await page.locator('#signet-login-dialog [data-action="connect"]').click()
    // The handler captures the URI synchronously; clear it before failure snapshots.
    await page.evaluate(() => { const input = document.getElementById('signet-login-bunker-input') as HTMLTextAreaElement | null; if (input) input.value = '' })
    await expect(page.locator('#signOut')).toHaveJSProperty('hidden', false, { timeout: 60_000 })
    expect(bunker.methods.has('get_public_key')).toBe(true)
    console.info('Bunker room lab: actual NIP-46 account attached')
    await witnessSettings(page)
    await page.locator('#mlsWitnessPrepare').click()
    const code = await daemon.pair()
    await page.evaluate(({ code, relay }) => { (document.getElementById('mlsWitnessCode') as HTMLInputElement).value = code; (document.getElementById('mlsWitnessRelays') as HTMLInputElement).value = relay; document.getElementById('mlsWitnessPair')!.click() }, { code, relay: relay! })
    await expect(page.locator('#mlsWitnessGenesis')).toBeEnabled({ timeout: 60_000 }); await page.locator('#mlsWitnessGenesis').click()
    await expect(page.locator('#mlsWitnessCheck')).toBeEnabled(); await daemon.enrol(await page.locator('#mlsWitnessCommand').inputValue())
    await page.locator('#mlsWitnessVaultRead').click(); await expect(page.locator('#mlsWitnessDeviceNew')).toBeEnabled({ timeout: 60_000 })
    await page.locator('#mlsWitnessDeviceNew').click(); await page.locator('#actionConfirm').click()
    await expect(page.locator('#mlsWitnessDevice')).toContainText('Credential:', { timeout: 60_000 })
    console.info('Bunker room lab: device enrolled through full-app controls')
    const enrolled = await page.locator('#mlsWitnessDevice').textContent(), device = enrolled!.match(/Device:\s*([0-9a-f]{64})/)?.[1]
    expect(device).toBeDefined()
    await page.locator('#mlsWitnessClose').click()
    await openSettings(page, 'Account'); await openDetails(page, '#accountMore'); await openDetails(page, '#rendezvousProvision')
    await page.locator('#rendezvousIndex').fill('1'); await page.locator('#provisionRendezvous').click()
    await expect(page.locator('#rendezvousStatus')).toContainText('This browser now holds rendezvous child 1', { timeout: 60_000 })
    expect(bunker.methods.has('heartwood_provision_rendezvous')).toBe(true)
    console.info('Bunker room lab: provisioned through actual NIP-46 browser key')
    await closeSettings(page)
    const read = await fetch(control! + '/ready'); expect(read.ok).toBe(true); const ready = await read.json()
    const post = async () => { const response = await fetch(control! + '/pairing', { method: 'POST' }); if (!response.ok) throw new Error('Disposable box pairing refused'); return (await response.json()).uri as string }
    await page.addScriptTag({ url: new URL('fixture-room-operator.js', baseURL!).href })
    // Malformed pairing must refuse before a Link engine or grant is created.
    expect(await page.evaluate(({ relay, node, persona, device }) => (window as any).FixtureOperator.install('invalid pairing', relay, node, persona, device).then(() => false, () => true), { relay: relay!, node: ready.link_node_id, persona: bunker.pubkey, device })).toBe(true)
    const operatorCode = await post()
    expect(await page.evaluate(({ uri, relay, node, persona, device }) => (window as any).FixtureOperator.install(uri, relay, node, persona, device), { uri: operatorCode, relay: relay!, node: ready.link_node_id, persona: bunker.pubkey, device })).toBe(true)
    await roomSettings(page)
    const roomCode = await post()
    await page.evaluate(({ uri, relay }) => { const panel = document.getElementById('mlsRoomDevelopment')!; panel.querySelector<HTMLInputElement>('[data-code]')!.value = uri; panel.querySelector<HTMLInputElement>('[data-relays]')!.value = relay; panel.querySelector<HTMLButtonElement>('[data-pair]')!.click(); panel.querySelector<HTMLInputElement>('[data-code]')!.value = '' }, { uri: roomCode, relay: relay! })
    await expect(page.locator('#mlsRoomDevelopment [data-status]')).toContainText('Room connection paired', { timeout: 60_000 })
    await page.locator('#mlsRoomDevelopment [data-routes]').click()
    await expect(page.locator('#mlsRoomDevelopment [data-status]')).toHaveText('1 saved room route(s).', { timeout: 60_000 })
    await expect(page.locator('#mlsRoomDevelopment [data-create-route] option')).toHaveCount(1, { timeout: 60_000 })
    await page.locator('#mlsRoomDevelopment [data-create-name]').fill('Disposable bunker room'); await page.locator('#mlsRoomDevelopment [data-create-days]').fill('1')
    await page.locator('#mlsRoomDevelopment [data-create]').click()
    await page.locator('#mlsRoomConsent [data-approve]').click({ timeout: 60_000 })
    await page.locator('#mlsRoomConsent [data-approve]').click({ timeout: 60_000 })
    await expect(page.locator('#mlsRoomDevelopment [data-status]')).toContainText('saved locally with its witness and installation confirmed', { timeout: 60_000 })
    console.info('Bunker room lab: local witnessed creation accepted after real cleanup')
    await page.locator('#mlsRoomDevelopment [data-rooms]').click()
    await expect(page.locator('#mlsRoomDevelopment [data-status]')).toContainText('Saved rooms checked with the current witness', { timeout: 60_000 })
    await expect(page.locator('#mlsRoomDevelopment [data-manual-room] option')).toHaveCount(1, { timeout: 60_000 })
    await page.locator('#mlsRoomDevelopment [data-manual]').click()
    await expect(page.locator('#mlsRoomDevelopment [data-status]')).toContainText('0 witnessed outbox record(s) resolved', { timeout: 60_000 })
    expect(errors).toEqual([])
    await page.locator('#mlsRoomDevelopment [data-close]').click(); await openSettings(page, 'Account'); await page.locator('#signOut').click()
    await expect(page.locator('#status')).toContainText("Signed out. This forgets this browser's connection to your signer", { timeout: 60_000 })
    await expect(page.locator('#signIn')).toBeVisible()
    expect(await page.evaluate(() => ['signet:login.bunkerUri', 'signet:login.bunkerClientSk'].filter(key => localStorage.getItem(key) !== null))).toEqual([])
    console.info(JSON.stringify({ acceptedBunkerMethods: [...bunker.methods].sort(), diagnostics: bunker.diagnostics }))
    for (const method of ['connect', 'get_public_key', 'sign_event', 'heartwood_provision_rendezvous']) expect(bunker.methods.has(method)).toBe(true)
    expect(bunker.diagnostics.invalidRequests).toBe(0)
    expect(bunker.diagnostics.invalidSignatures).toBe(0)
  } catch (error) {
    const status = await page.locator('#status').textContent().catch(() => '')
    console.info(JSON.stringify({ fixtureBunkerMethods: [...bunker.methods].sort(), diagnostics: bunker.diagnostics, frames, status: status?.replace(/(?:bunker|bothy):[^\s]+/g, '[fixture capability]').replace(/[0-9a-f]{64}/g, '[fixture key]') }))
    throw error
  } finally {
    const cleanup = await Promise.allSettled([context.close(), bunker.close(), daemon.cleanup()])
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)
    if (failures.length) throw new AggregateError(failures, 'Disposable bunker room cleanup failed')
  }
})
