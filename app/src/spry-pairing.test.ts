import { expect, it } from 'vitest'
import { completeSpryPairing, loadSpryPairing } from './spry-pairing.js'

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
