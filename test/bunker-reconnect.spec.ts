import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import { Relay } from 'nostr-tools/relay'
import { bytesToHex } from 'nostr-tools/utils'
import { TEST_RELAY_WS } from './relays.js'

/**
 * A bunker that was asleep when KithMoot opened, and wakes up later.
 *
 * On 5 October 2026 a signer went quiet overnight. KithMoot asked for the
 * account to be reconnected, but Reconnect opened the sign-in picker, which
 * pairs a new signer rather than asking the stored one again: rebooting the
 * signer changed nothing, and only restarting KithMoot (which restores the
 * stored bunker on load) brought the account back. Reconnect, and coming
 * back online, now ask the stored bunker again in place.
 */

/** A NIP-46 bunker on the test relay that answers only while awake. */
async function fakeBunker(user: Uint8Array) {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const relay = await Relay.connect(TEST_RELAY_WS)
  const state = { awake: false, requests: 0 }
  relay.subscribe([{ kinds: [24133], '#p': [pubkey], since: Math.floor(Date.now() / 1000) - 5 }], {
    onevent: async (event: NostrEvent) => {
      state.requests++
      if (!state.awake) return
      const key = getConversationKey(secret, event.pubkey)
      const request = JSON.parse(decrypt(event.content, key)) as { id: string; method: string; params: string[] }
      const answer = (result: string) => ({ id: request.id, result })
      const reply = request.method === 'connect' ? answer('ack')
        : request.method === 'get_public_key' ? answer(getPublicKey(user))
        : request.method === 'sign_event' ? answer(JSON.stringify(finalizeEvent(JSON.parse(request.params[0]!), user)))
        : request.method === 'ping' ? answer('pong')
        : { id: request.id, result: '', error: `${request.method} is not supported here` }
      await relay.publish(finalizeEvent({
        kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', event.pubkey]],
        content: encrypt(JSON.stringify(reply), key),
      }, secret))
    },
  })
  return { pubkey, state, close: () => relay.close() }
}

/** A browser that signed in with that bunker on an earlier visit. */
async function device(browser: Browser, baseURL: string, user: Uint8Array, bunker: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const pubkey = getPublicKey(user)
  const authEvent = finalizeEvent({ kind: 21236, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' }, user)
  await context.addInitScript(({ relay, pubkey, bunker, client, authEvent }) => {
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by acceptance test')
        super(defaults.includes(String(url).replace(/\/$/, '')) ? relay : url, protocols)
      }
    }
    // signet-login's stored session (its STORAGE_KEYS), as a bunker sign-in
    // leaves it: seeded once, so what the page does to it afterwards stands.
    if (localStorage.getItem('test.seeded')) return
    localStorage.setItem('test.seeded', '1')
    localStorage.setItem('signet:login.pubkey', pubkey)
    localStorage.setItem('signet:login.method', 'bunker')
    localStorage.setItem('signet:login.authEvent', authEvent)
    localStorage.setItem('signet:login.bunkerUri', `bunker://${bunker}?relay=${encodeURIComponent(relay)}`)
    localStorage.setItem('signet:login.bunkerClientSk', client)
    localStorage.setItem('kithmoot.last-nostr-account', pubkey)
    localStorage.setItem('kithmoot.last-nostr-method', 'bunker')
  }, { relay: relay.href, pubkey, bunker, client: bytesToHex(generateSecretKey()), authEvent: JSON.stringify(authEvent) })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

test('Reconnect asks the stored bunker again rather than pairing a new signer', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const user = generateSecretKey()
  const bunker = await fakeBunker(user)
  const context = await device(browser, baseURL!, user, bunker.pubkey)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    // The restore on load times out against a sleeping bunker.
    await expect(page.locator('#accountReconnect')).toBeVisible({ timeout: 45_000 })
    expect(bunker.state.requests).toBeGreaterThan(0)

    bunker.state.awake = true
    await page.locator('#accountReconnectButton').click()
    await expect(page.locator('#accountReconnect')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /Browser extension/ })).toHaveCount(0)
    await expect(page.locator('#status')).toContainText('Reconnected to your signer')
  } finally {
    await context.close()
    bunker.close()
  }
})

test('coming back online reconnects a stored bunker without being asked', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const user = generateSecretKey()
  const bunker = await fakeBunker(user)
  const context = await device(browser, baseURL!, user, bunker.pubkey)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.locator('#accountReconnect')).toBeVisible({ timeout: 45_000 })

    bunker.state.awake = true
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.locator('#accountReconnect')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /Browser extension/ })).toHaveCount(0)
  } finally {
    await context.close()
    bunker.close()
  }
})
