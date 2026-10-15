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

type NodeEmitter = {
  on(event: string, listener: () => void): unknown
  once(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

/** Node ws emits an asynchronous error when an unfinished handshake is
 * closed, and throws it when nobody listens. nostr-tools 2.25.2 closes a
 * timed-out handshake itself after dropping its own observer, before
 * `closingAbandoned` can attach one, so an unreachable relay would end the
 * process. Observe errors for the handshake only; browsers and Node's native
 * WebSocket have no `on` and no such throw. */
export function handshakeObservedWebSocket(Base: typeof WebSocket): typeof WebSocket {
  return class extends Base {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args)
      const socket = this as unknown as Partial<NodeEmitter>
      if (!socket.on || !socket.once || !socket.removeListener) return
      const observed = () => {}
      const detach = () => {
        socket.removeListener!('error', observed)
        socket.removeListener!('open', detach)
        socket.removeListener!('close', detach)
      }
      socket.on('error', observed)
      socket.once('open', detach)
      socket.once('close', detach)
    }
  }
}
