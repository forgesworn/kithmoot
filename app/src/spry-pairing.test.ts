import { expect, it } from 'vitest'
import { completeSpryPairing, loadSpryPairing, parseSpryPairingInput } from './spry-pairing.js'

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
