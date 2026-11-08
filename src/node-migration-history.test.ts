import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { copyNodeMigrationHistory, type MigrationHistoryTarget } from './node-migration-history.js'
const now = 1_900_000_000, sk = new Uint8Array(32).fill(2)
const original = (content: string, tags: string[][] = []) => finalizeEvent({ kind: 1460, created_at: now - 100, tags, content }, sk)
function fixture() {
  const kept = new Map<string, ReturnType<typeof original>>()
  const target: MigrationHistoryTarget = {
    publish: vi.fn(async e => { kept.set(e.id, e) }),
    read: vi.fn(async (ids: string[]) => ({ events: ids.flatMap(id => kept.has(id) ? [kept.get(id)!] : []), complete: true })),
  }
  const entries = [original('ciphertext one'), original('ciphertext two')].map(event => ({ event }))
  const options = { snapshots: [{ complete: true, entries }], target, accept: () => true, now: () => now, current: () => true }
  return { target, kept, entries, options }
}
describe('existing room history transfer', () => {
  it('keeps original signatures and ciphertext, deduplicates and checks target readback', async () => {
    const f = fixture()
    const proof = await copyNodeMigrationHistory({ ...f.options, snapshots: [...f.options.snapshots, ...f.options.snapshots] })
    expect(proof.events).toBe(2); expect(f.target.publish).toHaveBeenCalledTimes(2)
    expect([...f.kept.values()]).toEqual(expect.arrayContaining(f.entries.map(e => JSON.parse(JSON.stringify(e.event)))))
  })
  it('does not mistake publication acknowledgements for retained history', async () => {
    const f = fixture(); f.target.read = async () => ({ events: [], complete: true })
    await expect(copyNodeMigrationHistory(f.options)).rejects.toThrow('did not retain')
    f.target.read = async ids => ({ events: ids.map(id => f.kept.get(id)!), complete: false })
    await expect(copyNodeMigrationHistory(f.options)).rejects.toThrow('did not complete')
  })
  it('checks every source before writing and rejects incomplete, quiet or wrong-room history', async () => {
    for (const patch of [
      { snapshots: [{ complete: false, entries: [] }] },
      { snapshots: [{ complete: true, entries: [{ event: original('sealed inner'), quiet: true }] }] },
      { accept: () => false }, { maxEvents: 1 }, { maxBytes: 1 },
      { snapshots: [{ complete: true, entries: [{ event: { ...original('ciphertext'), content: 'tampered' } }] }] },
    ]) {
      const f = fixture()
      await expect(copyNodeMigrationHistory({ ...f.options, ...patch })).rejects.toThrow()
      expect(f.target.publish).not.toHaveBeenCalled()
    }
  })
  it('never extends an expired message or treats duplicate expiry as absence', async () => {
    const f = fixture()
    f.options.snapshots[0]!.entries.push({ event: original('expired', [['expiration', String(now - 1)]]) })
    expect((await copyNodeMigrationHistory(f.options)).events).toBe(2)
    const malformed = original('bad', [['expiration', String(now + 10)], ['expiration', String(now + 10)]])
    await expect(copyNodeMigrationHistory({ ...f.options, snapshots: [{ complete: true, entries: [{ event: malformed }] }] })).rejects.toThrow('expiry')
  })
  it('rejects altered target data and abandons a changed preparation during publication', async () => {
    const f = fixture()
    f.target.read = async ids => ({ events: ids.map(id => ({ ...f.kept.get(id)!, content: 'rewritten' })), complete: true })
    await expect(copyNodeMigrationHistory(f.options)).rejects.toThrow('readback')
    let current = true
    f.target.publish = async () => { current = false }
    await expect(copyNodeMigrationHistory({ ...f.options, current: () => current })).rejects.toThrow('changed')
  })
})
