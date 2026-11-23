import { createVmlsRevocationRumor, VMLS_REVOCATION_REQUEST_SECONDS } from '../../src/vmls-revocation-request.js'
import { keeperInboxDestination } from './mls-keeper-inbox-auth.js'
import { InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'

export const MAX_MLS_STANDALONE_OBSERVATIONS = 64
export interface MlsPrivateRevocationDestination {
  routeId: string; eventUrl: string; node: string; keeper: string; permissionId: string; transmittingDevice: string
}
export interface MlsStandaloneAttempt { revision: number; createdAt: number; expiration: number; confirmed: boolean; private?: MlsPrivateRevocationDestination }
export interface MlsStandaloneObservation {
  operation: string; sender: string; keeper: string; device: string
  sessions: string[]; boxes: string[]; observedAt: number; requestRevision: number
  attempt?: MlsStandaloneAttempt
  publicAttempted?: boolean
}
export interface MlsStandaloneState { checkedAt: number; observations: MlsStandaloneObservation[] }
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
export function validateMlsStandaloneState(state: MlsStandaloneState): void {
  const invalid = (): never => { throw new InvalidPersonaRecord('Invalid standalone revocation state') }
  if (!state || !exact(state, 'checkedAt,observations') || !time(state.checkedAt) || !Array.isArray(state.observations) || state.observations.length > MAX_MLS_STANDALONE_OBSERVATIONS) invalid()
  const operations = new Set<string>()
  for (const item of state.observations) {
    if (!item || !exact(item, [...(item.attempt === undefined ? [] : ['attempt']), ...(item.publicAttempted === undefined ? [] : ['publicAttempted']), 'boxes','device','keeper','observedAt','operation','requestRevision','sender','sessions'].sort().join(',')) ||
      !hex(item.operation) || !hex(item.sender) || !hex(item.keeper) || !hex(item.device) || item.sender === item.keeper ||
      item.operation !== mlsStandaloneRevocationOperation(item.sender, item.keeper, item.device) || operations.has(item.operation) ||
      !time(item.observedAt) || item.observedAt > state.checkedAt || !time(item.requestRevision) || item.publicAttempted !== undefined && typeof item.publicAttempted !== 'boolean') invalid()
    for (const hints of [item.sessions, item.boxes]) if (!Array.isArray(hints) || hints.length < 1 || hints.length > 64 ||
      !hints.every(hex) || hints.some((hint, index) => index > 0 && hints[index - 1]! >= hint)) invalid()
    if (item.attempt !== undefined) {
      const attempt = item.attempt
      if (!attempt || !exact(attempt, attempt.private === undefined ? 'confirmed,createdAt,expiration,revision' : 'confirmed,createdAt,expiration,private,revision') || !time(attempt.revision) || attempt.revision < 1 || attempt.revision !== item.requestRevision ||
        !time(attempt.createdAt) || attempt.createdAt < item.observedAt || attempt.createdAt > state.checkedAt || !time(attempt.expiration) ||
        attempt.expiration !== attempt.createdAt + VMLS_REVOCATION_REQUEST_SECONDS || typeof attempt.confirmed !== 'boolean') invalid()
      if (attempt.private !== undefined) {
        const d = attempt.private
        if (!d || !exact(d, 'eventUrl,keeper,node,permissionId,routeId,transmittingDevice') ||
          typeof d.routeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(d.routeId) ||
          !hex(d.node) || !hex(d.keeper) || d.keeper !== item.keeper || !hex(d.permissionId) || !hex(d.transmittingDevice) ||
          d.eventUrl !== keeperInboxDestination(d.node) || typeof item.publicAttempted !== 'boolean') invalid()
      } else if (item.publicAttempted === false) invalid()
      try { createVmlsRevocationRumor({ sender: item.sender, keeper: item.keeper, device: item.device, sessions: item.sessions, boxes: item.boxes,
        createdAt: attempt.createdAt, expiration: attempt.expiration }) } catch { invalid() }
    }
    operations.add(item.operation)
  }
}
