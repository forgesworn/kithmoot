/** Estimated effectiveType, RTT and throughput describe congestion, not a
 * changed route. Restarting a call for those estimates creates more churn. */
export function watchNodeNetwork(window: EventTarget | undefined,
  connection: (EventTarget & { type?: string }) | undefined, reconnect: () => void): () => void {
  let physical = connection?.type
  const changed = () => {
    if (!connection?.type || connection.type === physical) return
    physical = connection.type; reconnect()
  }
  window?.addEventListener('online', reconnect)
  connection?.addEventListener('change', changed)
  return () => {
    window?.removeEventListener('online', reconnect)
    connection?.removeEventListener('change', changed)
  }
}
