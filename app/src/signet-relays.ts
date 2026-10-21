/**
 * Keeping a Signet sign-in reachable.
 *
 * Signet serves its remote signer on one relay of its own,
 * `wss://relay.primal.net` (signet-app `PRODUCTION_RELAY_URL`), since nos.lol
 * stopped answering in October 2026. A pairing
 * made over some other relay is answered there for two minutes only, so a
 * sign-in whose link named just the person's first KithMoot relay worked on
 * the day and then failed at every later launch, which reads as having to
 * sign in again each time. Every sign-in link names Signet's relay, and a
 * stored remote-signer link gains it before it is used.
 */
export const SIGNET_RELAY = 'wss://relay.primal.net'

const relayKey = (url: string) => url.trim().toLowerCase().replace(/\/$/, '')

/** The person's first relay, then Signet's, then the rest: signet-login
 *  carries only the first three, and Signet's must be among them. */
export function signinRelays(relays: readonly string[]): string[] {
  const out: string[] = [], seen = new Set<string>()
  for (const url of [relays[0], SIGNET_RELAY, ...relays.slice(1)]) {
    if (!url?.trim() || seen.has(relayKey(url))) continue
    seen.add(relayKey(url))
    out.push(url.trim())
  }
  return out
}

/** A stored `bunker://` link that also names Signet's relay, or undefined
 *  when it already does or is not a bunker link at all. */
export function withSignetRelay(uri: string): string | undefined {
  let url: URL
  try { url = new URL(uri.trim()) } catch { return undefined }
  if (url.protocol !== 'bunker:' || !url.host) return undefined
  if (url.searchParams.getAll('relay').some(relay => relayKey(relay) === relayKey(SIGNET_RELAY))) return undefined
  url.searchParams.append('relay', SIGNET_RELAY)
  return url.toString()
}
