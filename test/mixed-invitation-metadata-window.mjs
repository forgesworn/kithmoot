import { sha256 } from './mixed-invitation-metadata-audit.mjs'
import { createHash } from 'node:crypto'

export function createPublicControlTracker({ subscription, origin }) {
  if (typeof subscription !== 'string' || !subscription || typeof origin !== 'string') throw Error('Public control identity required')
  const subscriptionSha256 = sha256(subscription), originSha256 = sha256(new URL(origin).origin)
  let req = false, close = false
  return Object.freeze({
    frame(source, endpoint, summary) {
      if (source !== 'app-websocket' || endpoint?.originSha256 !== originSha256 ||
          summary?.subscriptionSha256 !== subscriptionSha256) return
      if (summary.control === 'REQ') req = true
      if (summary.control === 'CLOSE') close = true
    },
    snapshot() { return { req, close } },
  })
}

export function createBrowserMetadataWindow({ metadataObservation, metadataCaptureHooks, manifest, origins, clock = Date.now, spoolDirectory }) {
  const observation = metadataObservation({ manifest, clock, ...(spoolDirectory === undefined ? {} : { spoolDirectory }) })
  const hooks = metadataCaptureHooks({ actor: 'alice', observation, origins })
  let finished = false, gaps = 0, activeCallbacks = 0
  const capture = call => {
    if (finished) { gaps++; return }
    activeCallbacks++
    try { call() } finally { activeCallbacks-- }
  }
  return Object.freeze({
    start() { if (finished) throw Error('Browser metadata window already closed'); observation.start() },
    webSocket(payload, direction, source, url) { capture(() => hooks.webSocket(payload, direction, source, url)) },
    outgoingHttp(request, source) { capture(() => hooks.outgoingHttp(request, source)) },
    positiveControl(phase, result) { capture(() => observation.positiveControl('alice', phase, result)) },
    finish() {
      if (finished) throw Error('Browser metadata window already closed')
      finished = true
      observation.finish()
      return Object.freeze({ ...observation.snapshot(), get coverageGaps() { return gaps }, missingRecords: 0,
        inFlight: 0, get activeCallbacks() { return activeCallbacks }, pendingAttempts: 0,
        get captureBoundaryComplete() { return gaps === 0 && activeCallbacks === 0 } })
    },
  })
}

export function createGeneralObservationStore({ directory, createMetadataSpool }) {
  const spool = createMetadataSpool({ directory, maxRecords: 100_000 })
  const digest = createHash('sha256').update('['), sourceCounts = {}, endpoints = {}
  let count = 0, overflow = false, closed = false, first = true
  return Object.freeze({
    append(value) {
      if (closed) { overflow = true; return }
      let encoded
      try { encoded = JSON.stringify(value); spool.append(encoded) } catch { overflow = true; return }
      digest.update(first ? encoded : `,${encoded}`); first = false; count++
      sourceCounts[value.source] = (sourceCounts[value.source] ?? 0) + 1
      const key = `${value.source} ${value.originAlias ?? '[unattributed]'} ${value.originSha256 ?? ''} ${value.pathSha256 ?? ''}`
      const endpoint = endpoints[key] ??= { items: 0, bytes: 0 }
      endpoint.items++; endpoint.bytes += value.length
    },
    snapshot() {
      const manifest = spool.snapshot()
      return structuredClone({ observationCount: count, observerOverflow: overflow || manifest.overflow,
        sourceCounts, endpoints, observationDigest: digest.copy().update(']').digest('hex'),
        observationSpool: { directory, ...manifest } })
    },
    close() {
      if (!closed) { closed = true; try { spool.close() } catch { overflow = true } }
      return this.snapshot()
    },
  })
}
