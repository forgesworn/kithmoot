import { storageOutboxReader, storageOutboxTransaction as storageOutboxTransactionForMigration } from './mls-storage-inbox.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { PersonaReader, PersonaTransaction } from './mls-persona-coordinator.js'
import { InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'
import type { Event } from 'nostr-tools/pure'
import type { MlsMemberStatus } from './mls-room-operations.js'
import type { PairedBox } from './browser-link.js'
import { mlsBoxNode } from './mls-grant-ledger.js'
import { readKeeperInboxPermission } from './mls-keeper-permissions.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { validateMlsStandaloneState, type MlsStandaloneObservation } from './mls-revocation-outbox-store.js'
export interface AdminStorageRequestSelection { leaf: string; expectedStorageKeeper: string; box: PairedBox; permission: Event; source?: { session: string; leaf: string }; rebind?: { operation: string; bindingRevision: number; requestRevision: number } }
/** Only called with the host's native, witnessed roster and current credential.
 * Permission signatures do not establish the operator's intended keeper. */
export function adminStorageRequestTarget(sender: string, localDevice: string, members: readonly MlsMemberStatus[], selection: AdminStorageRequestSelection, now: number): MlsMemberStatus {
  const hex = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  if (![sender, localDevice, selection.leaf, selection.expectedStorageKeeper].every(hex) || selection.expectedStorageKeeper === sender) throw new Error('Independently select the expected storage keeper and a different enrolled device.')
  const permission = readKeeperInboxPermission(selection.permission, now), node = mlsBoxNode(selection.box)
  if (permission.keeper !== selection.expectedStorageKeeper || permission.node !== node || permission.device !== localDevice) throw new Error('The signed permission differs from the expected storage keeper, selected node or current transmitting device.')
  const own = members.filter(member => member.own)
  if (own.length !== 1 || own[0].identity !== sender || own[0].device !== localDevice || own[0].pending || own[0].homeBox !== node ||
      !hex(own[0].leafId) || !Number.isSafeInteger(own[0].bindingExpiresAt) || own[0].bindingExpiresAt <= now) throw new Error('The unique current committed local leaf is missing, changed or expired.')
  const target = members.find(member => member.leafId === selection.leaf)
  if (!target || target.identity !== sender || target.own || target.pending || target.device === localDevice || target.homeBox !== node ||
      !Number.isSafeInteger(target.bindingExpiresAt) || target.bindingExpiresAt <= now || !hex(target.device)) throw new Error('Select a current committed nonlocal device belonging to this account on the selected node.')
  if (members.some(member => member.device === target.device && (member.identity !== sender || member.pending || member.own || member.homeBox !== node))) throw new Error('The target device has conflicting native roster bindings.')
  return target
}

// Separate protected object: no changes to legacy membership versions.
const requestRecord = bytesToHex(new TextEncoder().encode('kithmoot.admin-storage-requests.v1'))
interface DestinationBinding { operation: string; sender: string; keeper: string; device: string; node: string; box: PairedBox; permission: Event; transmitter: string; source?: { session: string; leaf: string } }
interface Binding extends DestinationBinding { revision: number; attempts: MlsStandaloneObservation[]; history: { binding: DestinationBinding; observation?: MlsStandaloneObservation }[] }
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
function validateDestination(b: DestinationBinding): boolean {
  if (!b?.permission) return false
  const p = readKeeperInboxPermission(b.permission, b.permission.created_at)
  if (p.keeper !== b.keeper || p.device !== b.transmitter || p.node !== b.node) return false
  return !!b && exact(b, ['box','device','keeper','node','operation','permission','sender','transmitter', ...(b.source ? ['source'] : [])].sort().join(',')) && (!b.source || exact(b.source, 'leaf,session') && hex(b.source.session) && hex(b.source.leaf)) &&
    [b.operation,b.sender,b.keeper,b.device,b.node,b.transmitter].every(hex) && b.sender !== b.keeper &&
    b.operation === mlsStandaloneRevocationOperation(b.sender, b.keeper, b.device) && !!b.box && exact(b.box, 'eventUrl,routeId') &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(b.box.routeId) && mlsBoxNode(b.box) === b.node
}
const destination = ({ revision: _revision, history: _history, attempts: _attempts, ...binding }: Binding): DestinationBinding => binding
async function bindings(tx: PersonaReader): Promise<Binding[]> {
  const bytes = await tx.readVault(requestRecord)
  if (!bytes) return []
  const invalid = (): never => { throw new InvalidPersonaRecord('Unsupported or damaged Admin2 storage request binding') }
  try {
    if (bytes.length > 512 * 1024) invalid()
    const j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!j || !exact(j, 'records,version') || j.version !== 1 || !Array.isArray(j.records) || j.records.length > 64) invalid()
    for (const b of j.records as Binding[]) {
      if (!b || !exact(b, ['attempts','box','device','history','keeper','node','operation','permission','revision','sender','transmitter', ...(b.source ? ['source'] : [])].sort().join(',')) || !validateDestination(destination(b)) ||
        !revision(b.revision) || !Array.isArray(b.attempts) || b.attempts.length > 64 || new Set(b.attempts.map(a => a.requestRevision)).size !== b.attempts.length || !Array.isArray(b.history) || b.history.length > 16 || b.revision !== b.history.length) invalid()
      for (const observed of b.attempts) {
        if (!observed.attempt || observed.operation !== b.operation || observed.sender !== b.sender || observed.keeper !== b.keeper || observed.device !== b.device) invalid()
        try { validateMlsStandaloneState({ checkedAt: Math.max(observed.observedAt, observed.attempt!.createdAt), observations: [observed] }) } catch { invalid() }
      }
      for (const h of b.history) {
        if (!h || !exact(h, h.observation ? 'binding,observation' : 'binding') || !validateDestination(h.binding) || h.binding.operation !== b.operation) invalid()
        if (h.observation) {
          const observed = h.observation
          const at = Math.max(observed.observedAt, observed.attempt?.createdAt ?? 0)
          try { validateMlsStandaloneState({ checkedAt: at, observations: [observed] }) } catch { invalid() }
          if (observed.operation !== b.operation || observed.sender !== b.sender || observed.keeper !== b.keeper || observed.device !== b.device) invalid()
        }
      }
    }
    if (new Set(j.records.map((b: Binding) => b.operation)).size !== j.records.length) invalid()
    return j.records
  } finally { bytes.fill(0) }
}
const legacyOutboxRecord = bytesToHex(new TextEncoder().encode('kithmoot.mls-membership.v1'))
/** Migrate only exactly bound canonical observations in one witnessed edit.
 * Ambiguity persists a critical shared fence with every original field intact;
 * old v1 readers reject that object before public discovery or crypto. */
export async function isolateLegacyStorageRequests(tx: PersonaTransaction): Promise<'ready' | 'fenced'> {
  const records = await bindings(tx)
  if (!records.length) return 'ready'
  const byOperation = new Map(records.map(b => [b.operation, b])), legacy = await readMlsMembership(tx)
  const older = legacy.requests.filter(r => byOperation.has(r.operation))
  const candidates = legacy.standalone?.observations.filter(r => byOperation.has(r.operation)) ?? []
  if (!older.length && !candidates.length) return 'ready'
  const fence = async (reason: string): Promise<'fenced'> => {
    const original = await tx.readVault(legacyOutboxRecord)
    if (!original) throw new InvalidPersonaRecord('The legacy recovery predecessor disappeared')
    try {
      const preserved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original))
      const bytes = new TextEncoder().encode(JSON.stringify({ ...preserved, version: 2,
        adminStorageRecoveryFence: { version: 1, originalVersion: 1, reason, operations: [...new Set([...older, ...candidates].map(r => r.operation))].sort() } }))
      try { if (bytes.length > 1024 * 1024 + 8192) throw new Error('The preserved recovery fence is too large.'); await tx.putVault(legacyOutboxRecord, bytes) } finally { bytes.fill(0) }
      return 'fenced'
    } finally { original.fill(0) }
  }
  if (older.length) return fence('unsupported-legacy-request-form')
  const ownTx = storageOutboxTransactionForMigration(tx), own = await readMlsMembership(ownTx)
  if (own.requests.length || own.removals.length || own.inbox) return fence('ambiguous-isolated-outbox')
  const ownState = own.standalone ?? { checkedAt: legacy.standalone!.checkedAt, observations: [] }
  for (const observation of candidates) {
    const bound = byOperation.get(observation.operation)!
    if (observation.sender !== bound.sender || observation.keeper !== bound.keeper || observation.device !== bound.device || !observation.boxes.includes(bound.node)) return fence('binding-differs')
    const p = observation.attempt?.private
    if (p && ![destination(bound), ...bound.history.map(h => h.binding)].some(b => b.keeper === p.keeper && b.node === p.node && b.box.routeId === p.routeId && b.box.eventUrl === p.eventUrl && b.permission.id === p.permissionId && b.transmitter === p.transmittingDevice)) return fence('unmatched-private-attempt')
    const previous = ownState.observations.find(r => r.operation === observation.operation)
    if (previous && JSON.stringify(previous) !== JSON.stringify(observation)) return fence('different-isolated-observation')
  }
  const operations = new Set(candidates.map(r => r.operation))
  ownState.checkedAt = Math.max(ownState.checkedAt, legacy.standalone!.checkedAt)
  for (const observation of candidates) if (!ownState.observations.some(r => r.operation === observation.operation)) ownState.observations.push(structuredClone(observation))
  ownState.observations.sort((a, b) => a.operation.localeCompare(b.operation))
  if (ownState.observations.length > 64) return fence('isolated-outbox-full')
  own.standalone = ownState
  legacy.standalone!.observations = legacy.standalone!.observations.filter(r => !operations.has(r.operation))
  await saveMlsMembership(ownTx, own); await saveMlsMembership(tx, legacy)
  return 'ready'
}
/** Direct native preparation requires the migration preflight to have
 * settled; it cannot roll back a critical recovery fence by throwing. */
export async function refuseLegacyStorageRequests(tx: PersonaReader): Promise<void> {
  const records = await bindings(tx)
  if (!records.length) return
  const operations = new Set(records.map(b => b.operation)), legacy = await readMlsMembership(tx)
  if (legacy.requests.some(r => operations.has(r.operation)) || legacy.standalone?.observations.some(r => operations.has(r.operation))) throw new InvalidPersonaRecord('Pre-isolation Admin2 request needs witnessed outbox recovery first.')
}
export async function adminStorageRequestRevision(tx: PersonaReader, operation: string): Promise<{ operation: string; bindingRevision: number; requestRevision: number }> {
  const b = (await bindings(tx)).find(b => b.operation === operation), observed = (await readMlsMembership(storageOutboxReader(tx))).standalone?.observations.find(o => o.operation === operation)
  if (!b || !observed) throw new Error('No retained Admin2 storage request exists.')
  return { operation, bindingRevision: b.revision, requestRevision: observed.requestRevision }
}
export async function adminStorageRequestSource(tx: PersonaReader, operation: string, sender: string): Promise<AdminStorageRequestSelection & { operation: string; device: string; source: { session: string; leaf: string } }> {
  const b = (await bindings(tx)).find(b => b.operation === operation)
  if (!b || b.sender !== sender || !b.source) throw new Error('Rebind this request through the actual saved Admin2 room before sending; no native source may be invented.')
  return { operation, device: b.device, source: { ...b.source }, leaf: b.source.leaf, expectedStorageKeeper: b.keeper, box: { ...b.box }, permission: structuredClone(b.permission) }
}
/** A rebind and all sends hold this operation across actual network/witness
 * settlement. Cancellation waits for that settlement; it cannot overwrite an
 * in-flight destination in another tab. Legacy sends can run without this. */
export async function withAdminStorageRequestGate<T>(sender: string, operation: string, work: () => Promise<T>, mode: 'shared' | 'exclusive' = 'exclusive'): Promise<T> {
  if (!hex(sender) || !hex(operation) || !globalThis.navigator?.locks) throw new Error('Admin2 storage requests require the cross-tab operation gate.')
  return await navigator.locks.request(`kithmoot.admin-storage-request.${sender}.${operation}`, { mode }, work)
}
export async function retainAdminStorageRequest(tx: PersonaTransaction, sender: string, localDevice: string, target: MlsMemberStatus, selection: AdminStorageRequestSelection): Promise<void> {
  await refuseLegacyStorageRequests(tx)
  const records = await bindings(tx), operation = mlsStandaloneRevocationOperation(sender, selection.expectedStorageKeeper, target.device)
  const next: DestinationBinding = { operation, sender, keeper: selection.expectedStorageKeeper, device: target.device, node: target.homeBox,
    box: { ...selection.box }, permission: structuredClone(selection.permission), transmitter: localDevice, ...(selection.source ? { source: { ...selection.source } } : {}) }
  const previous = records.find(b => b.operation === operation)
  if (selection.rebind) {
    const expected = selection.rebind, observed = (await readMlsMembership(storageOutboxReader(tx))).standalone?.observations.find(o => o.operation === operation)
    if (!previous || expected.operation !== operation || !revision(expected.bindingRevision) || !revision(expected.requestRevision) ||
      previous.revision !== expected.bindingRevision || observed?.requestRevision !== expected.requestRevision) throw new Error('The storage destination or request revision changed. Review the rebind again.')
    if (previous.history.length >= 16) throw new Error('This storage request has reached its retained replacement limit.')
    const history = [...previous.history, { binding: destination(previous), ...(observed ? { observation: structuredClone(observed) } : {}) }]
    records[records.indexOf(previous)] = { ...next, revision: previous.revision + 1, attempts: previous.attempts, history }
  } else if (previous && JSON.stringify(destination(previous)) !== JSON.stringify(next)) {
    throw new Error('The retained Admin2 storage request destination changed. Explicitly review a replacement at its current binding and request revisions.')
  } else if (!previous) records.push({ ...next, revision: 0, attempts: [], history: [] })
  if (records.length > 64) throw new Error('Admin2 storage request custody is full.')
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, records }))
  try { if (bytes.length > 512 * 1024) throw new Error('Admin2 storage request custody is full.'); await tx.putVault(requestRecord, bytes) } finally { bytes.fill(0) }
}
/** Retain transport evidence before fresh wrapping or expiry pruning. This
 * own bounded object leaves the legacy expiring-attempt schema unchanged. */
export async function retainAdminStorageAttempt(tx: PersonaTransaction, observation: MlsStandaloneObservation): Promise<void> {
  if (!observation.attempt) return
  const records = await bindings(tx), b = records.find(b => b.operation === observation.operation)
  if (!b) return
  const previous = b.attempts.find(a => a.requestRevision === observation.requestRevision)
  if (previous) {
    const old = structuredClone(previous.attempt!), next = structuredClone(observation.attempt)
    const acknowledged = next.confirmed; old.confirmed = false; next.confirmed = false
    if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error('Retained storage request attempt changed at the same revision.')
    if (!acknowledged || previous.attempt!.confirmed) return
    previous.attempt!.confirmed = true
  } else {
    if (b.attempts.length >= 64) throw new Error('This storage request has reached its retained attempt limit.')
    b.attempts.push(structuredClone(observation))
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, records }))
  try { if (bytes.length > 512 * 1024) throw new Error('Admin2 storage request custody is full.'); await tx.putVault(requestRecord, bytes) } finally { bytes.fill(0) }
}
/** Called before wrapping or network. Admin2 requests have no public path. */
export async function checkAdminStorageDelivery(tx: PersonaReader, operation: string, sender: string, selected?: { keeper: string; routeId: string; eventUrl: string; node: string; permissionId: string; transmittingDevice: string }): Promise<boolean> {
  const b = (await bindings(tx)).find(b => b.operation === operation)
  if (!b) return false
  if (!selected || b.sender !== sender || b.keeper !== selected.keeper || b.box.routeId !== selected.routeId || b.box.eventUrl !== selected.eventUrl ||
      b.node !== selected.node || b.permission.id !== selected.permissionId || b.transmitter !== selected.transmittingDevice) throw new Error('Admin2 storage requests require the exact retained private route, permission, transmitting device and independently selected keeper. No public fallback is allowed.')
  return true
}
