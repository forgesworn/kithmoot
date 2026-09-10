import { describe, expect, it } from 'vitest'
import { ContextVault } from './index.js'
import { createNostrIdentity } from './nostr.js'

const now = 1800000000
const identity = createNostrIdentity(new Uint8Array(32).fill(17))
const room = 'a1'.repeat(32)
async function fixture() {
  const vault = new ContextVault({ identity, room, now: () => now, fetch: async () => { throw new Error('Retrieval must not fetch') } })
  let view = await vault.create({ title: 'Workshop decisions', scope: 'kith', room })
  async function add(text: string, source: string, supersedes?: string) {
    view = await vault.append(view.id, view.head, { kind: 'evidence', text, source, observedAt: now, ...(supersedes ? { supersedes } : {}) })
    return view.records.at(-1)!
  }
  return { vault, add, view: () => view }
}

describe('bounded retrieval of authorised signed context', () => {
  it('returns query hits and one-hop provenance links without reading referenced collections or URLs', async () => {
    const f = await fixture()
    const first = await f.add('The turbine failed its inspection.', 'https://example.test/build/41')
    const shared = await f.add('The replacement bearing arrived.', 'https://example.test/build/41')
    const reference = await f.add(`Follow-up to context:${first.id}`, 'https://example.test/review/41')
    const remote = await f.add(`Second hop context:${reference.id}`, 'https://example.test/other')
    await f.add('Private-looking reference context:' + 'ff'.repeat(32), 'https://example.test/foreign')
    const result = f.vault.retrieve(f.view().id, { query: 'why did the turbine fail?', maxRecords: 8 })
    expect(result.records.map(r => r.id)).toEqual(expect.arrayContaining([first.id, shared.id, reference.id]))
    expect(result.records.map(r => r.id)).not.toContain(remote.id)
    expect(result.records.find(r => r.id === shared.id)).toMatchObject({ match: 'related', via: first.id })
    expect(result.links).toContainEqual({ from: first.id, to: shared.id, kind: 'same-source' })
    expect(result.links).toContainEqual({ from: reference.id, to: first.id, kind: 'record-reference' })
    expect(result).toMatchObject({ collection: f.view().id, room, head: f.view().head, evidenceOnly: true, cachedRevision: true })
    expect(result.records[0]).toMatchObject({ author: identity.pubkey, source: first.source, event: first.event, observedAt: now })
    expect(f.vault.retrieve(f.view().id, { query: 'turbine', includeRelated: false }).records.map(r => r.id)).toEqual([first.id])
  })

  it('rebuilds from the current head after corrections and never expands superseded records', async () => {
    const f = await fixture()
    const old = await f.add('The turbine is approved.', 'fixture://inspection')
    const prior = f.vault.retrieve(f.view().id, { query: 'turbine' })
    const corrected = await f.add('The turbine is refused until repaired.', 'fixture://inspection', old.id)
    const next = f.vault.retrieve(f.view().id, { query: 'turbine' })
    expect(next.head).not.toBe(prior.head)
    expect(next.records.map(r => r.id)).toEqual([corrected.id])
    expect(next.records[0].supersedes).toBe(old.id)
    expect(next.records[0].text).not.toContain('approved')
    expect(next.links).toEqual([])
    expect(f.vault.retrieve(f.view().id, { query: 'turbine', observedSince: now + 1 }).records).toEqual([])
  })

  it('caps the entire UTF-8 response, keeps complete evidence and can skip a record too large to fit', async () => {
    const f = await fixture()
    const large = await f.add('Turbine ' + '界'.repeat(3000), 'fixture://large')
    const small = await f.add('Turbine bearing replacement verified.', 'fixture://small')
    for (const maxBytes of [1024, 1600, 2048, 8192]) {
      const result = f.vault.retrieve(f.view().id, { query: 'turbine', maxBytes })
      const bytes = new TextEncoder().encode(JSON.stringify(result)).length
      expect(bytes).toBe(result.bytesUsed)
      expect(bytes).toBeLessThanOrEqual(maxBytes)
      expect(result.records.map(r => r.id)).not.toContain(large.id)
      expect(result.omitted).toBeGreaterThan(0)
      for (const row of result.records) expect(f.view().records.find(r => r.id === row.id)?.text).toBe(row.text)
    }
    expect(f.vault.retrieve(f.view().id, { query: 'turbine', maxBytes: 2048 }).records.map(r => r.id)).toEqual([small.id])
    expect(() => f.vault.retrieve(f.view().id, { query: '界'.repeat(500), maxBytes: 1024 })).toThrow('too small')
  })

  it('does not equate different source revisions or use unrelated records as a fallback', async () => {
    const f = await fixture()
    const hit = await f.add('Turbine inspection', 'https://example.test/report?revision=1')
    await f.add('Unrelated later report', 'https://example.test/report?revision=2')
    expect(f.vault.retrieve(f.view().id, { query: 'turbine' }).records.map(r => r.id)).toEqual([hit.id])
    expect(f.vault.retrieve(f.view().id, { query: 'no matching zebras' }).records).toEqual([])
    expect(() => f.vault.retrieve('ff'.repeat(32), { query: 'turbine' })).toThrow('not available')
    expect(() => f.vault.retrieve(f.view().id, { query: '', maxRecords: 99 })).toThrow()
  })
})
