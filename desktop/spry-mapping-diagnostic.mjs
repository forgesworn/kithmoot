import { setTimeout as delay } from 'node:timers/promises'

const codes = new Set(['ERR_ABORTED', 'ERR_TIMEOUT', 'ERR_CONFIG', 'ERR_NETWORK', 'ERR_SOCKET', 'ERR_BUSY', 'ERR_RESPONSE',
  'ERR_CONNECTION_REFUSED', 'ERR_SOURCE_UNAVAILABLE', 'ERR_ROUTE_UNAVAILABLE',
  'ERR_GATEWAY', 'ERR_EPOCH_CHANGED', 'ERR_ADDRESS_CHANGED', 'ERR_PORT_CHANGED',
  'ERR_PORT_COLLISION', 'ERR_LISTENER_PAIR', 'ERR_LEASE', 'ERR_CLOCK'])
const refusal = code => Object.assign(new Error('Mapping observations are incomplete.'), { code })
const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535

export function mappingPlan({ listenPort, relayPorts } = {}) {
  // This is a small capability experiment, not the desktop capacity setting.
  if (!validPort(listenPort) || !Array.isArray(relayPorts) || relayPorts.length < 2 || relayPorts.length > 4
      || !relayPorts.every(validPort) || new Set([listenPort, ...relayPorts]).size !== relayPorts.length + 1) {
    throw refusal('ERR_CONFIG')
  }
  return [
    { role: 'listener', protocol: 'udp', internalPort: listenPort },
    { role: 'listener', protocol: 'tcp', internalPort: listenPort },
    ...relayPorts.map(internalPort => ({ role: 'allocation', protocol: 'udp', internalPort })),
  ]
}

/**
 * Explicit, finite observation only. Does not start Spry, publish an endpoint,
 * prove ownership/reachability, or maintain a route. Never deletes mappings:
 * NAT-PMP can return somebody else's pre-existing per-host mapping.
 * client/clock/sleep are trusted host dependencies, never renderer input.
 */
export async function diagnoseMappings({ client, listenPort, relayPorts, signal,
  nowMs = () => performance.now(), sleep = (ms, options) => delay(ms, undefined, options) } = {}) {
  const plan = mappingPlan({ listenPort, relayPorts })
  if (!client || typeof client.externalAddress !== 'function' || typeof client.mapping !== 'function'
      || typeof nowMs !== 'function' || typeof sleep !== 'function') throw refusal('ERR_CONFIG')
  let lastTime = -Infinity
  function clock() {
    const value = nowMs()
    if (!Number.isFinite(value) || value < 0 || value < lastTime) throw refusal('ERR_CLOCK')
    lastTime = value
    return value
  }
  const started = clock()
  let previousEpoch
  let previousEpochTime
  let mappingAttempted = false
  let publicAddress
  const active = new Map()
  const observations = []
  const attempts = []
  const report = {
    schema: 1, status: 'incomplete', routeQualified: false, ownershipEstablished: false,
    externalReachabilityTested: false, vpnConfinementTested: false, independentRenewalProven: false,
    observations, attempts,
    cleanup: { mode: 'stop-renewal-only', deletionSent: false, mappingsMayRemain: false },
  }
  function checkSignal() { if (signal?.aborted) throw refusal('ERR_ABORTED') }
  function checkEpoch(epochSeconds, at) {
    if (!Number.isInteger(epochSeconds) || epochSeconds < 0 || epochSeconds > 0xffffffff) throw refusal('ERR_RESPONSE')
    if (previousEpoch !== undefined) {
      const elapsed = (at - previousEpochTime) / 1000
      const difference = epochSeconds - previousEpoch
      if (difference < 0 || difference < elapsed * 0.875 - 2 || difference > elapsed * 1.125 + 2) {
        throw refusal('ERR_EPOCH_CHANGED')
      }
    }
    previousEpoch = epochSeconds
    previousEpochTime = at
  }
  function requireLive() {
    const at = clock()
    if ([...active.values()].some(value => value.expiresAt <= at + 1000)) throw refusal('ERR_LEASE')
  }
  async function address(phase) {
    checkSignal()
    const response = await client.externalAddress({ signal })
    const at = clock()
    observations.push({ phase, type: 'external-address', ...response, elapsedMs: at - started })
    checkSignal()
    checkEpoch(response.epochSeconds, at)
    if (typeof response.externalAddress !== 'string') throw refusal('ERR_RESPONSE')
    if (publicAddress !== undefined && publicAddress !== response.externalAddress) throw refusal('ERR_ADDRESS_CHANGED')
    publicAddress = response.externalAddress
  }
  async function map(item, phase) {
    checkSignal()
    requireLive()
    const key = `${item.protocol}:${item.internalPort}`
    const preceding = active.get(key)
    const requested = { protocol: item.protocol, internalPort: item.internalPort,
      suggestedExternalPort: preceding?.externalPort ?? 0, lifetimeSeconds: 60 }
    const sentAt = clock()
    mappingAttempted = true
    const attempt = { phase, role: item.role, requested, elapsedMs: sentAt - started, outcome: 'unconfirmed' }
    attempts.push(attempt)
    let response
    try { response = await client.mapping({ ...requested, signal }) }
    catch (error) {
      if (error?.code === 'ERR_GATEWAY') {
        attempt.outcome = 'refused'
        if (Number.isInteger(error.resultCode) && error.resultCode >= 0 && error.resultCode <= 65535) attempt.resultCode = error.resultCode
      }
      throw error
    }
    attempt.outcome = 'replied'
    const at = clock()
    observations.push({ phase, type: 'mapping', role: item.role, ...response,
      elapsedMs: at - started, conservativeExpiryMs: sentAt - started + response.returned?.lifetimeSeconds * 1000 })
    checkSignal()
    checkEpoch(response.epochSeconds, at)
    const value = response.returned
    if (!value || value.protocol !== item.protocol || value.internalPort !== item.internalPort
        || !Number.isInteger(value.externalPort) || value.externalPort < 1 || value.externalPort > 65535) throw refusal('ERR_RESPONSE')
    // Stop on unexpected grants rather than renewing outside this experiment.
    if (!Number.isInteger(value.lifetimeSeconds) || value.lifetimeSeconds < 50 || value.lifetimeSeconds > 60) throw refusal('ERR_LEASE')
    // A renewal that completed after any old lease expired is not continuity.
    requireLive()
    if (preceding && preceding.externalPort !== value.externalPort) throw refusal('ERR_PORT_CHANGED')
    active.set(key, { externalPort: value.externalPort, expiresAt: sentAt + value.lifetimeSeconds * 1000 })
    requireLive()
    const udp = [...active.entries()].filter(([id]) => id.startsWith('udp:')).map(([, entry]) => entry.externalPort)
    if (new Set(udp).size !== udp.length) throw refusal('ERR_PORT_COLLISION')
    const listenerUdp = active.get(`udp:${listenPort}`)
    const listenerTcp = active.get(`tcp:${listenPort}`)
    if (listenerUdp && listenerTcp && listenerUdp.externalPort !== listenerTcp.externalPort) throw refusal('ERR_LISTENER_PAIR')
  }
  try {
    await address('initial')
    const firstMappingAt = clock()
    for (const item of plan) await map(item, 'initial')
    await address('after-initial-mappings')
    requireLive()
    // One bounded Proton-style renewal cycle. Wake delays invalidate observations.
    const wait = firstMappingAt + 45000 - clock()
    if (wait > 0) await sleep(wait, { signal })
    checkSignal()
    requireLive()
    await address('before-renewal')
    for (const item of plan) await map(item, 'renewal')
    await address('after-renewal')
    requireLive()
    report.status = 'observed'
    report.perTupleRenewalRepliesObserved = true
    report.portTranslationRequired = plan.some(item => active.get(`${item.protocol}:${item.internalPort}`).externalPort !== item.internalPort)
    report.publicAddressStable = true
  } catch (error) {
    report.status = signal?.aborted || error?.name === 'AbortError' || error?.code === 'ERR_ABORTED' ? 'cancelled' : 'incomplete'
    report.reason = report.status === 'cancelled' ? 'ERR_ABORTED' : (codes.has(error?.code) ? error.code : 'ERR_NETWORK')
  }
  report.cleanup.mappingsMayRemain = mappingAttempted
  report.cleanup.requestedLifetimeSeconds = 60
  // Grants are observations, not a guarantee that a non-compliant gateway expires them.
  report.cleanup.expiryConfirmed = false
  return report
}

/** Console output deliberately omits source/gateway/public IPs and port tuples. */
export function summariseMappingDiagnostic(report) {
  return {
    status: report.status, ...(report.reason ? { reason: report.reason } : {}),
    mappingReplies: report.observations.filter(item => item.type === 'mapping').length,
    renewalReplies: report.observations.filter(item => item.type === 'mapping' && item.phase === 'renewal').length,
    ...(report.status === 'observed' ? { portTranslationRequired: report.portTranslationRequired } : {}),
    routeQualified: false, ownershipEstablished: false, externalReachabilityTested: false,
    vpnConfinementTested: false, cleanup: report.cleanup,
  }
}
