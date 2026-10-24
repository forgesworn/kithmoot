import type { RealtimePeer, SwarmSession, TransportRuntime } from '../src/realtime/runtime.js'
import type { ServiceIce } from '../src/realtime/service.js'
import { REALTIME_PACKET_LIFETIME_MS } from '../src/realtime/service.js'

const PUBKEY = /^[0-9a-f]{64}$/
const COUNTERS = ['sent', 'received', 'sentBytes', 'receivedBytes', 'backpressureDrops',
  'receiveDrops', 'deadlineDrops', 'closedDrops', 'receivePending'] as const

/** Test-only full-mesh baseline. Every endpoint uses the same encrypted frame
 * adapter and unreliable RelaySwarm transport as the forwarding comparison;
 * only topology changes. No keys, SDP, addresses or payloads enter snapshots.
 *
 * Await creation on every page before calling start() on all pages together.
 * Creation starts responder listeners but never waits for connections, so
 * no initiator can race a responder which has not yet been constructed.
 */
export async function createMeshTransport(options: {
  runtime: TransportRuntime
  session: SwarmSession
  remotePubkeys: string[]
  ice: ServiceIce
  onDatagram: (bytes: Uint8Array) => void
}) {
  const { runtime, session, remotePubkeys, ice, onDatagram } = options
  if (!PUBKEY.test(session.pubkey) || remotePubkeys.length < 1 || remotePubkeys.length > 15
    || new Set(remotePubkeys).size !== remotePubkeys.length
    || remotePubkeys.some(pubkey => !PUBKEY.test(pubkey) || pubkey === session.pubkey)
    || ice.iceTransportPolicy !== 'all' || ice.iceServers.length !== 0) throw new Error('Invalid explicit direct-ICE mesh baseline')

  const requests = await Promise.all(remotePubkeys.map(async pubkey => {
    const pair = [session.pubkey, pubkey].sort()
    const message = new TextEncoder().encode(`kithmoot/realtime/mesh-baseline/v1/${pair[0]}/${pair[1]}`)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message))
    return { pubkey, id: Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') }
  }))
  const peers: { peer: RealtimePeer; initiator: boolean }[] = []
  let closed = false
  let starting: Promise<void> | null = null
  const close = () => {
    if (closed) return
    closed = true
    for (const { peer } of peers) peer.close()
  }
  try {
    for (const { pubkey, id } of requests) {
      const initiator = session.pubkey < pubkey
      const peer = new runtime.RealtimePeer({ session, peerPubkey: pubkey, initiator,
        requestId: id, iceServers: [], iceTransportPolicy: 'all', maxPacketLifeTimeMs: REALTIME_PACKET_LIFETIME_MS,
        ...(ice.RTCPeerConnectionImpl ? { RTCPeerConnectionImpl: ice.RTCPeerConnectionImpl } : {}), onDatagram })
      peers.push({ peer, initiator })
      // Native setup errors are observed now; eventual readiness/rejection is
      // observed by start(). No detached derived promise is left unhandled.
      if (!initiator) void peer.start().catch(() => {})
    }
  } catch {
    close(); throw new Error('Mesh baseline preparation failed')
  }
  return {
    start(): Promise<void> {
      if (starting) return starting
      if (closed) return Promise.reject(new Error('Mesh baseline closed'))
      starting = Promise.all(peers.map(({ peer }) => peer.start())).then(() => {
        if (closed) throw new Error('Mesh baseline closed')
      }).catch(() => { close(); throw new Error('Mesh baseline connection failed') })
      return starting
    },
    send(bytes: Uint8Array, sendOptions?: { deadlineMs?: number }): boolean {
      if (closed) return false
      let sent = true
      // Do not short-circuit: a congested neighbour must not starve others.
      for (const { peer } of peers) if (!peer.send(bytes, sendOptions)) sent = false
      return sent
    },
    close,
    snapshot() {
      const snapshots = peers.map(({ peer }) => peer.snapshot())
      const totals = Object.fromEntries(COUNTERS.map(key => [key, snapshots.reduce((sum, row) => {
        const value = row[key]
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? Math.min(Number.MAX_SAFE_INTEGER, sum + value) : sum
      }, 0)])) as Record<typeof COUNTERS[number], number>
      return { ...totals, peerCount: peers.length, closed,
        delivery: snapshots.every(row => row.delivery === 'finite-lifetime') ? 'finite-lifetime' : 'other',
        maxPacketLifeTimeMs: snapshots.every(row => row.maxPacketLifeTimeMs === REALTIME_PACKET_LIFETIME_MS) ? REALTIME_PACKET_LIFETIME_MS : null,
        ready: !closed && snapshots.every(row => row.ready === true && row.closed !== true) }
    },
  }
}
