import type { RoomSession } from '../../src/session.js'
import type { RelayTransport } from '../../src/relay-pool.js'

/** Revoke ordinary session ownership synchronously on EVERY policy revision,
 * including an unobserved private-to-Nostr round trip. Closing the outer
 * transport comes before leave(), so even its farewell or a late external
 * credential signature cannot inherit a freshly authorised public delegate.
 * Paired private routes retain their existing session and signer ownership. */
export function retireAccountNetworkRooms(rooms: readonly {
  session: Pick<RoomSession, 'leave'>
  transport?: Pick<RelayTransport, 'close'>
  privateRoute: boolean
}[]): Promise<PromiseSettledResult<void>[]> {
  const seen = new Set<Pick<RoomSession, 'leave'>>()
  const leaving: Promise<void>[] = []
  for (const room of rooms) {
    if (room.privateRoute || seen.has(room.session)) continue
    seen.add(room.session)
    // Continue revoking all rooms even if one transport's cleanup fails.
    try { room.transport?.close() } catch { /* leave still revokes the session. */ }
    try { leaving.push(room.session.leave()) } catch (error) { leaving.push(Promise.reject(error)) }
  }
  return Promise.allSettled(leaving)
}
