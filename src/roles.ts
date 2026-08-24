import { normaliseHex } from './hex.js'
import type { RosterEntry, SingularRole } from './types.js'

const SINGULAR_ROLES: SingularRole[] = ['mic', 'monitor']

export type RoleAssignment = Map<string, Partial<Record<SingularRole, string>>>

/**
 * Decide which one of a participant's devices holds each singular role.
 *
 * Two live microphones is feedback; two active speakers means hearing
 * everything twice. So `mic` and `monitor` are singular per participant. The
 * winner is the most recent claim, with a deterministic tiebreak on device
 * pubkey so every client in the room reaches the same answer without
 * negotiating.
 */
export function resolveSingularRoles(entries: RosterEntry[]): RoleAssignment {
  const result: RoleAssignment = new Map()

  for (const role of SINGULAR_ROLES) {
    const best = new Map<string, { device: string; claimedAt: number }>()

    for (const entry of entries) {
      const claimedAt = entry.claims[role]
      if (claimedAt === undefined) continue

      const current = best.get(entry.participant)
      // The tiebreak is lexicographic, not equality, so `hexEquals` cannot
      // help here: normalise both sides of the `<` at the one place a
      // device pubkey enters this comparison, the same way `Peer`'s glare
      // tiebreak does - see `hex.ts`'s `normaliseHex`.
      const wins =
        current === undefined ||
        claimedAt > current.claimedAt ||
        (claimedAt === current.claimedAt && normaliseHex(entry.device) < normaliseHex(current.device))

      if (wins) best.set(entry.participant, { device: entry.device, claimedAt })
    }

    for (const [participant, { device }] of best) {
      const roles = result.get(participant) ?? {}
      roles[role] = device
      result.set(participant, roles)
    }
  }

  return result
}
