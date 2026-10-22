import { describe, expect, it } from 'vitest'
import { FILE_STORAGE_KEY, LEGACY_FILE_STORAGE_KEY, PUBLIC_FILE_SERVERS, FILE_STORAGE_REQUIRED, isForgeSwornHost, retireForgeSwornConsent, FORGESWORN_STORAGE_CLOSED, sharedFileServer, storedFileServer, chooseFileServer, acceptDefaultFileServer, stopFileUploads, resolveFileDestination, defaultFileServer, destinationLimit, formatLimit, describeUploadFailure, type FileDestinationInput } from './file-storage.js'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

const FORGESWORN_ORIGINS = ['https://kithmoot.forgesworn.dev', 'https://KITHMOOT.forgesworn.dev/', 'https://shelter.forgesworn.dev', 'https://kithmoot.app']
const DEFAULT = PUBLIC_FILE_SERVERS[0]!.origin

const resolve = (store: ReturnType<typeof storage>, rest: Partial<FileDestinationInput> = {}) =>
  resolveFileDestination({ store, roomUsesBothy: false, ...rest })

describe('file storage consent', () => {
  it('writes nothing until a person acts', () => {
    const store = storage()
    expect(sharedFileServer(store)).toBe('')
    expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
    expect(FILE_STORAGE_REQUIRED).toBe('File uploads are off on this device. Turn them on in Settings › Privacy › Where files go.')
  })
  it('never upgrades a legacy destination into consent', () => {
    const store = storage()
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(sharedFileServer(store)).toBe('')
    expect(resolve(store)).toEqual({ kind: 'default', origin: DEFAULT, maxBytes: PUBLIC_FILE_SERVERS[0]!.maxBytes })
    expect(store.getItem(LEGACY_FILE_STORAGE_KEY)).toBe('https://old.example')
  })
  it('refuses an address that is not a plain https origin', () => {
    const store = storage()
    for (const url of ['http://files.example', 'https://user:pass@files.example', 'https://files.example/path', '']) {
      expect(() => chooseFileServer(store, url)).toThrow()
    }
    expect(sharedFileServer(store)).toBe('')
    expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
  })
  it('remembers a typed server as version 3 and a pressed Send as the default', () => {
    const store = storage()
    expect(chooseFileServer(store, ' https://Files.Example/ ')).toBe('https://files.example')
    expect(JSON.parse(store.getItem(FILE_STORAGE_KEY)!)).toEqual({ mode: 'shared', disclosure: 3, origin: 'https://files.example', via: 'typed' })
    expect(acceptDefaultFileServer(store, DEFAULT)).toBe(DEFAULT)
    expect(JSON.parse(store.getItem(FILE_STORAGE_KEY)!)).toEqual({ mode: 'shared', disclosure: 3, origin: DEFAULT, via: 'default' })
    expect(storedFileServer(store)).toEqual({ origin: DEFAULT, via: 'default' })
  })
  it('turning uploads off writes the choice down rather than forgetting it', () => {
    const store = storage()
    chooseFileServer(store, 'https://files.example')
    stopFileUploads(store)
    expect(JSON.parse(store.getItem(FILE_STORAGE_KEY)!)).toEqual({ mode: 'off', disclosure: 3 })
    expect(sharedFileServer(store)).toBe('')
    expect(resolve(store)).toEqual({ kind: 'off', reason: 'chosen' })
  })
  it.each(['bad json', 'null', '{}', '{"mode":"private","disclosure":1,"origin":"https://files.example"}', '{"mode":"shared","origin":"https://files.example"}', '{"mode":"shared","disclosure":3,"origin":"https://files.example"}', '{"mode":"shared","disclosure":3,"origin":"https://files.example","via":"elsewhere"}', '{"mode":"shared","disclosure":4,"origin":"https://files.example","via":"typed"}', '{"mode":"shared","disclosure":"2","origin":"https://files.example"}', '{"mode":"shared","disclosure":1,"origin":"http://files.example"}', '{"mode":"shared","disclosure":2,"origin":"https://files.example/path"}'])('fails closed for malformed or unsupported consent: %s', raw => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, raw)
    expect(sharedFileServer(store)).toBe('')
    expect(resolve(store).kind).toBe('default')
  })
  it('fails closed if storage cannot be read', () => {
    const store = { ...storage(), getItem: () => { throw new Error('denied') } }
    expect(sharedFileServer(store)).toBe('')
    expect(retireForgeSwornConsent(store)).toBe(false)
  })
})

describe('where a file goes', () => {
  it('an empty store resolves to the first public server, to be accepted at Send', () => {
    expect(resolve(storage())).toEqual({ kind: 'default', origin: DEFAULT, maxBytes: 209715200 })
  })
  it('a version 2 consent is a typed server', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: 2, origin: 'https://files.example' }))
    expect(resolve(store)).toEqual({ kind: 'server', origin: 'https://files.example', via: 'typed' })
  })
  it('a version 2 consent to the public server is honoured and gets its size limit', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: 2, origin: DEFAULT }))
    const destination = resolve(store)
    expect(destination).toEqual({ kind: 'server', origin: DEFAULT, via: 'typed' })
    expect(destinationLimit(destination)).toBe(209715200)
  })
  it('a version 3 default consent is honoured while it names the default', () => {
    const store = storage(); acceptDefaultFileServer(store, DEFAULT)
    expect(resolve(store)).toEqual({ kind: 'server', origin: DEFAULT, via: 'default' })
  })
  it('Nowhere resolves to off, chosen', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'off' }))
    expect(resolve(store)).toEqual({ kind: 'off', reason: 'chosen' })
  })
  it('a default consent naming an older default tells the person again (Q8)', () => {
    const store = storage(); acceptDefaultFileServer(store, 'https://old-default.example')
    expect(resolve(store)).toEqual({ kind: 'default', origin: DEFAULT, maxBytes: 209715200 })
    // The same consent follows a default that is still the same.
    expect(resolve(store, { deployerDefault: 'https://old-default.example' })).toEqual({ kind: 'server', origin: 'https://old-default.example', via: 'default' })
  })
  it('a typed consent never falls through when the default changes', () => {
    const store = storage(); chooseFileServer(store, 'https://mine.example')
    expect(resolve(store, { deployerDefault: 'https://other.example' })).toEqual({ kind: 'server', origin: 'https://mine.example', via: 'typed' })
  })
  it('a version 1 consent to a ForgeSworn host is not a choice', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: 1, origin: 'https://kithmoot.forgesworn.dev' }))
    expect(resolve(store).kind).toBe('default')
  })
  it('a consent of any version to a ForgeSworn host is not honoured: that storage takes no new files', () => {
    for (const disclosure of [2, 3]) {
      const store = storage(); store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure, origin: 'https://kithmoot.forgesworn.dev', ...(disclosure === 3 ? { via: 'typed' } : {}) }))
      expect(resolve(store).kind).toBe('default')
      expect(retireForgeSwornConsent(store)).toBe(true)
      expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
    }
  })
  it('refuses to choose a ForgeSworn host, and stores nothing', () => {
    const store = storage()
    expect(() => chooseFileServer(store, 'https://kithmoot.forgesworn.dev')).toThrow(FORGESWORN_STORAGE_CLOSED)
    expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
  })
  it('a Bothy room wins over everything below it', () => {
    for (const setup of [() => {}, (s: ReturnType<typeof storage>) => chooseFileServer(s, 'https://mine.example'), (s: ReturnType<typeof storage>) => stopFileUploads(s)]) {
      const store = storage(); setup(store)
      expect(resolve(store, { roomUsesBothy: true })).toEqual({ kind: 'bothy' })
    }
  })
  it.each(FORGESWORN_ORIGINS)('ignores a deployer default of %s', origin => {
    expect(resolve(storage(), { deployerDefault: origin })).toEqual({ kind: 'default', origin: DEFAULT, maxBytes: 209715200 })
    expect(defaultFileServer(origin)?.origin).toBe(DEFAULT)
  })
  it('uses a usable deployer default, with no size limit unless it is on the list', () => {
    expect(resolve(storage(), { deployerDefault: ' https://Files.Deployer.example/ ' })).toEqual({ kind: 'default', origin: 'https://files.deployer.example' })
    expect(resolve(storage(), { deployerDefault: DEFAULT })).toEqual({ kind: 'default', origin: DEFAULT, maxBytes: 209715200 })
    for (const bad of ['http://insecure.example', 'https://deployer.example/path', '', 'not a url']) {
      expect(resolve(storage(), { deployerDefault: bad }).kind).toBe('default')
      expect((resolve(storage(), { deployerDefault: bad }) as { origin: string }).origin).toBe(DEFAULT)
    }
  })
  it('has no destination when there is no default to offer', () => {
    // A list with no entries and no deployer default is S5 in the spec.
    expect(resolve(storage(), { publicServers: [] })).toEqual({ kind: 'off', reason: 'no-default' })
    expect(resolve(storage(), { publicServers: [], deployerDefault: 'https://mine.example' })).toEqual({ kind: 'default', origin: 'https://mine.example' })
  })
  it('formats a limit as whole megabytes', () => {
    expect(formatLimit(209715200)).toBe('200 MB')
    expect(formatLimit(1572864)).toBe('1.5 MB')
  })
})

describe('a room that lists storage (S5b)', () => {
  const nodes = ['https://node.example']
  it('a listed room wins over a device choice, Nowhere and Bothy', () => {
    for (const setup of [() => {}, (s: ReturnType<typeof storage>) => chooseFileServer(s, 'https://mine.example'), (s: ReturnType<typeof storage>) => stopFileUploads(s), (s: ReturnType<typeof storage>) => acceptDefaultFileServer(s, DEFAULT)]) {
      const store = storage(); setup(store)
      const before = store.getItem(FILE_STORAGE_KEY)
      expect(resolve(store, { roomStorage: { nodes } })).toEqual({ kind: 'group', nodes })
      expect(resolve(store, { roomStorage: { nodes }, roomUsesBothy: true })).toEqual({ kind: 'group', nodes })
      expect(store.getItem(FILE_STORAGE_KEY)).toBe(before)
    }
  })
  it('a withdrawn room never falls back to the device', () => {
    for (const setup of [() => {}, (s: ReturnType<typeof storage>) => chooseFileServer(s, 'https://mine.example')]) {
      const store = storage(); setup(store)
      expect(resolve(store, { roomStorage: { nodes: [] } })).toEqual({ kind: 'withdrawn' })
      expect(resolve(store, { roomStorage: { nodes: [] }, roomUsesBothy: true })).toEqual({ kind: 'withdrawn' })
    }
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

describe('consent written by the old pre-filled suggestion', () => {
  const v1 = (origin: string) => JSON.stringify({ mode: 'shared', disclosure: 1, origin })

  it.each(FORGESWORN_ORIGINS)('does not honour a version 1 consent to %s, and retires it once', origin => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, v1(origin))
    expect(sharedFileServer(store)).toBe('')
        expect(retireForgeSwornConsent(store)).toBe(true)
    expect(store.getItem(FILE_STORAGE_KEY)).toBeNull()
    expect(retireForgeSwornConsent(store)).toBe(false)
  })
  it('keeps the legacy key when it retires a consent', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, v1('https://kithmoot.forgesworn.dev'))
    store.setItem(LEGACY_FILE_STORAGE_KEY, 'https://old.example')
    expect(retireForgeSwornConsent(store)).toBe(true)
    expect(store.getItem(LEGACY_FILE_STORAGE_KEY)).toBe('https://old.example')
  })
  it('still honours a version 1 consent to another host and leaves it alone', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, v1('https://files.example'))
    expect(sharedFileServer(store)).toBe('https://files.example')
    expect(retireForgeSwornConsent(store)).toBe(false)
    expect(store.getItem(FILE_STORAGE_KEY)).toBe(v1('https://files.example'))
  })
  it('retires a typed consent to a ForgeSworn host too, keeping any other choice', () => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: 2, origin: 'https://kithmoot.forgesworn.dev' }))
    expect(sharedFileServer(store)).toBe('')
    expect(retireForgeSwornConsent(store)).toBe(true)
    chooseFileServer(store, 'https://files.example')
    expect(retireForgeSwornConsent(store)).toBe(false)
    expect(sharedFileServer(store)).toBe('https://files.example')
  })
  it.each(['bad json', 'null', '{}', '[]', '{"mode":"private","disclosure":1,"origin":"https://kithmoot.forgesworn.dev"}'])('retires nothing else: %s', raw => {
    const store = storage(); store.setItem(FILE_STORAGE_KEY, raw)
    expect(retireForgeSwornConsent(store)).toBe(false)
    expect(store.getItem(FILE_STORAGE_KEY)).toBe(raw)
  })
  it('does nothing when there is no consent', () => {
    const store = storage()
    expect(retireForgeSwornConsent(store)).toBe(false)
  })
})

describe('describeUploadFailure', () => {
  const ctx = { host: 'blossom.yakihonne.com', name: 'plan.pdf', online: true, own: false, size: 2400000, sizeText: '2.4 MB', limit: '200 MB' }
  const say = (message: string, over: Partial<typeof ctx> = {}) => describeUploadFailure(new Error(message), { ...ctx, ...over })
  it('names a network, timeout or server failure and offers both actions', () => {
    for (const message of ['Could not reach blossom.yakihonne.com.', 'The server answered 503.', 'The server answered 500: busy.']) {
      expect(say(message)).toEqual({ text: 'blossom.yakihonne.com didn’t take plan.pdf. Check your connection and try again.', retry: true, another: true })
    }
  })
  it('says offline without reading the error, and offers only Try again', () => {
    expect(say('Could not reach x.', { online: false })).toEqual({ text: 'You’re offline. plan.pdf will upload when you try again.', retry: true })
  })
  it('says the limit on a 413 when it is known', () => {
    expect(say('The server will not take a file this big (413).')).toEqual({ text: 'blossom.yakihonne.com takes files up to 200 MB. plan.pdf is 2.4 MB.' })
  })
  it('refuses a type on 415', () => {
    expect(say('The server answered 415.')).toEqual({ text: 'blossom.yakihonne.com won’t store plan.pdf. Choose another server.', another: true })
  })
  it('explains 401 and 403 only for a server the person chose', () => {
    const refused = 'The server refused the upload authorisation (401).'
    expect(say(refused, { own: true })).toEqual({ text: 'blossom.yakihonne.com didn’t let this device upload. If it’s Wildbloom Node, let KithMoot in again in Settings.', another: true })
    expect(say(refused, { own: false })?.retry).toBe(true)
  })
  it('leaves other errors to the caller', () => {
    expect(say('The room changed.')).toBeUndefined()
  })
})
