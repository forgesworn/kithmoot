import { parseProjection, type ContactsState, type PairingV2, type ProjectedCheck, type ProjectedTier } from '@forgesworn/signet-contacts'

export interface AccountContactsPairing { account: string; pairing: PairingV2 }
export interface GrantedContact {
  pubkey: string
  name?: string
  /** Missing permission or a conflicting duplicate is unknown, never Ken. */
  tier?: ProjectedTier
  checks: ProjectedCheck[]
  verification?: 'unverified' | 'proven' | 'mutual'
}
export interface GrantedContactsView {
  status: 'disconnected' | 'waiting' | 'ready' | 'stale' | 'revoked' | 'unavailable'
  contacts: GrantedContact[]
  blocked: Set<string>
  truncated: boolean
}
const HEX = /^[0-9a-f]{64}$/
const RANK: Record<ProjectedTier, number> = { none: 0, ken: 1, kith: 2, kin: 3 }
/** SDK state must come from this account's authenticated grant client. Recheck
 * permissions and freshness when consuming it, including cached projections.
 * Transport cards and local comparisons never fill missing granted fields. */
export function grantedContactsView(args: { account: string | undefined; binding: AccountContactsPairing | null;
  state: ContactsState; now: number; storageHealthy: boolean }): GrantedContactsView {
  const empty = (status: GrantedContactsView['status'], blocked = new Set<string>()): GrantedContactsView => ({ status, contacts: [], blocked, truncated: false })
  const { binding, state, now } = args
  if (!args.account || !binding || binding.account !== args.account) return empty('disconnected')
  if (!args.storageHealthy || !Number.isSafeInteger(now) || now < 0 || (state.grantId !== null && state.grantId !== binding.pairing.grantId)
    || !Array.isArray(state.blockedPubkeys) || state.blockedPubkeys.some(key => !HEX.test(key))) return empty('unavailable')
  const blocked = new Set(state.blockedPubkeys)
  if (state.revoked) return empty('revoked', blocked)
  if (!state.projection) return empty('waiting', blocked)
  const projection = parseProjection(JSON.stringify(state.projection)), pairing = binding.pairing
  if (!projection || projection.grantId !== pairing.grantId || projection.scopes.some(scope => !pairing.grantedCapabilities.includes(scope))
    || projection.expiresAt - projection.issuedAt > pairing.maxStalenessSeconds
    || projection.issuedAt > now || projection.frontier.publishedAt > now) return empty('unavailable', blocked)
  if (projection.revoked) return empty('revoked', blocked)
  if (now >= projection.expiresAt) return empty('stale', blocked)
  const has = (scope: typeof projection.scopes[number]) => projection.scopes.includes(scope) && pairing.grantedCapabilities.includes(scope)
  if (!has('signet.contacts.read:directory') || !has('signet.contacts.blocks.read')) return empty('unavailable', blocked)
  // A block wins even if a malformed producer duplicated the same key under a
  // different contact ID. Never return a visible duplicate of a blocked key.
  for (const row of projection.contacts) if (row.blocked) for (const identity of row.identities ?? []) blocked.add(identity.pubkey)
  const contacts = new Map<string, GrantedContact>()
  for (const row of projection.contacts) {
    for (const identity of row.identities ?? []) {
      if (blocked.has(identity.pubkey)) continue
      const next: GrantedContact = { pubkey: identity.pubkey, name: row.displayName,
        tier: has('signet.contacts.read:tier') ? row.effectiveTier : undefined,
        verification: has('signet.contacts.read:checks') ? identity.verification : undefined,
        checks: has('signet.contacts.read:check-records') ? (row.checks ?? []).filter(check => check.pubkey === identity.pubkey && check.checkedAt <= now * 1000) : [] }
      const prior = contacts.get(next.pubkey)
      if (prior) {
        if (prior.name !== next.name) prior.name = undefined
        prior.tier = prior.tier === undefined || next.tier === undefined ? undefined : RANK[prior.tier] <= RANK[next.tier] ? prior.tier : next.tier
        if (prior.verification !== next.verification) prior.verification = undefined
        prior.checks = prior.checks.filter(check => next.checks.some(other => other.method === check.method && other.checkedAt === check.checkedAt))
      } else contacts.set(next.pubkey, next)
    }
  }
  return { status: 'ready', contacts: [...contacts.values()], blocked, truncated: !!projection.truncated }
}
/** Current owner-granted tier only. This does not mint a room admission proof. */
export function grantedContactMeetsTier(view: GrantedContactsView, pubkey: string, minimum: 'kin' | 'kith' | 'ken'): boolean {
  if (view.status !== 'ready' || view.blocked.has(pubkey)) return false
  const tier = view.contacts.find(contact => contact.pubkey === pubkey)?.tier
  return tier !== undefined && RANK[tier] >= RANK[minimum]
}
