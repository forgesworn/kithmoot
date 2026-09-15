import { describe, expect, it, vi } from 'vitest'
import { deleteImportedHistory } from './private-history-deletion.js'

const eventId = 'a'.repeat(64)

describe('deleteImportedHistory', () => {
  it('records the private barrier before atomically removing local search material', async () => {
    const order: string[] = []
    const index = { remove: vi.fn(async id => { order.push(`local:${id}`); return true }) }
    const result = await deleteImportedHistory({
      eventId,
      index,
      recordPrivateTombstone: async id => { order.push(`box:${id}`); return 'recorded' },
    })
    expect(result).toEqual({ box: 'recorded', device: 'removed' })
    expect(order).toEqual([`box:${eventId}`, `local:${eventId}`])
  })

  it('keeps local search material when the selected box cannot record the barrier', async () => {
    const index = { remove: vi.fn(async () => true) }
    await expect(deleteImportedHistory({
      eventId,
      index,
      recordPrivateTombstone: async () => { throw new Error('receipt timed out') },
    })).rejects.toThrow('receipt timed out')
    expect(index.remove).not.toHaveBeenCalled()
  })

  it('treats an existing box barrier and an already-removed local record as truthful idempotent outcomes', async () => {
    const index = { remove: vi.fn(async () => false) }
    await expect(deleteImportedHistory({ eventId, index, recordPrivateTombstone: async () => 'duplicate' }))
      .resolves.toEqual({ box: 'duplicate', device: 'already-removed' })
  })
})
