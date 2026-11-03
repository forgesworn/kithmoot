import { expect, it } from 'vitest'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { probeNodeUdp, probeNodeStream } from './doctor.js'
function response(request: Buffer): Buffer {
  const answer = Buffer.alloc(32); request.copy(answer, 0, 0, 20); answer.writeUInt16BE(0x101); answer.writeUInt16BE(12, 2)
  answer.writeUInt16BE(0x20, 20); answer.writeUInt16BE(8, 22); answer[25] = 1; return answer
}
it('requires the expected UDP source, transaction and bounded mapped-address attribute without exposing an address', async () => {
  const server = createSocket('udp4')
  await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve)); const address = server.address()
  server.on('message', (request, peer) => {
    const wrong = response(request); wrong[8] ^= 1
    server.send(wrong, peer.port, peer.address)
    server.send(response(request), peer.port, peer.address)
  })
  try { expect(await probeNodeUdp('127.0.0.1', address.port, 500)).toBe(true) }
  finally { await new Promise<void>(resolve => server.close(resolve)) }
})
it('accepts a split TCP STUN frame and rejects malformed or oversized replies', async () => {
  let malformed = false
  const server = createServer(socket => {
    socket.on('error', () => {})
    socket.once('data', request => {
      const answer = malformed ? Buffer.alloc(513) : response(request)
      socket.write(answer.subarray(0, 9)); setTimeout(() => socket.end(answer.subarray(9)), 10)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address()
  if (!address || typeof address === 'string') throw Error('fixture listener')
  try {
    expect(await probeNodeStream('127.0.0.1', address.port, undefined, 500)).toBe(true)
    malformed = true; expect(await probeNodeStream('127.0.0.1', address.port, undefined, 500)).toBe(false)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
it('bounds a silent UDP check instead of retaining a test socket or claiming readiness', async () => {
  const server = createSocket('udp4')
  await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve))
  try { expect(await probeNodeUdp('127.0.0.1', server.address().port, 30)).toBe(false) }
  finally { await new Promise<void>(resolve => server.close(resolve)) }
})
