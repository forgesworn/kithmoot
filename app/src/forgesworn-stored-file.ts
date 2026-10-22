import { isForgeSwornHost } from '../../src/forgesworn-hosts.js'

/** True when a blob URL points at one of ForgeSworn's own hosts. Display only. */
export function isForgeSwornStoredFile(blobUrl: string | undefined): boolean {
  if (!blobUrl) return false
  try { return isForgeSwornHost(new URL(blobUrl).origin) } catch { return false }
}

/** The note under an attachment that was held on ForgeSworn's server, which
 *  stopped serving files on 22 October 2026; undefined for any other file.
 *  Same wording as Android 0.6.103. */
export function forgeSwornStorageNotice(blobUrl: string | undefined): string | undefined {
  if (!isForgeSwornStoredFile(blobUrl)) return undefined
  return `This file is no longer on ${new URL(blobUrl!).host}.`
}
