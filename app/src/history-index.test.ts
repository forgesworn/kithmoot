import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LocalHistoryIndex, importedHistoryCoverage, type EncryptedHistoryRecord, type HistoryIndexStorage } from './history-index.js'

class MemoryStorage implements HistoryIndexStorage {
  storedKey: CryptoKey | undefined
  values = new Map<string, EncryptedHistoryRecord>()
  async key(): Promise<CryptoKey | undefined> { return this.storedKey }
  async saveKey(key: CryptoKey): Promise<void> { this.storedKey = key }
  async records(): Promise<EncryptedHistoryRecord[]> { return [...this.values.values()] }
  async put(record: EncryptedHistoryRecord): Promise<void> { this.values.set(record.key, record) }
  async remove(key: string): Promise<void> { this.values.delete(key) }
}

const document = (id = 'a'.repeat(64), text = 'A private imported note'): { id: string; sentAt: number; text: string; participant: string; files: string[] } =>
  ({ id, sentAt: 1_700_000_000, text, participant: 'alice', files: ['secret.pdf'] })

describe('encrypted local history index', () => {
  it('stores only opaque records under a non-exportable device key and searches locally', async () => {
    const storage = new MemoryStorage(), crypt = webcrypto as unknown as Crypto
    const index = new LocalHistoryIndex(storage, crypt)
    expect(await index.add(document())).toBe('stored')
    expect(await index.add(document())).toBe('duplicate')
    expect(storage.storedKey?.extractable).toBe(false)
    const persisted = JSON.stringify(await storage.records())
    expect(persisted).not.toContain('private imported')
    expect(persisted).not.toContain('a'.repeat(64))
    expect((await index.search('private'))[0]).toMatchObject({ document: { text: 'A private imported note' } })
    expect(await new LocalHistoryIndex(storage, crypt).search('secret.pdf')).toHaveLength(1)
  })

  it('rejects tampering and deletes every local encrypted copy of an event', async () => {
    const storage = new MemoryStorage(), crypt = webcrypto as unknown as Crypto
    const index = new LocalHistoryIndex(storage, crypt)
    await index.add(document())
    const record = (await storage.records())[0]!
    storage.values.set(record.key, { ...record, ciphertext: record.ciphertext.slice(1) })
    await expect(index.search('')).rejects.toThrow(/could not be opened/)
    storage.values.clear()
    await index.add(document())
    expect(await index.remove('a'.repeat(64))).toBe(true)
    expect(await index.count()).toBe(0)
    expect(await index.remove('a'.repeat(64))).toBe(false)
  })

  it('keeps one stable device key for simultaneous first imports', async () => {
    const storage = new MemoryStorage(), crypt = webcrypto as unknown as Crypto
    const index = new LocalHistoryIndex(storage, crypt)
    await Promise.all([
      index.add(document('a'.repeat(64), 'first private note')),
      index.add(document('b'.repeat(64), 'second private note')),
    ])
    expect(await new LocalHistoryIndex(storage, crypt).search('private')).toHaveLength(2)
  })

  it('uses honest imported-index coverage wording', () => {
    expect(importedHistoryCoverage(0)).toBe('This device’s imported index: 0 items. Search stays on this device.')
    expect(importedHistoryCoverage(1)).toBe('This device’s imported index: 1 item. Search stays on this device.')
  })
})
