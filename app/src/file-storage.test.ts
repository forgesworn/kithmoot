import { describe, expect, it } from 'vitest'
import { FILE_STORAGE_KEY, LEGACY_FILE_STORAGE_KEY, sharedFileServer, requireSharedFileServer, allowSharedFileServer, stopFileUploads, suggestedFileServer } from './file-storage.js'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

describe('file storage consent', () => {
  it('defaults to no uploads, not the application host', () => {
    const store = storage()
    expect(sharedFileServer(store)).toBe('')
    expect(suggestedFileServer(store, 'https://app.example')).toBe('https://app.example')
    expect(() => requireSharedFileServer(store)).toThrow('File uploads are off')
    expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
  })
  it('never upgrades a legacy destination into consent', () => {
    const store = storage()
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(suggestedFileServer(store, 'https://app.example')).toBe('https://old.example')
    expect(sharedFileServer(store)).toBe('')
    expect(store.getItem(LEGACY_FILE_STORAGE_KEY)).toBe('https://old.example')
  })
  it('requires disclosure acknowledgement and a valid origin', () => {
    const store = storage()
    expect(() => allowSharedFileServer(store, 'https://files.example', false)).toThrow('Confirm')
    for (const url of ['http://files.example', 'https://user:pass@files.example', 'https://files.example/path', '']) {
      expect(() => allowSharedFileServer(store, url, true)).toThrow()
    }
    expect(sharedFileServer(store)).toBe('')
  })
  it('remembers explicit consent and revokes without reverting to legacy', () => {
    const store = storage()
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(allowSharedFileServer(store, ' https://Files.Example/ ', true)).toBe('https://files.example')
    expect(requireSharedFileServer(store)).toBe('https://files.example')
    stopFileUploads(store)
    expect(() => requireSharedFileServer(store)).toThrow('File uploads are off')
  })
  it.each(['bad json', 'null', '{}', '{"mode":"private","disclosure":1,"origin":"https://files.example"}', '{"mode":"shared","origin":"https://files.example"}', '{"mode":"shared","disclosure":2,"origin":"https://files.example"}', '{"mode":"shared","disclosure":1,"origin":"http://files.example"}'])('fails closed for malformed or unsupported consent: %s', raw => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, raw)
    expect(sharedFileServer(store)).toBe('')
  })
  it('fails closed if storage cannot be read', () => {
    const store = { ...storage(), getItem: () => { throw new Error('denied') } }
    expect(sharedFileServer(store)).toBe('')
    expect(() => requireSharedFileServer(store)).toThrow('File uploads are off')
  })
})
