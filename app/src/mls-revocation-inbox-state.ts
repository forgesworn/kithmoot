import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { MLS_REVOCATION_SEEN_SECONDS, type MlsRevocationInboxState } from './mls-revocation-inbox-store.js'

/** Shared witnessed clock and expiry maintenance for intake and stored scans. */
export async function mlsRevocationInboxState(tx: PersonaTransaction, keeper: string, now: number): Promise<MlsRevocationInboxState> {
  const journal = await readMlsMembership(tx), previous = journal.inbox, before = JSON.stringify(previous)
  if (!Number.isSafeInteger(now) || now < 0 || previous && now < previous.checkedAt) throw new Error('A trusted request time is unavailable.')
  if (previous && previous.keeper !== keeper) throw new InvalidPersonaRecord('Keeper inbox belongs to another persona')
  const state: MlsRevocationInboxState = previous ?? { keeper, checkedAt: now, seen: [], prompts: [] }
  state.checkedAt = now
  state.seen = state.seen.filter(item => item.receivedAt + MLS_REVOCATION_SEEN_SECONDS > now)
  state.prompts = state.prompts.filter(item => item.state === 'done' || item.state === 'approved' || item.request.expiration > now)
  if (state.attempts) state.attempts = state.attempts.filter(at => at + 60 > now)
  if (before !== JSON.stringify(state)) { journal.inbox = state; await saveMlsMembership(tx, journal) }
  return state
}
