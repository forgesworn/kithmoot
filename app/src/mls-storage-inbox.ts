import { bytesToHex } from '@noble/hashes/utils.js'
import { isolateLegacyStorageRequests } from './mls-admin-storage-request.js'
import type { BrowserPersonaCoordinator, PersonaReader, PersonaTransaction } from './mls-persona-coordinator.js'
const legacy = bytesToHex(new TextEncoder().encode('kithmoot.mls-membership.v1'))
const storage = bytesToHex(new TextEncoder().encode('kithmoot.storage-inbox.v1'))
/** Reuse the strict inbox schema in an independent protected object. All
 * seen IDs, prompts, budgets and private/public cursors stay mode-local.
 * This adapter cannot alias room or credential/grant custody objects. */
export function storageInboxTransaction(tx: PersonaTransaction): PersonaTransaction {
  const key = (id: string) => id === legacy ? storage : id
  return { installation: tx.installation, readVault: id => tx.readVault(key(id)), putVault: (id, bytes) => tx.putVault(key(id), bytes),
    dropVault: id => tx.dropVault(key(id)), readSession: tx.readSession.bind(tx), putSession: tx.putSession.bind(tx), dropSession: tx.dropSession.bind(tx) }
}
export function storageInboxCoordinator(coordinator: Pick<BrowserPersonaCoordinator, 'transact'>): Pick<BrowserPersonaCoordinator, 'transact'> {
  return { transact: (persona, change, current, activated) => coordinator.transact(persona, (tx, witness) => change(storageInboxTransaction(tx), witness), current, activated) }
}

const outboxAuthorities = new WeakMap<object, Pick<BrowserPersonaCoordinator, 'transact'>>()
export function storageOutboxAuthority(coordinator: Pick<BrowserPersonaCoordinator, 'transact'>): Pick<BrowserPersonaCoordinator, 'transact'> { return outboxAuthorities.get(coordinator) ?? coordinator }
const outbox = bytesToHex(new TextEncoder().encode('kithmoot.admin-storage-outbox.v1'))
/** Admin2 requests never inhabit legacy standalone state. An old public
 * outbox therefore has no observation or transport attempt to send. */
export function storageOutboxReader(tx: PersonaReader): PersonaReader {
  return { installation: tx.installation, readVault: id => tx.readVault(id === legacy ? outbox : id), readSession: tx.readSession.bind(tx) }
}
export function storageOutboxTransaction(tx: PersonaTransaction): PersonaTransaction {
  const key = (id: string) => id === legacy ? outbox : id
  return { installation: tx.installation, readVault: id => tx.readVault(key(id)), putVault: (id, bytes) => tx.putVault(key(id), bytes),
    dropVault: id => tx.dropVault(key(id)), readSession: tx.readSession.bind(tx), putSession: tx.putSession.bind(tx), dropSession: tx.dropSession.bind(tx) }
}
export function storageOutboxCoordinator(coordinator: Pick<BrowserPersonaCoordinator, 'transact'>): Pick<BrowserPersonaCoordinator, 'transact'> {
  const scoped: Pick<BrowserPersonaCoordinator, 'transact'> = { transact: async (persona, change, current, activated) => {
    const result = await coordinator.transact(persona, async (tx, witness) => {
      if (await isolateLegacyStorageRequests(tx) === 'fenced') return { isolated: false as const }
      return { isolated: true as const, value: await change(storageOutboxTransaction(tx), witness) }
    }, current, activated)
    if (result.state !== 'active') return result
    if (!result.value.isolated) throw new Error('Admin2 outbox recovery is fenced; original legacy and isolated evidence was retained.')
    return { ...result, value: result.value.value }
  } }
  outboxAuthorities.set(scoped, coordinator)
  return scoped
}
