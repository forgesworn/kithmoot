import { describe, it, expect, vi } from 'vitest'
import { nip44 } from 'nostr-tools'
import { generateSecretKey, type Event } from 'nostr-tools/pure'
import { base64 } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { hkdf } from '@noble/hashes/hkdf'
import { localIdentity } from './identity.js'
import { localPeerCrypt } from './dm.js'
import { decryptEnvelope, encryptEnvelope } from './attachment.js'
import { ProjectDirectory, PROJECT_DIRECTORY_LABELS, type ProjectDirectoryStorage } from './project-directory.js'
import { createJournalStorage, type JournalImage, type JournalKeyValueStore } from './journal-storage.js'
import { projectAuthority, projectId, signProject, unwrapProject, wrapProject, PROJECT_WRAP_KIND, type ProjectDefinition, type ProjectIdentity } from './projects.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const identity = (): ProjectIdentity => { const sk = generateSecretKey(); return { ...localIdentity(sk), ...localPeerCrypt(sk) } }
const definition = (name: string, ...members: ProjectIdentity[]): ProjectDefinition => ({ name, archived: false, authorityRevision: 1, rooms: [], members: members.map(p => ({ pubkey: p.pubkey, kind: 'person', epoch: 1 })) })
function storage() {
  let value: string | undefined
  return { async load() { return value }, async save(next: string) { value = next } } satisfies ProjectDirectoryStorage
}
class MemoryStore implements JournalKeyValueStore {
  readonly values = new Map<string, string>()
  writes = 0
  fault?: { write: number; phase: 'before' | 'after' }
  constructor(entries: [string, string][] = []) { for (const [key, value] of entries) this.values.set(key, value) }
  async get(key: string): Promise<string | undefined> { return this.values.get(key) }
  async set(key: string, value: string): Promise<void> {
    const write = ++this.writes
    if (this.fault?.write === write && this.fault.phase === 'before') { this.fault = undefined; throw new Error('injected failure before write') }
    this.values.set(key, value)
    if (this.fault?.write === write && this.fault.phase === 'after') { this.fault = undefined; throw new Error('injected failure after write') }
  }
  async remove(key: string): Promise<void> { this.values.delete(key) }
}
/** Counts save/append calls so batching and empty-write suppression are
 *  asserted on the adapter surface, not through implementation details. */
function counted(root: string, store: MemoryStore) {
  const journal = createJournalStorage(root, store)
  const calls = { saves: 0, appends: 0, deltas: [] as string[] }
  return { calls, journal, storage: {
    load: journal.load,
    save: async (snapshot: string) => { calls.saves += 1; return journal.save(snapshot) },
    loadIncremental: journal.loadIncremental,
    appendIncremental: async (delta: string) => { calls.appends += 1; calls.deltas.push(delta); return journal.appendIncremental(delta) },
  } satisfies ProjectDirectoryStorage }
}
const DELTA_KEY_INFO = PROJECT_DIRECTORY_LABELS[0]
async function deltaKeyFor(who: ProjectIdentity, image: JournalImage): Promise<Uint8Array> {
  const saved = JSON.parse(image.base!) as { key: string }
  const keyHex = await who.decrypt(who.pubkey, saved.key)
  return hkdf(sha256, hexToBytes(keyHex), undefined, DELTA_KEY_INFO, 32)
}
interface DecodedDelta { v: number; remove?: Record<string, string[]>; put?: Record<string, unknown[]> }
function decodeDeltas(image: JournalImage, key: Uint8Array): DecodedDelta[] {
  return image.deltas.map(raw => JSON.parse(nip44.v2.decrypt(raw, key)) as DecodedDelta)
}
const COLLECTION_NAMES = ['events', 'pending', 'requests', 'logoEvents', 'logoPending', 'logoRequests', 'logoWaiting'] as const
async function open(who: ProjectIdentity, relay: SimRelay, cache = storage(), transport = new SimTransport(relay)) {
  const d = new ProjectDirectory({ identity: who, transport, storage: cache })
  await d.open(); await vi.waitFor(() => expect(d.snapshot().ready).toBe(true)); return d
}
const synced = async (...directories: ProjectDirectory[]) => { await vi.waitFor(() => { for (const d of directories) expect(d.snapshot().pendingSends).toBe(0) }, { timeout: 10_000 }) }
class GuardedTransport extends SimTransport {
  async publishGuarded(event: Event, current: () => boolean): Promise<void> {
    if (!current()) throw new Error('Project authority changed')
    await this.publish(event)
  }
}

describe('shared projects reach members on their own relays', () => {
  it('hands each wrap to where the member reads, so a member who shares no relay with the owner still gets it', async () => {
    const ownerRelay = new SimRelay({ replay: true }), memberInbox = new SimRelay({ replay: true })
    const owner = identity(), member = identity()
    const inbox = new SimTransport(memberInbox)
    const delivered: string[] = []
    const a = new ProjectDirectory({ identity: owner, transport: new SimTransport(ownerRelay), storage: storage(),
      deliver: async (wrap, recipient) => { delivered.push(recipient); await inbox.publish(wrap) } })
    await a.open(); await vi.waitFor(() => expect(a.snapshot().ready).toBe(true))
    const b = await open(member, memberInbox)
    try {
      await a.create(definition('Across relays', owner, member), 'create-across-00001')
      await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects.map(p => p.definition?.name)).toEqual(['Across relays']))
      // The owner's own copy stays on the owner's relays only.
      expect(delivered).toEqual([member.pubkey])
    } finally { await a.close(); await b.close() }
  })
})

describe('shared projects across independent people and devices', () => {
  it('shares three overlapping and disjoint projects, syncs a deliberate join and restores encrypted state without relay history', async () => {
    const relay = new SimRelay({ replay: true }), alice = identity(), bob = identity(), carol = identity(), agent = identity()
    const aCache = storage(), bCache = storage()
    const a = await open(alice, relay, aCache), b = await open(bob, relay, bCache), c = await open(carol, relay), worker = await open(agent, relay)
    const dirs = [a, b, c, worker]
    try {
      await a.create(definition('Kithmoot', alice, bob, agent), 'create-kithmoot-0001')
      await a.create(definition('Bothy', alice, carol, agent), 'create-bothy-000001')
      await c.create(definition('Private research', carol), 'create-research-001')
      await synced(...dirs)
      await vi.waitFor(() => {
        expect(b.snapshot().projects.map(p => p.definition?.name)).toEqual(['Kithmoot'])
        expect(c.snapshot().projects.map(p => p.definition?.name)).toEqual(['Bothy', 'Private research'])
        expect(worker.snapshot().projects.map(p => p.definition?.name)).toEqual(['Bothy', 'Kithmoot'])
      })
      expect(b.snapshot().projects[0]!.joined).toBe(false)
      const invitation = b.snapshot().projects[0]!
      await b.follow(invitation, true, invitation.heads, 'join-kithmoot-00001'); await synced(b)
      const phone = await open(bob, relay); dirs.push(phone)
      await vi.waitFor(() => expect(phone.snapshot().projects[0]?.joined).toBe(true))
      expect(JSON.stringify(relay.published)).not.toContain('Kithmoot')
      expect(JSON.stringify(relay.published)).not.toContain(invitation.project)
      expect(await aCache.load()).not.toContain('Bothy')
      expect(await bCache.load()).not.toContain('Kithmoot')
      await b.close()
      const recovered = await open(bob, new SimRelay(), bCache); dirs.push(recovered)
      expect(recovered.snapshot().projects[0]).toMatchObject({ joined: true, definition: { name: 'Kithmoot' } })
      await expect(recovered.update(invitation, invitation.heads, definition('Stolen', bob), 'forged-project-0001')).rejects.toThrow('Only the project owner')
      const wrong = new ProjectDirectory({ identity: carol, transport: new SimTransport(relay), storage: bCache })
      await expect(wrong.open()).rejects.toThrow('another identity'); await wrong.close()
    } finally { await Promise.all(dirs.map(d => d.close())) }
  }, 20_000)

  it('keeps metadata changes out of authority and requires a fresh join after removal and re-addition', async () => {
    const relay = new SimRelay({ replay: true }), alice = identity(), bob = identity()
    const a = await open(alice, relay), b = await open(bob, relay)
    try {
      await a.create(definition('Original name', alice, bob), 'create-project-00001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects).toHaveLength(1))
      const initial = b.snapshot().projects[0]!
      await b.follow(initial, true, initial.heads, 'join-project-000001'); await synced(b)
      await a.update(initial, initial.heads, { ...initial.definition!, name: 'Renamed' }, 'rename-project-0001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.definition!.name).toBe('Renamed'))
      const renamed = a.snapshot().projects[0]!
      expect(renamed.authority).toBe(initial.authority)
      const observed = { ...renamed, head: renamed.heads[0]! }
      expect(projectAuthority(observed, renamed.definition!)).toBe(initial.authority)
      await a.update(renamed, renamed.heads, definition('Renamed', alice), 'remove-person-00001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.withdrawn).toBe(true))
      const removed = a.snapshot().projects[0]!
      await a.update(removed, removed.heads, definition('Renamed', alice, bob), 'restore-person-0001'); await synced(a)
      await vi.waitFor(() => expect(b.snapshot().projects[0]!.withdrawn).toBe(false))
      const readded = b.snapshot().projects[0]!
      expect(readded.joined).toBe(false)
      expect(readded.authority).not.toBe(initial.authority)
      expect(readded.definition!.members.find(m => m.pubkey === bob.pubkey)!.epoch).toBe(readded.revision)
      const late = await open(bob, relay)
      try { expect(late.snapshot().projects[0]!.joined).toBe(false) } finally { await late.close() }
      await b.follow(readded, true, readded.heads, 'join-again-00000001'); await synced(b)
      expect(b.snapshot().projects[0]!.joined).toBe(true)
    } finally { await Promise.all([a.close(), b.close()]) }
  }, 20_000)

  it('surfaces concurrent owner revisions and requires the exact known heads to resolve them', async () => {
    const owner = identity(), relay = new SimRelay({ replay: true }), a = await open(owner, relay)
    try {
      await a.create(definition('Start', owner), 'create-concurrent-01'); await synced(a)
      const initial = a.snapshot().projects[0]!
      const record = { v: 1 as const, op: 'snapshot' as const, project: initial.project, revision: 2, parents: initial.heads }
      const left = await signProject(owner, { ...record, request: 'concurrent-left-001', definition: { ...initial.definition!, name: 'Left' } })
      const right = await signProject(owner, { ...record, request: 'concurrent-right-01', definition: { ...initial.definition!, name: 'Right' } })
      relay.publish(wrapProject(left, owner.pubkey)); relay.publish(wrapProject(right, owner.pubkey))
      await vi.waitFor(() => expect(a.snapshot().projects[0]!.conflicted).toBe(true))
      const conflict = a.snapshot().projects[0]!
      expect(conflict.definition).toBeUndefined()
      await expect(a.update(conflict, [left.id], definition('Lost update', owner), 'incomplete-merge-01')).rejects.toThrow('Project changed')
      await a.update(conflict, conflict.heads, definition('Resolved', owner), 'resolve-project-001'); await synced(a)
      expect(a.snapshot().projects[0]).toMatchObject({ revision: 3, conflicted: false, definition: { name: 'Resolved' } })
      expect(a.snapshot().projects[0]!.authority).toBe(initial.authority)
      relay.publish(wrapProject(left, owner.pubkey))
      await new Promise(r => setTimeout(r, 20))
      expect(a.snapshot().projects[0]!.definition!.name).toBe('Resolved')
    } finally { await a.close() }
  })

  it('persists exact failed sends, keeps outstanding withdrawal notices through later edits, and does not publish after a failed save', async () => {
    const relay = new SimRelay({ replay: true }), owner = identity(), member = identity(), cache = storage()
    const transport = new SimTransport(relay), publish = vi.spyOn(transport, 'publish')
    const a = await open(owner, relay, cache, transport), b = await open(member, relay)
    try {
      await a.create(definition('Shared', owner, member), 'create-outbox-00001'); await synced(a)
      publish.mockRejectedValue(new Error('offline'))
      const initial = a.snapshot().projects[0]!
      await a.update(initial, initial.heads, definition('Owner only', owner), 'remove-offline-0001')
      await vi.waitFor(() => expect(publish.mock.results.length).toBeGreaterThan(2))
      const removed = a.snapshot().projects[0]!
      await a.update(removed, removed.heads, definition('Later edit', owner), 'later-offline-00001')
      await a.close()
      const restartedTransport = new SimTransport(relay)
      const restored = await open(owner, relay, cache, restartedTransport)
      try {
        expect(restored.snapshot().pendingSends).toBe(2)
        await restored.retry(); await synced(restored)
        await vi.waitFor(() => expect(b.snapshot().projects[0]!.withdrawn).toBe(true))
        expect(restored.snapshot().projects[0]!.definition!.name).toBe('Later edit')
        const before = relay.published.length, current = restored.snapshot().projects[0]!
        vi.spyOn(cache, 'save').mockRejectedValueOnce(new Error('disk full'))
        await expect(restored.update(current, current.heads, definition('Must not publish', owner), 'failed-save-0000001')).rejects.toThrow('disk full')
        expect(relay.published).toHaveLength(before)
        expect(restored.snapshot().projects[0]!.definition!.name).toBe('Later edit')
        expect(restored.snapshot().ready).toBe(false)
        await expect(restored.create(definition('Blocked until recovery', owner), 'after-save-failed-01')).rejects.toThrow('disk full')
      } finally { await restored.close() }
      const leaked = relay.published.find(e => e.tags.some(t => t[0] === 'p' && t[1] === member.pubkey))!
      expect(await unwrapProject(leaked, identity())).toBeUndefined()
    } finally { await Promise.all([a.close(), b.close()]) }
  }, 20_000)

  it('keeps exact retry receipts immutable and never revives earlier authority after archive and restore', async () => {
    const owner = identity(), relay = new SimRelay({ replay: true }), a = await open(owner, relay)
    try {
      const draft = definition('A project', owner), request = 'create-idempotent-01'
      const created = await a.create(draft, request); await synced(a)
      const count = relay.published.length
      const retried = await a.create(draft, request)
      expect(retried).toEqual(created)
      retried.head = '00'.repeat(32)
      expect(await a.create(draft, request)).toEqual(created)
      expect(relay.published).toHaveLength(count)
      await expect(a.create({ ...draft, name: 'Different intent' }, request)).rejects.toThrow('different project change')
      const before = a.snapshot().projects[0]!
      await a.update(before, before.heads, { ...before.definition!, archived: true }, 'archive-project-001'); await synced(a)
      const archived = a.snapshot().projects[0]!
      expect(archived.authority).not.toBe(before.authority)
      await a.update(archived, archived.heads, { ...archived.definition!, archived: false }, 'restore-project-001'); await synced(a)
      expect(a.snapshot().projects[0]!.authority).not.toBe(before.authority)
      expect(a.snapshot().projects[0]!.authority).not.toBe(archived.authority)
    } finally { await a.close() }
  })

  it('does not prompt for empty cache encryption and does not publish if closed while an external signer is pending', async () => {
    const owner = identity(), relay = new SimRelay(), encrypt = vi.fn(owner.encrypt)
    let release!: () => void, started!: () => void
    const signing = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const signEvent = vi.fn(async (...args: Parameters<ProjectIdentity['signEvent']>) => { started(); await held; return owner.signEvent(...args) })
    const cache = storage(), d = await open({ ...owner, encrypt, signEvent }, relay, cache)
    expect(encrypt).not.toHaveBeenCalled()
    expect(await cache.load()).toBeUndefined()
    const creating = d.create(definition('Closed before signing', owner), 'create-closed-00001')
    const rejected = expect(creating).rejects.toThrow('closed while signing')
    await signing
    const closing = d.close()
    release()
    await rejected; await closing
    expect(relay.published).toHaveLength(0)
    expect(await cache.load()).toBeUndefined()
    expect(d.snapshot().projects).toHaveLength(0)
    expect(d.snapshot().ready).toBe(false)
  })
})


describe('incremental project journal storage', () => {
  it.each([100, 1000])('replays %i relay events in 64-record durable batches', async (count) => {
      const owner = identity(), reader = identity(), relay = new SimRelay({ replay: true })
      const root = `kithmoot.shared-projects.v1.${reader.pubkey}`
      const store = new MemoryStore()
      const { calls, storage } = counted(root, store)
      const projects = 50, revisions = count / projects
      for (let p = 0; p < projects; p += 1) {
        let parent: string | undefined
        for (let r = 1; r <= revisions; r += 1) {
          const signed = await signProject(owner, { v: 1 as const, op: 'snapshot' as const, project: projectId(owner.pubkey, `replay-p${p}-request-0001`),
            revision: r, parents: parent ? [parent] : [], request: `replay-p${p}-r${r}-0000001`, definition: definition(`Replay ${p}`, owner, reader) })
          parent = signed.id
          relay.publish(wrapProject(signed, reader.pubkey))
        }
      }
      const directory = await open(reader, relay, storage)
      let snapshot: ReturnType<ProjectDirectory['snapshot']> | undefined
      try {
        // N accepted events produce ceil(N/64) durable writes - one base
        // snapshot, then one encrypted delta per remaining 64-record batch,
        // with amortised compaction replacing some appends - never N writes.
        expect(calls.saves + calls.appends).toBe(Math.ceil(count / 64))
        expect(calls.saves).toBeGreaterThanOrEqual(1)
        expect(calls.saves).toBeLessThanOrEqual(8)
        snapshot = directory.snapshot()
        expect(snapshot.projects).toHaveLength(projects)
        expect(snapshot.projects.every((project: { revision: number }) => project.revision === revisions)).toBe(true)
        const image = await createJournalStorage(root, store).loadIncremental()
        const key = await deltaKeyFor(reader, image)
        const deltas = decodeDeltas(image, key)
        for (const delta of deltas) {
          expect(delta.v).toBe(2)
          for (const name of [...Object.keys(delta.remove ?? {}), ...Object.keys(delta.put ?? {})]) expect(COLLECTION_NAMES).toContain(name)
        }
        // Every later accepted event appears as exactly one put with its
        // superseded head as one remove; across compactions the net of puts
        // over removes plus the base's events is exactly the retained set.
        const baseSaved = JSON.parse(image.base!) as { key: string; body: string }
        const baseKeyHex = await reader.decrypt(reader.pubkey, baseSaved.key)
        const baseCache = JSON.parse(new TextDecoder().decode(decryptEnvelope(base64.decode(baseSaved.body), baseKeyHex).source)) as { events: unknown[] }
        expect(baseCache.events.length).toBeLessThanOrEqual(projects)
        const puts = deltas.reduce((total, delta) => total + (delta.put?.events?.length ?? 0), 0)
        const removes = deltas.reduce((total, delta) => total + (delta.remove?.events?.length ?? 0), 0)
        expect(puts - removes + baseCache.events.length).toBe(projects)
        for (const storageKey of store.values.keys()) expect(storageKey).toMatch(new RegExp(`^${root}(\\.journal\\.v2\\.[0-9a-f]{64})?$`))
      } finally { await directory.close() }
      const restored = await open(reader, new SimRelay(), counted(root, store).storage)
      try {
        expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(JSON.parse(JSON.stringify(snapshot)))
      } finally { await restored.close() }
      // Signing and wrapping a thousand events, then replaying them from the
      // relay and again from the restored journal, is three passes of real
      // schnorr and NIP44 work; give slow machines room.
    }, 300_000)

  it('migrates an exact v1 cache and appends NIP44-encrypted collection deltas', async () => {
    const owner = identity(), relay = new SimRelay({ replay: true })
    const legacy = storage()
    const a = await open(owner, relay, legacy)
    await a.create(definition('Legacy', owner), 'migrate-create-000001')
    await synced(a)
    await a.close()
    const v1 = await legacy.load()
    const root = `kithmoot.shared-projects.v1.${owner.pubkey}`
    const store = new MemoryStore([[root, v1!]])
    const journal = createJournalStorage(root, store)
    const b = await open(owner, new SimRelay(), journal)
    try {
      expect(b.snapshot().projects.map(p => p.definition?.name)).toEqual(['Legacy'])
      await b.create(definition('Second', owner), 'migrate-create-000002')
      await synced(b)
      const image = await journal.loadIncremental()
      expect(image.base).toBe(v1)
      // The create commit and the acknowledgement removal each persist one delta.
      expect(image.deltas).toHaveLength(2)
      await expect(journal.load()).rejects.toThrow('loadIncremental')
      const key = await deltaKeyFor(owner, image)
      const commit = decodeDeltas(image, key).find(delta => delta.put !== undefined)!
      expect(commit.v).toBe(2)
      expect(Object.keys(commit.put!).sort()).toEqual(['events', 'pending', 'requests'])
      expect((commit.put!.events as Event[])).toHaveLength(1)
      const physical = JSON.stringify([...store.values.values()])
      expect(physical).not.toContain('Second')
      expect(physical).not.toContain('migrate-create-000002')
      for (const storageKey of store.values.keys()) expect(storageKey).toMatch(new RegExp(`^${root}(\\.journal\\.v2\\.[0-9a-f]{64})?$`))
    } finally { await b.close() }
    const reopened = await open(owner, new SimRelay(), createJournalStorage(root, store))
    try {
      expect(reopened.snapshot().projects.map(p => p.definition?.name).sort()).toEqual(['Legacy', 'Second'])
    } finally { await reopened.close() }
  })

  it.each([{ write: 1, phase: 'before' as const, committed: false }, { write: 1, phase: 'after' as const, committed: false },
    { write: 2, phase: 'before' as const, committed: false }, { write: 2, phase: 'after' as const, committed: true }])(
    'keeps the previous cache when a first-save $phase write fails at write $write', async ({ write, phase, committed }) => {
      const owner = identity(), relay = new SimRelay({ replay: true })
      const root = `kithmoot.shared-projects.v1.${owner.pubkey}`
      const store = new MemoryStore()
      const journal = createJournalStorage(root, store)
      const directory = await open(owner, relay, journal)
      store.fault = { write, phase }
      try {
        await expect(directory.create(definition('Fault', owner), 'fault-create-0000001')).rejects.toThrow('injected failure')
        expect(directory.snapshot().ready).toBe(false)
        // A fault before the head commit leaves no root; one after it leaves
        // the committed snapshot (the engine's write-order guarantee).
        expect(store.values.has(root)).toBe(committed)
        expect(relay.published.filter(event => event.kind === PROJECT_WRAP_KIND)).toHaveLength(0)
      } finally { await directory.close() }
      const restored = await open(owner, new SimRelay(), createJournalStorage(root, store))
      try {
        expect(restored.snapshot().projects.map(project => project.definition?.name)).toEqual(committed ? ['Fault'] : [])
      } finally { await restored.close() }
    })

  it.each([{ write: 1, phase: 'before' as const, revision: 1 }, { write: 1, phase: 'after' as const, revision: 1 },
    { write: 2, phase: 'before' as const, revision: 1 }, { write: 2, phase: 'after' as const, revision: 2 }])(
    'keeps durable state when a delta $phase write fails at write $write', async ({ write, phase, revision }) => {
      const owner = identity(), relay = new SimRelay({ replay: true })
      const root = `kithmoot.shared-projects.v1.${owner.pubkey}`
      const store = new MemoryStore()
      const journal = createJournalStorage(root, store)
      const directory = await open(owner, relay, journal)
      await directory.create(definition('Fault', owner), 'fault-create-0000001')
      await synced(directory)
      const head = store.values.get(root)
      store.fault = { write: store.writes + write, phase }
      try {
        const current = directory.snapshot().projects[0]!
        await expect(directory.update(current, current.heads, definition('Fault two', owner), 'fault-update-0000001')).rejects.toThrow('injected failure')
        expect(directory.snapshot().ready).toBe(false)
        if (!(phase === 'after' && write === 2)) expect(store.values.get(root)).toBe(head)
      } finally { await directory.close() }
      const restored = await open(owner, new SimRelay(), createJournalStorage(root, store))
      try {
        const projects = restored.snapshot().projects
        expect(projects).toHaveLength(1)
        expect(projects[0]!.revision).toBe(revision)
        expect(projects[0]!.definition!.name).toBe(revision === 1 ? 'Fault' : 'Fault two')
      } finally { await restored.close() }
    })

  it('appends no delta for a failed retry pass and one delta for the acknowledgements', async () => {
    const owner = identity(), member = identity(), relay = new SimRelay({ replay: true })
    const root = `kithmoot.shared-projects.v1.${owner.pubkey}`
    const store = new MemoryStore()
    const { calls, storage } = counted(root, store)
    const transport = new SimTransport(relay), publish = vi.spyOn(transport, 'publish')
    const directory = await open(owner, relay, storage, transport)
    try {
      await directory.create(definition('Retry', owner, member), 'retry-create-000001')
      await synced(directory)
      const base = calls.appends
      publish.mockRejectedValue(new Error('offline'))
      const initial = directory.snapshot().projects[0]!
      await directory.update(initial, initial.heads, definition('Retried', owner, member), 'retry-update-000001')
      expect(calls.appends).toBe(base + 1)
      await vi.waitFor(() => expect(publish.mock.results.length).toBeGreaterThan(1))
      // The failed auto-retry runs without the acknowledgement save; give its
      // tail a moment and assert it persisted nothing.
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(calls.appends).toBe(base + 1)
      expect(directory.snapshot().pendingSends).toBe(2)
      publish.mockRestore()
      // retry() returns while a previous pass is still publishing; poll it.
      await vi.waitFor(async () => { await directory.retry(); expect(directory.snapshot().pendingSends).toBe(0) }, { timeout: 10_000 })
      await synced(directory)
      expect(calls.appends).toBe(base + 2)
    } finally { await directory.close() }
  })

  it('compacts only when amortisation is due across hundreds of commits', async () => {
    const owner = identity(), relay = new SimRelay({ replay: true })
    const root = `kithmoot.shared-projects.v1.${owner.pubkey}`
    const store = new MemoryStore()
    const { calls, storage } = counted(root, store)
    const directory = await open(owner, relay, storage)
    try {
      for (let i = 0; i < 300; i += 1) {
        const current = directory.snapshot().projects[0]
        const next = definition(`Compact ${i}`, owner)
        const request = `compact-request-${String(i).padStart(4, '0')}`
        if (!current) await directory.create(next, request)
        else await directory.update(current, current.heads, next, request)
      }
      await synced(directory)
      // Every commit is durable exactly once (plus an acknowledgement pass);
      // full snapshots are the amortised exception, not the routine.
      expect(calls.appends + calls.saves).toBeGreaterThanOrEqual(300)
      expect(calls.appends + calls.saves).toBeLessThanOrEqual(650)
      expect(calls.saves).toBeGreaterThanOrEqual(3)
      expect(calls.saves).toBeLessThanOrEqual(12)
      const snapshot = JSON.parse(JSON.stringify(directory.snapshot()))
      expect(snapshot.projects[0].definition.name).toBe('Compact 299')
      await directory.close()
      const restored = await open(owner, new SimRelay(), createJournalStorage(root, store))
      try {
        expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(snapshot)
      } finally { await restored.close() }
    } finally { await directory.close() }
  }, 60_000)

  it('applying every generated delta to the old state equals the full state', async () => {
    const owner = identity(), member = identity(), relay = new SimRelay({ replay: true })
    const root = `kithmoot.shared-projects.v1.${owner.pubkey}`
    const store = new MemoryStore()
    const journal = createJournalStorage(root, store)
    const directory = await open(owner, relay, journal)
    try {
      await directory.create(definition('Oracle', owner, member), 'oracle-create-000001')
      await synced(directory)
      const first = directory.snapshot().projects[0]!
      await directory.update(first, first.heads, definition('Oracle two', owner), 'oracle-update-000001')
      await synced(directory)
      const expected = JSON.parse(JSON.stringify(directory.snapshot()))
      expect(expected.pendingSends).toBe(0)
      const image = await journal.loadIncremental()
      const saved = JSON.parse(image.base!) as { v: number; identity: string; key: string; body: string }
      const keyHex = await owner.decrypt(owner.pubkey, saved.key)
      const deltaKey = hkdf(sha256, hexToBytes(keyHex), undefined, DELTA_KEY_INFO, 32)
      const cache = JSON.parse(new TextDecoder().decode(decryptEnvelope(base64.decode(saved.body), keyHex).source)) as {
        events: Event[]; pending: { outer: Event }[]; requests: [string, unknown][]; logoEvents?: Event[]; logoPending?: { outer: Event }[]; logoRequests?: [string, unknown][]; logoWaiting?: Event[] }
      // Independent oracle: shadow-apply each encrypted delta to the base
      // cache, deletes before puts, then reload the shadow through the
      // legacy whole-cache reader with no relay history.
      const shadow = {
        events: new Map(cache.events.map(event => [event.id, event])),
        pending: new Map(cache.pending.map(pending => [pending.outer.id, pending])),
        requests: new Map(cache.requests),
        logoEvents: new Map((cache.logoEvents ?? []).map(event => [event.id, event])),
        logoPending: new Map((cache.logoPending ?? []).map(pending => [pending.outer.id, pending])),
        logoRequests: new Map(cache.logoRequests ?? []),
        logoWaiting: new Map((cache.logoWaiting ?? []).map(event => [event.id, event])),
      }
      expect(image.deltas.length).toBeGreaterThan(0)
      for (const raw of image.deltas) {
        const delta = JSON.parse(nip44.v2.decrypt(raw, deltaKey)) as DecodedDelta
        expect(delta.v).toBe(2)
        for (const name of COLLECTION_NAMES) {
          for (const id of delta.remove?.[name] ?? []) (shadow[name] as Map<string, unknown>).delete(id)
          for (const record of delta.put?.[name] ?? []) {
            if (name === 'events' || name === 'logoEvents' || name === 'logoWaiting') (shadow[name] as Map<string, unknown>).set((record as Event).id, record)
            else if (name === 'pending' || name === 'logoPending') (shadow[name] as Map<string, unknown>).set((record as { outer: Event }).outer.id, record)
            else (shadow[name] as Map<string, unknown>).set((record as [string, unknown])[0], (record as [string, unknown])[1])
          }
        }
      }
      const rebuilt = JSON.stringify({ v: 1, events: [...shadow.events.values()], pending: [...shadow.pending.values()], requests: [...shadow.requests],
        logoEvents: [...shadow.logoEvents.values()], logoPending: [...shadow.logoPending.values()], logoRequests: [...shadow.logoRequests], logoWaiting: [...shadow.logoWaiting.values()] })
      const sealed = encryptEnvelope(new TextEncoder().encode(rebuilt), { name: 'kithmoot-projects.json', type: 'application/json' }, { key: hexToBytes(keyHex), maxSourceBytes: 32 * 1024 * 1024 })
      let unexpectedSave: string | undefined
      const legacyAdapter: ProjectDirectoryStorage = { load: async () => JSON.stringify({ v: 1, identity: owner.pubkey, key: saved.key, body: base64.encode(sealed.envelope) }),
        save: async value => { unexpectedSave = value } }
      const restored = await open(owner, new SimRelay(), legacyAdapter)
      try {
        expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(expected)
        expect(unexpectedSave).toBeUndefined()
      } finally { await restored.close() }
    } finally { await directory.close() }
  })
})
