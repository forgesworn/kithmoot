/**
 * Sealed files waiting for a group's storage to take them (phase S5b).
 *
 * A file dropped into a room that keeps its files on the group's own computers
 * is sealed here first. When no computer will take it yet (this device has no
 * grant, or every node is down), the sealed bytes wait in this page's memory,
 * and the message that names them waits in the outbox until one does. Nothing
 * here is written to the device: a held file is lost with the page, which is
 * why the outbox warns before the page unloads. Durable custody of a sealed
 * file would be its own step.
 *
 * No DOM. The envelope is a Blob that may sit on disk (OPFS) under a dispose
 * hook; an entry is disposed the moment nothing refers to it.
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

  /** Hold a sealed file under its hash. A file already held under it is not replaced: the new bytes are the same file, so the newer backing is freed. */
  async hold(sha256: string, entry: HeldEnvelope): Promise<void> {
    const key = sha256.toLowerCase()
    if (this.#held.has(key)) { await this.#free(entry); return }
    this.#held.set(key, entry)
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
