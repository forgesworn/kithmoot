import { isForgeSwornHost } from '../../src/forgesworn-hosts.js'

/** The day files held on ForgeSworn's own server stop being kept: the start
 *  of 23 October 2026, UTC. The one place the date lives. */
export const FORGESWORN_STORAGE_ENDS_ON = '2026-10-23'
export const FORGESWORN_STORAGE_ENDS_AT_MS = Date.parse(`${FORGESWORN_STORAGE_ENDS_ON}T00:00:00Z`)

/** True when a blob URL points at one of ForgeSworn's own hosts. Display only. */
export function isForgeSwornStoredFile(blobUrl: string | undefined): boolean {
  if (!blobUrl) return false
  try { return isForgeSwornHost(new URL(blobUrl).origin) } catch { return false }
}

export function forgeSwornStorageEnded(now: number = Date.now()): boolean {
  return now >= FORGESWORN_STORAGE_ENDS_AT_MS
}

/** The warning under an attachment held on ForgeSworn's server, or undefined
 *  for any other file, or once the date has passed. */
export function forgeSwornStorageNotice(blobUrl: string | undefined, now: number = Date.now()): string | undefined {
  if (!isForgeSwornStoredFile(blobUrl) || forgeSwornStorageEnded(now)) return undefined
  const host = new URL(blobUrl!).host
  return `This file is stored on ${host}, which stops keeping files on 23 October. Save it now if you want to keep it.`
}
