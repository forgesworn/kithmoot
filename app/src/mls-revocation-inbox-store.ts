import { InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'
import { createVmlsRevocationRumor, VMLS_REVOCATION_FUTURE_SKEW_SECONDS, type VmlsRevocationRequest } from '../../src/vmls-revocation-request.js'
import { validateMlsKeeperApproval, type MlsKeeperApproval } from './mls-revocation-decision-store.js'

export const MAX_MLS_REVOCATION_SEEN = 1024
export const MAX_MLS_REVOCATION_PROMPTS = 64
export const MLS_REVOCATION_SEEN_SECONDS = 9 * 86400
export const MLS_KEEPER_PROMPT_SECONDS = 3600
export const MAX_MLS_KEEPER_PROMPT_COOLDOWNS = 1024
export interface MlsRevocationInboxPrompt {
  operation: string
  request: VmlsRevocationRequest
  receivedAt: number
  state: 'pending' | 'dismissed' | 'approved' | 'done'
  approval?: MlsKeeperApproval
  deferredUntil?: number
}
export interface MlsRevocationInboxState {
  keeper: string
  checkedAt: number
  seen: { id: string; receivedAt: number }[]
  prompts: MlsRevocationInboxPrompt[]
  /** Witnessed reservations precede signer use, including failed attempts. */
  attempts?: number[]
  scan?: MlsKeeperInboxScan
  directory?: { at: number; complete: boolean; relays: string[] }
  promptAfter?: { sender: string; until: number }[]
}
export interface MlsKeeperInboxScan {
  lastPageAt: number | null
  nextRelay: string | null
  cursors: { relay: string; until: number }[]
}
const hex32 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const relay = (v: unknown): v is string => typeof v === 'string' && v.length <= 2048 && /^wss?:\/\//.test(v) && (() => { try { const url = new URL(v); return url.href === v && !url.username && !url.password && !url.hash } catch { return false } })()

/** The inbox is part of the existing witnessed membership record, rather
 * than an additional vault slot that would reduce the room quota. */
export function validateMlsRevocationInbox(value: MlsRevocationInboxState): void {
  const invalid = (): never => { throw new InvalidPersonaRecord('Invalid MLS revocation inbox') }
  if (!value || typeof value !== 'object' || !exact(value, ['checkedAt', 'keeper', 'prompts', 'seen', ...(value.attempts === undefined ? [] : ['attempts']), ...(value.scan === undefined ? [] : ['scan']), ...(value.directory === undefined ? [] : ['directory']), ...(value.promptAfter === undefined ? [] : ['promptAfter'])].sort().join(',')) || !hex32(value.keeper) || !time(value.checkedAt) ||
      !Array.isArray(value.seen) || value.seen.length > MAX_MLS_REVOCATION_SEEN || !Array.isArray(value.prompts) || value.prompts.length > MAX_MLS_REVOCATION_PROMPTS) invalid()
  const seen = new Set<string>(), operations = new Set<string>()
  if (value.promptAfter !== undefined && (!Array.isArray(value.promptAfter) || value.promptAfter.length > MAX_MLS_KEEPER_PROMPT_COOLDOWNS ||
      value.promptAfter.some(item => !item || !exact(item, 'sender,until') || !hex32(item.sender) || item.sender === value.keeper || !time(item.until) || item.until > value.checkedAt + MLS_KEEPER_PROMPT_SECONDS) ||
      new Set(value.promptAfter.map(item => item.sender)).size !== value.promptAfter.length)) invalid()
  if (value.attempts !== undefined && (!Array.isArray(value.attempts) || value.attempts.length > 8 || value.attempts.some((at, index) => !time(at) || at > value.checkedAt || index > 0 && at < value.attempts![index - 1]!))) invalid()
  if (value.scan !== undefined) {
    const scan = value.scan
    if (!scan || !exact(scan, 'cursors,lastPageAt,nextRelay') || !(scan.lastPageAt === null || time(scan.lastPageAt) && scan.lastPageAt <= value.checkedAt) || !(scan.nextRelay === null || relay(scan.nextRelay)) ||
      !Array.isArray(scan.cursors) || scan.cursors.length > 6 || scan.cursors.some(item => !item || !exact(item, 'relay,until') || !relay(item.relay) || !time(item.until) || item.until > value.checkedAt) ||
      new Set(scan.cursors.map(item => item.relay)).size !== scan.cursors.length) invalid()
  }
  if (value.directory !== undefined) {
    const directory = value.directory
    if (!directory || !exact(directory, 'at,complete,relays') || !time(directory.at) || directory.at > value.checkedAt || typeof directory.complete !== 'boolean' ||
      !Array.isArray(directory.relays) || directory.relays.length > 6 || !directory.relays.every(relay) || new Set(directory.relays).size !== directory.relays.length ||
      !directory.complete && directory.relays.length !== 0) invalid()
  }
  for (const item of value.seen) {
    if (!item || typeof item !== 'object' || !exact(item, 'id,receivedAt') || !hex32(item.id) || !time(item.receivedAt) || item.receivedAt > value.checkedAt || seen.has(item.id)) invalid()
    seen.add(item.id)
  }
  for (const prompt of value.prompts) {
    if (!prompt || typeof prompt !== 'object' || !exact(prompt, [...(prompt.approval === undefined ? [] : ['approval']), ...(prompt.deferredUntil === undefined ? [] : ['deferredUntil']), 'operation', 'receivedAt', 'request', 'state'].sort().join(',')) || !hex32(prompt.operation) ||
        !time(prompt.receivedAt) || prompt.receivedAt > value.checkedAt || !['pending', 'dismissed', 'approved', 'done'].includes(prompt.state) || operations.has(prompt.operation)) invalid()
    try { createVmlsRevocationRumor(prompt.request) } catch { invalid() }
    if (prompt.request.keeper !== value.keeper || prompt.operation !== mlsStandaloneRevocationOperation(prompt.request.sender, value.keeper, prompt.request.device) ||
        prompt.request.createdAt > prompt.receivedAt + VMLS_REVOCATION_FUTURE_SKEW_SECONDS || prompt.request.expiration <= prompt.receivedAt) invalid()
    if (prompt.state === 'approved' && !prompt.approval || prompt.approval && !['approved', 'done'].includes(prompt.state)) invalid()
    if (prompt.deferredUntil !== undefined && (!['pending', 'approved'].includes(prompt.state) || !time(prompt.deferredUntil) || prompt.deferredUntil > value.checkedAt + MLS_KEEPER_PROMPT_SECONDS)) invalid()
    if (prompt.approval) {
      validateMlsKeeperApproval(prompt.approval, prompt.request, prompt.operation, prompt.receivedAt)
      if (prompt.approval.approvedAt > value.checkedAt) invalid()
    }
    operations.add(prompt.operation)
  }
}
