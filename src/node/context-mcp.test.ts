import { it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256Hex } from '../attachment.js'
import { issueAgentOwnership } from '../ownership.js'
import { localIdentity } from '../identity.js'
import { localPeerCrypt } from '../dm.js'
import { ContextFileStore } from './context-store.js'

const ROOM = 'ab'.repeat(32)

it('independent MCP processes share over real HTTPS, recover encrypted caches and reject unauthorised writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kith-context-mcp-'))
  const clients: Client[] = [], blobs = new Map<string, Buffer>(), failures: string[] = []
  let downloads = 0
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  const server = createServer({ key: await readFile(join(dir, 'tls.key')), cert: await readFile(join(dir, 'tls.crt')) }, async (req, res) => {
    try {
      if (req.method === 'PUT' && req.url === '/upload') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks), hash = sha256Hex(body)
        const event = JSON.parse(Buffer.from((req.headers.authorization ?? '').slice(6), 'base64').toString())
        expect(verifyEvent(event)).toBe(true); expect(event.kind).toBe(24242)
        expect(event.tags).toContainEqual(['t', 'upload']); expect(event.tags).toContainEqual(['x', hash])
        // Match the deployed KithMoot server: uploads at /upload, blobs at /blossom/.
        blobs.set('/blossom/' + hash, body)
        res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ url: `${origin}/blossom/${hash}`, sha256: hash, size: body.length })); return
      }
      downloads++; expect(req.headers.cookie).toBeUndefined()
      const blob = blobs.get(req.url ?? '')
      res.writeHead(blob ? 200 : 404); res.end(blob)
    } catch (err) { failures.push(String(err)); res.writeHead(400); res.end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const origin = `https://localhost:${(server.address() as { port: number }).port}`
  const ownerSk = generateSecretKey(), otherPrincipalSk = generateSecretKey(), agentSk = generateSecretKey()
  async function connect(name: string, sk: Uint8Array, room = ROOM) {
    const keyPath = join(dir, name + '.key'); await writeFile(keyPath, bytesToHex(sk), { mode: 0o600 })
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('bin/kithmoot-context.mjs'), 'mcp', '--identity', keyPath, '--expect-pubkey', getPublicKey(sk), '--state', join(dir, name + '.json'), '--room', room, '--server', origin], env: { PATH: process.env.PATH!, NODE_EXTRA_CA_CERTS: join(dir, 'tls.crt') }, stderr: 'pipe' })
    const client = new Client({ name: 'context-acceptance', version: '1' })
    await client.connect(transport); clients.push(client); return client
  }
  async function call(client: Client, name: string, args = {}): Promise<any> {
    const result = await client.callTool({ name, arguments: args })
    const value = (result.content as { text: string }[])[0].text
    if (result.isError) throw new Error(value)
    return JSON.parse(value)
  }
  try {
    const owner = await connect('owner', ownerSk), agent = await connect('agent', agentSk)
    expect((await agent.listTools()).tools.map(t => t.name)).toContain('context_read')
    expect(downloads).toBe(0); expect(await call(agent, 'context_list')).toEqual([])
    let collection = await call(owner, 'context_create', { title: 'Shared security review', scope: 'kith', room: ROOM })
    const grant = { subject: getPublicKey(agentSk), role: 'read', expiresAt: Math.floor(Date.now() / 1000) + 3600, agent: issueAgentOwnership({ principalSk: otherPrincipalSk, agent: getPublicKey(agentSk), issuedAt: Math.floor(Date.now() / 1000) }) }
    collection = await call(owner, 'context_set_grants', { collection: collection.id, expectedHead: collection.head, grants: [grant] })
    collection = await call(owner, 'context_append', { collection: collection.id, expectedHead: collection.head, kind: 'blocker', text: 'Person must check the physical display.', source: 'kithmoot://fixture/record/42', observedAt: Math.floor(Date.now() / 1000) })
    await call(owner, 'context_upload', { collection: collection.id, server: origin })
    let ticket = await call(owner, 'context_access', { collection: collection.id, recipient: getPublicKey(agentSk) })
    await call(agent, 'context_preview', { access: JSON.stringify(ticket) }); expect(downloads).toBe(0)
    expect((await call(agent, 'context_import', { access: JSON.stringify(ticket) })).records[0].text).toContain('physical display')
    await expect(call(agent, 'context_append', { collection: collection.id, expectedHead: collection.head, kind: 'fact', text: 'unauthorised', source: 'fixture', observedAt: 1 })).rejects.toThrow('write permission')
    await expect(call(agent, 'context_create', { title: 'Private', scope: 'personal' })).rejects.toThrow('room adapter')
    const cache = await readFile(join(dir, 'agent.json'), 'utf8')
    expect(cache).not.toContain('physical display'); expect(cache).not.toContain('Shared security review')
    expect((await stat(join(dir, 'agent.json'))).mode & 0o077).toBe(0)
    expect([...blobs.values()].every(b => !b.includes('physical display'))).toBe(true)
    await agent.close()
    const restarted = await connect('agent', agentSk), calls = downloads
    expect((await call(restarted, 'context_read', { collection: collection.id })).records).toHaveLength(1)
    expect(downloads).toBe(calls)
    for (const text of ['A second record.', 'A third record.']) collection = await call(owner, 'context_append', { collection: collection.id, expectedHead: collection.head, kind: 'fact', text, source: 'fixture', observedAt: Math.floor(Date.now() / 1000) })
    await call(owner, 'context_upload', { collection: collection.id, server: origin })
    ticket = await call(owner, 'context_access', { collection: collection.id, recipient: getPublicKey(agentSk) })
    expect((await call(restarted, 'context_import', { access: JSON.stringify(ticket) })).records).toHaveLength(3)
    const wrongRoom = await connect('other-room', agentSk, 'cd'.repeat(32)), before = downloads
    await expect(call(wrongRoom, 'context_import', { access: JSON.stringify(ticket) })).rejects.toThrow('not available')
    expect(downloads).toBe(before)
    await call(owner, 'context_set_grants', { collection: collection.id, expectedHead: collection.head, grants: [] })
    await call(owner, 'context_upload', { collection: collection.id, server: origin })
    await expect(call(owner, 'context_access', { collection: collection.id, recipient: getPublicKey(agentSk) })).rejects.toThrow('recipient grant')
    expect(failures).toEqual([])
  } finally {
    await Promise.all(clients.map(c => c.close().catch(() => {})))
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

it('serialises disk writers, detects stale heads, and refuses a cache reused for a different room', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kith-context-lock-')), sk = generateSecretKey()
  const options = { identity: { ...localIdentity(sk), ...localPeerCrypt(sk) }, room: ROOM }
  const store = new ContextFileStore(join(dir, 'cache.json'), options)
  try {
    const initial = await store.run(v => v.create({ title: 'Room', scope: 'kin', room: ROOM }), true)
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    const locked = store.run(async () => { entered(); await new Promise<void>(r => { release = r }) })
    await ready
    try { await expect(store.run(v => v.list())).rejects.toThrow('busy') } finally { release(); await locked }
    await store.run(v => v.append(initial.id, initial.head, { kind: 'fact', text: 'one', source: 'fixture', observedAt: 1 }), true)
    await expect(store.run(v => v.append(initial.id, initial.head, { kind: 'fact', text: 'two', source: 'fixture', observedAt: 1 }), true)).rejects.toThrow('changed')
    expect((await store.run(v => v.read(initial.id))).records.map(r => r.text)).toEqual(['one'])
    await expect(new ContextFileStore(store.path, { ...options, room: 'cd'.repeat(32) }).run(v => v.list())).rejects.toThrow('scope')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
