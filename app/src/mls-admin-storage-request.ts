import { bytesToHex } from '@noble/hashes/utils.js'
import type { PersonaReader, PersonaTransaction } from './mls-persona-coordinator.js'
import { InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { mlsStandaloneRevocationOperation } from './mls-revocation-binding.js'
import type { Event } from 'nostr-tools/pure'
import type { MlsMemberStatus } from './mls-room-operations.js'
import type { PairedBox } from './browser-link.js'
import { mlsBoxNode } from './mls-grant-ledger.js'
import { readKeeperInboxPermission } from './mls-keeper-permissions.js'
import { readMlsMembership } from './mls-membership-store.js'
import { validateMlsStandaloneState, type MlsStandaloneObservation } from './mls-revocation-outbox-store.js'
export interface AdminStorageRequestSelection { leaf: string; expectedStorageKeeper: string; box: PairedBox; permission: Event; rebind?: { operation: string; bindingRevision: number; requestRevision: number } }
/** Only called with the host's native, witnessed roster and current credential.
 * Permission signatures do not establish the operator's intended keeper. */
export function adminStorageRequestTarget(sender: string, localDevice: string, members: readonly MlsMemberStatus[], selection: AdminStorageRequestSelection, now: number): MlsMemberStatus {
  const hex = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  if (![sender, localDevice, selection.leaf, selection.expectedStorageKeeper].every(hex) || selection.expectedStorageKeeper === sender) throw new Error('Independently select the expected storage keeper and a different enrolled device.')
  const permission = readKeeperInboxPermission(selection.permission, now), node = mlsBoxNode(selection.box)
  if (permission.keeper !== selection.expectedStorageKeeper || permission.node !== node || permission.device !== localDevice) throw new Error('The signed permission differs from the expected storage keeper, selected node or current transmitting device.')
  const target = members.find(member => member.leafId === selection.leaf)
  if (!target || target.identity !== sender || target.own || target.pending || target.device === localDevice || target.homeBox !== node ||
      !Number.isSafeInteger(target.bindingExpiresAt) || target.bindingExpiresAt <= now || !hex(target.device)) throw new Error('Select a current committed nonlocal device belonging to this account on the selected node.')
  if (members.some(member => member.device === target.device && (member.identity !== sender || member.pending || member.own || member.homeBox !== node))) throw new Error('The target device has conflicting native roster bindings.')
  return target
}

// Separate protected object: no changes to legacy membership versions.
const requestRecord = bytesToHex(new TextEncoder().encode('kithmoot.admin-storage-requests.v1'))
interface DestinationBinding { operation: string; sender: string; keeper: string; device: string; node: string; box: PairedBox; permission: Event; transmitter: string }
interface Binding extends DestinationBinding { revision: number; attempts: MlsStandaloneObservation[]; history: { binding: DestinationBinding; observation?: MlsStandaloneObservation }[] }
const exact = (v: object, keys: string) => Object.keys(v).sort().join(',') === keys
const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
function validateDestination(b: DestinationBinding): boolean {
  if (!b?.permission) return false
  const p = readKeeperInboxPermission(b.permission, b.permission.created_at)
  if (p.keeper !== b.keeper || p.device !== b.transmitter || p.node !== b.node) return false
  return !!b && exact(b, 'box,device,keeper,node,operation,permission,sender,transmitter') &&
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
      if (!b || !exact(b, 'attempts,box,device,history,keeper,node,operation,permission,revision,sender,transmitter') || !validateDestination(destination(b)) ||
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
export async function adminStorageRequestRevision(tx: PersonaReader, operation: string): Promise<{ operation: string; bindingRevision: number; requestRevision: number }> {
  const b = (await bindings(tx)).find(b => b.operation === operation), observed = (await readMlsMembership(tx)).standalone?.observations.find(o => o.operation === operation)
  if (!b || !observed) throw new Error('No retained Admin2 storage request exists.')
  return { operation, bindingRevision: b.revision, requestRevision: observed.requestRevision }
}
/** A rebind and all sends hold this operation across actual network/witness
 * settlement. Cancellation waits for that settlement; it cannot overwrite an
 * in-flight destination in another tab. Legacy sends can run without this. */
export async function withAdminStorageRequestGate<T>(sender: string, operation: string, work: () => Promise<T>, mode: 'shared' | 'exclusive' = 'exclusive'): Promise<T> {
  if (!hex(sender) || !hex(operation) || !globalThis.navigator?.locks) throw new Error('Admin2 storage requests require the cross-tab operation gate.')
  return await navigator.locks.request(`kithmoot.admin-storage-request.${sender}.${operation}`, { mode }, work)
}
export async function retainAdminStorageRequest(tx: PersonaTransaction, sender: string, localDevice: string, target: MlsMemberStatus, selection: AdminStorageRequestSelection): Promise<void> {
  const records = await bindings(tx), operation = mlsStandaloneRevocationOperation(sender, selection.expectedStorageKeeper, target.device)
  const next: DestinationBinding = { operation, sender, keeper: selection.expectedStorageKeeper, device: target.device, node: target.homeBox,
    box: { ...selection.box }, permission: structuredClone(selection.permission), transmitter: localDevice }
  const previous = records.find(b => b.operation === operation)
  if (selection.rebind) {
    const expected = selection.rebind, observed = (await readMlsMembership(tx)).standalone?.observations.find(o => o.operation === operation)
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
