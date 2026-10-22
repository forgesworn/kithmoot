/**
 * Sealed files waiting for a group's storage to take them (phase S5b).
 *
 * A file dropped into a room that keeps its files on the group's own computers
 * is sealed here first. When no computer will take it yet (this device has no
 * grant, or every node is down), the sealed bytes wait in this page, and the
 * message that names them waits in the outbox until one does.
 *
 * What is held is a handle to the sealed bytes, not a copy this module keeps
 * safe. In Chromium the bytes are a temporary file in the origin's private
 * file system (`.kithmoot-upload-*.wbenc`), so they use disk, not the page's
 * heap, and a page that closes or crashes leaves that file behind: the person
 * loses the held file with the page (which is why the outbox warns before it
 * unloads), and `temp-upload-cleanup.ts` removes what such a page left on a
 * later start. Nothing here puts a sealed file anywhere a later visit can read
 * it back as the file. Durable custody of a sealed file would be its own step.
 *
 * A file lives exactly as long as something refers to it: a draft in any room
 * of this tab that still has it as an attachment, or a message in the outbox
 * that can still go (`sweep`). Nothing else decides that, so leaving a room
 * with a file waiting in its draft does not lose the file.
 *
 * No DOM. An entry is disposed the moment nothing refers to it.
 */

export type HeldReason = 'no-grant' | 'unreachable' | 'refused'

export interface HeldEnvelope {
  roomId: string
  /** The sealed bytes, as they hash to the key this entry is held under. */
  envelope: Blob
  /** Frees whatever backs `envelope`. Called once. */
  dispose?: () => Promise<void> | void
  /** Why no node took it, for the tray's words. */
  reason: HeldReason
  /** The message that names this file, once it has been sent from the draft. */
  messageId?: string
}

export class HeldEnvelopes {
  readonly #held = new Map<string, HeldEnvelope>()

  get size(): number { return this.#held.size }

  has(sha256: string): boolean { return this.#held.has(sha256.toLowerCase()) }

  get(sha256: string): HeldEnvelope | undefined { return this.#held.get(sha256.toLowerCase()) }

  /**
   * Hold a sealed file under its hash, at once. A caller stages the attachment
   * that names it before it awaits anything, so a sweep can never meet the file
   * between being held and being owned. False when a file is already held under
   * the hash (the new bytes are the same file): nothing is replaced, and the
   * caller frees its own copy.
   */
  add(sha256: string, entry: HeldEnvelope): boolean {
    const key = sha256.toLowerCase()
    if (this.#held.has(key)) return false
    this.#held.set(key, entry)
    return true
  }

  /** `add`, freeing the copy offered when a file is already held under the hash. */
  async hold(sha256: string, entry: HeldEnvelope): Promise<void> {
    if (!this.add(sha256, entry)) await this.#free(entry)
  }

  /** The message now carries these files: from here its fate decides theirs. */
  attach(hashes: Iterable<string>, messageId: string): void {
    for (const hash of hashes) {
      const entry = this.#held.get(hash.toLowerCase())
      if (entry) entry.messageId = messageId
    }
  }

  /** Let go of one file, whether a node took it or the person did not want it. */
  async release(sha256: string): Promise<void> {
    const key = sha256.toLowerCase()
    const entry = this.#held.get(key)
    if (!entry) return
    this.#held.delete(key)
    await this.#free(entry)
  }

  /**
   * Free everything nothing refers to: a file is kept while a draft still has it
   * as an attachment, or while the message that names it is in the outbox and
   * can still go. A message that moved to another key can never go, so its
   * files are not kept for it.
   */
  async sweep(live: { draftHashes: ReadonlySet<string>; messageIds: ReadonlySet<string> }): Promise<void> {
    const gone: [string, HeldEnvelope][] = []
    for (const [hash, entry] of this.#held) {
      if (live.draftHashes.has(hash)) continue
      if (entry.messageId !== undefined && live.messageIds.has(entry.messageId)) continue
      gone.push([hash, entry])
    }
    for (const [hash] of gone) this.#held.delete(hash)
    await Promise.all(gone.map(([, entry]) => this.#free(entry)))
  }

  /** Free every file held for a room, or for all rooms. */
  async clear(roomId?: string): Promise<void> {
    const gone = [...this.#held].filter(([, entry]) => roomId === undefined || entry.roomId === roomId)
    for (const [hash] of gone) this.#held.delete(hash)
    await Promise.all(gone.map(([, entry]) => this.#free(entry)))
  }

  async #free(entry: HeldEnvelope): Promise<void> {
    try { await entry.dispose?.() } catch { /* A temporary file that will not go is not a reason to keep the bytes. */ }
  }
}

/**
 * The staged attachments that were waiting for a group's storage and whose
 * sealed files are no longer held here. A message must not be sent with one: it
 * would name a file no computer has.
 */
export function lostAttachments<T extends { sha256: string }>(attachments: readonly T[], waiting: { has(attachment: T): boolean }, held: { has(sha256: string): boolean }): T[] {
  return attachments.filter(attachment => waiting.has(attachment) && !held.has(attachment.sha256))
}

