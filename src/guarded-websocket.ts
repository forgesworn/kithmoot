/** Check immediately before the underlying write. Dropping a cancelled frame
 * is deliberate: nostr-tools schedules send() in a promise callback without
 * catching a thrown socket error. The owner closes the connection and rejects
 * the operation separately. This wrapper owns no queue or retry. */
export function guardedWebSocket(Base: typeof WebSocket, current: () => boolean): typeof WebSocket {
  return class extends Base {
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (!current()) return
      super.send(data)
    }
  }
}
