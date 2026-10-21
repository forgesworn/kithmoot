/** ForgeSworn's own domains. One copy, shared by the library and the app. */
export const FORGESWORN_DOMAINS: readonly string[] = ['forgesworn.dev', 'kithmoot.app']

/** True for ForgeSworn's own hosts and any name under them. Unparseable input
 * is false: a caller that cares must validate the URL itself. */
export function isForgeSwornHost(origin: string): boolean {
  try {
    // A trailing dot names the same host in DNS, so it must not be a way round.
    const host = new URL(origin).hostname.toLowerCase().replace(/\.+$/, '')
    return FORGESWORN_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
  } catch { return false }
}
