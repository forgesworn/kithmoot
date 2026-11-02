import { afterEach, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NodeLedger } from './ledger.js'
import { NodeSupervisor } from './supervisor.js'
import { nodeHttp, preparePairing } from './http.js'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })
it('binds pairing and owner requests to the exact body, URL, method and a durable one-use nonce', async () => {
  const path = mkdtempSync(join(tmpdir(), 'kithmoot-node-http-')); cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  const nodeKey = generateSecretKey(), serviceKey = getPublicKey(nodeKey), now = Math.floor(Date.now() / 1000)
  const ledger = new NodeLedger(join(path, 'ledger.sqlite'), { host: 'node.example', serviceKey, salt: 'fixture' }); cleanup.push(() => ledger.close())
  const calls = { status: async () => ({ ready: true, leaseActive: true }), offer: async () => ({ v: 1 as const, endpoint: 'https://node.example', token: 'A'.repeat(43), expiresAt: now + 3600 }), register: async () => {}, remove: async () => {}, lease: async () => {} }
  const relay = { sync: async () => {}, publish: async () => {}, purge: async () => 0, status: async () => ({ rooms: 0, devices: 0, usedBytes: 0, leaseActive: true }) }
  const supervisor = new NodeSupervisor(ledger, calls, relay, 'node.example', nodeKey)
  const server = nodeHttp(supervisor, { origin: 'https://node.example', origins: ['https://app.example'], serviceKey })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listener')
  const base = `http://127.0.0.1:${address.port}`, owner = generateSecretKey(), foreign = generateSecretKey()
  function proof(path: string, body: string, key = owner) {
    return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: now, content: '', tags: [
      ['u', 'https://node.example' + path], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', randomBytes(32).toString('base64url')],
    ] }, key))).toString('base64')}`
  }
  const post = (path: string, body: string, auth: string, origin?: string) => fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: auth, ...(origin ? { origin } : {}) } })
  const pair = preparePairing(supervisor), body = JSON.stringify({ code: pair.code }), auth = proof('/node/v1/claim', body)
  expect((await post('/node/v1/claim', body, auth, 'https://evil.example')).status).toBe(403)
  expect((await post('/node/v1/claim', body.replace(pair.code, 'A'.repeat(43)), auth)).status).toBe(401)
  expect((await post('/node/v1/claim', body, auth)).status).toBe(200)
  expect(ledger.meta('pairing')).toBe('')
  expect((await post('/node/v1/claim', body, auth)).status).toBe(409)
  const room = JSON.stringify({ room: '01'.repeat(32), authority: getPublicKey(generateSecretKey()) })
  const roomBody = JSON.stringify({ ...JSON.parse(room), inviter: JSON.parse(room).authority })
  expect((await post('/node/v1/enrol', roomBody, proof('/node/v1/enrol', roomBody, foreign))).status).toBe(403)
  expect((await post('/node/v1/enrol', roomBody, proof('/groups/v1/events', roomBody))).status).toBe(401)
  expect((await post('/node/v1/enrol', roomBody, proof('/node/v1/enrol', roomBody))).status).toBe(200)
  const status = JSON.stringify(await (await fetch(base + '/node/v1/status')).json())
  expect(status).not.toContain(JSON.parse(roomBody).room); expect(status).not.toContain(getPublicKey(owner))
})
