import { readNodeTurnPorts } from '@forgesworn/fold-kit/node-room'
import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createNodeFront, type NodeFrontRoutes } from './front.js'
import { nodeRelayRange } from './relay-ports.js'

export interface NodeFrontConfiguration extends NodeFrontRoutes { v: 1; certificate: string; certificateKey: string }
const fields = ['v', 'host', 'relayIp', 'deskPort', 'spryPort', 'shelterPort', 'certificate', 'certificateKey', 'turnPorts', 'relayPortFirst', 'relayPortCount']
function checkedFile(path: string, privateKey = false): Buffer {
  if (!isAbsolute(path)) throw Error('Node front paths must be absolute')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const file = fstatSync(fd)
    if (!file.isFile() || file.size > 262144 || file.mode & 0o022 || privateKey && file.mode & 0o007
      || file.uid !== 0 && process.getuid && file.uid !== process.getuid()) throw Error('Node front files must be protected regular files owned by root or this service user')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
export function readFrontConfiguration(path: string): NodeFrontConfiguration {
  const c = JSON.parse(checkedFile(path).toString('utf8')) as NodeFrontConfiguration
  const ports = readNodeTurnPorts(c?.turnPorts), range = nodeRelayRange(c ?? {})
  if (!ports) throw Error('Invalid node front port profile')
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(key => !fields.includes(key)) || c.v !== 1
    || ![c.certificate, c.certificateKey].every(value => typeof value === 'string' && isAbsolute(value))
    || typeof c.relayIp !== 'string' || !Object.values(networkInterfaces()).flat().some(address => address?.family === 'IPv4' && address.address === c.relayIp)
    || ![c.deskPort, c.spryPort, c.shelterPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
    || new Set([c.deskPort, c.spryPort, c.shelterPort, ports.udpTcp, ports.tls, ...Array.from({ length: range.count }, (_, i) => range.first + i)]).size !== range.count + 5) throw Error('Invalid node front configuration')
  return c
}
export function readFrontCredentials(configuration: NodeFrontConfiguration) {
  return { cert: checkedFile(configuration.certificate), key: checkedFile(configuration.certificateKey, true) }
}
export async function runFront(path: string) {
  if (process.getuid?.() === 0) throw Error('Run the TLS front as its unprivileged service user')
  const configuration = readFrontConfiguration(path)
  const credentials = () => readFrontCredentials(configuration)
  const front = createNodeFront(configuration, credentials())
  try {
    await new Promise<void>((resolve, reject) => { front.server.once('error', reject); front.server.listen(443, '0.0.0.0', resolve) })
  } catch (error) { await front.close().catch(() => {}); throw error }
  return { close: front.close, reload: () => front.reload(credentials()) }
}
