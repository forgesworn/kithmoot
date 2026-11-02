import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { statfsSync } from 'node:fs'
import { localControl, readConfiguration } from './runtime.js'
import { NODE_VERSION } from './version.js'
import { WebSocket } from 'ws'

function bindingRequest(): Buffer {
  const body = Buffer.alloc(20); body.writeUInt16BE(1); body.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(body, 8); return body
}
function bindingReply(body: Buffer, request: Buffer): boolean {
  if (body.length < 20 || body.length > 512 || body.readUInt16BE(0) !== 0x101 || body.readUInt16BE(2) + 20 !== body.length
    || body.readUInt16BE(2) % 4 || body.readUInt32BE(4) !== 0x2112a442 || !body.subarray(8, 20).equals(request.subarray(8, 20))) return false
  let mapped = false
  for (let cursor = 20; cursor < body.length;) {
    if (cursor + 4 > body.length) return false
    const type = body.readUInt16BE(cursor), size = body.readUInt16BE(cursor + 2); cursor += 4
    if (cursor + size > body.length) return false
    if (type === 0x20 && size === 8 && body[cursor] === 0 && body[cursor + 1] === 1) mapped = true
    cursor += size + (4 - size % 4) % 4
    if (cursor > body.length) return false
  }
  return mapped
}
/** Local STUN round-trip only: never logs or returns the mapped address. */
export function probeNodeUdp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createSocket('udp4'), request = bindingRequest(); let finished = false
    const finish = (value: boolean) => { if (finished) return; finished = true; clearTimeout(timer); try { socket.close() } catch {}; resolve(value) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on('error', () => finish(false))
    socket.on('message', (body, peer) => { if (peer.address === host && peer.port === port && bindingReply(body, request)) finish(true) })
    try { socket.send(request, port, host, error => { if (error) finish(false) }) } catch { finish(false) }
  })
}
export function probeNodeStream(host: string, port: number, servername?: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const request = bindingRequest(); let socket: Socket | undefined, body = Buffer.alloc(0), finished = false
    const finish = (value: boolean) => { if (finished) return; finished = true; clearTimeout(timer); socket?.destroy(); resolve(value) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    try {
      socket = servername ? tlsConnect({ host, port, servername, minVersion: 'TLSv1.2', ALPNProtocols: ['stun.turn'] }) : tcpConnect(port, host)
      socket.once(servername ? 'secureConnect' : 'connect', () => socket!.write(request))
      socket.once('error', () => finish(false)); socket.once('close', () => finish(false))
      socket.on('data', chunk => {
        if (body.length + chunk.length > 512) return finish(false)
        body = Buffer.concat([body, chunk])
        if (body.length >= 20 && body.length >= body.readUInt16BE(2) + 20) finish(bindingReply(body, request))
      })
    } catch { finish(false) }
  })
}
function publicJson(host: string, name: string, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: host, port: 443, servername: name, path, agent: false, headers: { host: name }, timeout: 3000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('Node HTTPS check failed')); return }
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) request.destroy(Error('Node HTTPS answer too large')); else chunks.push(Buffer.from(chunk)) })
      response.once('error', reject); response.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch { reject(Error('Invalid node HTTPS answer')) } })
    })
    request.once('timeout', () => request.destroy(Error('Node HTTPS timeout'))); request.once('error', reject); request.end()
  })
}
function roomChallenge(host: string, name: string): Promise<boolean> {
  return new Promise(resolve => {
    // ws forwards TLS options: connect to this interface with the canonical SNI.
    const options = { servername: name, headers: { host: name }, handshakeTimeout: 3000, maxPayload: 1024 }
    const socket = new WebSocket(`wss://${host}/events`, options)
    let finished = false
    const finish = (value: boolean) => { if (finished) return; finished = true; clearTimeout(timer); socket.terminate(); resolve(value) }
    const timer = setTimeout(() => finish(false), 3000)
    socket.on('error', () => finish(false)); socket.once('close', () => finish(false))
    socket.on('message', data => {
      try {
        const value = JSON.parse(data.toString())
        if (Array.isArray(value) && value.length === 2 && value[0] === 'AUTH' && typeof value[1] === 'string' && value[1].length > 0 && value[1].length <= 128) finish(true)
        else if (Array.isArray(value) && value[0] === 'EVENT') finish(false)
      } catch { finish(false) }
    })
  })
}
export async function doctorNode(directory: string) {
  const configuration = readConfiguration(directory), checks: { name: string; ok: boolean }[] = []
  const check = async (name: string, operation: () => Promise<boolean>) => { let ok = false; try { ok = await operation() } catch {}; checks.push({ name, ok }) }
  const control = await localControl(directory, 'info').catch(() => ({ ok: false })) as { ok?: boolean; result?: { serviceKey?: string } }
  const serviceKey = control.ok && control.result?.serviceKey
  await Promise.all([
    check('local-supervisor', async () => { const reply = await localControl(directory, 'status') as { ok?: boolean; result?: { ready?: boolean } }; return reply.ok === true && reply.result?.ready === true }),
    check('HTTPS-profile-and-identity', async () => { const value = await publicJson(configuration.relayIp, configuration.host, '/node/v1/info'); return !!serviceKey && value.serviceKey === serviceKey && value.version === NODE_VERSION && value.profile === 'kithmoot-node/1' && value.origin === `https://${configuration.host}` }),
    check('WSS-authentication-challenge', () => roomChallenge(configuration.relayIp, configuration.host)),
    check('local-DNS', async () => {
      const expected = configuration.publicIp ?? configuration.relayIp
      const addresses = await Promise.all([configuration.host, `turn.${configuration.host}`].map(name => lookup(name, { all: true })))
      return addresses.every(rows => rows.length > 0 && rows.every(row => row.family === 4 && row.address === expected))
    }),
    check('storage-reserve', async () => { const state = statfsSync(directory); return state.bavail * state.bsize >= configuration.minFreeBytes }),
    check('STUN-UDP-3478', () => probeNodeUdp(configuration.relayIp, 3478)),
    check('STUN-TCP-3478', () => probeNodeStream(configuration.relayIp, 3478)),
    check('STUN-TLS-5349', () => probeNodeStream(configuration.relayIp, 5349, configuration.host)),
    check('STUN-TLS-443', () => probeNodeStream(configuration.relayIp, 443, `turn.${configuration.host}`)),
  ])
  return { v: 1, version: NODE_VERSION, localReady: checks.every(check => check.ok), checks: checks.sort((a, b) => a.name.localeCompare(b.name)),
    externalPending: ['Independent DNS and public certificate trust', 'UDP/TCP/TLS reachability from another network', 'Authenticated TURN allocations and media over TLS443', 'Mobile-data and physical GrapheneOS call acceptance'],
    note: 'Local STUN and TLS checks do not qualify outside TURN media. No mapped address or participant data is recorded.' }
}
