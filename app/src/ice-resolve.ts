import { browserDefaultTurnUrls, isDefaultIceUrls, originStunGuess, stunFromTurnUrl } from '../../src/ice-defaults.js'
import { callRelayServers, type CallRelay } from './call-relay.js'
import { CALL_RELAY_PROFILE_LIMIT, parseCallRelayProfile } from './call-relay-profile.js'

/** Said in the call when no relay is configured or the credential mint fails.
 *  It names a call relay and where to add one: "relay" alone reads as the
 *  room's Nostr relays, which carry no media. */
export const RELAY_MISSING_NOTICE = 'No call relay (TURN) is set up on this device, so this call may not connect on some networks. Add one in Settings › Connections.'

/** How long a call waits for the credential mint before going on without it. */
export const TURN_MINT_TIMEOUT_MS = 4000
// The existing session refreshes every forty minutes. Refuse a shorter lease
// rather than silently treating an arbitrary provider's credential as hourly.
export const TURN_MINT_MIN_TTL_SECONDS = 3600
export const TURN_MINT_MAX_TTL_SECONDS = 86_400
const deadlines = new WeakMap<RTCIceServer, number>()

/** Expiry applies to new allocations. It does not revoke an already established
 * connection or make any promise about the operator's allocation lifetime. */
export function liveIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  const now = performance.now()
  return servers.filter(server => (deadlines.get(server) ?? Infinity) > now)
}

export interface IceResolveOptions {
  /** Explicit device choice takes precedence, including in an existing room. */
  relay?: CallRelay
  /** The credential mint, or undefined when there is none. */
  endpoint: string | undefined
  location: Pick<Location, 'protocol' | 'hostname'>
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

const toUrlList = (urls: string | string[]): string[] => typeof urls === 'string' ? [urls] : urls

/** One TURN credential, or undefined on any failure: a 404 or other refusal,
 *  a network error, malformed JSON, or no answer inside the bound. Never
 *  throws, and never waits longer than `timeoutMs` even if the fetch ignores
 *  its abort signal. */
export async function fetchTurnCredential(endpoint: string, options: Pick<IceResolveOptions, 'fetch' | 'timeoutMs'> = {}): Promise<RTCIceServer | undefined> {
  // This is deployment configuration, never a room link or account API key.
  // Relative paths are same-origin; absolute endpoints must use HTTPS.
  try {
    if (endpoint.length > 2048 || /[\\\x00-\x20\x7f]/.test(endpoint) ||
        (!endpoint.startsWith('/') && !endpoint.startsWith('https://')) || endpoint.startsWith('//')) return undefined
    const url = new URL(endpoint, 'https://issuer-validation.invalid')
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
  } catch { return undefined }
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const started = performance.now()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined) }, options.timeoutMs ?? TURN_MINT_TIMEOUT_MS)
  })
  const attempt = (async (): Promise<RTCIceServer | undefined> => {
    try {
      const res = await send(endpoint, { signal: controller.signal, credentials: 'omit',
        redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' })
      if (controller.signal.aborted || !res.ok || res.redirected ||
          !/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type') ?? '') || !res.body) return undefined
      const declared = res.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > CALL_RELAY_PROFILE_LIMIT)) return undefined
      reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (!controller.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > CALL_RELAY_PROFILE_LIMIT) return undefined
        chunks.push(chunk.value)
      }
      if (controller.signal.aborted) return undefined
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
      const { ttl, ...profile } = body as Record<string, unknown>
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < TURN_MINT_MIN_TTL_SECONDS || ttl > TURN_MINT_MAX_TTL_SECONDS) return undefined
      const relay = parseCallRelayProfile(JSON.stringify(profile))
      const server: RTCIceServer = { urls: relay.urls, username: relay.username, credential: relay.credential }
      deadlines.set(server, started + ttl * 1000)
      return liveIceServers([server])[0]
    } catch { return undefined }
  })()
  try { return await Promise.race([attempt, bound]) } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
}

/**
 * The RTCIceServer list for a room's ICE URLs. A room naming its own servers
 * gets exactly those. A room on the defaults gets a minted TURN credential
 * when the mint answers, and otherwise plain STUN from this origin. A missing
 * or failing mint must never block or fail a call: this resolves promptly
 * (within the timeout) and does not throw.
 */
export async function resolveIceServers(urls: string[], options: IceResolveOptions): Promise<RTCIceServer[]> {
  if (options.relay) return callRelayServers(options.relay)
  const stun = (): RTCIceServer[] => originStunGuess(options.location).map(iceUrl => ({ urls: iceUrl }))
  if (!isDefaultIceUrls(urls)) return urls.map(iceUrl => ({ urls: iceUrl }))
  if (!options.endpoint) return stun()
  const fetched = await fetchTurnCredential(options.endpoint, options)
  if (!fetched) return stun()
  const compatible = browserDefaultTurnUrls(toUrlList(fetched.urls))
  if (compatible.length === 0) return stun()
  const turnServer: RTCIceServer = { ...fetched, urls: compatible }
  deadlines.set(turnServer, deadlines.get(fetched)!)
  const stunUrls = [...new Set(toUrlList(turnServer.urls).map(stunFromTurnUrl).filter((u): u is string => u !== undefined))]
  return [...stunUrls.map(iceUrl => ({ urls: iceUrl })), turnServer]
}

/** True when the list holds a TURN relay. */
export function hasRelay(servers: RTCIceServer[]): boolean {
  return liveIceServers(servers).some(server => toUrlList(server.urls).some(url => url.startsWith('turn')))
}
