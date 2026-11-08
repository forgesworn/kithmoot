import type { Event } from 'nostr-tools/pure'
import { nodeMigrationDigest, type NodeMigrationHistory } from '@forgesworn/fold-kit/node-migration'
import type { NodeRoomRecord } from '@forgesworn/fold-kit/node-room'
import { assertNodeRoomTransport } from './kithmoot-node.js'
import type { RelayPoolClient } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'

export interface MigrationHistoryEntry { event: Event; quiet?: boolean }
export interface MigrationHistorySnapshot {
  /** A source must report truncation, failed storage or incomplete reads. */
  complete: boolean
  entries: readonly MigrationHistoryEntry[]
}
export interface MigrationHistoryTarget {
  publish(event: Event): Promise<void>
  read(ids: string[]): Promise<{ events: Event[]; complete: boolean }>
}
const bytes = new TextEncoder()
const wire = (event: Event): string => JSON.stringify([event.id, event.pubkey, event.created_at, event.kind, event.tags, event.content, event.sig])
const copy = (event: Event): Event => JSON.parse(JSON.stringify(event)) as Event
const check = (condition: unknown, reason: string): void => { if (!condition) throw new Error(reason) }

/** Use the pinned authenticated room connection. Subscription callbacks may
 * fire on a local deadline, so only query's explicit completeness counts. */
export function nodeMigrationHistoryTarget(node: NodeRoomRecord, device: string, transport: RelayPoolClient): MigrationHistoryTarget {
  check(node.existing, 'Migration needs an existing-room node profile')
  assertNodeRoomTransport(transport, node, device)
  return {
    publish: event => transport.publish(event),
    read: ids => transport.query(node.relay, [{ ids, limit: ids.length }], 10_000, ids.length + 1),
  }
}

/** Copy original signed encrypted events and verify their return before
 * signing readiness. This performs no route switch or source deletion.
 * `accept` must recheck room/stream/epoch ownership, not just signatures.
 * Snapshots describe retained history; a relay's EOSE cannot prove that a
 * public relay has never forgotten an older event. */
export async function copyNodeMigrationHistory(options: {
  snapshots: readonly MigrationHistorySnapshot[]
  target: MigrationHistoryTarget
  accept: (event: Event) => boolean | Promise<boolean>
  now: () => number
  current: () => boolean
  signal?: AbortSignal
  maxEvents?: number
  maxBytes?: number
}): Promise<NodeMigrationHistory> {
  const maxEvents = options.maxEvents ?? 100_000, maxBytes = options.maxBytes ?? 128 * 1024 * 1024
  check(Number.isSafeInteger(maxEvents) && maxEvents > 0 && maxEvents <= 1_000_000
    && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'Invalid migration history bounds')
  const stillCurrent = (): void => { options.signal?.throwIfAborted(); check(options.current(), 'Migration changed during history transfer') }
  stillCurrent()
  check(options.snapshots.length > 0 && options.snapshots.every(s => s.complete), 'History source did not complete')
  const originals = new Map<string, Event>()
  let totalBytes = 0
  for (const snapshot of options.snapshots) for (const entry of snapshot.entries) {
    stillCurrent()
    check(!entry.quiet, 'Quiet history needs its original sealed carrier')
    const event = copy(entry.event)
    check(bytes.encode(wire(event)).byteLength <= 131_072 && verifyEventUncached(event), 'Invalid original history event')
    check(await options.accept(copy(event)), 'History event does not belong to this room')
    // Never republish expired messages, nor reinterpret malformed NIP-40 tags
    // as an absent expiry. Neither creates a fresh retention period.
    const expiry = event.tags.filter(t => t[0] === 'expiration')
    if (expiry.length) {
      check(expiry.length === 1 && expiry[0]!.length === 2 && /^[1-9][0-9]*$/.test(expiry[0]![1]!)
        && Number.isSafeInteger(Number(expiry[0]![1])), 'Invalid original history expiry')
      if (Number(expiry[0]![1]) <= options.now()) continue
    }
    const prior = originals.get(event.id)
    check(!prior || wire(prior) === wire(event), 'Conflicting original history event')
    if (!prior) {
      originals.set(event.id, event); totalBytes += bytes.encode(wire(event)).byteLength
      check(originals.size <= maxEvents && totalBytes <= maxBytes, 'History exceeds migration bounds')
    }
  }
  // Validate every source before the first network write. Partial copies may
  // remain after a failure, but they never authorise readiness or cutover.
  const events = [...originals.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (let offset = 0; offset < events.length; offset += 32) {
    const batch = events.slice(offset, offset + 32)
    for (const event of batch) { stillCurrent(); await options.target.publish(copy(event)); stillCurrent() }
    const read = await options.target.read(batch.map(event => event.id))
    stillCurrent(); check(read.complete, 'Node history readback did not complete')
    const returned = new Map<string, Event>()
    for (const raw of read.events) {
      const event = copy(raw)
      check(verifyEventUncached(event) && originals.has(event.id), 'Invalid node history readback')
      check(wire(event) === wire(originals.get(event.id)!), 'Node changed original history')
      returned.set(event.id, event)
    }
    check(batch.every(event => returned.has(event.id)), 'Node did not retain original history')
  }
  stillCurrent()
  return { events: events.length, digest: nodeMigrationDigest(events.map(event => event.id)) }
}
