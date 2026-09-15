/**
 * The local half of an honest imported-history deletion.
 *
 * A private custody barrier is recorded first. Only its authenticated
 * `recorded` or `duplicate` receipt permits the encrypted device index to
 * remove the same outer event ID. A failed or missing box receipt therefore
 * cannot turn into an unqualified claim that the item was deleted.
 */
import { submitPrivateMigrationRequest, type PrivateMigrationIdentity, type PrivateMigrationReply, type RelayTransport } from '../../src/index.js'
import type { LocalHistoryIndex } from './history-index.js'

export type PrivateHistoryDeletionOutcome = {
  box: 'recorded' | 'duplicate'
  device: 'removed' | 'already-removed'
}

export async function deleteImportedHistory(input: {
  eventId: string
  index: Pick<LocalHistoryIndex, 'remove'>
  /** Calls the selected box over the authenticated private migration path. */
  recordPrivateTombstone: (eventId: string) => Promise<'recorded' | 'duplicate'>
}): Promise<PrivateHistoryDeletionOutcome> {
  const box = await input.recordPrivateTombstone(input.eventId)
  if (box !== 'recorded' && box !== 'duplicate') throw new Error('The selected box did not record a deletion barrier.')
  const removed = await input.index.remove(input.eventId)
  return { box, device: removed ? 'removed' : 'already-removed' }
}

/** Send the governed private delete request and accept only its authenticated
 * receipt. The caller owns the order with local deletion and public requests. */
export async function recordPrivateHistoryTombstone(input: {
  eventId: string
  identity: PrivateMigrationIdentity
  node: string
  nonce: string
  transport: Pick<RelayTransport, 'publish' | 'subscribe'>
}): Promise<'recorded' | 'duplicate'> {
  const reply = await submitPrivateMigrationRequest({
    identity: input.identity,
    node: input.node,
    operation: { op: 'delete', id: input.eventId },
    nonce: input.nonce,
    transport: input.transport,
  })
  return deletionOutcome(reply)
}

function deletionOutcome(reply: PrivateMigrationReply): 'recorded' | 'duplicate' {
  const outcome = reply.result?.outcome
  if (reply.ok && (outcome === 'recorded' || outcome === 'duplicate')) return outcome
  const detail = reply.error?.message || reply.error?.code || 'no governed deletion receipt'
  throw new Error(`The selected box did not record this deletion barrier: ${detail}`)
}
