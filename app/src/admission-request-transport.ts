import type { RelayTransport } from '../../src/relay-pool.js'

/** The helper retries one request. Coalesce overlapping attempts while a relay
 * is connecting, and protect the actual write from cancellation or account
 * replacement. A relay ACK is separate from the host's admission decision. */
export function admissionRequestTransport(pool: RelayTransport, opts: {
  current(): boolean; phase(value: 'sending' | 'waiting' | 'reconnecting'): void
}): RelayTransport {
  let inFlight: Promise<void> | undefined
  let request: string | undefined
  let confirmed = false
  let closed = false
  const current = () => !closed && opts.current()
  return {
    close: () => { if (closed) return; closed = true; pool.close() },
    subscribe: (filters, receive, eose) => current()
      ? pool.subscribe(filters, (event, via) => { if (current()) receive(event, via) }, () => { if (current()) eose?.() })
      : () => {},
    publish: event => {
      if (!current() || event.kind !== 20466 || !pool.publishGuarded) return Promise.reject(new Error('Admission request is no longer available.'))
      if (request && request !== event.id) return Promise.reject(new Error('Another admission request is already active.'))
      request = event.id
      if (inFlight) return inFlight
      if (!confirmed) opts.phase('sending')
      const operation = Promise.resolve().then(() => {
        if (!current()) throw new Error('Admission request cancelled.')
        return pool.publishGuarded!(event, current)
      }).then(() => { confirmed = true; if (current()) opts.phase('waiting') }, error => {
        if (current()) opts.phase('reconnecting')
        throw error
      })
      const tracked = operation.finally(() => { if (inFlight === tracked) inFlight = undefined })
      inFlight = tracked
      return tracked
    },
  }
}
