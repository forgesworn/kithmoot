import type { AccountNetwork } from './account-network.js'
import type { PublicCallRelays } from './public-call-relays.js'

export const PUBLIC_RELAY_DISCOVERY_PAUSED = 'Public call relay discovery is paused in private invitations. Paired nodes and manually configured connections remain available. Enable Nostr in Account network to search public relays.'
export type PublicRelayDiscoveryTrigger = 'automatic' | 'manual'

/** Opening the Public call relays page is a render opportunity, not an explicit request for
 * public account traffic. Only Find/On may present the mode-required action;
 * a private automatic visit keeps all paired/native controls usable. */
export async function findPublicCallRelays(options: {
  network: Pick<AccountNetwork, 'nostr' | 'current'>
  relays: Pick<PublicCallRelays, 'enabled' | 'searchedAt' | 'discover'>
  outranked(): boolean
  generation(): number
  requireNostr(): boolean
  view: { status(message: string): void; render(): void }
  now?: () => number
}, trigger: PublicRelayDiscoveryTrigger = 'automatic'): Promise<void> {
  if (!options.network.nostr) {
    options.view.status(PUBLIC_RELAY_DISCOVERY_PAUSED)
    options.view.render()
    if (trigger === 'manual') options.requireNostr()
    return
  }
  if (!options.relays.enabled || options.outranked()) { options.view.render(); return }
  if (trigger === 'automatic' && (options.now?.() ?? Date.now()) - options.relays.searchedAt < 60_000) { options.view.render(); return }
  const generation = options.generation(), current = options.network.current()
  if (!current()) {
    if (!options.network.nostr) options.view.status(PUBLIC_RELAY_DISCOVERY_PAUSED)
    options.view.render()
    return
  }
  options.view.status('Asking your Nostr relays for public call relays…')
  try {
    const found = await options.relays.discover()
    if (generation !== options.generation() || !current()) return
    options.view.status(found.length ? `${found.length} public call relay${found.length === 1 ? '' : 's'} found. Select one to use it.` : 'No public call relays were found on your Nostr relays.')
  } catch {
    if (generation === options.generation() && current()) options.view.status('Your Nostr relays could not be asked. Try again later.')
  }
  options.view.render()
}
