/**
 * Deleting the files this device put on a Blossom server for a room, when
 * the room self-destructs or is left with "Leave and tidy up".
 *
 * Each upload is a fresh sealed envelope under a fresh key, signed by the
 * room's device key, so the server holds it under that one key and nobody
 * else. BUD-02 lets the same key ask for it to be deleted: a kind 24242
 * `t` delete authorisation naming the hash. Only this device can do it,
 * and only for what it uploaded. Files other members shared are theirs.
 *
 * What this device knows it uploaded comes from two places:
 *
 * - A record it writes the moment an upload lands, under a key naming the
 *   room (`kithmoot.uploads.v1.<roomId>`): the blob's URL and hash, never
 *   the file's name or key. The wipe that forgets the room removes it.
 * - For uploads made before that record existed, the kind 1063
 *   announcements this device's key signed, which the tidy-up's own
 *   device step has just fetched from the room's relays. A quiet room
 *   never published one, and a dated room's lapse with it under NIP-40,
 *   so this finds older files only for a room with no end, or one tidied
 *   before its end.
 *
 * A delete goes only to a URL on a server this app uploads to (the one
 * this device is set to use, or one its own record names) whose last path
 * segment is the hash: the checks an upload's descriptor is held to.
 *
 * A server that cannot be reached, or still serves a file afterwards, does
 * not hold the wipe up. The delete is signed again with a week's life and
 * kept under a key that names no room, and this device tries it again at
 * each launch until it works or the week is over. Nothing else is kept:
 * not the device key, which goes with the room. After the week the
 * server's own expiry is the backstop (the KithMoot server drops a blob 90
 * days after it was last fetched).
 */
import { finalizeEvent, type Event } from 'nostr-tools/pure'
import {
  blobDeleteUrl,
  buildDeleteAuthorisation,
  deleteBlob,
  isDeleteAuthorisation,
  FILE_EVENT_KIND,
  type BlobDeleteOutcome,
} from '../../src/attachment.js'
import type { DeviceStore } from './device-store.js'

export const UPLOADS_PREFIX = 'kithmoot.uploads.v1.'
/** Deletes still to send, for rooms already wiped. Names no room. */
export const PENDING_BLOB_DELETES_KEY = 'kithmoot.blob-deletes.v1'
/** How long a delete that did not go through is tried again: a week, the
 *  same as a self-destructed room's row in the list. */
export const BLOB_DELETE_RETRY_SECONDS = 7 * 86_400
/** How long one request may take before the server counts as unreachable. */
export const BLOB_DELETE_TIMEOUT_MS = 15_000
const MAX_UPLOADS = 1000
const MAX_PENDING = 2000
const PARALLEL = 4

export interface UploadedBlob { url: string; sha256: string }

const HASH = /^[0-9a-f]{64}$/

function readUploads(store: DeviceStore, roomId: string): UploadedBlob[] {
  try {
    const parsed = JSON.parse(store.get(UPLOADS_PREFIX + roomId) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((b): b is UploadedBlob => !!b && typeof b === 'object'
      && typeof (b as UploadedBlob).url === 'string' && typeof (b as UploadedBlob).sha256 === 'string' && HASH.test((b as UploadedBlob).sha256))
  } catch {
    return []
  }
}

/** Write down a blob this device uploaded for a room. */
export function recordUpload(store: DeviceStore, roomId: string, blob: UploadedBlob): void {
  const sha256 = blob.sha256.toLowerCase()
  if (!HASH.test(sha256)) return
  const kept = readUploads(store, roomId).filter(b => b.sha256 !== sha256)
  try {
    store.set(UPLOADS_PREFIX + roomId, JSON.stringify([...kept, { url: blob.url, sha256 }].slice(-MAX_UPLOADS)))
  } catch { /* Storage full or unavailable: the announcement is the fallback. */ }
}

/** The blobs this device recorded uploading for a room. */
export function roomUploads(store: DeviceStore, roomId: string): UploadedBlob[] {
  return readUploads(store, roomId)
}

export function forgetRoomUploads(store: DeviceStore, roomId: string): void {
  store.remove(UPLOADS_PREFIX + roomId)
}

/** The blobs a set of events says `devicePub` uploaded: its own kind 1063
 *  announcements' `url` and `x`. */
export function uploadsFromEvents(events: readonly Event[], devicePub: string): UploadedBlob[] {
  const out: UploadedBlob[] = []
  for (const event of events) {
    if (event.kind !== FILE_EVENT_KIND || event.pubkey !== devicePub) continue
    const url = event.tags.find(t => t[0] === 'url')?.[1]
    const sha256 = event.tags.find(t => t[0] === 'x')?.[1]?.toLowerCase()
    if (url && sha256 && HASH.test(sha256)) out.push({ url, sha256 })
  }
  return out
}

// ---------------------------------------------------------------------------
// Deletes still to send
// ---------------------------------------------------------------------------

interface PendingDelete {
  /** Where the delete goes, from `blobDeleteUrl`. */
  url: string
  sha256: string
  /** The signed delete authorisation, good until `until`. */
  auth: Event
  until: number
}

function readPending(store: DeviceStore): PendingDelete[] {
  try {
    const parsed = JSON.parse(store.get(PENDING_BLOB_DELETES_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is PendingDelete => !!p && typeof p === 'object'
      && typeof (p as PendingDelete).url === 'string' && typeof (p as PendingDelete).sha256 === 'string'
      && typeof (p as PendingDelete).until === 'number' && !!(p as PendingDelete).auth && typeof (p as PendingDelete).auth === 'object')
  } catch {
    return []
  }
}

function writePending(store: DeviceStore, pending: PendingDelete[]): void {
  try {
    if (pending.length) store.set(PENDING_BLOB_DELETES_KEY, JSON.stringify(pending.slice(-MAX_PENDING)))
    else store.remove(PENDING_BLOB_DELETES_KEY)
  } catch { /* Storage unavailable: the server's own expiry is the backstop. */ }
}

/** How many deletes are waiting to be tried again. */
export function pendingBlobDeletes(store: DeviceStore, now: number): number {
  return readPending(store).filter(p => p.until > now).length
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/** Run `work` over `items`, a few at a time. */
async function inParallel<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}

interface Sender {
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Send one delete, unless its host was already found unreachable in this
 *  run: then it is not tried again until the next. */
async function send(url: string, auth: Event, unreachable: Set<string>, opts: Sender): Promise<BlobDeleteOutcome> {
  const host = hostOf(url)
  if (unreachable.has(host)) return { status: 'failed', detail: `Could not reach ${host}.` }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? BLOB_DELETE_TIMEOUT_MS)
  const outcome = await deleteBlob(url, auth, { ...(opts.fetch ? { fetch: opts.fetch } : {}), signal })
  if (outcome.status === 'failed' && outcome.detail.startsWith('Could not reach')) unreachable.add(host)
  return outcome
}

export interface FileDeletionReport {
  /** Distinct files this device knows it shared in the room. */
  found: number
  deleted: number
  /** Not on a server this app uploads to, or not addressed by its hash: not sent. */
  refused: number
  /** Kept to try again: the server could not be reached, answered with an
   *  error, or still serves the file. */
  pending: number
  /** One line per host that did not delete everything. */
  details: string[]
}

export interface DeleteUploadsOptions extends Sender {
  blobs: readonly UploadedBlob[]
  /** Servers this app uploads to: the one it is set to use now, and those
   *  its own record names. */
  origins: readonly string[]
  /** The room's device key, which signed the uploads. */
  sk: Uint8Array
  now: () => number
  /** Where a delete that did not go through is kept for another try. */
  store: DeviceStore
}

/** Ask for every file in `blobs` to be deleted, keeping those that were
 *  not for another try. Never throws for a server's answer. */
export async function deleteUploads(opts: DeleteUploadsOptions): Promise<FileDeletionReport> {
  const bySha = new Map<string, UploadedBlob>()
  for (const blob of opts.blobs) if (!bySha.has(blob.sha256.toLowerCase())) bySha.set(blob.sha256.toLowerCase(), blob)
  const report: FileDeletionReport = { found: bySha.size, deleted: 0, refused: 0, pending: 0, details: [] }
  const targets: { url: string; sha256: string }[] = []
  for (const [sha256, blob] of bySha) {
    const url = blobDeleteUrl(blob.url, sha256, opts.origins)
    if (url) targets.push({ url, sha256 })
    else report.refused++
  }
  const unreachable = new Set<string>()
  const left = new Map<string, { count: number; detail: string }>()
  const retry: PendingDelete[] = []
  await inParallel(targets, async target => {
    const origin = new URL(target.url).origin
    const auth = finalizeEvent(buildDeleteAuthorisation(target.sha256, origin, opts.now()), opts.sk)
    const outcome = await send(target.url, auth, unreachable, opts)
    if (outcome.status === 'deleted') { report.deleted++; return }
    const now = opts.now()
    const until = now + BLOB_DELETE_RETRY_SECONDS
    // A week's authorisation for this one blob, so the device key can go
    // with the room and the delete can still be sent.
    retry.push({ url: target.url, sha256: target.sha256, until, auth: finalizeEvent(buildDeleteAuthorisation(target.sha256, origin, now, BLOB_DELETE_RETRY_SECONDS + 1), opts.sk) })
    const host = hostOf(target.url)
    left.set(host, { count: (left.get(host)?.count ?? 0) + 1, detail: outcome.detail })
  })
  if (retry.length) {
    const queued = new Set(retry.map(r => r.url))
    writePending(opts.store, [...readPending(opts.store).filter(p => !queued.has(p.url)), ...retry])
  }
  report.pending = retry.length
  for (const [host, { count, detail }] of [...left].sort(([a], [b]) => a < b ? -1 : 1)) {
    report.details.push(`${count} on ${host}: ${detail}`)
  }
  return report
}

let retrying: Promise<number> | undefined

/**
 * Try every kept delete again. Those that went through, and those whose
 * week is over, are dropped; the rest stay for the next launch. Resolves
 * with how many are still waiting. One run at a time in a page; two tabs
 * may both try, which only repeats a delete.
 */
export function retryPendingBlobDeletes(store: DeviceStore, now: () => number, opts: Sender = {}): Promise<number> {
  if (retrying) return retrying
  retrying = (async () => {
    const usable = (p: PendingDelete) => p.until > now() && isDeleteAuthorisation(p.auth, p.sha256, now())
    const due = readPending(store).filter(usable)
    const done = new Set<string>()
    const unreachable = new Set<string>()
    await inParallel(due, async p => {
      if ((await send(p.url, p.auth, unreachable, opts)).status === 'deleted') done.add(p.url)
    })
    // Read again: a tidy-up may have added to the list meanwhile.
    const after = readPending(store).filter(p => !done.has(p.url) && usable(p))
    writePending(store, after)
    return after.length
  })().finally(() => { retrying = undefined })
  return retrying
}
