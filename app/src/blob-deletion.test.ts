import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { memoryDeviceStore } from './device-store.js'
import {
  BLOB_DELETE_RETRY_SECONDS,
  PENDING_BLOB_DELETES_KEY,
  UPLOADS_PREFIX,
  deleteUploads,
  forgetRoomUploads,
  pendingBlobDeletes,
  recordUpload,
  retryPendingBlobDeletes,
  roomUploads,
  uploadsFromEvents,
} from './blob-deletion.js'

const NOW = 1_800_000_000
const ROOM = 'r'.repeat(64)
const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32)
const SERVER = 'https://files.example'

/** A Blossom server in memory: holds blobs under their uploader's key and
 *  deletes them for that key only, as blossom-server-ts does; answers HEAD. */
function blossom(held: Map<string, string>, opts: { down?: boolean } = {}) {
  const requests: Array<{ method: string; url: string; auth?: Event }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (opts.down) throw new TypeError('offline')
    const method = init?.method ?? 'GET'
    const header = (init?.headers as Record<string, string> | undefined)?.Authorization
    const auth = header ? JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8')) as Event : undefined
    requests.push({ method, url, ...(auth ? { auth } : {}) })
    const hash = url.split('/').at(-1)!
    if (method === 'DELETE') {
      if (!auth || !verifyEvent(auth) || auth.kind !== 24242 || !auth.tags.some(t => t[0] === 't' && t[1] === 'delete')
        || !auth.tags.some(t => t[0] === 'x' && t[1] === hash) || Number(auth.tags.find(t => t[0] === 'expiration')?.[1]) <= NOW) {
        return new Response(null, { status: 401 })
      }
      if (!held.has(hash)) return new Response(null, { status: 404 })
      if (held.get(hash) === auth.pubkey) held.delete(hash)
      return new Response('{"message":"Deleted"}', { status: 200 })
    }
    return new Response(null, { status: held.has(hash) ? 200 : 404 })
  })
  return { fetch, requests }
}

describe('the record of what this device uploaded', () => {
  it('keeps url and hash per room, once each, and nothing else', () => {
    const store = memoryDeviceStore()
    recordUpload(store, ROOM, { url: `${SERVER}/blossom/${A}`, sha256: A.toUpperCase() })
    recordUpload(store, ROOM, { url: `${SERVER}/blossom/${A}`, sha256: A })
    recordUpload(store, ROOM, { url: `${SERVER}/blossom/${B}`, sha256: B })
    recordUpload(store, ROOM, { url: 'x', sha256: 'not a hash' })
    expect(roomUploads(store, ROOM)).toEqual([{ url: `${SERVER}/blossom/${A}`, sha256: A }, { url: `${SERVER}/blossom/${B}`, sha256: B }])
    expect(store.keys()).toEqual([UPLOADS_PREFIX + ROOM])
    expect(roomUploads(store, 'other')).toEqual([])
    forgetRoomUploads(store, ROOM)
    expect(store.keys()).toEqual([])
  })

  it('reads older uploads from the device’s own file announcements only', () => {
    const sk = generateSecretKey(), other = generateSecretKey()
    const announce = (key: Uint8Array, hash: string) => finalizeEvent({ kind: 1063, created_at: NOW, content: '', tags: [['url', `${SERVER}/${hash}`], ['x', hash]] }, key)
    const events = [announce(sk, A), announce(other, B), finalizeEvent({ kind: 1460, created_at: NOW, content: '', tags: [['url', 'x'], ['x', C]] }, sk)]
    expect(uploadsFromEvents(events, getPublicKey(sk))).toEqual([{ url: `${SERVER}/${A}`, sha256: A }])
  })
})

describe('deleting a room’s uploads', () => {
  it('deletes each of this device’s files with its device key, and sends nothing to another server', async () => {
    const sk = generateSecretKey()
    const held = new Map([[A, getPublicKey(sk)], [B, getPublicKey(sk)]])
    const server = blossom(held)
    const store = memoryDeviceStore()
    const report = await deleteUploads({
      blobs: [
        { url: `${SERVER}/blossom/${A}`, sha256: A },
        { url: `${SERVER}/blossom/${A}`, sha256: A },
        { url: `${SERVER}/blossom/${B}`, sha256: B },
        { url: `https://elsewhere.example/${C}`, sha256: C },
        { url: `${SERVER}/blossom/${A}`, sha256: C },
      ],
      origins: [SERVER], sk, now: () => NOW, store, fetch: server.fetch as never,
    })
    expect(report).toEqual({ found: 3, deleted: 2, refused: 1, pending: 0, details: [] })
    expect(held.size).toBe(0)
    const deletes = server.requests.filter(r => r.method === 'DELETE')
    expect(deletes.map(r => r.url).sort()).toEqual([`${SERVER}/blossom/${A}`, `${SERVER}/blossom/${B}`])
    for (const d of deletes) {
      expect(d.auth!.pubkey).toBe(getPublicKey(sk))
      expect(Number(d.auth!.tags.find(t => t[0] === 'expiration')![1]) - d.auth!.created_at).toBeLessThanOrEqual(60)
    }
    expect(server.requests.some(r => r.url.includes('elsewhere'))).toBe(false)
    expect(store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
  })

  it('keeps a delete the server did not carry out for a week, signed, naming no room, and sends it again later', async () => {
    const sk = generateSecretKey()
    const hashes = Array.from({ length: 10 }, (_, i) => i.toString(16).repeat(64))
    const held = new Map(hashes.map(h => [h, getPublicKey(sk)]))
    const store = memoryDeviceStore()
    const down = blossom(held, { down: true })
    const report = await deleteUploads({
      blobs: hashes.map(sha256 => ({ url: `${SERVER}/blossom/${sha256}`, sha256 })),
      origins: [SERVER], sk, now: () => NOW, store, fetch: down.fetch as never,
    })
    expect(report.deleted).toBe(0)
    expect(report.pending).toBe(10)
    expect(report.details).toEqual(['10 on files.example: Could not reach files.example.'])
    // Found unreachable: the rest are not sent in the same run, only kept.
    expect(down.fetch.mock.calls.length).toBeLessThanOrEqual(4)
    const kept = store.get(PENDING_BLOB_DELETES_KEY)!
    expect(kept).not.toContain(ROOM)
    expect(pendingBlobDeletes(store, NOW)).toBe(10)

    // Next launch, the server is back: sent with the kept authorisation;
    // no key needed.
    const up = blossom(held)
    expect(await retryPendingBlobDeletes(store, () => NOW + 3600, { fetch: up.fetch as never })).toBe(0)
    expect(held.size).toBe(0)
    expect(up.requests.filter(r => r.method === 'DELETE').every(r => r.auth!.pubkey === getPublicKey(sk))).toBe(true)
    expect(store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
  })

  it('keeps one the server still serves, and drops what is left after the week', async () => {
    const sk = generateSecretKey()
    // Owned by another key: the server answers 200 and keeps the bytes.
    const held = new Map([[A, getPublicKey(generateSecretKey())]])
    const store = memoryDeviceStore()
    const report = await deleteUploads({ blobs: [{ url: `${SERVER}/blossom/${A}`, sha256: A }], origins: [SERVER], sk, now: () => NOW, store, fetch: blossom(held).fetch as never })
    expect(report.pending).toBe(1)
    expect(report.details).toEqual(['1 on files.example: files.example still serves the file.'])
    expect(await retryPendingBlobDeletes(store, () => NOW + 60, { fetch: blossom(held).fetch as never })).toBe(1)
    const late = blossom(held)
    expect(await retryPendingBlobDeletes(store, () => NOW + BLOB_DELETE_RETRY_SECONDS, { fetch: late.fetch as never })).toBe(0)
    expect(late.fetch).not.toHaveBeenCalled()
    expect(store.get(PENDING_BLOB_DELETES_KEY)).toBeNull()
  })
})
