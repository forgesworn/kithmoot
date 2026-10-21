import { describe, expect, it } from 'vitest'
import { FILE_STORAGE_KEY, LEGACY_FILE_STORAGE_KEY, PUBLIC_FILE_SERVERS, isForgeSwornHost, retireSuggestedForgeSwornConsent, sharedFileServer, requireSharedFileServer, allowSharedFileServer, stopFileUploads, suggestedFileServer } from './file-storage.js'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

const FORGESWORN_ORIGINS = ['https://kithmoot.forgesworn.dev', 'https://KITHMOOT.forgesworn.dev/', 'https://shelter.forgesworn.dev', 'https://kithmoot.app']

describe('file storage consent', () => {
  it('defaults to no uploads and no suggestion', () => {
    const store = storage()
    expect(sharedFileServer(store)).toBe('')
    expect(suggestedFileServer(store)).toBe('')
    expect(() => requireSharedFileServer(store)).toThrow('File uploads are off')
    expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
  })
  it('never upgrades a legacy destination into consent', () => {
    const store = storage()
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(suggestedFileServer(store)).toBe('https://old.example')
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
  it('remembers explicit consent as version 2 and revokes without reverting to legacy', () => {
    const store = storage()
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(allowSharedFileServer(store, ' https://Files.Example/ ', true)).toBe('https://files.example')
    expect(JSON.parse(store.getItem(FILE_STORAGE_KEY)!)).toEqual({ mode: 'shared', disclosure: 2, origin: 'https://files.example' })
    expect(requireSharedFileServer(store)).toBe('https://files.example')
    stopFileUploads(store)
    expect(() => requireSharedFileServer(store)).toThrow('File uploads are off')
  })
  it.each(['bad json', 'null', '{}', '{"mode":"private","disclosure":1,"origin":"https://files.example"}', '{"mode":"shared","origin":"https://files.example"}', '{"mode":"shared","disclosure":3,"origin":"https://files.example"}', '{"mode":"shared","disclosure":"2","origin":"https://files.example"}', '{"mode":"shared","disclosure":1,"origin":"http://files.example"}', '{"mode":"shared","disclosure":2,"origin":"https://files.example/path"}'])('fails closed for malformed or unsupported consent: %s', raw => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, raw)
    expect(sharedFileServer(store)).toBe('')
  })
  it('fails closed if storage cannot be read', () => {
    const store = { ...storage(), getItem: () => { throw new Error('denied') } }
    expect(sharedFileServer(store)).toBe('')
    expect(suggestedFileServer(store, 'https://deployer.example')).toBe('https://deployer.example')
    expect(retireSuggestedForgeSwornConsent(store)).toBe(false)
    expect(() => requireSharedFileServer(store)).toThrow('File uploads are off')
  })
})

describe('ForgeSworn hosts', () => {
  it.each([
    ['https://forgesworn.dev', true],
    ['https://kithmoot.forgesworn.dev', true],
    ['https://KITHMOOT.forgesworn.dev/', true],
    ['https://shelter.forgesworn.dev', true],
    ['https://kithmoot.forgesworn.dev.', true],
    ['https://kithmoot.app', true],
    ['https://www.kithmoot.app:8443', true],
    ['https://forgesworn.dev.example', false],
    ['https://notforgesworn.dev', false],
    ['https://forgesworn.dev.evil.example', false],
    ['https://kithmoot.apple', false],
    ['https://files.example', false],
    ['kithmoot.forgesworn.dev', false],
    ['', false],
    ['not a url', false],
  ])('%s is %s', (origin, expected) => {
    expect(isForgeSwornHost(origin)).toBe(expected)
  })
})

describe('public file servers', () => {
  it('names an operator and a size for each, and none is a ForgeSworn host', () => {
    expect(PUBLIC_FILE_SERVERS.length).toBeGreaterThan(0)
    for (const server of PUBLIC_FILE_SERVERS) {
      expect(isForgeSwornHost(server.origin)).toBe(false)
      expect(new URL(server.origin).origin).toBe(server.origin)
      expect(server.origin.startsWith('https://')).toBe(true)
      expect(server.operator).not.toBe('')
      expect(server.maxBytes).toBeGreaterThan(0)
      expect(server.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
  it('lists Yakihonne as checked on 20 October 2026', () => {
    expect(PUBLIC_FILE_SERVERS).toEqual([{ origin: 'https://blossom.yakihonne.com', operator: 'Yakihonne LLC', maxBytes: 209715200, checked: '2026-10-20' }])
  })
})

describe('the suggestion', () => {
  it.each(FORGESWORN_ORIGINS)('never offers %s, from the legacy key or the deployer default', origin => {
    const store = storage()
    expect(suggestedFileServer(store, origin)).toBe('')
    store.setItem(LEGACY_FILE_STORAGE_KEY, origin)
    expect(suggestedFileServer(store)).toBe('')
    expect(suggestedFileServer(store, origin)).toBe('')
  })
  it('skips a ForgeSworn legacy value and falls through to a usable deployer default', () => {
    const store = storage()
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://kithmoot.forgesworn.dev')
    expect(suggestedFileServer(store, 'https://files.deployer.example')).toBe('https://files.deployer.example')
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'not a url')
    expect(suggestedFileServer(store, ' https://Files.Deployer.example/ ')).toBe('https://files.deployer.example')
  })
  it('prefers a legacy value to the deployer default, and ignores an unusable default', () => {
    const store = storage()
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(suggestedFileServer(store, 'https://files.deployer.example')).toBe('https://old.example')
    expect(suggestedFileServer(storage(), 'http://insecure.example')).toBe('')
    expect(suggestedFileServer(storage(), 'https://deployer.example/path')).toBe('')
    expect(suggestedFileServer(storage(), '')).toBe('')
    expect(suggestedFileServer(storage(), undefined)).toBe('')
  })
  it('shows a person the server they chose, even a ForgeSworn one they typed', () => {
    const store = storage()
    allowSharedFileServer(store, 'https://kithmoot.forgesworn.dev', true)
    expect(suggestedFileServer(store)).toBe('https://kithmoot.forgesworn.dev')
  })
})

describe('consent written by the old pre-filled suggestion', () => {
  const v1 = (origin: string) => JSON.stringify({ mode: 'shared', disclosure: 1, origin })

  it.each(FORGESWORN_ORIGINS)('does not honour a version 1 consent to %s, and retires it once', origin => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, v1(origin))
    expect(sharedFileServer(store)).toBe('')
    expect(suggestedFileServer(store)).toBe('')
    expect(retireSuggestedForgeSwornConsent(store)).toBe(true)
    expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
    expect(retireSuggestedForgeSwornConsent(store)).toBe(false)
  })
  it('keeps the legacy key when it retires a consent', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, v1('https://kithmoot.forgesworn.dev'))
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(retireSuggestedForgeSwornConsent(store)).toBe(true)
    expect(store.getItem(LEGACY_FILE_STORAGE_KEY)).toBe('https://old.example')
  })
  it('still honours a version 1 consent to another host and leaves it alone', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, v1('https://files.example'))
    expect(sharedFileServer(store)).toBe('https://files.example')
    expect(requireSharedFileServer(store)).toBe('https://files.example')
    expect(retireSuggestedForgeSwornConsent(store)).toBe(false)
    expect(store.getItem(FILE_STORAGE_KEY)).toBe(v1('https://files.example'))
  })
  it('honours a fresh version 2 consent to a ForgeSworn host, which a person must have typed', () => {
    const store = storage()
    expect(allowSharedFileServer(store, 'https://kithmoot.forgesworn.dev', true)).toBe('https://kithmoot.forgesworn.dev')
    expect(sharedFileServer(store)).toBe('https://kithmoot.forgesworn.dev')
    expect(retireSuggestedForgeSwornConsent(store)).toBe(false)
    expect(sharedFileServer(store)).toBe('https://kithmoot.forgesworn.dev')
  })
  it.each(['bad json', 'null', '{}', '[]', '{"mode":"shared","disclosure":3,"origin":"https://kithmoot.forgesworn.dev"}', '{"mode":"private","disclosure":1,"origin":"https://kithmoot.forgesworn.dev"}'])('retires nothing else: %s', raw => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, raw)
    expect(retireSuggestedForgeSwornConsent(store)).toBe(false)
    expect(store.getItem(FILE_STORAGE_KEY)).toBe(raw)
  })
  it('does nothing when there is no consent', () => {
    const store = storage()
    expect(retireSuggestedForgeSwornConsent(store)).toBe(false)
  })
})
