import { VMLS_REVOCATION_REQUEST_SECONDS } from '../../src/vmls-revocation-request.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import type { PersonaTransaction } from './mls-persona-coordinator.js'
import { validateMlsStandaloneState, type MlsStandaloneState } from './mls-revocation-outbox-store.js'

/** Only a witnessed action supplies the clock. Expiry removes transport
 * attempts, never the authenticated observations authorising future requests. */
export async function mlsStandaloneState(tx: PersonaTransaction, now: number): Promise<MlsStandaloneState> {
  const journal = await readMlsMembership(tx), previous = journal.standalone, before = JSON.stringify(previous)
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - VMLS_REVOCATION_REQUEST_SECONDS || previous && now < previous.checkedAt ||
    journal.requests.some(item => now < Math.max(item.createdAt, item.sentAt ?? 0))) throw new Error('A trusted request time is unavailable.')
  const state: MlsStandaloneState = previous ?? { checkedAt: now, observations: journal.requests.map(item => ({
    operation: item.operation, sender: item.sender, keeper: item.keeper, device: item.device, sessions: item.sessions.slice(), boxes: item.boxes.slice(),
    observedAt: item.createdAt, requestRevision: item.sentAt === null ? 0 : 1,
    ...(item.sentAt === null ? {} : { attempt: { revision: 1, createdAt: item.sentAt, expiration: item.sentAt + VMLS_REVOCATION_REQUEST_SECONDS, confirmed: true } }),
  })) }
  // Validate migrated deadlines before pruning; overflowing legacy markers
  // cannot disappear through expiry and become a trusted empty state.
  validateMlsStandaloneState(state)
  state.checkedAt = now
  for (const item of state.observations) if (item.attempt && item.attempt.expiration <= now) delete item.attempt
  if (!previous || before !== JSON.stringify(state)) {
    journal.requests = []; journal.standalone = state; await saveMlsMembership(tx, journal)
  }
  return state
}
