import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'

// RFC 6886 §§3.1–3.5: https://www.rfc-editor.org/rfc/rfc6886.html
// This is a one-shot diagnostic, with no discovery, retries, renewal or deletion.
// Proton's private-port-zero allocation flow is deliberately unsupported: this
// client probes explicit nonzero internal ports and cannot qualify that flow.
const messages = {
  ERR_CONFIG: 'Invalid NAT-PMP diagnostic configuration.',
  ERR_BUSY: 'A NAT-PMP diagnostic request is already running.',
  ERR_ABORTED: 'NAT-PMP diagnostic aborted.',
  ERR_TIMEOUT: 'NAT-PMP diagnostic timed out.',
  ERR_CONNECTION_REFUSED: 'NAT-PMP diagnostic connection refused.',
  ERR_SOURCE_UNAVAILABLE: 'NAT-PMP diagnostic source address unavailable.',
  ERR_ROUTE_UNAVAILABLE: 'NAT-PMP diagnostic route unavailable.',
  ERR_SOCKET: 'NAT-PMP diagnostic socket failed.',
  ERR_RESPONSE: 'Invalid NAT-PMP diagnostic response.',
  ERR_GATEWAY: 'NAT-PMP gateway refused the diagnostic request.',
}

export class NatPmpError extends Error {
  constructor(code, resultCode) {
    super(messages[code])
    this.name = 'NatPmpError'
    this.code = code
    if (resultCode !== undefined) this.resultCode = resultCode
  }
}

function invalid() { throw new NatPmpError('ERR_CONFIG') }
function socketError(error) {
  const code = error?.code
  if (code === 'ECONNREFUSED') return new NatPmpError('ERR_CONNECTION_REFUSED')
  if (code === 'EADDRNOTAVAIL') return new NatPmpError('ERR_SOURCE_UNAVAILABLE')
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return new NatPmpError('ERR_ROUTE_UNAVAILABLE')
  return new NatPmpError('ERR_SOCKET')
}
function privateIpv4(ip) {
  if (typeof ip !== 'string' || !isIPv4(ip)) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}
function loopbackIpv4(ip) {
  return typeof ip === 'string' && isIPv4(ip) && Number(ip.split('.')[0]) === 127
}
function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max }
function validateTimeout(timeoutMs) { if (!integer(timeoutMs, 1, 10000)) invalid() }
function validateSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid()
}
function mappingRequest(options = {}) {
  if (!options || typeof options !== 'object') invalid()
  const { protocol, internalPort, suggestedExternalPort, lifetimeSeconds = 60 } = options
  if (!['udp', 'tcp'].includes(protocol) || !integer(internalPort, 1, 65535) ||
      !integer(suggestedExternalPort, 0, 65535) || !integer(lifetimeSeconds, 1, 60)) invalid()
  const request = Buffer.alloc(12)
  request[1] = protocol === 'udp' ? 1 : 2
  request.writeUInt16BE(internalPort, 4)
  request.writeUInt16BE(suggestedExternalPort, 6)
  request.writeUInt32BE(lifetimeSeconds, 8)
  return { request, requested: { protocol, internalPort, suggestedExternalPort, lifetimeSeconds } }
}

// Exported for bounded offline parser tests. No response is a claim of ownership,
// reachability or a usable TURN route. The returned lease is the gateway's claim.
export function parseNatPmpResponse(datagram, request) {
  if (!Buffer.isBuffer(request) || ![2, 12].includes(request.length) || request[0] !== 0 ||
      (request.length === 2 ? request[1] !== 0 : ![1, 2].includes(request[1]))) invalid()
  if (request.length === 12) {
    mappingRequest({ protocol: request[1] === 1 ? 'udp' : 'tcp', internalPort: request.readUInt16BE(4),
      suggestedExternalPort: request.readUInt16BE(6), lifetimeSeconds: request.readUInt32BE(8) })
    if (request.readUInt16BE(2) !== 0) invalid()
  }
  const length = request[1] === 0 ? 12 : 16
  if (!Buffer.isBuffer(datagram) || datagram.length !== length || datagram[0] !== 0 ||
      datagram[1] !== request[1] + 128) throw new NatPmpError('ERR_RESPONSE')
  if (request[1] !== 0 && datagram.readUInt16BE(8) !== request.readUInt16BE(4)) {
    throw new NatPmpError('ERR_RESPONSE')
  }
  const resultCode = datagram.readUInt16BE(2)
  if (resultCode !== 0) throw new NatPmpError('ERR_GATEWAY', resultCode)
  const epochSeconds = datagram.readUInt32BE(4)
  if (request[1] === 0) {
    const octets = [...datagram.subarray(8)]
    // Reject unspecified, loopback, multicast and reserved external addresses.
    if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224) throw new NatPmpError('ERR_RESPONSE')
    return { externalAddress: octets.join('.'), epochSeconds }
  }
  const externalPort = datagram.readUInt16BE(10)
  const lifetimeSeconds = datagram.readUInt32BE(12)
  if (!externalPort || !lifetimeSeconds) throw new NatPmpError('ERR_RESPONSE')
  return { returned: { protocol: request[1] === 1 ? 'udp' : 'tcp', internalPort: datagram.readUInt16BE(8),
    externalPort, lifetimeSeconds }, epochSeconds }
}

function exchange({ sourceIp, gatewayIp, gatewayPort, timeoutMs, request, signal, socketFactory = createSocket }) {
  validateSignal(signal)
  if (signal?.aborted) return Promise.reject(new NatPmpError('ERR_ABORTED'))
  return new Promise((resolve, reject) => {
    let socket
    try { socket = socketFactory('udp4') }
    catch (error) { reject(socketError(error)); return }
    let settled = false
    let timer
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners('message')
      const complete = () => {
        socket.removeAllListeners()
        if (error) reject(error); else resolve(result)
      }
      try { socket.close(complete) } catch { complete() }
    }
    const onAbort = () => finish(new NatPmpError('ERR_ABORTED'))
    socket.on('error', error => finish(socketError(error)))
    socket.on('message', (datagram, remote) => {
      // A connected UDP socket also filters by address AND port in the kernel.
      if (remote.address !== gatewayIp || remote.port !== gatewayPort || remote.family !== 'IPv4') return
      // Check the size before the parser; never retain or expose arbitrary data.
      if (datagram.length !== (request[1] === 0 ? 12 : 16)) {
        finish(new NatPmpError('ERR_RESPONSE'))
      } else {
        finish(undefined, datagram)
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(new NatPmpError('ERR_TIMEOUT')), timeoutMs)
    try {
      socket.bind({ address: sourceIp, port: 0, exclusive: true }, () => {
        if (settled) return
        try {
          socket.connect(gatewayPort, gatewayIp, () => {
            if (settled) return
            try { socket.send(request, error => { if (error) finish(socketError(error)) }) }
            catch (error) { finish(socketError(error)) }
          })
        } catch (error) { finish(socketError(error)) }
      })
    } catch (error) { finish(socketError(error)) }
  })
}

function client({ sourceIp, gatewayIp, timeoutMs, exchangeRequest }) {
  let busy = false
  async function run(request, signal) {
    validateSignal(signal)
    if (busy) throw new NatPmpError('ERR_BUSY')
    busy = true
    try {
      const response = await exchangeRequest({ sourceIp, gatewayIp, gatewayPort: 5351, timeoutMs, request, signal })
      return parseNatPmpResponse(response, request)
    } finally { busy = false }
  }
  return Object.freeze({
    externalAddress(options = {}) {
      if (!options || typeof options !== 'object') invalid()
      return run(Buffer.from([0, 0]), options.signal)
    },
    async mapping(options = {}) {
      const { request, requested } = mappingRequest(options)
      return { requested, ...await run(request, options.signal) }
    },
  })
}

/** Explicit private/CGNAT IPv4 endpoints only; construction performs no I/O. */
export function createNatPmpClient(options = {}) {
  if (!options || typeof options !== 'object') invalid()
  const { sourceIp, gatewayIp, timeoutMs = 2000 } = options
  if (!privateIpv4(sourceIp) || !privateIpv4(gatewayIp)) invalid()
  validateTimeout(timeoutMs)
  return client({ sourceIp, gatewayIp, timeoutMs, exchangeRequest: exchange })
}

/** Test seam: callers must inject an exchange; production has no injection. */
export function createNatPmpClientWithExchangeForTest(options = {}) {
  if (!options || typeof options !== 'object') invalid()
  const { sourceIp, gatewayIp, timeoutMs = 2000, exchange: exchangeRequest } = options
  if (!privateIpv4(sourceIp) || !privateIpv4(gatewayIp) || typeof exchangeRequest !== 'function') invalid()
  validateTimeout(timeoutMs)
  return client({ sourceIp, gatewayIp, timeoutMs, exchangeRequest })
}

/** Offline fixture transport: loopback literals only, with an explicit port. */
export function exchangeNatPmpDatagramForTest({ sourceIp, gatewayIp, gatewayPort, timeoutMs = 2000, request, signal,
  socketFactoryForTest = createSocket } = {}) {
  if (!loopbackIpv4(sourceIp) || !loopbackIpv4(gatewayIp) || !integer(gatewayPort, 1, 65535)) invalid()
  validateTimeout(timeoutMs)
  if (typeof socketFactoryForTest !== 'function') invalid()
  // Reuse strict request validation without sending anything.
  try { parseNatPmpResponse(Buffer.alloc(request?.length === 2 ? 12 : 16), request) }
  catch (error) { if (!(error instanceof NatPmpError) || error.code === 'ERR_CONFIG') invalid() }
  return exchange({ sourceIp, gatewayIp, gatewayPort, timeoutMs, request: Buffer.from(request), signal,
    socketFactory: socketFactoryForTest })
}
