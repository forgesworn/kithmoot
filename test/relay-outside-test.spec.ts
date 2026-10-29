import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { createRoom, join, open, newDeviceContext } from './browser.js'

/**
 * The relay outside test (docs/protocol.md, "Relay outside test"): a member
 * runs the built-in call relay (`spry-node supervised`) and, with no call
 * running, asks another member to test it. The member's app redeems the
 * host's offer over the encrypted `spry:` control channel, runs its two
 * temporary peers (one relay-only on the relay, one with the relay's listener
 * as its STUN server), and sends the verdict back through encrypted
 * signalling to the host's device alone.
 *
 * Everything is on loopback (test/spry-supervised-fixture.mjs), so the
 * tester's address is the relay's own and the honest answer is "from the
 * host's own network": the relay refuses a peer on its own address, so the
 * test fails `inbound` with `sameNetwork`. That proves the mechanism end to
 * end, never outside reachability, and no pass is possible here. The
 * host's trigger is a hook that only the acceptance build
 * (VITE_E2E_RELAY_OUTSIDE_TEST) has; no screen offers it yet.
 */

const FIXTURE = `http://127.0.0.1:${process.env.E2E_SPRY_FIXTURE_PORT ?? 7799}`
const CONTROL_HOST = 'control.example'
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']
const HOST_PARTICIPANT_SECRET = bytesToHex(new Uint8Array(32).fill(41))
const HOST_PARTICIPANT = getPublicKey(hexToBytes(HOST_PARTICIPANT_SECRET))
const GUEST_PARTICIPANT_SECRET = bytesToHex(new Uint8Array(32).fill(42))
const GUEST_PARTICIPANT = getPublicKey(hexToBytes(GUEST_PARTICIPANT_SECRET))
const PAIRING_SECRET = process.env.E2E_SPRY_PAIRING_SECRET ?? ''
const STUN_URL = /^stun:127\.0\.0\.1:\d{4,5}$/
const TURN_URL = /^turn:127\.0\.0\.1:\d{4,5}\?transport=(udp|tcp)$/

interface Device { context: BrowserContext; page: Page; denied: string[]; control: string[] }

async function device(browser: Browser, baseURL: string, { participant, host }: { participant: string; host?: { endpoint: string; id: string } }): Promise<Device> {
  const context = await newDeviceContext(browser, baseURL, { viewport: { width: 1280, height: 800 } })
  const denied: string[] = [], control: string[] = []
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!LOOPBACK.includes(url.hostname)) { denied.push(url.origin); return route.abort('blockedbyclient') }
    return route.continue()
  })
  await context.routeWebSocket(/.*/, socket => {
    const { hostname, origin } = new URL(socket.url())
    if (hostname === CONTROL_HOST) { control.push(origin); socket.connectToServer(); return }
    if (!LOOPBACK.includes(hostname)) { denied.push(origin); socket.close(); return }
    socket.connectToServer()
  })
  await context.addInitScript(({ pairing, participant, pairingSecret, hostParticipant }) => {
    localStorage.setItem('kithmoot.profiles.enabled', 'false')
    localStorage.setItem('kithmoot.participant', participant)
    if (pairing) localStorage.setItem('kithmoot.spry-pairing.v1', JSON.stringify({ v: 1, endpoint: pairing.endpoint, id: pairing.id, secretKey: pairingSecret, participant: hostParticipant }))
  }, { pairing: host, participant, pairingSecret: PAIRING_SECRET, hostParticipant: HOST_PARTICIPANT })
  const page = await context.newPage()
  return { context, page, denied, control }
}

const pairing = async (request: APIRequestContext) => (await request.get(`${FIXTURE}/fixture/pairing`)).json() as Promise<{ endpoint: string; id: string }>

interface Outcome { answered: boolean; device?: string; participant?: string; at?: number; ok?: boolean; stage?: string; sameNetwork?: boolean; finding?: string }
const ask = (page: Page, participant: string) => page.evaluate(p =>
  (window as unknown as { __kithmootRelayOutsideTest: (participant: string) => Promise<unknown> }).__kithmootRelayOutsideTest(p), participant) as Promise<Outcome>

test('a host asks a member to test its built-in relay from outside, and hears the verdict alone', async ({ browser, baseURL, request }) => {
  const host = await device(browser, baseURL!, { participant: HOST_PARTICIPANT_SECRET, host: await pairing(request) })
  const guest = await device(browser, baseURL!, { participant: GUEST_PARTICIPANT_SECRET })
  try {
    const link = await createRoom(host.page, baseURL!, undefined, 'Ada')
    await open(guest.page, link, 'Rowan')
    await join(guest.page)
    // The guest holds the host's offer once the host's descriptor reaches it.
    await expect.poll(() => guest.page.evaluate(() => localStorage.getItem('kithmoot.spry-rooms.v1') ?? ''), { timeout: 60_000 }).toContain('spry://')
    expect(guest.control, 'no call and no test yet: the guest has not contacted the relay').toEqual([])
    const before = await guest.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length)

    // The host's app registers the guest's key a moment after it joins; a
    // login refused before then is said as such, and asked again.
    let outcome: Outcome = { answered: false }
    for (let attempt = 0; attempt < 4; attempt++) {
      outcome = await ask(host.page, GUEST_PARTICIPANT)
      if (outcome.answered && outcome.stage !== 'credentials') break
      await host.page.waitForTimeout(3000)
    }
    // Peer A got a relayed address (the stage is past `allocate`); peer B's
    // address is the relay's own, which a node with mapped ports refuses as a
    // peer, exactly as it would refuse a tester behind the host's own router.
    expect(outcome).toEqual({ answered: true, device: expect.stringMatching(/^[0-9a-f]{64}$/), participant: GUEST_PARTICIPANT,
      at: expect.any(Number), ok: false, stage: 'inbound', sameNetwork: true, finding: 'same-network' })
    expect(guest.control.length, 'the tester redeemed the host\'s offer over control').toBeGreaterThan(0)

    // The tester's two temporary peers: A relay-only on the node, B with the
    // node's listener as its only STUN server and no TURN. Both closed.
    const peers = await guest.page.evaluate(from => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.slice(from).map(pc => ({
      state: pc.connectionState, policy: pc.getConfiguration().iceTransportPolicy ?? 'all',
      urls: (pc.getConfiguration().iceServers ?? []).flatMap(server => [server.urls].flat()),
    })), before)
    expect(peers).toHaveLength(2)
    expect(peers.every(peer => peer.state === 'closed'), 'temporary peers closed').toBe(true)
    expect(peers[0]!.policy).toBe('relay')
    for (const url of peers[0]!.urls) expect(url).toMatch(TURN_URL)
    expect(peers[1]!.policy).toBe('all')
    expect(peers[1]!.urls).toEqual([expect.stringMatching(STUN_URL)])

    // Asked again at once: declined, and nothing runs.
    const again = await ask(host.page, GUEST_PARTICIPANT)
    expect(again).toMatchObject({ answered: true, ok: false, stage: 'declined', finding: 'not-run' })
    expect(await guest.page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length)).toBe(before + 2)

    // A member who shares no relay has nothing to ask about.
    await expect(ask(guest.page, HOST_PARTICIPANT)).rejects.toThrow(/not sharing its own built-in call relay/)
    expect([...host.denied, ...guest.denied]).toEqual([])

    const stats = await (await request.get(`${FIXTURE}/fixture/stats`)).json()
    await test.info().attach('relay-outside-test', { contentType: 'application/json', body: JSON.stringify({
      result: { ok: outcome.ok, stage: outcome.stage, sameNetwork: outcome.sameNetwork, finding: outcome.finding }, again: again.stage,
      testerPeers: peers.map(peer => ({ policy: peer.policy, schemes: peer.urls.map(url => url.split(':')[0]) })),
      nodeUrls: stats.urls, nodeBinarySha256: stats.nodeBinarySha256, externalRequests: [...host.denied, ...guest.denied],
      loopbackOnly: true, separateNetworks: false, outsideReachabilityProven: false, physicalDevices: false,
    }, null, 2) })
  } finally { await Promise.all([host, guest].map(d => d.context.close())) }
})
