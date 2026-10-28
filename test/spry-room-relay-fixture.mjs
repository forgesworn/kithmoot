#!/usr/bin/env node
/**
 * A disposable standard-profile Spry node behind a local HTTPS facade.
 *
 * This is a model of one member who runs their own Spry node and pairs
 * KithMoot with it, so that everyone in that member's rooms, including
 * guests with no Spry of their own, can reach a TURN relay. It starts:
 *
 *   - the real `spry-node` executable (spry-turn, standard profile), which in
 *     turn supervises the real `spry-turn` relay beside it;
 *   - a TLS facade on 127.0.0.1 with a throwaway certificate, standing in for
 *     the operator's HTTPS reverse proxy.
 *
 * Nothing here is a fabricated credential service: pairing, grants and
 * credentials are the node's own. The owner key is generated per run, lives
 * only in this process and the node's environment, and signs the owner-only
 * requests (pairing creation, listing, removal) on the test's behalf.
 *
 * Only aggregate synthetic counters are exposed. No access or request log is
 * kept, and no token, credential or key is printed, stored or returned.
 *
 * Build the executables with scripts/build-spry-node-fixture.sh, then point
 * E2E_SPRY_NODE_BINARY at the absolute path of `spry-node`; `spry-turn` must
 * sit beside it (or be named by E2E_SPRY_RELAY_BINARY).
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const FACADE_PORT = Number(process.env.E2E_SPRY_FACADE_PORT ?? 7795)
const APP_PORT = Number(process.env.E2E_PORT ?? 5595)
const HOST = process.env.E2E_SPRY_HOST ?? 'spry-node.example'
const ENDPOINT = `https://${HOST}:${FACADE_PORT}`
const APP_URL = `https://localhost:${APP_PORT}/j/`

const binary = process.env.E2E_SPRY_NODE_BINARY ?? ''
if (!isAbsolute(binary) || !existsSync(binary)) {
  throw new Error('Set E2E_SPRY_NODE_BINARY to the absolute path of a built spry-node (see scripts/build-spry-node-fixture.sh)')
}
const relayBinary = process.env.E2E_SPRY_RELAY_BINARY ?? join(dirname(binary), 'spry-turn')
if (!isAbsolute(relayBinary) || !existsSync(relayBinary)) throw new Error('spry-turn must sit beside spry-node or be named by E2E_SPRY_RELAY_BINARY')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

const root = mkdtempSync(join(tmpdir(), 'kithmoot-spry-room-'))
const ownerSecret = generateSecretKey()
const nodeSecret = randomBytes(32).toString('hex')
let nodeChild
let nodePort
let facade
let stopping = false

const observed = {
  nodeBinarySha256: sha256(readFileSync(binary)),
  relayBinarySha256: sha256(readFileSync(relayBinary)),
  credentialRequests: 0, grantRequests: 0, claimRequests: 0, pairingRequests: 0,
  deviceRequests: 0, vouchRequests: 0, removeRequests: 0, sealed: false, leakRefused: 0,
  cookies: false, referrer: false, query: false,
}
// Signing keys are public identifiers; only their count is exposed.
const signers = { credentials: new Set(), grants: new Set(), claims: new Set() }
// Hashes of issued usernames, so a test can prove which answer a browser used
// without the facade ever returning a credential.
const usernames = new Set()
// Spry keys the owner's app registered or a member vouched for: public
// identifiers, exposed only as yes or no for a key the test already holds.
const registered = new Set()

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
  })
}

function nodeRequest(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: nodePort, method, path, headers, timeout: 5000 }, (res) => {
      const chunks = []
      let length = 0
      res.on('data', (chunk) => {
        length += chunk.length
        if (length > 65536) { req.destroy(new Error('answer too large')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('node timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

/** An owner-authorised request, exactly as the node's own owner page signs one. */
async function ownerRequest(path, data) {
  const body = JSON.stringify(data)
  const event = finalizeEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
    tags: [['u', ENDPOINT + path], ['method', 'POST'], ['payload', sha256(body)], ['nonce', base64url(randomBytes(32))]],
  }, ownerSecret)
  const answer = await nodeRequest('POST', path, {
    'Content-Type': 'application/json',
    Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
    'Content-Length': Buffer.byteLength(body),
  }, body)
  if (answer.status !== 200) throw new Error(`owner request ${path} refused with ${answer.status}`)
  return JSON.parse(answer.body.toString())
}

async function startNode() {
  nodePort = await freePort()
  nodeChild = spawn(binary, [], {
    env: {
      PATH: process.env.PATH,
      SPRY_PUBLIC_URL: ENDPOINT,
      SPRY_KITHMOOT_URL: APP_URL,
      SPRY_OWNER_KEYS: getPublicKey(ownerSecret),
      SPRY_TURN_SECRET: nodeSecret,
      SPRY_STATE_FILE: join(root, 'pairings.json'),
      SPRY_HTTP_PORT: String(nodePort),
      // A loopback relay is allowed only in an explicit local-fixture run.
      SPRY_RELAY_IP: '127.0.0.1',
      SPRY_LOCAL_TEST: 'true',
      SPRY_RELAY_BINARY: relayBinary,
    },
    stdio: 'ignore',
  })
  const child = nodeChild
  child.on('exit', () => { if (nodeChild === child) nodeChild = undefined })
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!nodeChild) throw new Error('spry-node exited before it was ready')
    try {
      const status = JSON.parse((await nodeRequest('GET', '/v1/status')).body.toString())
      if (status.ready === true) return
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('spry-node did not become ready')
}

async function stopNode() {
  const child = nodeChild
  if (!child) return
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 4000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
  nodeChild = undefined
}

function signerOf(header) {
  try {
    const event = JSON.parse(Buffer.from(String(header).replace(/^Nostr /, ''), 'base64').toString())
    return typeof event.pubkey === 'string' && /^[a-f0-9]{64}$/.test(event.pubkey) ? event.pubkey : undefined
  } catch { return undefined }
}

function reply(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

function fixtureStats() {
  return {
    ...observed,
    entrypoint: ENDPOINT,
    nodeRunning: !!nodeChild,
    distinctCredentialSigners: signers.credentials.size,
    distinctGrantSigners: signers.grants.size,
    distinctClaimSigners: signers.claims.size,
    issuedUsernames: usernames.size,
  }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'https://fixture.invalid')
  // Fixture controls: never proxied, and never reachable by a browser page
  // because they send no CORS headers.
  if (url.pathname === '/') return reply(res, { ready: true })
  if (url.pathname === '/fixture/stats' && req.method === 'GET') return reply(res, fixtureStats())
  if (url.pathname.startsWith('/fixture/')) {
    if (req.method !== 'POST' && !['/fixture/username-seen', '/fixture/registered'].includes(url.pathname)) return reply(res, { error: 'Not found' }, 404)
    if (url.pathname === '/fixture/pairing') {
      const issued = await ownerRequest('/v1/pairings', {})
      return reply(res, { hash: new URL(issued.url).hash, expiresAt: issued.expiresAt })
    }
    if (url.pathname === '/fixture/revoke') {
      const { pairings } = await ownerRequest('/v1/pairings/list', {})
      for (const { id } of pairings) await ownerRequest('/v1/pairings/remove', { id })
      return reply(res, { removed: pairings.length })
    }
    if (url.pathname === '/fixture/reset') {
      for (const key of ['credentialRequests', 'grantRequests', 'claimRequests', 'pairingRequests', 'deviceRequests', 'vouchRequests', 'removeRequests', 'leakRefused']) observed[key] = 0
      for (const key of ['cookies', 'referrer', 'query', 'sealed']) observed[key] = false
      for (const set of [...Object.values(signers), usernames, registered]) set.clear()
      return reply(res, { reset: true })
    }
    if (url.pathname === '/fixture/stop-node') { await stopNode(); return reply(res, { nodeRunning: false }) }
    if (url.pathname === '/fixture/start-node') { if (!nodeChild) await startNode(); return reply(res, { nodeRunning: true }) }
    if (url.pathname === '/fixture/registered') {
      return reply(res, { registered: registered.has(url.searchParams.get('k') ?? '') })
    }
    if (url.pathname === '/fixture/leak') {
      // A leaked token in the hands of a browser that never joined the room:
      // a fresh key signs a credential request exactly as a client would.
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const { token } = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return reply(res, { error: 'token' }, 400)
      const body = JSON.stringify({ grant: token })
      const event = finalizeEvent({
        kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
        tags: [['u', ENDPOINT + '/v1/credentials'], ['method', 'POST'], ['payload', sha256(body)], ['nonce', base64url(randomBytes(32))]],
      }, generateSecretKey())
      const answer = await nodeRequest('POST', '/v1/credentials', {
        'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1',
        Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Length': Buffer.byteLength(body),
      }, body)
      if (answer.status === 403) observed.leakRefused++
      return reply(res, { status: answer.status })
    }
    if (url.pathname === '/fixture/username-seen') {
      return reply(res, { seen: usernames.has(sha256(url.searchParams.get('u') ?? '')) })
    }
    return reply(res, { error: 'Not found' }, 404)
  }
  // Everything else is the node itself, as its operator's proxy would pass it.
  if (req.headers.cookie) observed.cookies = true
  if (req.headers.referer) observed.referrer = true
  if (url.search) observed.query = true
  const signer = signerOf(req.headers.authorization)
  if (req.method === 'POST') {
    if (url.pathname === '/v1/credentials') { observed.credentialRequests++; if (signer) signers.credentials.add(signer) }
    if (url.pathname === '/v1/grants') { observed.grantRequests++; if (signer) signers.grants.add(signer) }
    if (url.pathname === '/v1/pairings/claim') { observed.claimRequests++; if (signer) signers.claims.add(signer) }
    if (url.pathname === '/v1/pairings') observed.pairingRequests++
    if (url.pathname === '/v1/grants/devices') observed.deviceRequests++
    if (url.pathname === '/v1/grants/vouch') observed.vouchRequests++
    if (url.pathname === '/v1/grants/remove') observed.removeRequests++
  }
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > 16384) { res.writeHead(413).end(); return }
    chunks.push(chunk)
  }
  if (!nodeChild) return reply(res, { error: 'unavailable' }, 503)
  const headers = { ...req.headers }
  delete headers.host; delete headers.connection
  headers['x-forwarded-for'] = '127.0.0.1'
  let answer
  try { answer = await nodeRequest(req.method ?? 'GET', url.pathname + url.search, headers, Buffer.concat(chunks)) }
  catch { return reply(res, { error: 'unavailable' }, 503) }
  if (req.method === 'POST' && url.pathname === '/v1/credentials' && answer.status === 200) {
    try { usernames.add(sha256(JSON.parse(answer.body.toString()).username)) } catch { /* not a credential answer */ }
  }
  if (req.method === 'POST' && answer.status === 200 && ['/v1/grants/devices', '/v1/grants/vouch'].includes(url.pathname)) {
    try {
      const sent = JSON.parse(Buffer.concat(chunks).toString())
      for (const key of sent.add ?? []) registered.add(key)
      for (const key of sent.remove ?? []) registered.delete(key)
      if (url.pathname === '/v1/grants/devices') observed.sealed = JSON.parse(answer.body.toString()).sealed === true
    } catch { /* not a registration */ }
  }
  const out = { ...answer.headers }
  delete out.connection; delete out['transfer-encoding']
  res.writeHead(answer.status, out)
  res.end(answer.body)
}

async function shutdown() {
  if (stopping) return
  stopping = true
  try { facade?.close(); facade?.closeAllConnections?.() } catch { /* already closed */ }
  await stopNode().catch(() => {})
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  const key = join(root, 'key.pem'), cert = join(root, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST},DNS:localhost,IP:127.0.0.1`], { stdio: 'ignore' })
  chmodSync(key, 0o600)
  await startNode()
  facade = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    handle(req, res).catch(() => { try { reply(res, { error: 'unavailable' }, 503) } catch { /* connection gone */ } })
  })
  // A browser's idle pre-opened socket must not hold up other requests.
  facade.on('tlsClientError', () => {})
  facade.on('clientError', (_error, socket) => { socket.destroy() })
  facade.listen(FACADE_PORT, '127.0.0.1')
} catch (error) {
  process.stderr.write(`spry-room-relay fixture failed: ${error instanceof Error ? error.message : 'unknown'}\n`)
  await stopNode().catch(() => {})
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
