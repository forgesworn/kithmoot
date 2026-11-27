import { stunFromTurnUrl } from '../../src/ice-defaults.js'

/** A relay explicitly chosen on this device. Never put credentials in room links. */
export interface CallRelayLogin { urls: string[]; username: string; credential: string }
export interface CallRelay extends CallRelayLogin { standby?: CallRelayLogin }
export const CALL_RELAY_KEY = 'kithmoot.call-relay.v1'
export const CALL_RELAY_PROFILE_LIMIT = 16_384
export const INVALID_CALL_RELAY_STANDBY = 'Enter a primary relay and different TURN addresses for the standby relay.'

export function parseCallRelay(addresses: string, username: string, credential: string): CallRelayLogin | undefined {
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

export function withCallRelayStandby(primary: CallRelayLogin | undefined, standby: CallRelayLogin): CallRelay {
  if (!primary || standby.urls.some(url => primary.urls.includes(url))) throw new Error(INVALID_CALL_RELAY_STANDBY)
  return { ...primary, standby }
}

function storedLogin(value: unknown): CallRelayLogin {
  const login = value as Partial<CallRelayLogin>
  if (!Array.isArray(login.urls) || login.urls.some(url => typeof url !== 'string') ||
      typeof login.username !== 'string' || typeof login.credential !== 'string') throw new Error()
  const parsed = parseCallRelay(login.urls.join(','), login.username, login.credential)
  if (!parsed) throw new Error()
  return parsed
}

export function loadCallRelay(store: Pick<Storage, 'getItem'>): CallRelay | undefined {
  const text = store.getItem(CALL_RELAY_KEY)
  if (text === null) return undefined
  try {
    if (text.length > CALL_RELAY_PROFILE_LIMIT) throw new Error()
    const value = JSON.parse(text) as CallRelay
    const relay = storedLogin(value)
    return value.standby === undefined ? relay : withCallRelayStandby(relay, storedLogin(value.standby))
  } catch { throw new Error("The saved relay server can't be read. Open Settings › Calls › Relay server and save it again or remove it.") }
}

export function saveCallRelay(store: Pick<Storage, 'setItem' | 'removeItem'>, relay: CallRelay | undefined): void {
  if (!relay) { store.removeItem(CALL_RELAY_KEY); return }
  const text = JSON.stringify(relay)
  if (text.length > CALL_RELAY_PROFILE_LIMIT) throw new Error('The relay addresses and logins are too long.')
  store.setItem(CALL_RELAY_KEY, text)
}

/** Credentials are attached only to the URLs entered alongside them. */
export function callRelayServers(relay: CallRelayLogin): RTCIceServer[] {
  const stun = [...new Set(relay.urls.map(stunFromTurnUrl).filter((url): url is string => url !== undefined))]
  return [...stun.map(urls => ({ urls })), { urls: [...relay.urls], username: relay.username, credential: relay.credential }]
}
