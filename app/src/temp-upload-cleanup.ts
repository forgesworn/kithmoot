/**
 * Sealed files a page left behind.
 *
 * In Chromium a file being sealed for upload sits in the origin's private file
 * system as `.kithmoot-upload-<hex>.wbenc`, so a large one does not fill the
 * page's heap (`packages/context`, `temporaryEnvelopeStore`). It is removed when
 * its upload settles. A page that is closed or crashes with one still held (a
 * file waiting for a group's storage, say) leaves it there, and nothing else
 * would ever remove it.
 *
 * Removed here at start, but only once it is old: another tab of this origin may
 * be holding a file this very hour, and a held file belongs to the page that
 * holds it. A week is longer than a person leaves a message waiting in one tab
 * without anything touching it. Best effort, and silent: a file that will not go
 * is left for the next start.
 *
 * Structural types, as the package that writes these files uses, so it runs
 * where the DOM declarations predate the file system access API.
 */

export const TEMPORARY_UPLOAD_PATTERN = /^\.kithmoot-upload-[0-9a-f]{32}\.wbenc$/
/** How old a leftover file must be before it is nobody's. */
export const TEMPORARY_UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface Entry { kind: string; getFile?(): Promise<{ lastModified: number }> }
interface Directory {
  entries(): AsyncIterable<[string, Entry]>
  removeEntry(name: string): Promise<void>
}

/** How many leftover files were removed. */
export async function removeStaleTemporaryUploads(directory: Directory, now: number, maxAgeMs = TEMPORARY_UPLOAD_MAX_AGE_MS): Promise<number> {
  let removed = 0
  const stale: string[] = []
  try {
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind !== 'file' || !TEMPORARY_UPLOAD_PATTERN.test(name) || !entry.getFile) continue
      try {
        const file = await entry.getFile()
        if (now - file.lastModified >= maxAgeMs) stale.push(name)
      } catch { /* Gone already, or not readable: not ours to judge. */ }
    }
  } catch { return 0 }
  for (const name of stale) {
    try { await directory.removeEntry(name); removed++ } catch { /* Held open elsewhere, or already gone: left for the next start. */ }
  }
  return removed
}

/** The browser's own private file system, when it has one. */
export async function removeStaleTemporaryUploadsHere(now: number = Date.now()): Promise<number> {
  try {
    const storage = (globalThis as unknown as { navigator?: { storage?: { getDirectory?: () => Promise<Directory> } } }).navigator?.storage
    if (!storage?.getDirectory) return 0
    return await removeStaleTemporaryUploads(await storage.getDirectory(), now)
  } catch { return 0 }
}
