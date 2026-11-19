import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import type { GuardedPublishOptions } from '../../src/relay-pool.js'

/** The slice of a pool hold this delivery uses: one guarded carrier. */
export interface InboxCarrier {
  publishGuarded?(event: Event, current: () => boolean, options?: GuardedPublishOptions): Promise<void>
  close(): void
}

export interface InboxDelivery {
  /** Relays that answered OK true. */
  accepted: string[]
  /** Relays that did not, with what they said. */
  unaccepted: { url: string; reason: string }[]
}

/** How long a throwaway key waits for a relay to finish NIP-42. */
export const INBOX_AUTH_TIMEOUT_MS = 10_000

/** A relay that looked at the event and refused it for a reason signing in
 * cannot change. Anything else (an auth-required refusal, a closed link, a
 * timeout) is a relay that may simply not have authenticated yet. */
const FINAL_REFUSAL = /\b(?:blocked|banned|restricted|invalid|pow|rate-limited):/

const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Offer one signed gift wrap to each inbox relay on its own carrier, so one
 * relay accepting never stops another being tried. A relay that did not accept
 * is offered the same event again after authenticating with a throwaway key
 * made for this attempt and wiped afterwards. The account is never used:
 * identifying the sender to the recipient's relay is what a gift wrap hides,
 * and the signer would be prompted. Relays that refuse for a reason other than
 * authentication (`restricted:`, `blocked:` and the like) are not repeated.
 * Resolves if at least one relay accepted; otherwise rejects.
 */
export async function publishToInboxRelays(event: Event, relays: readonly string[], current: () => boolean,
  open: (relay: string) => InboxCarrier): Promise<InboxDelivery> {
  const offer = async (url: string, options?: GuardedPublishOptions): Promise<void> => {
    if (!current()) throw new Error('Public message cancelled.')
    const hold = open(url)
    try {
      if (!hold.publishGuarded) throw new Error('A guarded public carrier is unavailable.')
      await hold.publishGuarded(event, current, options)
    } finally { hold.close() }
  }
  const results = await Promise.all([...new Set(relays)].map(async (url): Promise<{ url: string; reason?: string }> => {
    let reason: string
    try { await offer(url); return { url } } catch (error) { reason = reasonOf(error) }
    if (!current() || FINAL_REFUSAL.test(reason)) return { url, reason }
    // Never the account: a fresh key per attempt, zeroed whatever happens.
    const key = generateSecretKey()
    try {
      const identity = { pubkey: getPublicKey(key), signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, key) }
      await offer(url, { authentication: [{ url, identity }], authenticationTimeoutMs: INBOX_AUTH_TIMEOUT_MS })
      return { url }
    } catch (error) { return { url, reason: reasonOf(error) } }
    finally { key.fill(0) }
  }))
  const accepted = results.filter(row => row.reason === undefined).map(row => row.url)
  const unaccepted = results.filter((row): row is { url: string; reason: string } => row.reason !== undefined)
  if (!current()) throw new Error('Public message cancelled.')
  if (!accepted.length) throw new Error(`No inbox relay accepted the message (${unaccepted.map(row => `${row.url}: ${row.reason}`).join('; ')})`)
  return { accepted, unaccepted }
}
