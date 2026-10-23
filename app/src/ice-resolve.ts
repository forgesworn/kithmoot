import { browserDefaultTurnUrls, isDefaultIceUrls, originStunGuess, stunFromTurnUrl } from '../../src/ice-defaults.js'
import { callRelayServers, type CallRelay } from './call-relay.js'

/** Said in the call when no relay is configured or the credential mint fails. */
export const RELAY_MISSING_NOTICE = 'Some calls need a relay. Your group has none, so this call may not connect on some networks.'

/** How long a call waits for the credential mint before going on without it. */
export const TURN_MINT_TIMEOUT_MS = 4000

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
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined) }, options.timeoutMs ?? TURN_MINT_TIMEOUT_MS)
  })
  const attempt = (async (): Promise<RTCIceServer | undefined> => {
    try {
      const res = await send(endpoint, { signal: controller.signal })
      if (!res.ok) return undefined
      const body = (await res.json()) as Partial<{ urls: string[]; username: string; credential: string }>
      if (!Array.isArray(body.urls) || body.urls.length === 0 || !body.username || !body.credential) return undefined
      return { urls: body.urls, username: body.username, credential: body.credential }
    } catch { return undefined }
  })()
  try { return await Promise.race([attempt, bound]) } finally { clearTimeout(timer) }
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
  const stunUrls = [...new Set(toUrlList(turnServer.urls).map(stunFromTurnUrl).filter((u): u is string => u !== undefined))]
  return [...stunUrls.map(iceUrl => ({ urls: iceUrl })), turnServer]
}

/** True when the list holds a TURN relay. */
export function hasRelay(servers: RTCIceServer[]): boolean {
  return servers.some(server => toUrlList(server.urls).some(url => url.startsWith('turn')))
}
