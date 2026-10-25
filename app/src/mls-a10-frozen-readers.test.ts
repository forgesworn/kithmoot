import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
it('executes pinned old-reader fixtures from the exact a10 compatibility baseline', () => {
  const manifest = JSON.parse(readFileSync(new URL('./mls-a10-frozen-readers.fixture.json', import.meta.url), 'utf8'))
  expect(manifest.sourceCommit).toBe('a10ba7198974fc2a4c10d529425aef71e82fe012')
  for (const [name, entry] of Object.entries(manifest.files) as [string, { fixtureSha256: string; exactFunctionSha256?: string }][]) {
    const bytes = readFileSync(new URL(name, import.meta.url))
    expect(digest(bytes)).toBe(entry.fixtureSha256)
    if (entry.exactFunctionSha256) {
      const source = bytes.toString('utf8'), start = source.indexOf('export function mlsGrantCustody(value: unknown)')
      expect(digest(source.slice(start))).toBe(entry.exactFunctionSha256)
    }
  }
})
