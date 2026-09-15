import { test, expect } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, open } from './browser.js'

/**
 * Regression test for the fix in docs/decisions.md, 13 September 2026:
 * KithMoot's web client no longer hands out Google's public STUN server as
 * its ICE default.
 *
 * This drives the real built app (see app/src/ice-defaults.test.ts for a
 * unit test of the derivation logic on its own) and reads back the actual
 * `RTCConfiguration` every `RTCPeerConnection` in the page was constructed
 * with, via `getConfiguration()` - not a copy of what the app meant to
 * pass, the thing the browser's WebRTC stack actually got.
 *
 * Runs against the local build (playwright.config.ts's webServer: a local
 * `vite preview` and a local test relay), not the live deployment -
 * test/turn-relay.spec.ts is the one that needs a real `/turn` endpoint and
 * real infrastructure, and stays out of scope here. On `localhost` this
 * app's own origin-STUN guess also correctly resolves to nothing (see
 * `originStunGuess` in ice-defaults.ts, and the "for localhost development"
 * clause in its comment), so the meaningful assertion is simply that no
 * `RTCPeerConnection` anywhere in the page was ever handed a Google host -
 * not that it was handed some other concrete server instead.
 */
test('a default room hands its RTCPeerConnections no Google host', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')

    // At least one RTCPeerConnection must actually have been built on each
    // side - a pass because nothing was ever checked would not be a pass.
    for (const page of [pageA, pageB]) {
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length), {
          message: 'no RTCPeerConnection was ever constructed - nothing to assert',
          timeout: 60_000,
        })
        .toBeGreaterThan(0)
    }

    for (const [label, page] of [
      ['A', pageA],
      ['B', pageB],
    ] as const) {
      const iceServerUrls = await page.evaluate(() =>
        (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.flatMap((pc) =>
          (pc.getConfiguration().iceServers ?? []).flatMap((server) =>
            (Array.isArray(server.urls) ? server.urls : [server.urls]) as string[],
          ),
        ),
      )
      const googleUrls = iceServerUrls.filter((u) => u.toLowerCase().includes('google'))
      expect(googleUrls, `device ${label} was handed a Google ICE server: ${googleUrls.join(', ')} (full list: ${iceServerUrls.join(', ') || '(none)'})`).toEqual([])
    }
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('a production-style TURN response does not invent optional STUN/TLS', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  const turnCredential = {
    urls: [
      'turn:kithmoot.example:3478',
      'turn:kithmoot.example:3478?transport=tcp',
      'turns:kithmoot.example:5349',
    ],
    username: 'test-user',
    credential: 'test-password',
    ttl: 3600,
  }
  const answerTurn = (context: typeof contextA) => context.route('**/turn', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(turnCredential) }),
  )

  try {
    await Promise.all([answerTurn(contextA), answerTurn(contextB)])
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')

    for (const page of [pageA, pageB]) {
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length), {
          message: 'no RTCPeerConnection was ever constructed - nothing to assert',
          timeout: 60_000,
        })
        .toBeGreaterThan(0)
    }

    const iceServerUrls = await pageB.evaluate(() =>
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.flatMap((pc) =>
        (pc.getConfiguration().iceServers ?? []).flatMap((server) =>
          (Array.isArray(server.urls) ? server.urls : [server.urls]) as string[],
        ),
      ),
    )
    expect(iceServerUrls).toContain('stun:kithmoot.example:3478')
    expect(iceServerUrls.filter(url => url.toLowerCase().startsWith('stuns:'))).toEqual([])
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('a member can require credentialed relay-only ICE without querying STUN', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  const turnCredential = {
    urls: ['turn:kithmoot.example:3478', 'turns:kithmoot.example:5349'],
    username: 'time-bound-user',
    credential: 'time-bound-password',
    ttl: 3600,
  }
  const answerTurn = (context: typeof contextA) => context.route('**/turn', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(turnCredential) }),
  )

  try {
    await Promise.all([answerTurn(contextA), answerTurn(contextB)])
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')

    await open(pageB, url, 'Bob')
    await pageB.locator('#joinNetworkPrivacy > summary').click()
    await pageB.locator('#joinRelayOnly').check()
    await expect(pageB.locator('#joinNetworkPrivacy')).toContainText('TURN provider can still see')
    await pageB.locator('#join').click()
    await expect(pageB.locator('#roomArea')).toBeVisible()

    await expect.poll(() => pageB.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length), {
      message: 'the relay-only member made no peer connection', timeout: 60_000,
    }).toBeGreaterThan(0)

    const configurations = await pageB.evaluate(() =>
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.map(pc => {
        const config = pc.getConfiguration()
        return {
          policy: config.iceTransportPolicy,
          servers: (config.iceServers ?? []).map(server => ({
            urls: Array.isArray(server.urls) ? server.urls : [server.urls],
            username: server.username,
            credential: server.credential,
          })),
        }
      }),
    )
    for (const configuration of configurations) {
      expect(configuration.policy).toBe('relay')
      expect(configuration.servers).not.toHaveLength(0)
      expect(configuration.servers.every(server =>
        server.urls.every(url => url.toLowerCase().startsWith('turn')) &&
        server.username === turnCredential.username && server.credential === turnCredential.credential,
      )).toBe(true)
    }
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
