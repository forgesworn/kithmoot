import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { getPublicKey } from 'nostr-tools/pure'
import { completeSpryPairing, loadSpryPairing, parseAccountSpryPairing, parseSpryPairingInput } from './spry-pairing.js'

const pairingHash = () => '#spry=' + btoa(JSON.stringify({ v: 1, endpoint: 'https://relay.example:3744', code: 'a'.repeat(43), expiresAt: Math.floor(Date.now()/1000)+100 })).replaceAll('=', '')

it('reads complete pasted app and web links locally, rejecting other inputs', () => {
  const hash = pairingHash()
  for (const base of ['kithmoot://join', 'https://kithmoot.app/j/', 'https://workspace.example/j/']) {
    expect(parseSpryPairingInput('  ' + base + hash + '\n')).toBe(hash)
  }
  for (const input of ['javascript:alert(1)', 'https://user:password@example.test/j/'+hash, 'kithmoot://signet'+hash,
    'https://example.test/?code=secret'+hash, 'http://example.test/j/'+hash, 'kithmoot://join?other=1'+hash,
    'kithmoot://join#spry=invalid', 'x'.repeat(5000)]) {
    expect(() => parseSpryPairingInput(input)).toThrow()
  }
})

it('does not overwrite another account pairing if identity changes during consent or claim', async () => {
  let current = true, requests = 0, writes = 0
  const store = { setItem: () => { writes++ } }
  const fetcher: typeof fetch = async () => { requests++; current = false; return Response.json({ version: 1, endpoint: 'https://relay.example:3744', id: 'b'.repeat(43) }) }
  expect(await completeSpryPairing(pairingHash(), store, 'alice', async () => { current = false; return true }, fetcher, () => current)).toBe(false)
  expect(requests).toBe(0)
  current = true
  expect(await completeSpryPairing(pairingHash(), store, 'alice', async () => true, fetcher, () => current)).toBe(false)
  expect(requests).toBe(1)
  expect(writes).toBe(0)
})

it('requires consent and keeps pairing authority with the selected account', async () => {
  const values = new Map<string, string>(), store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const endpoint = 'https://relay.example:3744', code = 'a'.repeat(43), expiresAt = Math.floor(Date.now() / 1000) + 100
  const hash = '#spry=' + btoa(JSON.stringify({ v: 1, endpoint, code, expiresAt })).replaceAll('=', '')
  let requests = 0
  const fetcher: typeof fetch = async () => { requests++; return Response.json({ version: 1, endpoint, id: code }) }
  expect(await completeSpryPairing(hash, store, 'alice', async () => false, fetcher)).toBe(false)
  expect(requests).toBe(0)
  expect(await completeSpryPairing(hash, store, 'alice', async () => true, fetcher)).toBe(true)
  expect(loadSpryPairing(store, 'alice')?.endpoint).toBe(endpoint)
  expect(loadSpryPairing(store, 'bob')).toBeUndefined()
  expect(JSON.stringify([...values.values()])).not.toContain(code + '"' + ',"expiresAt')
})

it('keeps the per-room share choice on this device, per person, bounded and tolerant of junk', async () => {
  const { loadSpryShare, saveSpryShare } = await import('./spry-pairing.js')
  const { classifyOrdinaryPhysicalName } = await import('./ordinary-physical-snapshot.js')
  const data = new Map<string, string>()
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  const me = 'a'.repeat(64), other = 'b'.repeat(64), room = 'c'.repeat(64)
  expect(loadSpryShare(store, me, room)).toBe(false)
  saveSpryShare(store, me, room, true)
  expect(loadSpryShare(store, me, room)).toBe(true)
  expect(loadSpryShare(store, other, room)).toBe(false)
  expect([...data.keys()]).toEqual(['kithmoot.spry-share.v1'])
  // Registered with the storage classifier, or it would hold room access.
  expect(classifyOrdinaryPhysicalName('kithmoot.spry-share.v1', 'browser')?.family).toBe('routing')
  saveSpryShare(store, me, room, false)
  expect(loadSpryShare(store, me, room)).toBe(false)
  expect(data.size).toBe(0)
  data.set('kithmoot.spry-share.v1', '{not json')
  expect(loadSpryShare(store, me, room)).toBe(false)
  data.set('kithmoot.spry-share.v1', JSON.stringify([7, 'x', `${me}:${room}`]))
  expect(loadSpryShare(store, me, room)).toBe(true)
  for (let i = 0; i < 300; i++) saveSpryShare(store, me, i.toString(16).padStart(64, '0'), true)
  expect(JSON.parse(data.get('kithmoot.spry-share.v1')!)).toHaveLength(256)
  expect(() => saveSpryShare(store, 'visitor', room, true)).toThrow()
})

it('renders the share row from the session alone, never minting a visitor key before a saved account resolves', () => {
  // renderSpryShareChoice runs in the lobby as well as in a room. With no
  // account connected yet, currentIdentity() falls back to participantKey(),
  // which mints and keeps a visitor key in a browser whose saved Nostr
  // account is still being restored.
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const start = main.indexOf('function renderSpryShareChoice(')
  expect(start).toBeGreaterThan(-1)
  const body = main.slice(start, main.indexOf('\nfunction ', start + 1))
  expect(body).not.toMatch(/\b(currentIdentity|participantKey|localIdentity)\(/)
  expect(body).toContain('ownSpryPairing(s.participant)')
  // The helper reads the hand pairing and this computer's own relay by the
  // participant it is given, and never the current identity.
  const helper = main.slice(main.indexOf('function ownSpryPairing('), main.indexOf('\nfunction ', main.indexOf('function ownSpryPairing(') + 1))
  expect(helper).not.toMatch(/\b(currentIdentity|participantKey|localIdentity)\(/)
})

it('keeps the endpoint a built-in relay reports exactly as the node printed it', () => {
  // The shape of spry-node's ready line: clients compare spry: endpoints as
  // whole strings, so any rewriting here would leave the desktop's own relay
  // running while the page never matched its offers.
  const endpoint = `spry://${getPublicKey(new Uint8Array(32).fill(5))}?relay=wss%3A%2F%2Frelay.primal.net%2F`
  const pair = parseAccountSpryPairing({ v: 1, endpoint, id: 'p'.repeat(43), secretKey: '01'.repeat(32), participant: 'd'.repeat(64), local: { host: '192.168.1.20', port: 30000 } })
  expect(pair.endpoint).toBe(endpoint)
})
