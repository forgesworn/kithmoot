import { addressHost } from './call-path-words.js'

type Stat = Record<string, unknown>

/** Only an observed selection counts. A nominated backup is not the route. */
export function selectedCallPair(stats: readonly Stat[]): Stat | undefined {
  const transports = stats.filter(s => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string')
  const selected = stats.filter(s => s.type === 'candidate-pair' && (transports.length
    ? transports.some(t => t.selectedCandidatePairId === s.id) : s.selected === true))
  // BUNDLE uses one pair. Multiple distinct transports cannot honestly be
  // summarised as one route, so keep this unknown rather than choose one.
  return selected.length === 1 ? selected[0] : undefined
}

/** Relay server names only; never peer addresses, credentials or URL queries. */
function relayHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^turns?:(?:\/\/)?(?:\[[a-f0-9:]+\]|[a-z0-9._-]+)(?::\d+)?(?:\?[^\s]*)?$/i.test(value)) return undefined
  const host = addressHost(value)
  return host && host.length <= 253 && /^[a-z0-9.:_-]+$/i.test(host) ? host : undefined
}

const count = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const protocol = (v: unknown): string | undefined => typeof v === 'string' && /^(udp|tcp|tls)$/i.test(v) ? v.toUpperCase() : undefined

/** Read-only, local observation. Configured ICE servers never imply use. */
export function observedCallConnection(state: string, stats: readonly Stat[], context: { via?: string; nodeHost?: string } = {}): {
  state: string; route: string; traffic: string; video: string
} {
  const pair = selectedCallPair(stats)
  const local = pair && stats.find(s => s.type === 'local-candidate' && s.id === pair.localCandidateId)
  const remote = pair && stats.find(s => s.type === 'remote-candidate' && s.id === pair.remoteCandidateId)
  let route = 'Selected media route unavailable'
  if (pair && local?.candidateType && remote?.candidateType) {
    if (local.candidateType === 'relay' || remote.candidateType === 'relay') {
      const host = local.candidateType === 'relay' ? relayHost(local.url) : undefined
      route = host ? `${host === context.nodeHost ? 'Room node TURN relay' : 'TURN relay'} · ${host}`
        : 'Through a TURN relay · server name unavailable'
      const transport = local.candidateType === 'relay' ? protocol(local.relayProtocol) : undefined
      if (transport) route += ` · this device to relay: ${transport}`
      if (remote.candidateType === 'relay') route += ' · the other end also uses a relay'
    } else {
      route = `Direct to ${context.via ? context.via : 'the other device'}`
      const transport = protocol(local.protocol)
      if (transport) route += ` · ${transport}`
    }
    if (context.via && (local.candidateType === 'relay' || remote.candidateType === 'relay')) route += ` · endpoint: ${context.via}`
    if (state !== 'connected') route = `Last selected: ${route}`
  }
  const rtt = typeof pair?.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime) && pair.currentRoundTripTime >= 0
    ? ` · round trip ${Math.round(pair.currentRoundTripTime * 1000)} ms` : ''
  const videos = stats.filter(s => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video' && !s.isRemote)
  return {
    state, route,
    traffic: pair ? `Sent ${count(pair.bytesSent)} bytes · received ${count(pair.bytesReceived)} bytes${rtt}` : 'Traffic measurements unavailable',
    video: videos.length ? `Received video: ${videos.reduce((n, s) => n + count(s.framesDecoded), 0)} frames decoded · ${videos.reduce((n, s) => n + count(s.packetsLost), 0)} packets lost` : 'No inbound video measurements',
  }
}
