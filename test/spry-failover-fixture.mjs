import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { createConnection, createServer as tcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// Disposable TURN servers with separate operator secrets and real TLS.
// The local TCP proxy can stop forwarding without closing a client socket.
const host = '127.0.0.1'
const binary = process.env.E2E_SPRY_RELAY_BINARY ?? ''
if (!isAbsolute(binary)) throw new Error('Set E2E_SPRY_RELAY_BINARY to an absolute TLS-enabled spry-turn binary')
const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'kithmoot-spry-failover-'))
const relays = []

async function listen(server, port = 0) {
  server.listen(port, host)
  await once(server, 'listening')
  return server.address().port
}

async function startRelay(role) {
  const key = join(root, role + '.key'), cert = join(root, role + '.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', key, '-out', cert], { stdio: 'ignore' })
  const probe = tcpServer()
  const backendPort = await listen(probe)
  await new Promise(resolve => probe.close(resolve))

  const env = { SPRY_TURN_SECRET: randomBytes(32).toString('hex') }
  const child = spawn(binary, ['serve', '--listen', host + ':0', '--allow-loopback-peers', '--exit-on-stdin-close',
    '--realm', role + '.test', '--tls-listen', host + ':' + backendPort, '--tls-cert', cert, '--tls-key', key],
  { env, stdio: ['pipe', 'ignore', 'pipe'] })
  const exited = new Promise(resolve => {
    child.once('close', resolve)
    child.once('error', resolve)
  })
  child.stdin.on('error', () => {})
  const stop = async () => {
    child.stdin.end()
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
    try { await exited } finally { clearTimeout(deadline) }
  }

  const sockets = new Map()
  let connections = 0
  let blocked = false
  const frontend = tcpServer(client => {
    connections++
    const backend = blocked ? undefined : createConnection(backendPort, host)
    sockets.set(client, backend)
    client.on('error', () => client.destroy())
    client.on('close', () => { sockets.delete(client); backend?.destroy() })
    backend?.on('error', () => client.destroy())
    backend?.on('close', () => client.destroy())
    if (backend) client.pipe(backend).pipe(client)
    else client.resume()
  })
  const close = async () => {
    const closed = new Promise(resolve => frontend.close(resolve))
    for (const client of sockets.keys()) client.destroy()
    await Promise.all([closed, stop()])
  }

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Spry did not become ready')), 6000)
      let output = ''
      child.stderr.on('data', chunk => {
        output = (output + chunk).slice(-512)
        if (/ready \(UDP\/TCP /.test(output)) { clearTimeout(timer); resolve() }
      })
      void exited.then(() => {
        clearTimeout(timer)
        reject(new Error(role + ' Spry exited before binding TLS. ' + output.trim()))
      })
    })
    const port = await listen(frontend)
    return {
      close, stop,
      connections: () => connections,
      blackhole() {
        blocked = true
        for (const [client, backend] of sockets) {
          if (!backend) continue
          client.unpipe(backend).resume()
          backend.unpipe(client).resume()
        }
      },
      login(device) {
        const login = JSON.parse(execFileSync(binary, ['credential', '--ttl', '3600', '--label', role + '-' + device],
          { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
        return { urls: ['turns:' + host + ':' + port + '?transport=tcp'], ...login }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function reset() {
  await Promise.all(relays.splice(0).map(relay => relay.close()))
  relays.push(await startRelay('primary'))
  relays.push(await startRelay('standby'))
}

const api = httpServer(async (request, response) => {
  try {
    const reply = value => response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
    if (request.method === 'GET') {
      if (request.url === '/') return reply({ ready: true })
      if (request.url === '/stats') return reply({ binarySha256, connections: relays.map(relay => relay.connections()) })
      const device = /^\/login\/([0-2])$/.exec(request.url ?? '')?.[1]
      if (device) return reply({ ...relays[0].login(device), standby: relays[1].login(device) })
    }
    if (request.method === 'POST') {
      if (request.url === '/reset') { await reset(); return reply({ ready: true }) }
      if (request.url === '/stop') { await relays[0].stop(); return reply({ stopped: true }) }
      if (request.url === '/blackhole') { relays[0].blackhole(); return reply({ blocked: true }) }
    }
    response.writeHead(404).end()
  } catch {
    response.writeHead(500).end()
  }
})

async function shutdown() {
  api.close()
  await Promise.all(relays.splice(0).map(relay => relay.close()))
  await rm(root, { recursive: true, force: true })
}
process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })
try {
  await reset()
  await listen(api, Number(process.env.E2E_SPRY_FAILOVER_PORT ?? 7797))
} catch (error) {
  await shutdown()
  throw error
}
