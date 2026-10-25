import type { MlsGrantRecord } from './mls-grant-ledger.js'
/** References to exact storage statements, separate from legacy MLS grants.
 * Payload v3 is critical: a v2 reader must refuse the complete custody. */
export interface MlsStorageScope {
  node: string; device: string; issuer: string; persona: string; grantId: string; expiration: number
  active: string; revocation: string; state: 'reserved' | 'active' | 'revoking' | 'revoked'
}
export interface MlsGrantScopeCustody {
  version: 2 | 3; phase: 'fenced' | 'ready'; fence: string; records: MlsGrantRecord[]; storageScopes?: MlsStorageScope[]
}
export const storageScopeReference = (g: MlsGrantRecord, state: MlsStorageScope['state']): MlsStorageScope => ({
  node: g.node, device: g.device, issuer: g.issuer, persona: g.persona, grantId: g.grantId, expiration: g.expiration,
  active: g.active.id, revocation: g.revocation.id, state,
})
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
export function validateStorageScopes(value: unknown): MlsStorageScope[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid storage scope custody.')
  for (const s of value) if (!s || !exact(s, 'active,device,expiration,grantId,issuer,node,persona,revocation,state') ||
    ![s.node,s.device,s.issuer,s.persona,s.active,s.revocation].every(hex) || !/^[0-9a-f]{32}$/.test(s.grantId) ||
    !Number.isSafeInteger(s.expiration) || s.expiration <= 0 || !['reserved','active','revoking','revoked'].includes(s.state) || s.active === s.revocation) throw new Error('Invalid storage scope custody.')
  if (new Set(value.map(s => `${s.node}/${s.device}`)).size !== value.length) throw new Error('Duplicate storage scope custody.')
  return value.map(s => ({ node: s.node, device: s.device, issuer: s.issuer, persona: s.persona, grantId: s.grantId, expiration: s.expiration, active: s.active, revocation: s.revocation, state: s.state })).sort((a, b) => a.node.localeCompare(b.node) || a.device.localeCompare(b.device))
}
const currentTime = (now: number) => { if (!Number.isSafeInteger(now) || now < 0) throw new Error('A current scope time is required.') }
export function assertLegacyGrantScope(c: MlsGrantScopeCustody, g: Pick<MlsGrantRecord, 'node' | 'device'>, now: number): void {
  currentTime(now)
  if (c.storageScopes?.some(s => s.node === g.node && s.device === g.device && s.state !== 'revoked' && s.expiration > now)) {
    throw new Error('This node/device scope has retained storage-only authority; legacy creation and publication are blocked.')
  }
}
function assertNoLiveLegacy(c: MlsGrantScopeCustody, g: Pick<MlsGrantRecord, 'node' | 'device'>, now: number): void {
  currentTime(now)
  if (c.records.some(r => r.node === g.node && r.device === g.device && r.state !== 'revoked' && r.expiration > now)) {
    throw new Error('This node/device scope has live or unconfirmed legacy authority; storage creation and publication are blocked.')
  }
}
export function assertStorageGrantScopeAvailable(c: MlsGrantScopeCustody, g: Pick<MlsGrantRecord, 'node' | 'device'>, now: number): void {
  assertNoLiveLegacy(c, g, now)
  if (c.storageScopes?.some(s => s.node === g.node && s.device === g.device && s.state !== 'revoked' && s.expiration > now)) throw new Error('This storage scope is already reserved.')
}
export function claimStorageGrantScope(c: MlsGrantScopeCustody, g: MlsGrantRecord, now: number): MlsGrantScopeCustody {
  assertStorageGrantScopeAvailable(c, g, now)
  return { ...c, version: 3, storageScopes: validateStorageScopes([...(c.storageScopes ?? []).filter(s => s.node !== g.node || s.device !== g.device), storageScopeReference(g, 'reserved')]) }
}
export function changeStorageGrantScope(c: MlsGrantScopeCustody, g: MlsGrantRecord, state: MlsStorageScope['state'], now: number): MlsGrantScopeCustody {
  assertNoLiveLegacy(c, g, now)
  const previous = c.storageScopes?.find(s => s.node === g.node && s.device === g.device)
  if (!previous || JSON.stringify({ ...previous, state }) !== JSON.stringify(storageScopeReference(g, state)) || previous.state === 'revoked' && state !== 'revoked') throw new Error('The exact protected storage scope changed; publication is blocked.')
  return { ...c, version: 3, storageScopes: validateStorageScopes(c.storageScopes!.map(s => s === previous ? { ...s, state } : s)) }
}
