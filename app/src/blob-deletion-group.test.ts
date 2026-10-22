import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { memoryDeviceStore } from './device-store.js'
import {
  PENDING_BLOB_DELETES_KEY, PENDING_GROUP_DELETES_KEY, deleteUploads, isGroupDeleteUrl, pendingBlobDeletes, readGroupDeleteMarks, retryPendingBlobDeletes, uploadOrigins,
} from './blob-deletion.js'

const NOW = 1_800_000_000
const HASH = 'ab'.repeat(32)
const HASH2 = 'cd'.repeat(32)
const NODE = 'https://grove.example.net'
const UNDER = 'https://hill.example.org:8443/wb/store'

interface Seen { method: string; url: string; auth: boolean }

/** A group node as far as a delete is concerned: the delete is accepted (once), a read without a token is `401` whether or not the blob is there, and a read with one finds nothing after. */
function groupNode(opts: { acceptDelete?: number; down?: boolean } = {}) {
  const seen: Seen[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (opts.down) throw new TypeError('connection refused')
    const method = init?.method ?? 'GET'
    const header = (init?.headers as Record<string, string> | undefined)?.Authorization
    seen.push({ method, url, auth: header !== undefined })
    if (method === 'DELETE') {
      const token = JSON.parse(Buffer.from(header!.slice('Nostr '.length), 'base64').toString('utf8')) as Event
      expect(verifyEvent(token)).toBe(true)
      expect(token.tags.find(t => t[0] === 't')?.[1]).toBe('delete')
      return new Response(null, { status: opts.acceptDelete ?? 200 })
    }
    if (!header) return new Response(null, { status: 401, headers: { 'x-reason': 'missing' } })
    return new Response(null, { status: 404 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen }
}

const blob = (base: string, sha256 = HASH) => ({ url: `${base}/${sha256}`, sha256, key: 'device' as const })

describe('a room’s group files are deleted on the nodes it lists', () => {
  it('knows a group file by its url being exactly <listed base>/<hash>', () => {
    expect(isGroupDeleteUrl(`${NODE}/${HASH}`, HASH, [NODE])).toBe(true)
    expect(isGroupDeleteUrl(`${UNDER}/${HASH}`, HASH.toUpperCase(), [NODE, UNDER])).toBe(true)
    expect(isGroupDeleteUrl(`${NODE}/${HASH}`, HASH, [UNDER])).toBe(false)
    expect(isGroupDeleteUrl(`https://files.example/${HASH}`, HASH, [NODE])).toBe(false)
    expect(isGroupDeleteUrl(`${NODE}/x/${HASH}`, HASH, [NODE])).toBe(false)
    expect(isGroupDeleteUrl(`${NODE}/${HASH}`, HASH, [])).toBe(false)
  })

  it('goes to a node with the signed delete, on a base path too, and an authenticated look decides', async () => {
    const sk = generateSecretKey()
    const store = memoryDeviceStore()
    const node = groupNode()
    const confirm = vi.fn(async () => 'absent' as const)
    const report = await deleteUploads({
      blobs: [blob(NODE), blob(UNDER, HASH2)], origins: uploadOrigins([blob(NODE), blob(UNDER, HASH2)], [new URL(NODE).origin, new URL(UNDER).origin]),
      groups: { bases: [NODE, UNDER], confirm }, sk, now: () => NOW, store, fetch: node.fetch,
    })
    expect(report).toEqual({ found: 2, deleted: 2, refused: 0, pending: 0, details: [] })
    expect(node.seen.filter(s => s.method === 'DELETE').map(s => s.url).sort()).toEqual([`${NODE}/${HASH}`, `${UNDER}/${HASH2}`])
    // The look is the authenticated one the caller supplied: no unauthenticated HEAD is sent.
    expect(node.seen.some(s => s.method === 'HEAD')).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
    expect(store.get(PENDING_GROUP_DELETES_KEY)).toBeNull()
  })

  it('a node that still serves the file after the delete keeps it pending', async () => {
    const store = memoryDeviceStore()
    const report = await deleteUploads({
      blobs: [blob(NODE)], origins: [NODE], groups: { bases: [NODE], confirm: async () => 'present' }, sk: generateSecretKey(), now: () => NOW, store, fetch: groupNode().fetch,
    })
    expect(report).toMatchObject({ found: 1, deleted: 0, pending: 1 })
    expect(report.details).toEqual(['1 on grove.example.net: grove.example.net still serves the file.'])
    expect(pendingBlobDeletes(store, NOW)).toBe(1)
    expect(readGroupDeleteMarks(store.get(PENDING_GROUP_DELETES_KEY))).toEqual([`${NODE}/${HASH}`])
  })

  it('without a key to look with, the node’s acceptance is all there is, and the report says so', async () => {
    const store = memoryDeviceStore()
    const node = groupNode()
    const report = await deleteUploads({ blobs: [blob(NODE)], origins: [NODE], groups: { bases: [NODE] }, sk: generateSecretKey(), now: () => NOW, store, fetch: node.fetch })
    expect(report).toMatchObject({ found: 1, deleted: 1, pending: 0 })
    expect(report.details).toEqual(['deleted on grove.example.net, not confirmed (this device can no longer read there)'])
    // The only look was the unauthenticated one, which a group node answers 401 to either way.
    expect(node.seen.map(s => `${s.method} ${s.auth}`)).toEqual(['DELETE true', 'HEAD false'])
  })

  it('a device that can no longer read says the same, and a look that fails leaves the delete to be tried again', async () => {
    const unconfirmed = await deleteUploads({
      blobs: [blob(NODE)], origins: [NODE], groups: { bases: [NODE], confirm: async () => 'unconfirmed' }, sk: generateSecretKey(), now: () => NOW, store: memoryDeviceStore(), fetch: groupNode().fetch,
    })
    expect(unconfirmed).toMatchObject({ deleted: 1, details: ['deleted on grove.example.net, not confirmed (this device can no longer read there)'] })
    const store = memoryDeviceStore()
    const failed = await deleteUploads({
      blobs: [blob(NODE)], origins: [NODE], groups: { bases: [NODE], confirm: async () => 'failed' }, sk: generateSecretKey(), now: () => NOW, store, fetch: groupNode().fetch,
    })
    expect(failed).toMatchObject({ deleted: 0, pending: 1 })
    expect(pendingBlobDeletes(store, NOW)).toBe(1)
  })

  it('a file on a public server in the same room is deleted the plain way, beside the group’s', async () => {
    const store = memoryDeviceStore()
    const plain = 'https://files.example'
    const seen: string[] = []
    const fetchMixed = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(url).host}`)
      if (init?.method === 'DELETE') return new Response(null, { status: 200 })
      if (new URL(url).host === 'files.example') return new Response(null, { status: 404 })
      return new Response(null, { status: (init?.headers as Record<string, string> | undefined)?.Authorization ? 404 : 401 })
    }) as typeof globalThis.fetch
    const report = await deleteUploads({
      blobs: [blob(NODE), blob(plain, HASH2)], origins: [NODE, plain], groups: { bases: [NODE], confirm: async () => 'absent' }, sk: generateSecretKey(), now: () => NOW, store, fetch: fetchMixed,
    })
    expect(report).toMatchObject({ found: 2, deleted: 2, pending: 0 })
    // The plain file was looked at the plain way; the group file with the supplied look, so no HEAD went to the node.
    expect(seen.sort()).toEqual(['DELETE files.example', 'DELETE grove.example.net', 'HEAD files.example'])
  })

  it('refuses a node the room does not list: a file only on a listed origin may be deleted', async () => {
    const node = groupNode()
    const report = await deleteUploads({
      blobs: [blob('https://stranger.example.net')], origins: [NODE], groups: { bases: [NODE] }, sk: generateSecretKey(), now: () => NOW, store: memoryDeviceStore(), fetch: node.fetch,
    })
    expect(report).toMatchObject({ found: 1, refused: 1, deleted: 0 })
    expect(node.fetch).not.toHaveBeenCalled()
  })
})

describe('a group delete that is tried again at a later launch', () => {
  async function leftBehind() {
    const store = memoryDeviceStore()
    const report = await deleteUploads({
      blobs: [blob(NODE), blob('https://files.example', HASH2)], origins: [NODE, 'https://files.example'], groups: { bases: [NODE], confirm: async () => 'absent' },
      sk: generateSecretKey(), now: () => NOW, store, fetch: groupNode({ down: true }).fetch,
    })
    expect(report).toMatchObject({ found: 2, deleted: 0, pending: 2 })
    return store
  }

  it('is marked beside the journal, which keeps its closed shape, and names no room', async () => {
    const store = await leftBehind()
    expect(readGroupDeleteMarks(store.get(PENDING_GROUP_DELETES_KEY))).toEqual([`${NODE}/${HASH}`])
    for (const row of JSON.parse(store.get(PENDING_BLOB_DELETES_KEY)!)) expect(Object.keys(row).sort()).toEqual(['auth', 'sha256', 'until', 'url'])
  })

  it('with no key and no room, DELETE accepted and then HEAD 401 is deleted, not confirmed', async () => {
    const store = await leftBehind()
    const node = groupNode()
    const left = await retryPendingBlobDeletes(store, () => NOW + 3600, { fetch: node.fetch })
    // The group row is done. The plain row (a server that is not one of the room's) is read the plain way, answers 401 to the look, and is kept.
    expect(left).toBe(1)
    expect(node.seen.filter(s => s.url.startsWith(NODE)).map(s => `${s.method} ${s.auth}`)).toEqual(['DELETE true', 'HEAD false'])
    expect(JSON.parse(store.get(PENDING_BLOB_DELETES_KEY)!).map((r: { url: string }) => r.url)).toEqual([`https://files.example/${HASH2}`])
    // The mark goes with its row.
    expect(store.get(PENDING_GROUP_DELETES_KEY)).toBeNull()
  })

  it('a row that is not marked is read the plain way: the same 401 is a delete that could not be confirmed', async () => {
    const store = memoryDeviceStore()
    await deleteUploads({ blobs: [blob(NODE)], origins: [NODE], sk: generateSecretKey(), now: () => NOW, store, fetch: groupNode({ down: true }).fetch })
    expect(store.get(PENDING_GROUP_DELETES_KEY)).toBeNull()
    expect(await retryPendingBlobDeletes(store, () => NOW + 60, { fetch: groupNode().fetch })).toBe(1)
  })

  it('a damaged list of marks never holds a delete up: it is read as none', async () => {
    const store = await leftBehind()
    store.set(PENDING_GROUP_DELETES_KEY, '{not an array')
    expect(() => readGroupDeleteMarks(store.get(PENDING_GROUP_DELETES_KEY))).toThrow(/could not be verified/)
    expect(await retryPendingBlobDeletes(store, () => NOW + 60, { fetch: groupNode().fetch })).toBe(2)
  })

  it('the list of marks is read strictly: canonical JSON, https urls, no repeats', () => {
    expect(readGroupDeleteMarks(null)).toEqual([])
    expect(readGroupDeleteMarks(JSON.stringify([`${NODE}/${HASH}`]))).toEqual([`${NODE}/${HASH}`])
    for (const raw of ['[]', '{}', '["http://x/y"]', '["https://a/b","https://a/b"]', '[1]', '[ "https://a/b" ]', 'text']) {
      expect(() => readGroupDeleteMarks(raw), raw).toThrow()
    }
  })

  it('marks are kept only for the rows still in the journal', async () => {
    const store = memoryDeviceStore()
    await deleteUploads({ blobs: [blob(NODE)], origins: [NODE], groups: { bases: [NODE] }, sk: getTestKey(), now: () => NOW, store, fetch: groupNode({ down: true }).fetch })
    expect(readGroupDeleteMarks(store.get(PENDING_GROUP_DELETES_KEY))).toHaveLength(1)
    // The week passes: the journal lets the row go, and the mark with it.
    expect(await retryPendingBlobDeletes(store, () => NOW + 8 * 86_400, { fetch: groupNode().fetch })).toBe(0)
    expect(store.get(PENDING_GROUP_DELETES_KEY)).toBeNull()
    expect(store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
  })
})

function getTestKey(): Uint8Array {
  const sk = generateSecretKey()
  expect(getPublicKey(sk)).toMatch(/^[0-9a-f]{64}$/)
  return sk
}
