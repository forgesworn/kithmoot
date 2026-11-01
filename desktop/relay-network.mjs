import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

/**
 * Whether this computer's default route leaves through a VPN, and if so
 * whether that VPN forwards ports (design-proton-relay.md, phase 1).
 *
 * A relay behind a full-tunnel VPN cannot be reached through the home router.
 * Some VPNs (Proton on its P2P servers) answer NAT-PMP at their gateway and
 * forward ports to the tunnel address; the relay can then run there, reached
 * at the VPN's address. spry-node maps the ports itself once it is told the
 * gateway (`--gateway`), so all this decides is which gateway, if any.
 */

/** Interface names that are tunnels: the same list spry-portmap uses. */
export const TUNNEL_PREFIXES = Object.freeze(['utun', 'ipsec', 'ppp', 'tun', 'wg', 'tap'])

const NATPMP_PORT = 5351

/** The interface that holds `address`, or undefined. */
export function interfaceFor(address, interfaces = networkInterfaces()) {
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    if ((entries ?? []).some(entry => entry?.address === address)) return name
  }
  return undefined
}

export function isTunnel(name) {
  return typeof name === 'string' && TUNNEL_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** The first host of the bind's /24: Proton's gateway (10.2.0.2 gives 10.2.0.1). */
export function candidateGateway(bind) {
  if (!isIPv4(bind)) return undefined
  const parts = bind.split('.').map(Number)
  if (parts[3] === 1) return undefined
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`
}

/** A public unicast IPv4 address: what callers outside could reach. */
export function publicAddress(address) {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19)))
}

/**
 * Ask `gateway` for its external address (RFC 6886 opcode 0), sent from
 * `bind` so it leaves through the tunnel. Resolves the address when the
 * gateway answers with success and a public address, else undefined. Never
 * rejects.
 */
export function probeNatPmp(gateway, { bind, timeoutMs = 1000, tries = 2, create = createSocket } = {}) {
  return new Promise(resolve => {
    if (!isIPv4(gateway)) { resolve(undefined); return }
    let socket
    let timer
    let sent = 0
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { socket?.close() } catch { /* Already closed. */ }
      resolve(value)
    }
    try { socket = create('udp4') } catch { resolve(undefined); return }
    socket.on('error', () => done(undefined))
    socket.on('message', (message, from) => {
      if (from?.address !== gateway || from?.port !== NATPMP_PORT) return
      if (message.length < 12 || message[0] !== 0 || message[1] !== 128) return
      if (message.readUInt16BE(2) !== 0) { done(undefined); return }
      const address = [...message.subarray(8, 12)].join('.')
      done(publicAddress(address) ? address : undefined)
    })
    const send = () => {
      if (settled) return
      if (sent >= tries) { done(undefined); return }
      sent++
      try { socket.send(Buffer.from([0, 0]), NATPMP_PORT, gateway) } catch { done(undefined); return }
      timer = setTimeout(send, timeoutMs)
    }
    try {
      socket.bind({ address: bind, port: 0 }, send)
    } catch { done(undefined) }
  })
}

/**
 * How the relay can run on the network `bind` belongs to:
 * - `{ kind: 'direct' }`: no tunnel; the home router is used as before.
 * - `{ kind: 'vpn-forwarding', gateway, publicAddress }`: a VPN that forwards
 *   ports; spry-node maps them at `gateway`.
 * - `{ kind: 'vpn' }`: a VPN without port forwarding; the relay cannot run.
 */
export async function classifyNetwork({ bind, interfaces = networkInterfaces, probe = probeNatPmp } = {}) {
  const name = interfaceFor(bind, typeof interfaces === 'function' ? interfaces() : interfaces)
  if (!isTunnel(name)) return { kind: 'direct' }
  const gateway = candidateGateway(bind)
  if (!gateway) return { kind: 'vpn' }
  const address = await probe(gateway, { bind })
  return address ? { kind: 'vpn-forwarding', gateway, publicAddress: address } : { kind: 'vpn' }
}
