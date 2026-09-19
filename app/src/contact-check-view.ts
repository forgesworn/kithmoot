import type { GrantedContactsView } from './granted-contacts.js'
import type { VerificationView } from '../../src/verification.js'

/** Presentation only: no tier or admission inference. Only a ready, scoped
 * grant can supply a Signet claim; local observations stay explicitly local. */
export function contactCheckView(granted: GrantedContactsView | undefined, peer: string, local: VerificationView): {
  status: VerificationView['status']; label: string; title: string
} {
  if (granted?.status === 'unavailable' || granted?.blocked.has(peer)) {
    return { status: 'unknown', label: 'check unavailable', title: 'This contact cannot currently be checked.' }
  }
  const contact = granted?.status === 'ready' ? granted.contacts.find(row => row.pubkey === peer) : undefined
  const methods = { words: 'word comparison', 'in-person': 'in-person check', nip05: 'NIP-05 check', 'app-attested': 'app attestation' }
  const checks = contact?.checks ?? []
  if (checks.length) {
    const latest = checks.reduce((a, b) => a.checkedAt >= b.checkedAt ? a : b)
    return { status: 'verified', label: 'Signet check',
      title: `Signet shared a ${methods[latest.method]} dated ${new Date(latest.checkedAt).toLocaleDateString()}. This does not grant room access or change their tier.` }
  }
  if (contact?.verification === 'proven' || contact?.verification === 'mutual') {
    return { status: 'verified', label: 'Signet checked', title: `Signet shared a ${contact.verification} identity check. No dated check record was shared. This does not grant room access or change their tier.` }
  }
  if (local.status === 'verified') return { status: 'verified', label: 'checked here',
    title: `You compared words for this key on this device on ${new Date((local.verifiedAt ?? 0) * 1000).toLocaleDateString()}. This local observation has not been sent to Signet.` }
  if (local.status === 'key-changed') return { status: 'key-changed', label: 'code changed',
    title: 'You previously checked a different key using this name on this device. Compare words and recognise the person before trusting this key.' }
  return { status: 'unknown', label: 'not checked', title: 'No check is available for this key. Open to compare words.' }
}
