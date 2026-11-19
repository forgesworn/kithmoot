/** Public inbox suggestions, verified with expiring gift wraps on 19 November
 * 2026. These are an editor draft until the account publishes its own list. */
export const DEFAULT_NOSTR_INBOX_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.primal.net/',
  'wss://nos.lol/',
  'wss://relay.ditto.pub/',
])

export function nostrInboxRelayDraft(published: readonly string[] | undefined): string {
  if (published === undefined) return ''
  return (published.length ? published : DEFAULT_NOSTR_INBOX_RELAYS).join('\n')
}
