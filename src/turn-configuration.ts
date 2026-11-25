/** Older WebKit rejects explicit TURN transports. Keep the same UDP and TLS
 * endpoints using their default transport, and omit unsupported plain TCP. */
export function compatibleTurnConfiguration(config: RTCConfiguration, error: unknown): RTCConfiguration {
  if (!error || typeof error !== 'object' || !('name' in error) ||
      !['SyntaxError', 'NotSupportedError'].includes(String(error.name))) throw error
  const servers = config.iceServers ?? []
  const original = servers.flatMap(server => [server.urls].flat())
  const iceServers = servers.map(server => ({
    ...server,
    urls: [server.urls].flat()
      .filter(url => !/^turn:[^?]+\?transport=tcp$/i.test(url.trim()))
      .map(url => url.replace(/^(turn:[^?]+)\?transport=udp$/i, '$1')
        .replace(/^(turns:[^?]+)\?transport=tcp$/i, '$1')),
  })).filter(server => server.urls.length > 0)
  const compatible = iceServers.flatMap(server => server.urls)
  if (compatible.length === original.length && compatible.every((url, index) => url === original[index])) throw error
  if (!compatible.some(url => /^turns?:/i.test(url))) {
    throw new Error('This browser needs a turn: address over UDP or a turns: address for TLS. Plain TURN over TCP is unsupported.')
  }
  return { ...config, iceServers }
}

/** Retry the rejected configuration with WebKit-compatible TURN addresses. */
export function callRelayPeerConnection(config: RTCConfiguration,
  create: (config: RTCConfiguration) => RTCPeerConnection = config => new RTCPeerConnection(config),
): RTCPeerConnection {
  try { return create(config) } catch (error) { return create(compatibleTurnConfiguration(config, error)) }
}

/** `setConfiguration` through the same WebKit filter, for a relay whose
 *  login is renewed or replaced on a live connection. */
export function callRelaySetConfiguration(pc: Pick<RTCPeerConnection, 'setConfiguration'>, config: RTCConfiguration): void {
  try { pc.setConfiguration(config) } catch (error) { pc.setConfiguration(compatibleTurnConfiguration(config, error)) }
}
