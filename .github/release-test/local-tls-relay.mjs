import { execFileSync, spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect, createServer as reservePort } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:tls'

export async function startLocalTlsRelay(relayScript) {
  const host = 'room-board-fixture.invalid'
  const dir = await mkdtemp(join(tmpdir(), 'kithmoot-board-certificate-'))
  const pem = join(dir, 'cert.pem')
  const keyFile = join(dir, 'key.pem')
  let server, relay
  const sockets = new Set()
  async function shutdown() {
    for (const socket of sockets) socket.destroy()
    server?.close()
    relay?.kill()
    await rm(dir, { recursive: true, force: true })
  }
  try {
    execFileSync(process.env.KM_TEST_OPENSSL || 'openssl', [
      'req', '-new', '-newkey', 'rsa:2048', '-x509', '-nodes', '-days', '1', '-subj', '/CN=' + host,
      '-addext', 'subjectAltName=DNS:' + host, '-keyout', keyFile, '-out', pem,
    ], { stdio: 'ignore' })
    const cert = await readFile(pem)
    const key = await readFile(keyFile)
    const pin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({
      type: 'spki', format: 'der',
    })).digest('base64')
    const reservation = reservePort()
    await listen(reservation)
    const relayPort = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    relay = spawn(process.execPath, [relayScript], {
      env: { ...process.env, RELAY_PORT: String(relayPort), RELAY_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    server = createServer({ cert, key }, peer => {
      const backend = connect(relayPort, '127.0.0.1')
      sockets.add(peer)
      sockets.add(backend)
      peer.pipe(backend)
      backend.pipe(peer)
      const close = () => { peer.destroy(); backend.destroy(); sockets.delete(peer); sockets.delete(backend) }
      for (const socket of [peer, backend]) socket.on('error', close).on('close', close)
    })
    await listen(server)
    return {
      relayURL: 'wss://' + host + ':' + server.address().port,
      healthURL: 'http://127.0.0.1:' + relayPort + '/',
      browserArgs: ['--host-resolver-rules=MAP ' + host + ' 127.0.0.1', '--ignore-certificate-errors-spki-list=' + pin],
      shutdown,
    }
  } catch (error) {
    await shutdown()
    throw error
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
}
