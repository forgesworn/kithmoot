/** Reduce browser stats before they reach the UI: never expose remote IPs,
 * SDP, TURN credentials or the room URL through this panel. */
export function metadataConnection(state: string, stats: Record<string, unknown>[]): {
  call: { state: string; route: string; sent: number; received: number }; addresses: string[]
} {
  const transport = stats.find(s => s.type === 'transport' && s.selectedCandidatePairId)
  const pair = stats.find(s => s.type === 'candidate-pair' && (transport ? s.id === transport.selectedCandidatePairId : s.selected === true))
  const local = pair && stats.find(s => s.id === pair.localCandidateId)
  const remote = pair && stats.find(s => s.id === pair.remoteCandidateId)
  const viaRelay = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const addresses = [...new Set(stats.filter(s => s.type === 'local-candidate' && (s.candidateType === 'srflx' || s.candidateType === 'prflx'))
    .map(s => s.address ?? s.ip).filter((value): value is string => typeof value === 'string' && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value))) ]
  const protocol = typeof local?.protocol === 'string' && /^(udp|tcp)$/i.test(local.protocol) ? ` over ${local.protocol.toUpperCase()}` : ''
  return { call: { state, route: pair ? `${viaRelay ? 'TURN relay' : 'Direct ICE connection'}${protocol}` : 'Selected route unavailable', sent: count(transport?.bytesSent ?? pair?.bytesSent), received: count(transport?.bytesReceived ?? pair?.bytesReceived) }, addresses }
}
