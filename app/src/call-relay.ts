import { stunFromTurnUrl } from '../../src/ice-defaults.js'

/** A relay explicitly chosen on this device. Never put credentials in room links. */
export interface CallRelay { urls: string[]; username: string; credential: string }
export const CALL_RELAY_KEY = 'kithmoot.call-relay.v1'

export function parseCallRelay(addresses: string, username: string, credential: string): CallRelay | undefined {
  const urls = addresses.split(',').map(url => url.trim().toLowerCase()).filter(Boolean)
  if (!urls.length && !username && !credential) return undefined
  if (!urls.length || urls.length > 8 || !username.trim() || username.length > 1024 || !credential || credential.length > 1024 || /[\x00-\x1f\x7f]/.test(username + credential)) {
    throw new Error('Enter a TURN address, username and password, or clear all three fields.')
  }
  for (const url of urls) {
    const match = /^(turns?):(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url)
    if (!match || url.length > 512 || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) ||
        (match[1].toLowerCase() === 'turns' && match[4]?.toLowerCase() === 'udp')) {
      throw new Error('Use turn:host:3478 or turns:host:5349, separated by commas. Put login details in their own fields.')
    }
  }
  return { urls, username, credential }
}

export function loadCallRelay(store: Pick<Storage, 'getItem'>): CallRelay | undefined {
  const text = store.getItem(CALL_RELAY_KEY)
  if (text === null) return undefined
  try {
    if (text.length > 16384) throw new Error()
    const value = JSON.parse(text) as CallRelay
    if (!Array.isArray(value.urls) || value.urls.some(url => typeof url !== 'string') ||
        typeof value.username !== 'string' || typeof value.credential !== 'string') throw new Error()
    const relay = parseCallRelay(value.urls.join(','), value.username, value.credential)
    if (!relay) throw new Error()
    return relay
  } catch { throw new Error('The saved call relay could not be read. Open Connections and save it again or remove it.') }
}

export function saveCallRelay(store: Pick<Storage, 'setItem' | 'removeItem'>, relay: CallRelay | undefined): void {
  if (relay) store.setItem(CALL_RELAY_KEY, JSON.stringify(relay))
  else store.removeItem(CALL_RELAY_KEY)
}

/** Credentials are attached only to the URLs entered alongside them. */
export function callRelayServers(relay: CallRelay): RTCIceServer[] {
  const stun = [...new Set(relay.urls.map(stunFromTurnUrl).filter((url): url is string => url !== undefined))]
  return [...stun.map(urls => ({ urls })), { urls: [...relay.urls], username: relay.username, credential: relay.credential }]
}

/** The configuration without plain TURN/TCP URIs, for the one known WebKit
 * syntax incompatibility, or the original error when that is not the cause. */
function withoutPlainTurnTcp(config: RTCConfiguration, error: unknown): RTCConfiguration {
  if (!error || typeof error !== 'object' || !('name' in error) ||
      !['SyntaxError', 'NotSupportedError'].includes(String(error.name))) throw error
  const servers = config.iceServers ?? []
  const original = servers.flatMap(server => [server.urls].flat())
  const iceServers = servers.map(server => ({ ...server,
    urls: [server.urls].flat().filter(url => !/^turn:[^?]+\?transport=tcp$/i.test(url.trim())),
  }))
    .filter(server => server.urls.length > 0)
  if (iceServers.flatMap(server => server.urls).length === original.length) throw error
  if (!iceServers.some(server => server.urls.some(url => url.startsWith('turn')))) {
    throw new Error('This browser needs a turn: address over UDP or a turns: address for TLS. Plain TURN over TCP is unsupported.')
  }
  return { ...config, iceServers }
}

/** WebKit rejects plain TURN/TCP URIs. Keep the chosen UDP/TLS alternatives
 * without removing TCP from browsers which support it. No network is started
 * by the rejected constructor; retry only that known syntax incompatibility. */
export function callRelayPeerConnection(config: RTCConfiguration,
  create: (config: RTCConfiguration) => RTCPeerConnection = config => new RTCPeerConnection(config),
): RTCPeerConnection {
  try { return create(config) } catch (error) { return create(withoutPlainTurnTcp(config, error)) }
}

/** `setConfiguration` through the same WebKit filter, for a relay whose
 *  login is renewed or replaced on a live connection. */
export function callRelaySetConfiguration(pc: Pick<RTCPeerConnection, 'setConfiguration'>, config: RTCConfiguration): void {
  try { pc.setConfiguration(config) } catch (error) { pc.setConfiguration(withoutPlainTurnTcp(config, error)) }
}
