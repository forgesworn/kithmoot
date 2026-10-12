// Real Node ws against a loopback-only unfinished HTTP upgrade. No room or radio.
import http from 'node:http'
import WebSocket from 'ws'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { NostrRelayPool } from '../dist/src/relay-pool.js'

const mode = process.argv[2] ?? 'bare'
const sockets = new Set()
const created = []
let existingErrors = 0
let closed = 0
const server = http.createServer()
server.on('connection', socket => {
  sockets.add(socket)
  socket.once('end', () => socket.destroy())
  socket.once('close', () => sockets.delete(socket))
})
server.on('upgrade', () => {})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
class TrackedSocket extends WebSocket {
  constructor(...args) {
    super(...args)
    created.push(this)
    if (mode === 'observer') this.on('error', () => { existingErrors++ })
    this.once('close', () => { closed++ })
  }
}
process.once('uncaughtExceptionMonitor', error => {
  console.log(JSON.stringify({ fatalAbandonedHandshake: error.message === 'WebSocket was closed before the connection was established' }))
})
if (mode === 'unrelated') process.nextTick(() => { throw new Error('synthetic unrelated fatal') })
const pool = new NostrRelayPool([`ws://127.0.0.1:${address.port}`], undefined,
  { websocketImplementation: TrackedSocket })
const key = generateSecretKey()
const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'synthetic loopback handshake refusal' }, key)
key.fill(0)
let rejected = false
try {
  await pool.publish(event)
} catch {
  rejected = true
} finally {
  pool.close()
}
const deadline = Date.now() + 2000
while (Date.now() < deadline && (closed !== created.length || sockets.size)) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
console.log(JSON.stringify({ rejected, created: created.length, closed, existingErrors,
  remainingSockets: sockets.size,
  remainingErrorListeners: created.map(socket => socket.listenerCount('error')),
  allSocketsClosed: created.every(socket => socket.readyState === WebSocket.CLOSED) }))
for (const socket of sockets) socket.destroy()
await new Promise(resolve => server.close(resolve))
