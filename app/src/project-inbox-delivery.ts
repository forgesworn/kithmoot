import type { Event } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'

/** Recipient lookup can outlive a membership change. Recheck after lookup;
 * the pool must also check before each delayed socket write. */
export async function deliverGuardedProjectInbox(wrap: Event, recipient: string, current: () => boolean, options: {
  targets(recipient: string): Promise<string[]>
  pool(targets: string[]): Pick<RelayTransport, 'publishGuarded' | 'close'>
}): Promise<void> {
  if (!current()) return
  const targets = await options.targets(recipient)
  if (!targets.length || !current()) return
  const pool = options.pool(targets)
  try {
    if (!current()) return
    if (!pool.publishGuarded) throw new Error('This connection cannot safely deliver project logos')
    await pool.publishGuarded(wrap, current)
  } finally { pool.close() }
}
