import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isIPv4 } from 'node:net'

const invalid = () => new Error('The local relay configuration is unavailable or invalid.')
export function parseHostingConfig(text) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8192) throw invalid()
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'executable,listenIp,port,relayPorts'
      || typeof value.executable !== 'string' || !isAbsolute(value.executable)
      || typeof value.listenIp !== 'string' || !isIPv4(value.listenIp)) throw invalid()
    const octets = value.listenIp.split('.').map(Number)
    const port = p => Number.isInteger(p) && p > 0 && p <= 65535
    if (octets[0] === 0 || octets[0] >= 224 || octets[3] === 255 || !port(value.port)
      || !Array.isArray(value.relayPorts) || value.relayPorts.length !== 2 || !value.relayPorts.every(port)
      || value.relayPorts[0] > value.relayPorts[1] || value.relayPorts[1] - value.relayPorts[0] >= 32
      || (value.port >= value.relayPorts[0] && value.port <= value.relayPorts[1])) throw invalid()
    return value
  } catch { throw invalid() }
}

/** Bounded read, including when a file changes after opening. Never reads on launch. */
export async function loadHostingConfig(path) {
  let file
  try {
    if (!isAbsolute(path)) throw invalid()
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    if (!(await file.stat()).isFile()) throw invalid()
    const buffer = Buffer.alloc(8193)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > 8192) throw invalid()
    return parseHostingConfig(buffer.subarray(0, length).toString('utf8'))
  } catch { throw invalid() } finally { await file?.close() }
}

/** Cancellation invalidates an outstanding stop before it can reissue Quit. */
export function createHostingQuitGuard({ stop, quit, failed }) {
  let epoch = 0
  let quitting = false
  let confirmed = false
  function cancel() { epoch++; quitting = false; confirmed = false }
  async function request() {
    if (quitting || confirmed) return false
    const token = ++epoch
    quitting = true
    const stopped = await stop({ block: true })
    if (token !== epoch) return false
    if (!stopped) { cancel(); await failed(); return false }
    confirmed = true
    quit()
    return true
  }
  return { request, cancel, get quitting() { return quitting }, get confirmed() { return confirmed } }
}

/** Main-process native controls only: no renderer commands, persistence or sharing. */
export function createHostingControls({ enabled, configPath, load = loadHostingConfig, createHost, showDialog, changed = () => {} }) {
  let host
  let status = { status: 'off' }
  let generation = 0
  let blocked = false
  let presenting
  let stopping
  const available = enabled === true && typeof configPath === 'string' && isAbsolute(configPath)
  const state = () => ({ ...status, available, blocked })
  const publish = next => { status = next; changed(state()) }
  async function stop({ block = false } = {}) {
    generation++
    if (block) blocked = true
    changed(state())
    if (stopping) return stopping
    if (!host) { publish({ status: 'off' }); return true }
    const active = host
    stopping = (async () => {
      try {
        await active.stop()
        if (host === active) { host = undefined; publish({ status: 'off' }) }
        return true
      } catch {
        publish({ status: 'failed' })
        return false
      } finally { stopping = undefined }
    })()
    return stopping
  }
  async function resume() {
    const operation = stop({ block: true })
    const token = generation
    const stopped = await operation
    if (stopped && token === generation) { blocked = false; changed(state()) }
    return stopped
  }
  async function present() {
    if (presenting) return presenting
    const token = generation
    presenting = (async () => {
      try {
        if (!available) {
          await showDialog({ message: 'Local call relay unavailable', detail: 'This build has no enabled development relay configuration. No relay was started.', buttons: ['OK'], defaultId: 0, cancelId: 0 })
          return
        }
        if (host || status.status !== 'off') {
          const { response } = await showDialog({ message: `Local call relay: ${status.status === 'running' ? 'Running (local bind)' : status.status}`,
            detail: status.endpoint ? `Listener: ${status.endpoint}. Public and VPN routing have not been tested.` : 'The relay has no confirmed active listener.',
            buttons: ['Cancel', 'Stop'], defaultId: 0, cancelId: 0 })
          if (response === 1 && token === generation) await stop()
          return
        }
        if (blocked) return
        const config = await load(configPath)
        if (token !== generation || blocked) return
        const { response } = await showDialog({ type: 'warning', message: 'Start a development local call relay?',
          detail: `Listener: ${config.listenIp}:${config.port}\nUDP relay ports: ${config.relayPorts.join('–')}\nLimits: 32 allocations, 8 per login, 32 TCP connections, 1,000,000 bytes per second per allocation. This is not a total bandwidth or data cap.\n\nThe operator can see connection addresses, authentication identities, timing and volume. Hosting consumes bandwidth. Check applicable laws and your ISP/VPN terms. Local binding does not prove Proton, VPN or public routing. Nothing will be advertised or shared. Closing the window, quitting or suspending requests Stop; suspension may occur before shutdown completes.`,
          buttons: ['Cancel', 'Start relay'], defaultId: 0, cancelId: 0 })
        if (response !== 1 || token !== generation || blocked) return
        let active
        active = createHost({ executable: config.executable, onState(next) {
          if (host === active) publish({ status: next.status, ...(next.endpoint ? { endpoint: next.endpoint } : {}) })
        } })
        host = active
        publish({ status: 'starting' })
        await active.start({ listenIp: config.listenIp, port: config.port, relayPorts: config.relayPorts })
        if (token !== generation || blocked) await stop()
      } catch {
        // Paths, binary output and configuration contents never enter native errors.
        if (token === generation) {
          if (host) await stop()
          publish({ status: 'failed' })
          await showDialog({ type: 'error', message: 'Local call relay could not start', detail: 'Check the owner-supplied development configuration and reviewed executable. No routing qualification was performed.', buttons: ['OK'], defaultId: 0, cancelId: 0 })
        }
      } finally { presenting = undefined }
    })()
    return presenting
  }
  return { state, present, stop, resume }
}
