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
      const wins =
        current === undefined ||
        claimedAt > current.claimedAt ||
        (claimedAt === current.claimedAt && entry.device < current.device)

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
