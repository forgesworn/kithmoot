/**
 * Per-member ICE privacy, kept separate from a room's shared ICE hints.
 *
 * The room author can name servers, but deciding whether this browser may
 * reveal its host or server-reflexive address is the person using this device's
 * choice. With `iceTransportPolicy: 'relay'` the browser gathers relay
 * candidates only. We also remove STUN URLs rather than merely relying on the
 * policy: the selected TURN service should be the only ICE infrastructure
 * this mode contacts.
 */

export const RELAY_ONLY_NO_RELAY = 'This room has no usable TURN relay. Turn off “Hide my IP address on calls” to join the call.'

/** Whether relay-only mode has a relay to use. When false the room can still
 *  be joined for chat, but a call must be refused, never made direct. */
export function relayOnlyAvailable(servers: readonly RTCIceServer[]): boolean {
  try { relayOnlyIceConfiguration(servers); return true } catch { return false }
}

function urlsOf(server: RTCIceServer): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls]
}

function isTurn(url: string): boolean {
  return url.toLowerCase().startsWith('turn:') || url.toLowerCase().startsWith('turns:')
}

/**
 * Produce the only configuration allowed when someone asks to hide their IP
 * from other call members. A bare TURN URL cannot allocate a relay and must
 * not turn this into a direct call, so it is rejected before any peer is
 * created.
 */
export function relayOnlyIceConfiguration(servers: readonly RTCIceServer[]): RTCConfiguration {
  const relayServers = servers.flatMap((server) => {
    const urls = urlsOf(server).filter(isTurn)
    if (urls.length === 0 || typeof server.username !== 'string' || !server.username || typeof server.credential !== 'string' || !server.credential) return []
    return [{ ...server, urls }]
  })
  if (relayServers.length === 0) throw new Error(RELAY_ONLY_NO_RELAY)
  return { iceServers: relayServers, iceTransportPolicy: 'relay' }
}
