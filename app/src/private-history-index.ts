/**
 * The one currently supported path from recovered relay material into the
 * encrypted device-local index: an addressed NIP-17 direct-message gift wrap
 * that the selected signer can open.  Raw history is retained by Bothy first;
 * this module never sends plaintext, query terms or a decryption failure back
 * to a relay or box.
 */
import { getEventHash, type Event } from 'nostr-tools/pure'
import { verifyEventUncached } from '../../src/verify.js'
import type { PrivateMigrationIdentity } from '../../src/private-migration.js'
import type { ImportedHistoryDocument, LocalHistoryIndex } from './history-index.js'

const HEX = /^[0-9a-f]{64}$/
const GIFT_WRAP_KIND = 1059
const SEAL_KIND = 13
const NIP17_DIRECT_MESSAGE_KIND = 14
const MAX_TEXT_BYTES = 64 * 1024

/** Opens one NIP-17 outer wrapper, or returns no document when it is not an
 * addressed direct message the current signer is entitled to read. Relay
 * material is deliberately treated as hostile and decryption failures are
 * not observable outside this process. */
export async function openIndexableNip17GiftWrap(input: {
  event: Event
  identity: PrivateMigrationIdentity
}): Promise<ImportedHistoryDocument | undefined> {
  try {
    const { event, identity } = input
    if (!HEX.test(identity.pubkey) || event.kind !== GIFT_WRAP_KIND || !hasRecipient(event.tags, identity.pubkey) || !verifyEventUncached(event)) return
    const seal = JSON.parse(await identity.decrypt(event.pubkey, event.content)) as Event
    if (!validEvent(seal) || seal.kind !== SEAL_KIND || seal.tags.length !== 0 || !verifyEventUncached(seal)) return
    const rumor = JSON.parse(await identity.decrypt(seal.pubkey, seal.content)) as Record<string, unknown>
    if (!validRumor(rumor) || rumor.pubkey !== seal.pubkey || rumor.kind !== NIP17_DIRECT_MESSAGE_KIND || !hasRecipient(rumor.tags, identity.pubkey)) return
    if (new TextEncoder().encode(rumor.content).byteLength > MAX_TEXT_BYTES) return
    return {
      // The signed outer wrapper is what the importer and custody store retain.
      // Keep its ID inside the local ciphertext too, so local deletion is tied
      // to the actual retained record rather than an unsigned rumour.
      id: event.id,
      participant: rumor.pubkey,
      conversation: 'nip17',
      sentAt: rumor.created_at,
      text: rumor.content,
    }
  } catch { return }
}

/** Adds only documents the selected signer could open, and reports each
 * local outcome for an honest recovery receipt. */
export async function indexAccessibleNip17GiftWraps(input: {
  events: readonly Event[]
  identity: PrivateMigrationIdentity
  index: LocalHistoryIndex
}): Promise<{ stored: number; duplicate: number; retired: number; inaccessible: number }> {
  const result = { stored: 0, duplicate: 0, retired: 0, inaccessible: 0 }
  for (const event of input.events) {
    const document = await openIndexableNip17GiftWrap({ event, identity: input.identity })
    if (!document) { result.inaccessible++; continue }
    const outcome = await input.index.add(document)
    result[outcome]++
  }
  return result
}

function validEvent(value: unknown): value is Event {
  const event = value as Event
  return !!event && HEX.test(event.id) && HEX.test(event.pubkey) && Number.isSafeInteger(event.created_at) && event.created_at >= 0 &&
    Number.isSafeInteger(event.kind) && Array.isArray(event.tags) && typeof event.content === 'string'
}

function validRumor(value: Record<string, unknown>): value is { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string } {
  return HEX.test(value.id as string) && HEX.test(value.pubkey as string) && Number.isSafeInteger(value.kind) &&
    Number.isSafeInteger(value.created_at) && (value.created_at as number) >= 0 && Array.isArray(value.tags) &&
    (value.tags as unknown[]).every(tag => Array.isArray(tag) && tag.every(item => typeof item === 'string')) && typeof value.content === 'string' &&
    value.id === getEventHash({ pubkey: value.pubkey as string, kind: value.kind as number, created_at: value.created_at as number, tags: value.tags as string[][], content: value.content as string })
}

function hasRecipient(tags: unknown, recipient: string): boolean {
  return Array.isArray(tags) && tags.some(tag => Array.isArray(tag) && tag.length >= 2 && tag[0] === 'p' && tag[1] === recipient)
}
