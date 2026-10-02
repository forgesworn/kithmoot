// `issueKindredProof`, `evaluateAccess`, the canonical kindred message and
// `ACCESS_LABELS` moved to @forgesworn/fold-kit (see the T2.1 codec
// cutover). `evaluateAgentAccess` stays here: it needs `ownership.ts` and
// `RosterEntry`, neither of which moved.
import { verifyAgentOwnership } from './ownership.js'
import type { RoomPolicy, RosterEntry } from './types.js'

export type { IssueKindredProofOptions } from '@forgesworn/fold-kit'
export { issueKindredProof, evaluateAccess, ACCESS_LABELS } from '@forgesworn/fold-kit'

/**
 * Decide whether an agent's roster entry is admitted under the room's agent
 * rule. Nothing to decide for a person, or in a room with no rule.
 *
 * Recheck `entry.owner` at the decision time: a proof accepted by
 * `decodeRosterEvent` can expire while the roster entry remains live.
 * An agent whose principal has not arrived yet is not admitted yet, and is
 * admitted on its next entry once they have; one whose principal leaves is
 * swept with them.
 */
export function evaluateAgentAccess(
  policy: RoomPolicy | undefined,
  entry: Pick<RosterEntry, 'agent' | 'owner' | 'participant'>,
  isMember: (participant: string) => boolean,
  now = Math.floor(Date.now() / 1000),
): { admitted: boolean; reason: string } {
  if (policy?.agents !== 'owned-by-members' || entry.agent !== true) return { admitted: true, reason: 'no agent rule applies' }
  if (!entry.owner || !verifyAgentOwnership(entry.owner, { agent: entry.participant, now }).ok) return { admitted: false, reason: 'no ownership proof' }
  if (!isMember(entry.owner.principal)) return { admitted: false, reason: 'principal is not in the room' }
  return { admitted: true, reason: 'owned by a member' }
}
