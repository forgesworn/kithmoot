import { spawn as spawnProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { isIPv4 } from 'node:net'

/**
 * Supervises `spry-node supervised --map-ports`, the built-in call relay
 * (docs/design/2026-10-28-built-in-relay.md, 1.3; spry-turn
 * docs/supervised-mode.md). The node opens its own router ports, keeps them
 * alive and gives them back on stop; this module starts it, reads its JSON
 * lines from stdout and stops it.
 *
 * Rules kept from the preview supervisor: an explicit start, a private stdin
 * pipe the node exits on, a readiness line, a bounded stop that escalates,
 * an observed exit before Off, a guard against a stale run, no raw child
 * output kept (stderr is discarded), and no secret ever in the state.
 */

const messages = {
  ERR_CONFIG: 'Invalid call relay settings.',
  ERR_ALREADY_STARTED: 'The call relay is already running.',
  ERR_START_FAILED: 'The call relay could not start.',
  ERR_START_TIMEOUT: 'The call relay did not become ready in time.',
  ERR_START_CANCELLED: 'Starting the call relay was cancelled.',
  ERR_RELAY_EXITED: 'The call relay stopped unexpectedly.',
  ERR_CANNOT_HOST: 'This network cannot host a call relay.',
  ERR_STOP_TIMEOUT: 'The call relay has not exited.',
}
export function supervisorError(code) { return Object.assign(new Error(messages[code]), { code }) }

/** The owner's home defaults (design, owner decisions of 28 October 2026).
 *  The aggregate cap is left at the node's own default, 625,000 bytes a second. */
export const RELAY_CAPS = Object.freeze({ maxAllocations: 8, maxPerUser: 2, maxTcpConnections: 16, bytesPerSecond: 125000 })

const HEX64 = /^[0-9a-f]{64}$/
const PAIRING = /^[A-Za-z0-9_-]{43}$/
const TURN_URL = /^turn:([0-9.]{7,15}):([0-9]{1,5})\?transport=(udp|tcp)$/
const LINE_LIMIT = 8192
/** Why a router could not host, as the node words it. */
export const PORTMAP_REASONS = Object.freeze(['no-gateway', 'vpn', 'wrong-interface', 'no-answer', 'refused', 'failed',
  'carrier-grade-nat', 'double-nat', 'unusable-address', 'too-few-ports', 'record', 'expired'])
const METHODS = ['pcp', 'natpmp', 'upnp']
const count = value => Number.isSafeInteger(value) && value >= 0

function validPort(value) { return Number.isInteger(value) && value >= 1024 && value <= 65535 }
function usableBind(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false
  const [a, b] = value.split('.').map(Number)
  return a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254) && value !== '255.255.255.255'
}

/** The command line for one run. Every network value is explicit. */
export function supervisedArgs({ pairingPublicKey, stateFile, controlRelays, bind, listenPort }) {
  if (typeof pairingPublicKey !== 'string' || !HEX64.test(pairingPublicKey) || typeof stateFile !== 'string' || !isAbsolute(stateFile)
    || !Array.isArray(controlRelays) || controlRelays.length < 1 || controlRelays.length > 4
    || !controlRelays.every(url => typeof url === 'string' && url.startsWith('wss://'))
    || !usableBind(bind) || !validPort(listenPort)) throw supervisorError('ERR_CONFIG')
  return ['supervised', '--exit-on-stdin-close', '--map-ports',
    '--pairing-key', pairingPublicKey, '--state-file', stateFile,
    ...controlRelays.flatMap(url => ['--control-relay', url]),
    '--bind', bind, '--listen-port', String(listenPort),
    '--max-allocations', String(RELAY_CAPS.maxAllocations), '--max-per-user', String(RELAY_CAPS.maxPerUser),
    '--max-tcp-connections', String(RELAY_CAPS.maxTcpConnections), '--bytes-per-second', String(RELAY_CAPS.bytesPerSecond)]
}

/** A cleared environment: the node refuses every `SPRY_` setting it does not
 *  expect, so nothing of the app's own may leak in. Windows needs SystemRoot
 *  for its socket library. */
export function childEnvironment(turnSecret, env = process.env, platform = process.platform) {
  if (typeof turnSecret !== 'string' || !HEX64.test(turnSecret)) throw supervisorError('ERR_CONFIG')
  const out = { SPRY_TURN_SECRET: turnSecret }
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT
    if (root) out.SystemRoot = root
  }
  return out
}

function turnUrls(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return undefined
  for (const url of value) {
    const match = typeof url === 'string' ? TURN_URL.exec(url) : null
    if (!match || !isIPv4(match[1]) || !validPort(Number(match[2]))) return undefined
  }
  return [...value]
}
function portMap(value) {
  if (!Array.isArray(value) || value.length > 64) return undefined
  return value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(validPort)) ? value.map(pair => [...pair]) : undefined
}

/** One stdout line as a checked event, or undefined for anything else. */
export function parseNodeLine(text) {
  let value
  try { value = JSON.parse(text) } catch { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1) return undefined
  switch (value.event) {
    case 'ready': {
      const urls = turnUrls(value.urls), relayPortMap = portMap(value.relayPortMap)
      if (typeof value.endpoint !== 'string' || !value.endpoint.startsWith('spry://') || value.endpoint.length > 2048
        || typeof value.pairing !== 'string' || !PAIRING.test(value.pairing) || !urls || !relayPortMap) return undefined
      return { event: 'ready', endpoint: value.endpoint, pairing: value.pairing, urls, relayPortMap }
    }
    case 'urls': {
      const urls = turnUrls(value.urls), relayPortMap = portMap(value.relayPortMap)
      return urls && relayPortMap ? { event: 'urls', urls, relayPortMap } : undefined
    }
    case 'status':
      if (!count(value.allocations) || !count(value.bytesRelayed) || !(value.lastAllocation === null || count(value.lastAllocation))) return undefined
      return { event: 'status', allocations: value.allocations, bytesRelayed: value.bytesRelayed, lastAllocation: value.lastAllocation }
    case 'control':
      return count(value.relays) ? { event: 'control', relays: value.relays } : undefined
    case 'portmap': {
      const state = value.state
      if (state === 'mapped' || state === 'changed') {
        if (!METHODS.includes(value.method) || !count(value.allocationPorts) || !count(value.requested) || typeof value.permanent !== 'boolean') return undefined
        const reason = state === 'changed' ? (['address', 'port', 'ports'].includes(value.reason) ? value.reason : undefined) : null
        if (reason === undefined) return undefined
        return { event: 'portmap', state, method: value.method, allocationPorts: value.allocationPorts, requested: value.requested,
          permanent: value.permanent, ...(reason ? { reason } : {}) }
      }
      if (state === 'restored') return count(value.restored) ? { event: 'portmap', state, restored: value.restored } : undefined
      if (state === 'failed' || state === 'lost') return PORTMAP_REASONS.includes(value.reason) ? { event: 'portmap', state, reason: value.reason } : undefined
      if (state === 'cleaned' || state === 'released') return count(value.removed) && count(value.remaining) ? { event: 'portmap', state, removed: value.removed, remaining: value.remaining } : undefined
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * `start` resolves with the state once the node prints `ready`, or rejects.
 * The state names what the person may see: status, router method and port
 * counts, the public TURN URLs (their own address), the `spry:` endpoint and
 * pairing id, use counts. Never the TURN secret.
 *
 * Exit code 3 means the network cannot host (`portmap failed` or `lost`), and
 * becomes status `cannot-host` with the node's reason word, not a crash.
 */
export function createRelaySupervisor({ executable, spawn = spawnProcess, onState, startupTimeoutMs = 120_000,
  stopTimeoutMs = 6000, killTimeoutMs = 2000 } = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || typeof spawn !== 'function'
    || ![startupTimeoutMs, stopTimeoutMs, killTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
    || (onState !== undefined && typeof onState !== 'function')) throw supervisorError('ERR_CONFIG')
  let current = { status: 'off' }
  let run
  const state = () => structuredClone(current)
  function publish(value) {
    current = value
    if (onState) {
      const snapshot = state()
      queueMicrotask(() => { try { onState(snapshot) } catch { /* Observers cannot control cleanup. */ } })
    }
  }
  function update(active, change) { if (run === active) publish({ ...current, ...change }) }
  function settle(active, error) {
    if (active.settled) return
    active.settled = true
    clearTimeout(active.timer)
    if (error) active.reject(error)
    else active.resolve(state())
  }
  async function terminate(active) {
    if (active.cleanup) return active.cleanup
    active.cleanup = (async () => {
      const wait = ms => Promise.race([active.exit, new Promise(resolve => { active.waitTimer = setTimeout(resolve, ms) })])
        .finally(() => clearTimeout(active.waitTimer))
      if (!active.exited) {
        // EOF starts the node's orderly stop: relay first, then each router
        // mapping it made is removed, normally well inside three seconds.
        try { active.child.stdin?.end() } catch { /* Escalate below. */ }
        await wait(stopTimeoutMs)
      }
      if (!active.exited) {
        try { active.child.kill('SIGKILL') } catch { /* Wait for confirmed exit. */ }
        await wait(killTimeoutMs)
      }
      if (!active.exited) throw supervisorError('ERR_STOP_TIMEOUT')
    })()
    return active.cleanup
  }
  async function fail(active, code, extra = {}) {
    if (run !== active || active.stopping || active.failed) return
    active.failed = true
    clearTimeout(active.timer)
    const status = code === 'ERR_CANNOT_HOST' ? 'cannot-host' : 'failed'
    publish({ status, error: { code, message: messages[code] }, ...extra })
    settle(active, supervisorError(code))
    try { await terminate(active) } catch {
      if (run === active) publish({ status: 'failed', error: { code: 'ERR_STOP_TIMEOUT', message: messages.ERR_STOP_TIMEOUT } })
    }
    if (run === active && active.exited) run = undefined
  }
  function handle(active, event) {
    if (run !== active || active.stopping || active.failed) return
    if (event.event === 'ready') {
      if (active.ready) return
      active.ready = true
      update(active, { status: 'running', endpoint: event.endpoint, pairing: event.pairing, urls: event.urls, allocationPorts: event.relayPortMap.length })
      settle(active)
    } else if (event.event === 'urls') {
      update(active, { urls: event.urls, allocationPorts: event.relayPortMap.length })
    } else if (event.event === 'status') {
      update(active, { counts: { allocations: event.allocations, bytesRelayed: event.bytesRelayed, lastAllocation: event.lastAllocation } })
    } else if (event.event === 'control') {
      update(active, { control: { relays: event.relays } })
    } else if (event.event === 'portmap') {
      if (event.state === 'mapped' || event.state === 'changed') {
        update(active, { mapping: { method: event.method, allocationPorts: event.allocationPorts, requested: event.requested,
          permanent: event.permanent, restored: current.mapping?.restored ?? 0 } })
      } else if (event.state === 'restored' && current.mapping) {
        update(active, { mapping: { ...current.mapping, restored: current.mapping.restored + event.restored } })
      } else if (event.state === 'failed' || event.state === 'lost') {
        active.reason = event.reason
      }
    }
  }
  function start(options) {
    let args, env
    try {
      if (run) throw supervisorError('ERR_ALREADY_STARTED')
      args = supervisedArgs(options ?? {})
      env = childEnvironment(options.turnSecret)
    } catch (error) { return Promise.reject(error?.code ? error : supervisorError('ERR_CONFIG')) }
    const active = { exited: false, settled: false, local: { host: options.bind, port: options.listenPort } }
    const ready = new Promise((resolve, reject) => { active.resolve = resolve; active.reject = reject })
    // A caller that only watches the state must not see an unhandled rejection.
    ready.catch(() => {})
    active.exit = new Promise(resolve => { active.exitResolve = resolve })
    run = active
    publish({ status: 'starting', local: active.local })
    try {
      active.child = spawn(executable, args, { env, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      active.exited = true
      active.exitResolve()
      void fail(active, 'ERR_START_FAILED')
      return ready
    }
    const exited = code => {
      if (active.exited) return
      active.exited = true
      active.exitResolve()
      clearTimeout(active.timer)
      if (run !== active) return
      if (active.stopping || active.failed) { run = undefined; if (active.stopping) publish({ status: 'off' }); return }
      if (code === 3) void fail(active, 'ERR_CANNOT_HOST', { reason: active.reason ?? 'failed' })
      else void fail(active, active.ready ? 'ERR_RELAY_EXITED' : 'ERR_START_FAILED')
    }
    active.child.once('exit', code => exited(code))
    // A failed spawn emits error then close, without exit.
    active.child.once('close', code => exited(code))
    active.child.on('error', () => { void fail(active, 'ERR_START_FAILED') })
    // A broken lifetime pipe fails closed, without an unhandled EPIPE.
    active.child.stdin?.on('error', () => { void fail(active, 'ERR_RELAY_EXITED') })
    let line = ''
    let oversized = false
    active.child.stdout?.on('data', chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\n') {
          const event = !oversized ? parseNodeLine(line) : undefined
          line = ''; oversized = false
          if (event) handle(active, event)
        } else if (!oversized) {
          if (line.length < LINE_LIMIT) line += character
          else { line = ''; oversized = true }
        }
      }
    })
    active.timer = setTimeout(() => { void fail(active, 'ERR_START_TIMEOUT') }, startupTimeoutMs)
    return ready
  }
  async function stop() {
    const active = run
    if (!active) { if (current.status !== 'failed' && current.status !== 'cannot-host') publish({ status: 'off' }); return state() }
    if (active.stopPromise) return active.stopPromise
    active.stopping = true
    settle(active, supervisorError('ERR_START_CANCELLED'))
    publish({ ...current, status: 'stopping' })
    active.stopPromise = (async () => {
      try { await terminate(active) } catch (error) {
        if (run === active) publish({ status: 'failed', error: { code: error.code, message: error.message } })
        throw error
      }
      if (run === active) { run = undefined; publish({ status: 'off' }) }
      return { status: 'off' }
    })()
    return active.stopPromise
  }
  /** Forget a finished run's failure, so the state reads Off again. */
  function clear() { if (!run) publish({ status: 'off' }) }
  return { state, start, stop, clear }
}
