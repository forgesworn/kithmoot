/**
 * What to call the signer a saved Nostr account was last connected with.
 *
 * A tab without that signer must not quietly act for this browser or a
 * visitor instead of the account. Saying which signer to reconnect is the
 * difference between "Reconnect" and a person knowing to unlock their
 * extension or open their bunker. The stored method is a hint from an
 * earlier visit, never proof of identity, so an unknown value gets the
 * generic wording rather than a guess.
 */
export function signerLabel(method: string | null | undefined): string {
  switch (method) {
    case 'nip07': return 'your Nostr browser extension'
    case 'bunker': return 'your bunker'
    case 'amber': return 'your Android signer app'
    case 'nsec': return 'your pasted key, which is not kept after a reload'
    default: return 'your Nostr signer'
  }
}
