import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileGroupGrantStore, groupGrantLedgerPath, groupGrantsFromFlags, movedAsideLedgers } from './group-grants-config.js'

const flags = (over: Partial<Parameters<typeof groupGrantsFromFlags>[0]> = {}) => ({
  nodes: ['https://files.example.net'], bytes: '1000', reset: false, command: 'create', statePath: '/state/room.json', log: () => {}, ...over,
})

describe('--group-withdraw', () => {
  it('makes a withdrawn configuration over the ledger beside the state, with no nodes and no ceiling', () => {
    const c = groupGrantsFromFlags(flags({ nodes: [], bytes: undefined, withdraw: true }))!
    expect(c.withdrawn).toBe(true)
    expect(c.nodes).toEqual([])
    expect((c.store as FileGroupGrantStore).path).toBe('/state/room.json.grants')
  })

  it('is refused with a node, a ceiling or a reset, without a state, and outside create', () => {
    expect(() => groupGrantsFromFlags(flags({ withdraw: true }))).toThrow(/cannot be given with --group-node/)
    expect(() => groupGrantsFromFlags(flags({ nodes: [], withdraw: true }))).toThrow(/not combined with --group-bytes/)
    expect(() => groupGrantsFromFlags(flags({ nodes: [], bytes: undefined, reset: true, withdraw: true }))).toThrow(/not combined/)
    expect(() => groupGrantsFromFlags(flags({ nodes: [], bytes: undefined, withdraw: true, statePath: undefined }))).toThrow(/--state/)
    expect(() => groupGrantsFromFlags(flags({ nodes: [], bytes: undefined, withdraw: true, command: 'join' }))).toThrow(/keeper/)
  })

  it('the cap of eight nodes is told to the operator before anything starts', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => `https://n${i}.example.net`)
    expect(() => groupGrantsFromFlags(flags({ nodes }))).toThrow(/at most 8 group nodes/)
  })
})

describe('group node flags', () => {
  it('nothing given means nothing configured', () => {
    expect(groupGrantsFromFlags(flags({ nodes: [], bytes: undefined }))).toBeUndefined()
  })

  it('a node and a ceiling make a configuration, with the ledger beside the state', () => {
    const c = groupGrantsFromFlags(flags({ nodes: ['https://Files.Example.net/', 'http://127.0.0.1:3742'] }))!
    expect(c.nodes).toEqual(['https://Files.Example.net/', 'http://127.0.0.1:3742'])
    expect(c.bytes).toBe('1000')
    expect((c.store as FileGroupGrantStore).path).toBe('/state/room.json.grants')
    expect(groupGrantLedgerPath('/state/room.json')).toBe('/state/room.json.grants')
  })

  it('refuses a node without a ceiling, saying there is no default', () => {
    expect(() => groupGrantsFromFlags(flags({ bytes: undefined }))).toThrow(/--group-bytes.*no default/)
    expect(() => groupGrantsFromFlags(flags({ bytes: '  ' }))).toThrow(/--group-bytes/)
  })

  it('refuses a ceiling that is not whole bytes', () => {
    for (const bytes of ['0', '-5', '1.5', '10GiB', '01', '9223372036854775808']) expect(() => groupGrantsFromFlags(flags({ bytes })), bytes).toThrow(/bytes/)
  })

  it('refuses the flags without a node, without --state, or for anything but a keeper', () => {
    expect(() => groupGrantsFromFlags(flags({ nodes: [], bytes: '5' }))).toThrow(/at least one --group-node/)
    expect(() => groupGrantsFromFlags(flags({ nodes: [], bytes: undefined, reset: true }))).toThrow(/at least one --group-node/)
    expect(() => groupGrantsFromFlags(flags({ statePath: undefined }))).toThrow(/--state/)
    expect(() => groupGrantsFromFlags(flags({ command: 'join' }))).toThrow(/keeper/)
  })

  it('refuses onion nodes, other schemes, duplicates and unusable host names, with the reason', () => {
    expect(() => groupGrantsFromFlags(flags({ nodes: ['http://abcdefghij.onion'] }))).toThrow(/onion/)
    expect(() => groupGrantsFromFlags(flags({ nodes: ['gopher://x.example'] }))).toThrow(/http and https/)
    expect(() => groupGrantsFromFlags(flags({ nodes: ['https://a.example', 'https://a.example:8443'] }))).toThrow(/twice/)
    expect(() => groupGrantsFromFlags(flags({ nodes: ['http://[::1]:80'] }))).toThrow(/host name/)
    expect(() => groupGrantsFromFlags(flags({ nodes: ['not a url'] }))).toThrow(/not a URL/)
  })

  it('plain http only for a node on this machine', () => {
    expect(() => groupGrantsFromFlags(flags({ nodes: ['http://files.example.net'] }))).toThrow(/plain http/)
    expect(groupGrantsFromFlags(flags({ nodes: ['http://localhost:3742'] }))).toBeDefined()
  })

  it('--group-reset is carried through', () => {
    expect(groupGrantsFromFlags(flags({ reset: true }))!.resetUnreadable).toBe(true)
    expect(groupGrantsFromFlags(flags())!.resetUnreadable).toBeUndefined()
  })
})

describe('the ledger file', () => {
  it('is private, replaced whole, read back, and moved aside rather than deleted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kithmoot-ledger-'))
    const store = new FileGroupGrantStore(join(dir, 'room.json.grants'))
    expect(await store.load()).toBeUndefined()
    await store.save('{"a":1}')
    await store.save('{"a":2}')
    expect(await store.load()).toBe('{"a":2}')
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const moved = await store.moveAside(1_800_000_000)
    expect(moved).toBe(`${store.path}.unreadable-1800000000`)
    expect(await readFile(moved!, 'utf8')).toBe('{"a":2}')
    expect(await store.load()).toBeUndefined()
    // A second move in the same second does not overwrite the first.
    await writeFile(store.path, 'again')
    const second = await store.moveAside(1_800_000_000)
    expect(second).toBe(`${store.path}.unreadable-1800000000-1`)
    expect(await readFile(moved!, 'utf8')).toBe('{"a":2}')
    expect(await store.moveAside(1)).toBeUndefined()
  })

  it('lists the ledgers moved aside, so a self-destruct can remove them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kithmoot-aside-'))
    const state = join(dir, 'room.json')
    const store = new FileGroupGrantStore(groupGrantLedgerPath(state))
    await writeFile(store.path, 'x')
    await store.moveAside(5)
    await writeFile(store.path, 'y')
    await store.moveAside(5)
    await writeFile(join(dir, 'other.grants.unreadable-1'), 'z')
    expect(movedAsideLedgers(state).sort()).toEqual([`${store.path}.unreadable-5`, `${store.path}.unreadable-5-1`])
    expect(movedAsideLedgers(join(dir, 'missing', 'room.json'))).toEqual([])
  })
})
