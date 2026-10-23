/**
 * A STUN server chosen on this device.
 *
 * STUN tells a device its own public address so a call can try to connect
 * directly. By default calls ask somebody else's public server
 * (`DEFAULT_STUN_URLS` in src/ice-defaults.ts). A person who would rather
 * not use it can name their own here. It is kept on this device only and
 * never written into a room link, so choosing it sends nobody else to it.
 *
 * When set, it replaces every STUN address a call would otherwise use: the
 * default, a room link's hints and STUN derived from a relay. A relay (TURN)
 * entry and its login are left exactly as they were.
 */

export const CALL_STUN_KEY = 'kithmoot.call-stun.v1'

/** At most this many addresses; more only adds requests that leak the same address. */
export const MAX_CALL_STUN_URLS = 4

/** Said when an entry is not a plain STUN address. */
export const CALL_STUN_FORMAT_ERROR = 'Use stun:host:3478, separated by commas. A relay goes under Call relay.'

const STUN_URL = /^stun:(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i

/**
 * The addresses typed, or undefined when the field is blank (use the
 * default). Throws `CALL_STUN_FORMAT_ERROR` for anything that is not a plain
 * `stun:` address: no `stuns:` (Safari refuses it), no `turn:` (a relay needs
 * a login and has its own setting), no query or login.
 */
export function parseCallStun(text: string): string[] | undefined {
  const urls = [...new Set(text.split(',').map(url => url.trim()).filter(Boolean))]
  if (urls.length === 0) return undefined
  if (urls.length > MAX_CALL_STUN_URLS) throw new Error(`Enter up to ${MAX_CALL_STUN_URLS} STUN addresses.`)
  for (const url of urls) {
    const match = url.length <= 256 ? STUN_URL.exec(url) : null
    if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
      throw new Error(CALL_STUN_FORMAT_ERROR)
    }
  }
  return urls.map(url => url.toLowerCase())
}

/** The saved addresses, or undefined. A saved value that no longer parses is
 *  dropped rather than used, and the default applies. */
export function loadCallStun(store: Pick<Storage, 'getItem'>): string[] | undefined {
  try {
    const text = store.getItem(CALL_STUN_KEY)
    if (text === null || text.length > 2048) return undefined
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value) || value.some(url => typeof url !== 'string')) return undefined
    return parseCallStun(value.join(','))
  } catch {
    return undefined
  }
}

export function saveCallStun(store: Pick<Storage, 'setItem' | 'removeItem'>, urls: string[] | undefined): void {
  if (urls?.length) store.setItem(CALL_STUN_KEY, JSON.stringify(urls))
  else store.removeItem(CALL_STUN_KEY)
}

const isStun = (url: string): boolean => /^stuns?:/i.test(url.trim())

/**
 * `servers` with every STUN address replaced by `stun`. Relay entries keep
 * their own URLs and login; an entry left with no URLs is dropped. With no
 * device choice the list is returned unchanged.
 */
export function withDeviceStun(servers: RTCIceServer[], stun: string[] | undefined): RTCIceServer[] {
  if (!stun?.length) return servers
  const rest = servers
    .map(server => ({ ...server, urls: [server.urls].flat().filter(url => !isStun(url)) }))
    .filter(server => server.urls.length > 0)
  return [{ urls: [...stun] }, ...rest]
}
