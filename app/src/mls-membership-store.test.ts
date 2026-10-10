import { describe, expect, it } from 'vitest'
import { MAX_MLS_MEMBERSHIP_BYTES, MLS_MEMBERSHIP_SEEN_RESERVE_BYTES, readMlsMembership, saveMlsMembership, type MlsMembershipJournal } from './mls-membership-store.js'
import { MAX_MLS_REVOCATION_SEEN } from './mls-revocation-inbox-store.js'
import type { PersonaTransaction } from './mls-persona-coordinator.js'

class MemoryTransaction implements PersonaTransaction {
  readonly installation = '55'.repeat(32)
  readonly vault = new Map<string, Uint8Array>()
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, value: Uint8Array) { this.vault.set(id, value.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
const size = (record: MlsMembershipJournal) => new TextEncoder().encode(JSON.stringify(record)).length
// These are storage-shape fixtures, not claims of decoded MLS journal validity.
function filled(target: number): MlsMembershipJournal {
  const record: MlsMembershipJournal = { version: 1, requests: [], removals: [], inbox: {
    keeper: '11'.repeat(32), checkedAt: Number.MAX_SAFE_INTEGER, seen: [], prompts: [],
  } }
  while (size(record) + 400 < target) {
    record.removals.push({ operation: record.removals.length.toString(16).padStart(64, '0'), session: '22'.repeat(32),
      kind: 'device', target: '33'.repeat(32), compromised: false, createdAt: 0, attempts: 0, failure: null, journal: '00' })
    const room = Math.min(131_070, target - size(record))
    record.removals.at(-1)!.journal += '00'.repeat(Math.floor(room / 2))
  }
  return record
}

describe('membership byte admission', () => {
  it('admits the full worst-case seen set after other records approach their reserved budget', async () => {
    const tx = new MemoryTransaction(), record = filled(MAX_MLS_MEMBERSHIP_BYTES - MLS_MEMBERSHIP_SEEN_RESERVE_BYTES)
    expect(size(record)).toBeGreaterThan(MAX_MLS_MEMBERSHIP_BYTES - MLS_MEMBERSHIP_SEEN_RESERVE_BYTES - 400)
    await saveMlsMembership(tx, record)
    record.inbox!.seen = Array.from({ length: MAX_MLS_REVOCATION_SEEN }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), receivedAt: Number.MAX_SAFE_INTEGER }))
    await saveMlsMembership(tx, record)
    expect((await readMlsMembership(tx)).inbox!.seen).toHaveLength(MAX_MLS_REVOCATION_SEEN)
    expect(size(record)).toBeLessThanOrEqual(MAX_MLS_MEMBERSHIP_BYTES)
  })
  it('refuses admission that would occupy the seen reserve without replacing the old record', async () => {
    const tx = new MemoryTransaction(), before: MlsMembershipJournal = { version: 1, removals: [], requests: [] }
    await saveMlsMembership(tx, before)
    const full = filled(MAX_MLS_MEMBERSHIP_BYTES - 200)
    expect(size(full)).toBeLessThan(MAX_MLS_MEMBERSHIP_BYTES)
    await expect(saveMlsMembership(tx, full)).rejects.toThrow('MLS membership journal is full')
    expect(await readMlsMembership(tx)).toEqual(before)
  })
  it('reserves capacity even before the persona has opened its keeper inbox', async () => {
    const tx = new MemoryTransaction(), record = filled(MAX_MLS_MEMBERSHIP_BYTES - MLS_MEMBERSHIP_SEEN_RESERVE_BYTES)
    const inbox = record.inbox!; delete record.inbox
    await saveMlsMembership(tx, record)
    inbox.seen = Array.from({ length: MAX_MLS_REVOCATION_SEEN }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), receivedAt: Number.MAX_SAFE_INTEGER }))
    record.inbox = inbox
    await saveMlsMembership(tx, record)
    expect((await readMlsMembership(tx)).inbox!.seen).toHaveLength(MAX_MLS_REVOCATION_SEEN)
  })
  it('keeps legacy records readable at the old physical limit but refuses writes without headroom', async () => {
    const tx = new MemoryTransaction(); await saveMlsMembership(tx, { version: 1, removals: [], requests: [] })
    const legacy = filled(MAX_MLS_MEMBERSHIP_BYTES - 200)
    tx.vault.set([...tx.vault.keys()][0]!, new TextEncoder().encode(JSON.stringify(legacy)))
    expect(await readMlsMembership(tx)).toEqual(legacy)
    await expect(saveMlsMembership(tx, legacy)).rejects.toThrow('MLS membership journal is full')
  })
})
