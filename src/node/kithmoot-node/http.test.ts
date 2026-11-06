import { afterEach, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NodeLedger } from './ledger.js'
import { NodeSupervisor } from './supervisor.js'
import { nodeHttp, preparePairing } from './http.js'
import { buildGrant } from '../../group-grants.js'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })
it('binds pairing and owner requests to the exact body, URL, method and a durable one-use nonce', async () => {
  const path = mkdtempSync(join(tmpdir(), 'kithmoot-node-http-')); cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  const nodeKey = generateSecretKey(), serviceKey = getPublicKey(nodeKey), now = Math.floor(Date.now() / 1000)
  const ledger = new NodeLedger(join(path, 'ledger.sqlite'), { host: 'node.example', serviceKey, salt: 'fixture' }); cleanup.push(() => ledger.close())
  const calls = { status: async () => ({ ready: true, leaseActive: true }), offer: async () => ({ v: 1 as const, endpoint: 'https://node.example', token: 'A'.repeat(43), expiresAt: now + 3600 }), register: async () => {}, remove: async () => {}, lease: async () => {} }
  let relayUnavailable = false, relayLease = false
  const relay = { sync: async () => {}, publish: async () => {}, purge: async () => 0, status: async () => {
    if (relayUnavailable) throw Error('private child path must never be returned')
    return { rooms: 0, devices: 0, usedBytes: 4096, leaseActive: relayLease }
  } }
  const supervisor = new NodeSupervisor(ledger, calls, relay, 'node.example', nodeKey)
  const server = nodeHttp(supervisor, { origin: 'https://node.example', origins: ['https://app.example'], serviceKey, turnPorts: { udpTcp: 34790, tls: 53499 } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`, owner = generateSecretKey(), foreign = generateSecretKey()
  function proof(path: string, body: string, key = owner) {
    return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: now, content: '', tags: [
      ['u', 'https://node.example' + path], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', randomBytes(32).toString('base64url')],
    ] }, key))).toString('base64')}`
  }
  const post = (path: string, body: string, auth: string, origin?: string) => fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: auth, ...(origin ? { origin } : {}) } })
  expect(await (await fetch(base + '/node/v1/info')).json()).toMatchObject({ turnPorts: { udpTcp: 34790, tls: 53499 }, calls: 'relay-only', files: 'off' })
  const pair = preparePairing(supervisor), body = JSON.stringify({ code: pair.code }), auth = proof('/node/v1/claim', body)
  expect((await post('/node/v1/claim', body, auth, 'https://evil.example')).status).toBe(403)
  expect((await post('/node/v1/claim', body.replace(pair.code, 'A'.repeat(43)), auth)).status).toBe(401)
  expect((await post('/node/v1/claim', body, auth)).status).toBe(200)
  expect(ledger.meta('pairing')).toBe('')
  expect((await post('/node/v1/claim', body, auth)).status).toBe(409)
  await supervisor.tick()
  expect(await supervisor.ownerStatus()).toMatchObject({ ready: true, relayReady: true, rooms: 0 })
  const authority = generateSecretKey(), room = JSON.stringify({ room: '01'.repeat(32), authority: getPublicKey(authority) })
  const roomBody = JSON.stringify({ ...JSON.parse(room), inviter: JSON.parse(room).authority, ends: now + 3600 })
  expect((await post('/node/v1/enrol', roomBody, proof('/node/v1/enrol', roomBody, foreign))).status).toBe(403)
  expect((await post('/node/v1/enrol', roomBody, proof('/groups/v1/events', roomBody))).status).toBe(401)
  expect((await post('/node/v1/enrol', roomBody, proof('/node/v1/enrol', roomBody))).status).toBe(200)
  expect(await supervisor.ownerStatus()).toMatchObject({ ready: false, relayReady: false, rooms: 1 })
  relayLease = true
  const status = JSON.stringify(await (await fetch(base + '/node/v1/status')).json())
  expect(status).not.toContain(JSON.parse(roomBody).room); expect(status).not.toContain(getPublicKey(owner))
  const statusBody = '{}'
  expect((await post('/node/v1/status', statusBody, proof('/node/v1/status', statusBody, foreign))).status).toBe(403)
  const detailed = await (await post('/node/v1/status', statusBody, proof('/node/v1/status', statusBody))).json()
  expect(detailed).toMatchObject({ v: 1, version: '0.1.0-rc.1', paired: true, rooms: 1, devices: 0, storeBytes: 4096, turnReady: true, relayReady: true })
  expect(JSON.stringify(detailed)).not.toContain(JSON.parse(roomBody).room); expect(JSON.stringify(detailed)).not.toContain(getPublicKey(owner))
  relayUnavailable = true
  const partial = await (await post('/node/v1/status', statusBody, proof('/node/v1/status', statusBody))).json()
  expect(partial).toMatchObject({ ready: false, relayReady: false }); expect(partial).not.toHaveProperty('storeBytes')
  expect(JSON.stringify(partial)).not.toContain('private child path')
  const reconnect = JSON.stringify({ code: preparePairing(supervisor).code })
  expect((await post('/node/v1/claim', reconnect, proof('/node/v1/claim', reconnect, foreign))).status).toBe(409)
  expect((await post('/node/v1/claim', reconnect, proof('/node/v1/claim', reconnect))).status).toBe(200)
  expect(ledger.meta('owner')).toBe(getPublicKey(owner)); expect(ledger.rooms()).toHaveLength(1)
  expect((await post('/node/v1/claim', reconnect, proof('/node/v1/claim', reconnect))).status).toBe(403)
  relayUnavailable = false
  const device = generateSecretKey(), grant = buildGrant({ authoritySk: authority, roomId: JSON.parse(room).room, device: getPublicKey(device),
    server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'], grantId: '01'.repeat(16), createdAt: now, expiration: now + 3600 })
  const confirmation = buildGrant({ authoritySk: authority, roomId: JSON.parse(room).room, device: getPublicKey(device),
    server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'], grantId: '01'.repeat(16), createdAt: now + 1, expiration: now + 3600 })
  for (const event of [grant, confirmation, confirmation]) {
    const body = JSON.stringify(event)
    expect((await post('/groups/v1/events', body, proof('/groups/v1/events', body, authority))).status).toBe(200)
  }
  const stale = JSON.stringify(grant)
  expect((await post('/groups/v1/events', stale, proof('/groups/v1/events', stale, authority))).status).toBe(409)
  const access = JSON.stringify({ room: JSON.parse(room).room, grant: '01'.repeat(16) })
  const accepted = await (await post('/node/v1/access', access, proof('/node/v1/access', access, device))).json()
  expect(accepted).toMatchObject({ state: 'active', event: confirmation, offer: { expiresAt: now + 3600 } })
  expect(ledger.devices()[0]?.expires).toBe(now + 3600)
})
