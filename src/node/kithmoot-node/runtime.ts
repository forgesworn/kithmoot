import { spawn, type ChildProcess } from 'node:child_process'
import { constants, lstatSync, readFileSync, openSync, closeSync, fstatSync, mkdirSync, writeFileSync, fsyncSync, unlinkSync } from 'node:fs'
import { createServer as netServer, connect } from 'node:net'
import { join, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { isHostName } from '../../group-grants.js'
import { NodeLedger, NodeRefusal } from './ledger.js'
import { NodeSupervisor } from './supervisor.js'
import { SpryBackend, ShelterBackend } from './backends.js'
import { nodeHttp, preparePairing } from './http.js'
import { readNodeTurnPorts, type NodeTurnPorts } from '@forgesworn/fold-kit/node-room'
import { NODE_VERSION } from './version.js'

export interface NodeConfiguration {
  v: 1
  host: string
  hosting: 'rented' | 'archy'
  relayIp: string
  publicIp?: string
  aggregateBytesPerSecond: number
  maxBytes: number
  minFreeBytes: number
  maxRooms: number
  origins: string[]
  spryBinary: string
  shelterBinary: string
  certificate?: string
  certificateKey?: string
  tlsGate?: true
  turnPorts?: NodeTurnPorts
  relayPortFirst?: number
  deskPort: number
  spryPort: number
  shelterPort: number
}
const fields = ['v', 'host', 'hosting', 'relayIp', 'publicIp', 'aggregateBytesPerSecond', 'maxBytes', 'minFreeBytes', 'maxRooms', 'origins', 'spryBinary', 'shelterBinary', 'certificate', 'certificateKey', 'deskPort', 'spryPort', 'shelterPort', 'tlsGate', 'turnPorts', 'relayPortFirst']
function publicV4(value: unknown): boolean {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return false
  const [a, b, c] = value.split('.').map(Number)
  return value.split('.').every(v => Number(v) <= 255) && a! >= 1 && a! < 224 && a !== 10 && a !== 127
    && !(a === 100 && b! >= 64 && b! <= 127) && !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31)
    && !(a === 192 && (b === 168 || b === 0 && [0, 2].includes(c!)))
    && !(a === 198 && ([18, 19].includes(b!) || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113)
}
export function validateConfiguration(value: unknown): NodeConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw Error('Invalid node configuration')
  const c = value as NodeConfiguration, ports = readNodeTurnPorts(c.turnPorts), first = c.relayPortFirst ?? 49160
  if (!ports) throw Error('Invalid node TURN ports')
  const integer = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
  if (c.v !== 1 || typeof c.host !== 'string' || !isHostName(c.host) || !c.host.includes('.') || c.host.endsWith('.local')
    || !['rented', 'archy'].includes(c.hosting) || typeof c.relayIp !== 'string'
    || !publicV4(c.publicIp ?? c.relayIp) || c.publicIp !== undefined && !publicV4(c.publicIp)
    || !integer(c.aggregateBytesPerSecond, 1, 67108864) || !integer(c.maxBytes, 1048576, Number.MAX_SAFE_INTEGER)
    || !integer(c.minFreeBytes, 1048576, Number.MAX_SAFE_INTEGER) || !integer(c.maxRooms, 1, 64)
    || ![c.deskPort, c.spryPort, c.shelterPort].every(p => integer(p, 1024, 65535))
    || new Set([c.deskPort, c.spryPort, c.shelterPort, ports.udpTcp, ports.tls, ...Array.from({ length: 32 }, (_, i) => first + i)]).size !== 37
    || !integer(first, 1024, 65504) || c.tlsGate !== undefined && c.tlsGate !== true
    || c.tlsGate && (c.hosting !== 'archy' || c.certificate !== undefined || c.certificateKey !== undefined)
    || !Array.isArray(c.origins) || c.origins.length > 16) throw Error('Invalid node configuration')
  // The native backend parses/binds the actual interface. Never guess it from
  // a third-party IP service, hostname lookup or the operator's home router.
  if (!/^[0-9.]+$/.test(c.relayIp) || c.relayIp.split('.').length !== 4 || c.relayIp.split('.').some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) throw Error('Invalid relay interface')
  for (const origin of c.origins) { const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw Error('Invalid browser origin') }
  for (const path of [c.spryBinary, c.shelterBinary, ...(c.tlsGate ? [] : [c.certificate, c.certificateKey])]) if (typeof path !== 'string' || !isAbsolute(path)) throw Error('Node paths must be explicit absolute paths')
  return structuredClone(c)
}
function privateDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw Error('Node state directory must be private and owned by this user')
}
function privateRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 65536 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw Error('Node secrets must be private regular files owned by this user')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}
export interface InitialNodeSecrets { serviceKey: string; turnSecret: string; stateSalt: string }
function checkedSecrets(value: InitialNodeSecrets | undefined): InitialNodeSecrets {
  if (!value || Object.keys(value).length !== 3 || Object.keys(value).some(key => !['serviceKey', 'turnSecret', 'stateSalt'].includes(key)) || ![value.serviceKey, value.turnSecret, value.stateSalt].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    || new Set([value.serviceKey, value.turnSecret, value.stateSalt]).size !== 3) throw Error('Three independent manifest-declared node secrets are required')
  try { getPublicKey(new Uint8Array(Buffer.from(value.serviceKey, 'hex'))) } catch { throw Error('Invalid manifest service key') }
  return value
}
export function initialise(directory: string, value: unknown, resume = false, declared?: InitialNodeSecrets): void {
  const configuration = validateConfiguration(value)
  const imported = configuration.tlsGate || declared ? checkedSecrets(declared) : undefined
  mkdirSync(directory, { mode: 0o700, recursive: true }); privateDirectory(directory)
  if (!resume) {
    try { lstatSync(join(directory, 'node.json')); throw Error('Node state already exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  // Exclusive creation preserves an existing installation or partial attempt.
  const marker = join(directory, 'initialising')
  if (resume) privateRead(marker)
  else { const fd = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd) }
  for (const [name, contents] of [
    ['node.json', JSON.stringify(configuration, null, 2)],
    ['service.key', imported?.serviceKey ?? Buffer.from(generateSecretKey()).toString('hex')],
    ['turn.secret', imported?.turnSecret ?? randomBytes(32).toString('hex')],
    ['state.salt', imported?.stateSalt ?? randomBytes(32).toString('hex')],
  ]) {
    const path = join(directory, name!)
    if (resume) {
      try {
        const existing = privateRead(path).trim()
        if (name === 'node.json' ? JSON.stringify(validateConfiguration(JSON.parse(existing))) !== JSON.stringify(configuration) : !/^[a-f0-9]{64}$/.test(existing)) throw Error('Partial node state does not match this installation')
        if (imported && name !== 'node.json' && existing !== contents) throw Error('Manifest secrets differ from existing node state')
        continue
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const file = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try { writeFileSync(file, contents! + '\n'); fsyncSync(file) } finally { closeSync(file) }
  }
  const parent = openSync(directory, constants.O_RDONLY)
  try { fsyncSync(parent); unlinkSync(marker); fsyncSync(parent) } finally { closeSync(parent) }
}
export function readConfiguration(directory: string): NodeConfiguration {
  privateDirectory(directory)
  try { lstatSync(join(directory, 'initialising')); throw Error('Node initialisation is incomplete') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return validateConfiguration(JSON.parse(privateRead(join(directory, 'node.json'))))
}
/** Children are restarted here; their fail-closed leases cover desk death.
 * stdout/stderr are deliberately disconnected, including native diagnostics. */
export async function runNode(directory: string, declared?: InitialNodeSecrets): Promise<{ supervisor: NodeSupervisor; close(): Promise<void> }> {
  if (process.getuid?.() === 0) throw Error('Run the node as its unprivileged service user')
  const c = readConfiguration(directory), origin = `https://${c.host}`, ports = readNodeTurnPorts(c.turnPorts)!
  for (const binary of [c.spryBinary, c.shelterBinary]) {
    const info = lstatSync(binary)
    if (!info.isFile() || info.mode & 0o022 || !(info.mode & 0o111)) throw Error('Backend executables must be regular, executable and not writable by other users')
  }
  const rawKey = privateRead(join(directory, 'service.key')).trim(), secret = privateRead(join(directory, 'turn.secret')).trim(), salt = privateRead(join(directory, 'state.salt')).trim()
  if (c.tlsGate || declared) {
    const imported = checkedSecrets(declared)
    if (rawKey !== imported.serviceKey || secret !== imported.turnSecret || salt !== imported.stateSalt) throw Error('Manifest secrets differ from existing node state')
  }
  if (![rawKey, secret, salt].every(v => /^[0-9a-f]{64}$/.test(v))) throw Error('Invalid private node state')
  const key = new Uint8Array(Buffer.from(rawKey, 'hex')), serviceKey = getPublicKey(key)
  const ledger = new NodeLedger(join(directory, 'ledger.sqlite'), { host: c.host, serviceKey, salt, maxRooms: c.maxRooms })
  const relaySocket = join(directory, 'shelter.sock'), controlSocket = join(directory, 'node.sock')
  const supervisor = new NodeSupervisor(ledger, new SpryBackend({ local: `http://127.0.0.1:${c.spryPort}`, origin, key, turnSecret: secret }), new ShelterBackend(relaySocket), c.host, key)
  const http = nodeHttp(supervisor, { origin, origins: c.origins, serviceKey, turnPorts: c.turnPorts })
  const children = new Set<ChildProcess>(), timers = new Set<ReturnType<typeof setTimeout>>()
  let closing = false
  const launch = (binary: string, args: string[], environment: NodeJS.ProcessEnv, failures = 0): void => {
    if (closing) return
    const child = spawn(binary, args, { env: environment, stdio: 'ignore' }); children.add(child)
    let restarted = false
    const restart = (): void => {
      if (restarted) return; restarted = true; children.delete(child)
      if (closing) return
      const timer = setTimeout(() => { timers.delete(timer); launch(binary, args, environment, failures + 1) }, Math.min(30000, 1000 * 2 ** Math.min(failures, 5)))
      timers.add(timer)
    }
    child.once('exit', restart); child.once('error', restart)
  }
  // A stale socket can only be removed after obtaining the ledger's writer
  // lock. Never replace a live endpoint or a non-socket file.
  try {
    const info = lstatSync(controlSocket)
    if (!info.isSocket()) throw Error('Control path is not a socket')
    await new Promise<void>((resolve, reject) => {
      const socket = connect(controlSocket)
      socket.once('connect', () => { socket.destroy(); reject(Error('Control socket is in use')) })
      socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? resolve() : reject(error))
      socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Control socket could not be checked')) })
    })
    unlinkSync(controlSocket)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { ledger.close(); throw error } }
  let controls = 0
  const control = netServer(socket => {
    if (controls >= 8) { socket.destroy(); return }; controls++
    socket.once('close', () => { controls-- }); socket.setTimeout(3000, () => socket.destroy())
    let body = ''
    socket.on('data', chunk => { body += chunk.toString('utf8'); if (body.length > 256) socket.destroy() })
    socket.on('error', () => {})
    socket.on('end', () => {
      try {
        const value = JSON.parse(body)
        const result = value.op === 'pair' ? preparePairing(supervisor) : value.op === 'status' ? supervisor.status() : value.op === 'info' ? { v: 1, version: NODE_VERSION, origin, serviceKey } : undefined
        if (!result) throw Error('invalid operation')
        socket.end(JSON.stringify({ ok: true, result }))
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: error instanceof NodeRefusal ? error.code : 'invalid-local-request' })) }
    })
  })
  const close = async (): Promise<void> => {
    if (closing) return; closing = true
    for (const timer of timers) clearTimeout(timer)
    await supervisor.stop()
    await Promise.all([new Promise<void>(r => { http.close(() => r()); http.closeAllConnections() }), new Promise<void>(r => control.close(() => r()))])
    for (const child of children) {
      child.kill('SIGTERM')
      await new Promise<void>(r => { const timer = setTimeout(() => { child.kill('SIGKILL'); r() }, 5000); child.once('exit', () => { clearTimeout(timer); r() }) })
    }
    try { unlinkSync(controlSocket) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    finally { ledger.close(); key.fill(0) }
  }
  try {
    await new Promise<void>((r, reject) => { http.once('error', reject); http.listen(c.deskPort, '127.0.0.1', r) })
    await new Promise<void>((r, reject) => { control.once('error', reject); control.listen(controlSocket, r) })
    const { chmodSync } = await import('node:fs'); chmodSync(controlSocket, 0o600)
    launch(c.spryBinary, [], { SPRY_PUBLIC_URL: origin, SPRY_OWNER_KEYS: serviceKey, SPRY_PAIRING_KEY: serviceKey, SPRY_TURN_SECRET: secret,
      SPRY_ROOM_SEAL: 'required', SPRY_PUBLIC: 'false', SPRY_RELAY_IP: c.relayIp, ...(c.publicIp ? { SPRY_PUBLIC_IP: c.publicIp } : {}),
      SPRY_HTTP_BIND: '127.0.0.1', SPRY_HTTP_PORT: String(c.spryPort), SPRY_STATE_FILE: join(directory, 'spry.json'),
      ...(c.tlsGate ? { SPRY_TLS_GATE: 'true' } : { SPRY_TLS_CERT_FILE: c.certificate, SPRY_TLS_KEY_FILE: c.certificateKey }), SPRY_TLS_443: 'true',
      SPRY_TURN_PORT: String(ports.udpTcp), SPRY_TLS_PORT: String(ports.tls), SPRY_RELAY_PORTS: `${c.relayPortFirst ?? 49160}:${(c.relayPortFirst ?? 49160) + 31}`,
      SPRY_AGGREGATE_BYTES_PER_SECOND: String(c.aggregateBytesPerSecond), SPRY_ALLOWED_ORIGINS: c.origins.join(',') })
    launch(c.shelterBinary, ['room-relay', '--data', join(directory, 'rooms'), '--control', relaySocket, '--listen', `127.0.0.1:${c.shelterPort}`,
      '--url', `wss://${c.host}/events`, '--max-bytes', String(c.maxBytes), '--min-free-bytes', String(c.minFreeBytes), '--max-rooms', String(c.maxRooms)], {})
    supervisor.start()
    return { supervisor, close }
  } catch (error) { await close(); throw error }
}
export function localControl(directory: string, op: 'pair' | 'status' | 'info'): Promise<unknown> {
  privateDirectory(directory)
  return new Promise((resolve, reject) => {
    const socket = connect(join(directory, 'node.sock')); let result = ''
    socket.setTimeout(4000, () => { socket.destroy(); reject(Error('Local node did not answer')) })
    socket.once('error', () => reject(Error('Local node is unavailable')))
    socket.once('connect', () => socket.end(JSON.stringify({ op })))
    socket.on('data', chunk => { result += String(chunk); if (result.length > 65536) { socket.destroy(); reject(Error('Invalid local reply')) } })
    socket.once('end', () => { socket.destroy(); try { resolve(JSON.parse(result)) } catch { reject(Error('Invalid local reply')) } })
  })
}
