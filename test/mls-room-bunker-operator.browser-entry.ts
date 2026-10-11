import { sha256 } from '@noble/hashes/sha2.js'
import { finalizeEvent } from 'nostr-tools/pure'
// In-page fixture operator outside the private owner: real Link and NIP-42,
// never a client/route/receipt/readiness object supplied to application services.
import { startBrowserLink } from '../app/src/browser-link-runtime.js'
import { readLinkPairing } from '../app/src/browser-link-pairing.js'
import { mlsGrantScope } from '../app/src/mls-grant-ledger.js'
export async function install(uri: string, relay: string, node: string, persona: string, device: string) {
  const master = sha256(new TextEncoder().encode('kithmoot-g5-fixture-signer-v2:alice'))
  let seed: Uint8Array | undefined, pairing: ReturnType<typeof readLinkPairing> | undefined
  let engine: Awaited<ReturnType<typeof startBrowserLink>> | undefined
  let socket: Awaited<ReturnType<NonNullable<typeof engine>['openSocket']>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false
  const retries = new Set<ReturnType<typeof setTimeout>>()
  try {
    seed = crypto.getRandomValues(new Uint8Array(32)); pairing = readLinkPairing(uri)
    const server = `ws://${node}/events`, now = Math.floor(Date.now() / 1000)
    const grant = finalizeEvent({ kind: 24242, created_at: now, content: '', tags: [
      ['t', 'event-grant'], ['server', server], ['d', mlsGrantScope(device)], ['p', persona],
      ['device', device], ['grant', Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')], ['read', '1460'], ['expiration', String(now + 3600)],
      ['vmls', '67108864'], ['status', 'active'],
    ] }, master)
    engine = await startBrowserLink({ transportSeed: seed, relayUrls: [relay], routes: [] })
    const queued: string[] = []
    const send = (value: unknown) => { if (closed) return; const text = JSON.stringify(value); if (socket) socket.sendText(text); else queued.push(text) }
    let done!: () => void, fail!: (error: Error) => void
    const installed = new Promise<void>((resolve, reject) => { done = resolve; fail = reject })
    // The callback can reject before openSocket resolves and the await begins.
    void installed.catch(() => {})
    const route = await engine.pairRoute(pairing)
    socket = await engine.openSocket(server, route.routeId, { onText: text => {
      const frame = JSON.parse(text)
      if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
        const event = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', server], ['challenge', frame[1]]] }, master)
        send(['AUTH', event])
      }
      if (frame[0] === 'OK' && frame[2] === true && frame[1] !== grant.id) send(['EVENT', grant])
      if (frame[0] === 'OK' && frame[1] === grant.id) {
        if (frame[2] === true) done()
        else if (String(frame[3]).includes('pending')) {
          const retry = setTimeout(() => { retries.delete(retry); send(['EVENT', grant]) }, 200); retries.add(retry)
        } else fail(new Error('Lab operator grant refused: ' + String(frame[3]).replace(/(?:bunker|bothy):[^\s]+/g, '[capability]').replace(/[0-9a-f]{32,}/g, '[identifier]').slice(0, 160)))
      }
    }, onClosed: () => fail(new Error('Lab operator relay closed')) })
    for (const text of queued) socket.sendText(text)
    timer = setTimeout(() => fail(new Error('Lab operator grant timed out')), 30_000)
    await installed
    return true
  } finally {
    closed = true; clearTimeout(timer); for (const retry of retries) clearTimeout(retry)
    const cleanup = await Promise.allSettled([Promise.resolve().then(() => socket?.disconnect()), Promise.resolve().then(() => engine?.stop())])
    pairing?.pairingSecret.fill(0); seed?.fill(0); master.fill(0)
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)
    if (failures.length) throw new AggregateError(failures, 'Fixture operator cleanup failed')
  }
}
