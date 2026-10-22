import { describe, expect, it } from 'vitest'
import { FORGESWORN_STORAGE_ENDS_AT_MS, forgeSwornStorageNotice, isForgeSwornStoredFile } from './forgesworn-stored-file.js'

const HOSTED = 'https://kithmoot.forgesworn.dev/blossom/' + 'a'.repeat(64)
const before = FORGESWORN_STORAGE_ENDS_AT_MS - 86_400_000
const after = FORGESWORN_STORAGE_ENDS_AT_MS + 1000

describe('files stored on ForgeSworn', () => {
  it('shows the warning only for ForgeSworn-hosted files, before the date', () => {
    expect(forgeSwornStorageNotice(HOSTED, before)).toBe('This file is stored on kithmoot.forgesworn.dev, which stops keeping files on 23 October. Save it now if you want to keep it.')
    for (const other of ['https://blossom.yakihonne.com/' + 'a'.repeat(64), 'https://files.example/x', 'not a url', '', undefined]) {
      expect(isForgeSwornStoredFile(other)).toBe(false)
      expect(forgeSwornStorageNotice(other, before)).toBeUndefined()
    }
  })
  it('stops warning once the date has passed', () => {
    expect(forgeSwornStorageNotice(HOSTED, after)).toBeUndefined()
  })
  it('is 23 October 2026', () => {
    expect(new Date(FORGESWORN_STORAGE_ENDS_AT_MS).toISOString()).toBe('2026-10-23T00:00:00.000Z')
  })
})
