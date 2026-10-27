import { spawn as spawnProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isIPv4 } from 'node:net'

const messages = {
  ERR_CONFIG: 'Invalid local hosting configuration.',
  ERR_ALREADY_STARTED: 'Hosting is already active.',
  ERR_START_FAILED: 'The relay could not start.',
  ERR_START_TIMEOUT: 'The relay did not become ready in time.',
  ERR_START_CANCELLED: 'Hosting start was cancelled.',
  ERR_RELAY_EXITED: 'The relay stopped unexpectedly.',
  ERR_STOP_TIMEOUT: 'The relay has not exited; hosting remains unavailable.',
  ERR_NOT_RUNNING: 'Hosting is not running.',
}
function refusal(code) { return Object.assign(new Error(messages[code]), { code }); }
function validPort(value) { return Number.isInteger(value) && value > 0 && value <= 65535; }
function configuration({ listenIp, port, relayPorts } = {}) {
  const octets = typeof listenIp === 'string' && isIPv4(listenIp) ? listenIp.split('.').map(Number) : []
  if (octets.length !== 4 || octets[0] === 0 || octets[0] >= 224 || octets[3] === 255
      || !validPort(port) || !Array.isArray(relayPorts) || relayPorts.length !== 2
      || !relayPorts.every(validPort) || relayPorts[0] > relayPorts[1] || relayPorts[1] - relayPorts[0] >= 32
      || (port >= relayPorts[0] && port <= relayPorts[1])) throw refusal('ERR_CONFIG')
  return { listenIp, port, relayPorts: [...relayPorts] }
}

/**
 * Optional local process supervisor. Construction performs no I/O or scheduling.
 * The host must await stop on normal app exit. The native executable must support
 * --exit-on-stdin-close: its lifetime is tied to this parent's private stdin pipe.
 * Secrets stay in process memory and the child environment. JavaScript strings
 * and the OS spawn environment cannot be reliably zeroised by this module.
 * nowSeconds is a trusted host dependency; credential callers choose only TTL.
 */
export function createSpryHosting({ executable, spawn = spawnProcess, startupTimeoutMs = 5000,
  stopTimeoutMs = 2000, onState, nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || typeof spawn !== 'function'
      || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1
      || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1
      || typeof nowSeconds !== 'function'
      || (onState !== undefined && typeof onState !== 'function')) throw refusal('ERR_CONFIG')
  let current = { status: 'off' }
  let run
  const state = () => structuredClone(current)
  function publish(value) {
    current = value
    if (onState) {
      const snapshot = state()
      queueMicrotask(() => { try { onState(snapshot); } catch { /* Observers cannot control cleanup. */ } })
    }
  }
  function clearStartup(active) { clearTimeout(active.timer); active.timer = undefined; }
  function rejectStart(active, code) {
    if (active.settled) return
    active.settled = true
    clearStartup(active)
    active.reject(refusal(code))
  }
  async function terminate(active) {
    if (active.cleanup) return active.cleanup
    active.cleanup = (async () => {
      if (!active.exited) {
        // EOF is the native crash guard as well as a cooperative stop request.
        // Keep the signal fallback for a wedged or incompatible executable.
        try { active.child.stdin?.end() } catch { /* Signals still apply. */ }
        try { active.child.kill('SIGTERM'); } catch { /* Escalate below. */ }
        await Promise.race([active.exit, new Promise(resolve => { active.termTimer = setTimeout(resolve, stopTimeoutMs); })])
        clearTimeout(active.termTimer)
      }
      if (!active.exited) {
        try { active.child.kill('SIGKILL'); } catch { /* Wait for confirmed exit. */ }
        await Promise.race([active.exit, new Promise(resolve => { active.killTimer = setTimeout(resolve, stopTimeoutMs); })])
        clearTimeout(active.killTimer)
      }
      if (!active.exited) throw refusal('ERR_STOP_TIMEOUT')
    })()
    return active.cleanup
  }
  async function fail(active, code) {
    if (run !== active || active.stopping || active.failed) return
    active.failed = true
    active.secret = undefined
    clearStartup(active)
    publish({ status: 'failed', error: { code, message: messages[code] } })
    try { await terminate(active); } catch {
      if (run === active) publish({ status: 'failed', error: { code: 'ERR_STOP_TIMEOUT', message: messages.ERR_STOP_TIMEOUT } })
    }
    if (run === active && active.exited) run = undefined
    rejectStart(active, code)
  }
  function start(options) {
    let config
    try {
      config = configuration(options)
      if (run) throw refusal('ERR_ALREADY_STARTED')
    } catch (error) { return Promise.reject(error?.code ? error : refusal('ERR_CONFIG')); }
    const active = { config, secret: randomBytes(32).toString('hex'), exited: false, settled: false }
    const ready = new Promise((resolve, reject) => { active.resolve = resolve; active.reject = reject; })
    active.exit = new Promise(resolve => { active.exitResolve = resolve; })
    run = active
    publish({ status: 'starting' })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('SPRY_')))
    env.SPRY_TURN_SECRET = active.secret
    const endpoint = `${config.listenIp}:${config.port}`
    const args = ['serve', '--listen', endpoint, '--relay-ip', config.listenIp,
      '--relay-ports', config.relayPorts.join(':'), '--max-allocations', '32', '--max-per-user', '8',
      '--max-connections', '32', '--bytes-per-second', '1000000', '--exit-on-stdin-close']
    try {
      active.child = spawn(executable, args, { env, shell: false, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    } catch {
      active.exited = true
      active.exitResolve()
      void fail(active, 'ERR_START_FAILED')
      return ready
    }
    const exited = () => {
      if (active.exited) return
      active.exited = true
      active.secret = undefined
      active.exitResolve()
      clearStartup(active)
      if (run === active && !active.stopping && !active.failed) void fail(active, active.settled ? 'ERR_RELAY_EXITED' : 'ERR_START_FAILED')
      else if (run === active && (active.failed || active.stopping)) {
        run = undefined
        if (active.stopping) publish({ status: 'off' })
      }
    }
    active.child.once('exit', exited)
    // Failed spawn emits error then close, without exit.
    active.child.once('close', exited)
    active.child.on('error', () => { void fail(active, 'ERR_START_FAILED'); })
    // A broken lifetime pipe must fail closed without an unhandled EPIPE.
    active.child.stdin?.on('error', () => { void fail(active, 'ERR_RELAY_EXITED'); })
    active.child.stdin?.once('close', () => {
      if (!active.exited) void fail(active, 'ERR_RELAY_EXITED')
    })
    let line = ''
    let oversized = false
    active.child.stderr?.on('data', chunk => {
      if (run !== active || active.settled || active.stopping || active.failed) return
      for (const character of chunk.toString('utf8')) {
        if (character === '\n') {
          const match = !oversized && /^spry-turn [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)? ready \(UDP\/TCP ([^)]+)\)\r?$/.exec(line)
          line = ''; oversized = false
          if (match) {
            if (match[1] !== endpoint) { void fail(active, 'ERR_START_FAILED'); return; }
            active.settled = true
            clearStartup(active)
            publish({ status: 'running', endpoint, exposure: 'locally-bound' })
            active.resolve(state())
            return
          }
        } else if (!oversized) {
          if (line.length < 512) line += character
          else { line = ''; oversized = true; }
        }
      }
    })
    if (!active.settled && !active.failed) active.timer = setTimeout(() => { void fail(active, 'ERR_START_TIMEOUT'); }, startupTimeoutMs)
    return ready
  }
  async function stop() {
    const active = run
    if (!active) { publish({ status: 'off' }); return state(); }
    if (active.stopPromise) return active.stopPromise
    active.stopping = true
    active.secret = undefined
    rejectStart(active, 'ERR_START_CANCELLED')
    publish({ status: 'stopping' })
    active.stopPromise = (async () => {
      try { await terminate(active); } catch (error) {
        if (run === active) publish({ status: 'failed', error: { code: error.code, message: error.message } })
        throw error
      }
      if (run === active) { run = undefined; publish({ status: 'off' }); }
      // An Off observer may already have started a new run. This operation
      // reports the completed stop, without reading or changing its successor.
      return { status: 'off' }
    })()
    return active.stopPromise
  }
  function credentials(options = {}) {
    if (current.status !== 'running' || !run?.secret || run.exited) throw refusal('ERR_NOT_RUNNING')
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => key !== 'ttlSeconds')) throw refusal('ERR_CONFIG')
    const { ttlSeconds = 300 } = options
    let issuedAt
    try { issuedAt = nowSeconds(); } catch { throw refusal('ERR_CONFIG'); }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600
        || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(issuedAt + ttlSeconds)) throw refusal('ERR_CONFIG')
    const expiresAt = issuedAt + ttlSeconds
    const username = `${expiresAt}:${randomBytes(16).toString('hex')}`
    return { username, credential: createHmac('sha1', run.secret).update(username).digest('base64'), expiresAt,
      urls: [`turn:${current.endpoint}?transport=udp`, `turn:${current.endpoint}?transport=tcp`] }
  }
  return { state, start, stop, credentials }
}
