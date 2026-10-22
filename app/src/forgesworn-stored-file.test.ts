import { describe, expect, it } from 'vitest'
import { forgeSwornStorageNotice, isForgeSwornStoredFile } from './forgesworn-stored-file.js'

const HOSTED = 'https://kithmoot.forgesworn.dev/blossom/' + 'a'.repeat(64)

describe('files stored on ForgeSworn', () => {
  it('says a ForgeSworn-hosted file is gone, and nothing for any other file', () => {
    expect(forgeSwornStorageNotice(HOSTED)).toBe('This file is no longer on kithmoot.forgesworn.dev.')
    for (const other of ['https://blossom.yakihonne.com/' + 'a'.repeat(64), 'https://files.example/x', 'not a url', '', undefined]) {
      expect(isForgeSwornStoredFile(other)).toBe(false)
      expect(forgeSwornStorageNotice(other)).toBeUndefined()
    }
  })
})
