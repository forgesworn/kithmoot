import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { MLS_REVOCATION_SEEN_SECONDS, MLS_KEEPER_PROMPT_SECONDS, MAX_MLS_KEEPER_PROMPT_COOLDOWNS, type MlsRevocationInboxState } from './mls-revocation-inbox-store.js'

export function mlsKeeperPromptAfter(state: MlsRevocationInboxState, sender: string, until: number): void {
  const items = state.promptAfter ??= [], existing = items.find(item => item.sender === sender)
  if (existing) existing.until = Math.max(existing.until, until)
  else {
    if (items.length >= MAX_MLS_KEEPER_PROMPT_COOLDOWNS) throw new Error('The keeper prompt cooldown journal is full.')
    items.push({ sender, until })
  }
}

/** Shared witnessed clock and expiry maintenance for intake and stored scans. */
export async function mlsRevocationInboxState(tx: PersonaTransaction, keeper: string, now: number): Promise<MlsRevocationInboxState> {
  const journal = await readMlsMembership(tx), previous = journal.inbox, before = JSON.stringify(previous)
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - MLS_KEEPER_PROMPT_SECONDS || previous && now < previous.checkedAt) throw new Error('A trusted request time is unavailable.')
  if (previous && previous.keeper !== keeper) throw new InvalidPersonaRecord('Keeper inbox belongs to another persona')
  const state: MlsRevocationInboxState = previous ?? { keeper, checkedAt: now, seen: [], prompts: [] }
  state.checkedAt = now
  // Migration derives cooldowns from retained receipts before expiry pruning:
  // a short-lived pending request cannot reset the sender's hour on restart.
  if (!state.promptAfter) {
    state.promptAfter = []
    for (const prompt of state.prompts) if (prompt.receivedAt + MLS_KEEPER_PROMPT_SECONDS > now) mlsKeeperPromptAfter(state, prompt.request.sender, prompt.receivedAt + MLS_KEEPER_PROMPT_SECONDS)
  }
  state.promptAfter = state.promptAfter.filter(item => item.until > now)
  state.seen = state.seen.filter(item => item.receivedAt + MLS_REVOCATION_SEEN_SECONDS > now)
  state.prompts = state.prompts.filter(item => item.state === 'done' || item.state === 'approved' || item.request.expiration > now)
  // Expired deferrals become one visible sender group. Reserve its next hour
  // once, so an immediate new target cannot create another fresh prompt.
  for (const prompt of state.prompts) if (prompt.deferredUntil !== undefined && prompt.deferredUntil <= now) {
    delete prompt.deferredUntil
    mlsKeeperPromptAfter(state, prompt.request.sender, now + MLS_KEEPER_PROMPT_SECONDS)
  }
  if (state.attempts) state.attempts = state.attempts.filter(at => at + 60 > now)
  if (before !== JSON.stringify(state)) { journal.inbox = state; await saveMlsMembership(tx, journal) }
  return state
}
