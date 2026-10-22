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
 * this device explicitly consented to use, or an exact verified announcement
 * names) whose last path
 * segment is the hash: the checks an upload's descriptor is held to.
 *
 * A file on one of the room's own storage nodes is deleted the same way, with
 * the same signed permission, but a group node answers `401` to every
 * unauthenticated read, so "is it gone?" is asked with a signed read while the
 * room's key is at hand (`GroupDeletes.confirm`), and otherwise the node's
 * acceptance of the delete is all there is to go on and is reported as such
 * (`deleteGroupBlob`). Which kept rows are group deletes is written beside the
 * journal (`PENDING_GROUP_DELETES_KEY`), because the journal's rows are a
 * closed shape an older copy of the app must still be able to read, and a
 * delete retried at a later launch no longer has the room to ask.
 *
 * A server that cannot be reached, or still serves a file afterwards, does
 * not hold the wipe up once a week's exact-target permission is durably
 * kept under a key that names no room, and this device tries it again at
 * each launch until it works or the week is over. Nothing else is kept:
 * not the device key, which goes with the room. After the week the
 * server's own expiry is the backstop (the KithMoot server drops a blob 90
 * days after it was last fetched).
 */
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import {
  blobDeleteUrl,
  buildDeleteAuthorisation,
  deleteBlob,
  isDeleteAuthorisation,
  isDeleteAuthorisationTarget,
  FILE_EVENT_KIND,
  type BlobDeleteOutcome,
} from '../../src/attachment.js'
import { verifyEventUncached } from '../../src/verify.js'
import { deleteGroupBlob, type GroupBlobDeleteOutcome, type HeadOutcome } from '../../src/group-storage.js'
import type { DeviceStore } from './device-store.js'
import { ordinaryUtf8Length } from './ordinary-state-codec.js'

export const UPLOADS_PREFIX = 'kithmoot.uploads.v1.'
/** Deletes still to send, for rooms already wiped. Names no room. */
export const PENDING_BLOB_DELETES_KEY = 'kithmoot.blob-deletes.v1'
/** Which of the deletes still to send go to a group node: their delete URLs, a subset of the journal's. Names no room. */
export const PENDING_GROUP_DELETES_KEY = 'kithmoot.blob-delete-groups.v1'
/** How long a delete that did not go through is tried again: a week, the
 *  same as a self-destructed room's row in the list. */
export const BLOB_DELETE_RETRY_SECONDS = 7 * 86_400
/** How long one request may take before the server counts as unreachable. */
export const BLOB_DELETE_TIMEOUT_MS = 15_000
const MAX_UPLOADS = 1000
const MAX_PENDING = 2000
const PARALLEL = 4

/** `key` says which key signed the upload, so its delete is signed the same
 *  way: the room's device key (`device`, the only one stage A writes) or the
 *  per-device file key used for a person's own Wildbloom (`file`, stage C).
 *  Records written before it existed carry none, and mean `device`. */
export interface UploadedBlob { url: string; sha256: string; key?: 'device' | 'file' }

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
  const kept = readUploads(store, roomId).filter(b => b.sha256 !== sha256 || b.url !== blob.url)
  try {
    store.set(UPLOADS_PREFIX + roomId, JSON.stringify([...kept, { url: blob.url, sha256, ...(blob.key ? { key: blob.key } : {}) }].slice(-MAX_UPLOADS)))
  } catch { /* Storage full or unavailable: the announcement is the fallback. */ }
}

/** The blobs this device recorded uploading for a room. */
export function roomUploads(store: DeviceStore, roomId: string): UploadedBlob[] {
  return readUploads(store, roomId)
}

/** Where a room's deletes go: the origins of the files this device recorded
 *  uploading there (so a device that changed server can still tidy up the
 *  old one), then the origin it uploads to now, if any. The one place that
 *  decides it: S5b adds a group's nodes here.
 *
 *  Only a record that says which key signed it (`key`) adds its origin: the
 *  app writes that field itself, at the moment an upload to a server the
 *  person allowed lands. A record without one is older, or was not written by
 *  an upload, and is never trusted to name a place to send a delete (the
 *  tidy-up pauses on it instead, as before). */
export function uploadOrigins(recorded: readonly UploadedBlob[], current: readonly string[] = []): string[] {
  const origins = new Set<string>()
  for (const blob of recorded) {
    if (!blob.key) continue
    try { origins.add(new URL(blob.url).origin) } catch { /* Not a URL: nothing to delete there. */ }
  }
  for (const origin of current) if (origin) origins.add(origin)
  return [...origins]
}

export function forgetRoomUploads(store: DeviceStore, roomId: string): void {
  store.remove(UPLOADS_PREFIX + roomId)
}

/** The blobs a set of events says `devicePub` uploaded: its own kind 1063
 *  announcements' `url` and `x`. */
export function uploadsFromEvents(events: readonly Event[], devicePub: string): UploadedBlob[] {
  const out: UploadedBlob[] = []
  for (const event of events) {
    try {
      // Capture once and verify without nostr-tools' mutable verification cache.
      const owned: Event = JSON.parse(JSON.stringify(event))
      if (owned.kind !== FILE_EVENT_KIND || owned.pubkey !== devicePub || !verifyEventUncached(owned)) continue
      const urls = owned.tags.filter(t => t[0] === 'url'), hashes = owned.tags.filter(t => t[0] === 'x')
      if (urls.length !== 1 || hashes.length !== 1 || urls[0]!.length !== 2 || hashes[0]!.length !== 2) continue
      const url = urls[0]![1]!, sha256 = hashes[0]![1]!
      if (HASH.test(sha256) && blobDeleteUrl(url, sha256, [new URL(url).origin])) out.push({ url, sha256 })
    } catch { /* An unsupported announcement is not upload provenance. */ }
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

/** Validate the whole physical journal before effects. Unsupported rows are
 * retained intact for recovery, never filtered into a successful retry. This
 * is historical signed target correlation, not fresh upload/room authority. */
export function readPendingBlobDeleteJournal(raw: string | null): PendingDelete[] {
  if (raw === null) return []
  try {
    ordinaryUtf8Length(raw)
    const parsed: unknown = JSON.parse(raw)
    if (JSON.stringify(parsed) !== raw || !Array.isArray(parsed) || !parsed.length || parsed.length > MAX_PENDING) throw Error()
    const urls = new Set<string>()
    for (const p of parsed) {
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.url !== 'string' || typeof p.sha256 !== 'string' ||
          Object.keys(p).length !== 4 || ['url', 'sha256', 'auth', 'until'].some(key => !Object.hasOwn(p, key)) ||
          !Number.isSafeInteger(p.until) || p.until < 0 || !isDeleteAuthorisationTarget(p.auth, p.sha256, p.url)) throw Error()
      if (urls.has(p.url)) throw Error()
      urls.add(p.url)
      const expiration = Number(p.auth.tags.find((t: string[]) => t[0] === 'expiration')[1])
      // The writer copies the signed expiry, including the t=0 clamp.
      if (expiration !== p.auth.created_at + BLOB_DELETE_RETRY_SECONDS + 1 || p.until !== expiration) throw Error()
    }
    return parsed as PendingDelete[]
  } catch { throw new Error('Saved file deletions could not be verified; the journal was retained.') }
}

/** The delete URLs marked as group deletes, validated whole. Throws on anything else. */
export function readGroupDeleteMarks(raw: string | null): string[] {
  if (raw === null) return []
  try {
    ordinaryUtf8Length(raw)
    const parsed: unknown = JSON.parse(raw)
    if (JSON.stringify(parsed) !== raw || !Array.isArray(parsed) || !parsed.length || parsed.length > MAX_PENDING ||
        new Set(parsed).size !== parsed.length || parsed.some(u => typeof u !== 'string' || u.length > 2048 || !/^https:\/\//.test(u))) throw Error()
    return parsed as string[]
  } catch { throw new Error('Saved group file deletions could not be verified; the list was retained.') }
}

/** The marks, or none: they only decide how a delete's outcome is read, so a damaged list never holds a delete up. */
function groupMarks(store: DeviceStore): Set<string> {
  try { return new Set(readGroupDeleteMarks(store.get(PENDING_GROUP_DELETES_KEY))) } catch { return new Set() }
}

/** Keep the marks of deletes still in the journal, and no others. */
function writeGroupMarks(store: DeviceStore, marks: Iterable<string>, pending: readonly PendingDelete[]): void {
  try {
    const live = new Set(pending.map(p => p.url))
    const kept = [...new Set(marks)].filter(url => live.has(url)).sort()
    if (kept.length) store.set(PENDING_GROUP_DELETES_KEY, JSON.stringify(kept)); else store.remove(PENDING_GROUP_DELETES_KEY)
  } catch { /* Read as a plain delete next time, which fails to confirm and is tried again. */ }
}

/** Whether a delete URL is exactly `<base>/<hash>` for one of a room's group nodes. */
export function isGroupDeleteUrl(url: string, sha256: string, bases: readonly string[]): boolean {
  return bases.some(base => url === `${base}/${sha256.toLowerCase()}`)
}

function writePending(store: DeviceStore, pending: PendingDelete[]): void {
  if (pending.length > MAX_PENDING) throw new Error('File deletion retry journal is full; existing entries were retained.')
  const raw = pending.length ? JSON.stringify(pending) : null
  if (raw !== null) {
    ordinaryUtf8Length(raw)
    // Apply the same complete parser to the actual bytes about to be stored.
    readPendingBlobDeleteJournal(raw)
    store.set(PENDING_BLOB_DELETES_KEY, raw)
  } else store.remove(PENDING_BLOB_DELETES_KEY)
  if (store.get(PENDING_BLOB_DELETES_KEY) !== raw) throw new Error('File deletion retry journal could not be saved and verified.')
}

function validClock(now: () => number): number {
  const n = now()
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('File deletion retry needs a valid clock.')
  return n
}

/** A damaged or legacy journal is a hold, never a zero-pending status. */
export function pendingBlobDeletes(store: DeviceStore, now: number): number {
  validClock(() => now)
  return readPendingBlobDeleteJournal(store.get(PENDING_BLOB_DELETES_KEY)).filter(p => p.until > now).length
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

/** Where a room's group deletes go, and how one is confirmed. */
export interface GroupDeletes {
  /** The room's listed node bases. A delete URL exactly `<base>/<hash>` is a group delete. */
  bases: readonly string[]
  /** An authenticated read of the blob, while this device still holds the room's key and a `get` grant. Without it the node's acceptance decides, and is reported as unconfirmed. */
  confirm?: (url: string, sha256: string) => Promise<HeadOutcome>
}

interface Sender {
  fetch?: typeof fetch
  timeoutMs?: number
  /** The room's group nodes, for a tidy-up that has them. A retry at a later launch has none, and reads the marks. */
  groups?: GroupDeletes
}

type DeleteOutcome = BlobDeleteOutcome | GroupBlobDeleteOutcome

/** Send one delete, unless its host was already found unreachable in this
 *  run: then it is not tried again until the next. A group delete is read
 *  by `deleteGroupBlob`, which does not mistake a node's `401` for failure. */
async function send(url: string, auth: Event, unreachable: Set<string>, opts: Sender, group = false): Promise<DeleteOutcome> {
  const host = hostOf(url)
  if (unreachable.has(host)) return { status: 'failed', detail: `Could not reach ${host}.` }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? BLOB_DELETE_TIMEOUT_MS)
  const outcome: DeleteOutcome = group
    ? await deleteGroupBlob(url, auth, { ...(opts.fetch ? { fetch: opts.fetch } : {}), signal, ...(opts.groups?.confirm ? { confirm: opts.groups.confirm } : {}) })
    : await deleteBlob(url, auth, { ...(opts.fetch ? { fetch: opts.fetch } : {}), signal })
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
  /** Where a delete may go: the origins this device recorded uploading to for
   *  the room, and the one it uploads to now (`uploadOrigins`). */
  origins: readonly string[]
  /** Historical own-device announcements, verified here before exact-target use. */
  signedUploads?: readonly Event[]
  /** The room's device key, which signed the uploads. */
  sk: Uint8Array
  now: () => number
  /** Where a delete that did not go through is kept for another try. */
  store: DeviceStore
}

/** Ask for every file in `blobs` to be deleted, keeping those that were
 *  not for another try. Never throws for a server's answer. */
export async function deleteUploads(opts: DeleteUploadsOptions): Promise<FileDeletionReport> {
  const existing = readPendingBlobDeleteJournal(opts.store.get(PENDING_BLOB_DELETES_KEY))
  const now = validClock(opts.now)
  const provenance = new Set(uploadsFromEvents(opts.signedUploads ?? [], getPublicKey(opts.sk)).map(b => JSON.stringify([b.url, b.sha256])))
  const distinct = new Map<string, UploadedBlob>()
  for (const blob of opts.blobs) distinct.set(JSON.stringify([blob.url, blob.sha256]), blob)
  const report: FileDeletionReport = { found: distinct.size, deleted: 0, refused: 0, pending: 0, details: [] }
  const targets = new Map<string, UploadedBlob>()
  for (const blob of distinct.values()) {
    let url = blobDeleteUrl(blob.url, blob.sha256, opts.origins)
    if (!url && provenance.has(JSON.stringify([blob.url, blob.sha256]))) {
      url = blobDeleteUrl(blob.url, blob.sha256, [new URL(blob.url).origin])
    }
    if (url) targets.set(url, { url, sha256: blob.sha256.toLowerCase() })
    else report.refused++
  }
  report.found = targets.size + report.refused
  if (!targets.size) return report
  if (existing.filter(p => !targets.has(p.url)).length + targets.size > MAX_PENDING) {
    throw new Error('File deletion retry journal is full; existing entries were retained.')
  }
  const groupBases = opts.groups?.bases ?? []
  const groupTargets = new Set([...targets.values()].filter(target => isGroupDeleteUrl(target.url, target.sha256, groupBases)).map(target => target.url))
  const retry: PendingDelete[] = [...targets.values()].map(target => {
    const auth = finalizeEvent(buildDeleteAuthorisation(target.sha256, new URL(target.url).origin, now, BLOB_DELETE_RETRY_SECONDS + 1, target.url), opts.sk)
    const prior = existing.find(p => p.url === target.url)
    if (prior && prior.auth.pubkey !== auth.pubkey) throw new Error('File deletion target has a different retained uploader; existing permission was retained.')
    return { ...target, auth, until: Number(auth.tags.find(t => t[0] === 'expiration')![1]) }
  })
  // All permissions, including the worst-case byte/count capacity, must be
  // saved and read back before the first request. No lost keys after quota failure.
  const kept = [...existing.filter(p => !targets.has(p.url)), ...retry]
  writePending(opts.store, kept)
  // Marked before the first request, with the permissions, so a delete that is cut off is still read as a group's when it is retried.
  const marks = groupMarks(opts.store)
  for (const url of groupTargets) marks.add(url)
  writeGroupMarks(opts.store, marks, kept)
  const unreachable = new Set<string>()
  const left = new Map<string, { count: number; detail: string }>()
  const done = new Set<string>()
  const unconfirmed = new Set<string>()
  await inParallel(retry, async target => {
    const outcome: DeleteOutcome = target.until > validClock(opts.now)
      ? await send(target.url, target.auth, unreachable, opts, marks.has(target.url))
      : { status: 'failed' as const, detail: 'File deletion permission expired before sending.' }
    if (outcome.status === 'deleted') {
      report.deleted++; done.add(JSON.stringify(target))
      if ('detail' in outcome && outcome.detail) unconfirmed.add(outcome.detail)
      return
    }
    const host = hostOf(target.url)
    left.set(host, { count: (left.get(host)?.count ?? 0) + 1, detail: outcome.detail })
  })
  if (done.size) {
    const after = readPendingBlobDeleteJournal(opts.store.get(PENDING_BLOB_DELETES_KEY)).filter(p => !done.has(JSON.stringify(p)))
    writePending(opts.store, after)
    writeGroupMarks(opts.store, marks, after)
  }
  report.pending = retry.length - report.deleted
  for (const [host, { count, detail }] of [...left].sort(([a], [b]) => a < b ? -1 : 1)) {
    report.details.push(`${count} on ${host}: ${detail}`)
  }
  // The node took the delete but this device could not look afterwards: said, not hidden.
  for (const detail of [...unconfirmed].sort()) report.details.push(detail)
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
    const clock = () => validClock(now)
    clock()
    const due = readPendingBlobDeleteJournal(store.get(PENDING_BLOB_DELETES_KEY)).filter(p => p.until > clock() && isDeleteAuthorisation(p.auth, p.sha256, clock()))
    const marks = groupMarks(store)
    const done = new Set<string>()
    const unreachable = new Set<string>()
    await inParallel(due, async p => {
      if (p.until <= clock() || !isDeleteAuthorisation(p.auth, p.sha256, clock())) return
      if ((await send(p.url, p.auth, unreachable, opts, marks.has(p.url))).status === 'deleted') done.add(JSON.stringify(p))
    })
    // Read again: a tidy-up may have added to the list meanwhile.
    const after = readPendingBlobDeleteJournal(store.get(PENDING_BLOB_DELETES_KEY))
      .filter(p => !done.has(JSON.stringify(p)) && p.until > clock() && isDeleteAuthorisation(p.auth, p.sha256, clock()))
    writePending(store, after)
    writeGroupMarks(store, marks, after)
    return after.length
  })().finally(() => { retrying = undefined })
  return retrying
}
