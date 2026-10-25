import { bytesToHex } from '@noble/hashes/utils.js'
import type { BrowserPersonaCoordinator, PersonaTransaction } from './mls-persona-coordinator.js'
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
