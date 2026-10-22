import { describe, expect, it } from 'vitest'
import { TEMPORARY_UPLOAD_MAX_AGE_MS, removeStaleTemporaryUploads, removeStaleTemporaryUploadsHere } from './temp-upload-cleanup.js'

const NOW = 1_800_000_000_000
const name = (n: string): string => `.kithmoot-upload-${n.repeat(32).slice(0, 32)}.wbenc`
const DAY = 86_400_000

function directory(files: Record<string, { age: number; kind?: string; unreadable?: boolean }>, options: { stuck?: string[] } = {}) {
  const removed: string[] = []
  const dir = {
    async *entries(): AsyncIterable<[string, { kind: string; getFile?: () => Promise<{ lastModified: number }> }]> {
      for (const [file, info] of Object.entries(files)) {
        yield [file, {
          kind: info.kind ?? 'file',
          getFile: async () => { if (info.unreadable) throw new Error('gone'); return { lastModified: NOW - info.age } },
        }]
      }
    },
    async removeEntry(file: string): Promise<void> { if (options.stuck?.includes(file)) throw new Error('in use'); removed.push(file) },
  }
  return { dir, removed }
}

describe('sealed files a page left in the private file system', () => {
  it('removes only the temporary upload files that are old, and nothing else', async () => {
    const { dir, removed } = directory({
      [name('a')]: { age: 8 * DAY },
      [name('b')]: { age: 2 * DAY },
      [name('c')]: { age: TEMPORARY_UPLOAD_MAX_AGE_MS },
      'notes.txt': { age: 30 * DAY },
      '.kithmoot-upload-short.wbenc': { age: 30 * DAY },
      [`${name('d')}.bak`]: { age: 30 * DAY },
      [name('e').replace('.wbenc', '')]: { age: 30 * DAY },
      [name('f')]: { age: 30 * DAY, kind: 'directory' },
    })
    expect(await removeStaleTemporaryUploads(dir, NOW)).toBe(2)
    expect(removed.sort()).toEqual([name('a'), name('c')].sort())
  })

  it('leaves a recent file alone: another tab of this origin may be holding it', async () => {
    const { dir, removed } = directory({ [name('a')]: { age: 6 * DAY + 23 * 3_600_000 } })
    expect(await removeStaleTemporaryUploads(dir, NOW)).toBe(0)
    expect(removed).toEqual([])
  })

  it('a file that cannot be read or removed is left for the next start and does not stop the rest', async () => {
    const { dir, removed } = directory({
      [name('a')]: { age: 9 * DAY, unreadable: true },
      [name('b')]: { age: 9 * DAY },
      [name('c')]: { age: 9 * DAY },
    }, { stuck: [name('b')] })
    expect(await removeStaleTemporaryUploads(dir, NOW)).toBe(1)
    expect(removed).toEqual([name('c')])
  })

  it('a directory that cannot be listed removes nothing and says nothing', async () => {
    const broken = { entries: () => { throw new Error('denied') }, removeEntry: async () => { throw new Error('unreachable') } }
    expect(await removeStaleTemporaryUploads(broken as never, NOW)).toBe(0)
  })

  it('where there is no private file system it does nothing', async () => {
    expect(await removeStaleTemporaryUploadsHere(NOW)).toBe(0)
  })
})
