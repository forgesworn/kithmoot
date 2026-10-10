import { InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'
import { createVmlsRevocationRumor, VMLS_REVOCATION_FUTURE_SKEW_SECONDS, type VmlsRevocationRequest } from '../../src/vmls-revocation-request.js'
import { validateMlsKeeperApproval, type MlsKeeperApproval } from './mls-revocation-decision-store.js'

export const MAX_MLS_REVOCATION_SEEN = 256
export const MAX_MLS_REVOCATION_PROMPTS = 64
export const MLS_REVOCATION_SEEN_SECONDS = 9 * 86400
export interface MlsRevocationInboxPrompt {
  operation: string
  request: VmlsRevocationRequest
  receivedAt: number
  state: 'pending' | 'dismissed' | 'approved' | 'done'
  approval?: MlsKeeperApproval
}
export interface MlsRevocationInboxState {
  keeper: string
  checkedAt: number
  seen: { id: string; receivedAt: number }[]
  prompts: MlsRevocationInboxPrompt[]
}
const hex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys

/** The inbox is part of the existing witnessed membership record, rather
 * than an additional vault slot that would reduce the room quota. */
export function validateMlsRevocationInbox(value: MlsRevocationInboxState): void {
  const invalid = (): never => { throw new InvalidPersonaRecord('Invalid MLS revocation inbox') }
  if (!value || typeof value !== 'object' || !exact(value, 'checkedAt,keeper,prompts,seen') || !hex32(value.keeper) || !time(value.checkedAt) ||
      !Array.isArray(value.seen) || value.seen.length > MAX_MLS_REVOCATION_SEEN || !Array.isArray(value.prompts) || value.prompts.length > MAX_MLS_REVOCATION_PROMPTS) invalid()
  const seen = new Set<string>(), operations = new Set<string>()
  for (const item of value.seen) {
    if (!item || typeof item !== 'object' || !exact(item, 'id,receivedAt') || !hex32(item.id) || !time(item.receivedAt) || item.receivedAt > value.checkedAt || seen.has(item.id)) invalid()
    seen.add(item.id)
  }
  for (const prompt of value.prompts) {
    if (!prompt || typeof prompt !== 'object' || !exact(prompt, [...(prompt.approval === undefined ? [] : ['approval']), 'operation', 'receivedAt', 'request', 'state'].sort().join(',')) || !hex32(prompt.operation) ||
        !time(prompt.receivedAt) || prompt.receivedAt > value.checkedAt || !['pending', 'dismissed', 'approved', 'done'].includes(prompt.state) || operations.has(prompt.operation)) invalid()
    try { createVmlsRevocationRumor(prompt.request) } catch { invalid() }
    if (prompt.request.keeper !== value.keeper || prompt.operation !== mlsStandaloneRevocationOperation(prompt.request.sender, value.keeper, prompt.request.device) ||
        prompt.request.createdAt > prompt.receivedAt + VMLS_REVOCATION_FUTURE_SKEW_SECONDS || prompt.request.expiration <= prompt.receivedAt) invalid()
    if (prompt.state === 'approved' && !prompt.approval || prompt.approval && !['approved', 'done'].includes(prompt.state)) invalid()
    if (prompt.approval) {
      validateMlsKeeperApproval(prompt.approval, prompt.request, prompt.operation, prompt.receivedAt)
      if (prompt.approval.approvedAt > value.checkedAt) invalid()
    }
    operations.add(prompt.operation)
  }
}
