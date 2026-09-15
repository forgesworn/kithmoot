import { normaliseBlossomServer } from '../../src/attachment.js'

export const FILE_STORAGE_KEY = 'kithmoot.file-storage.v1'
export const LEGACY_FILE_STORAGE_KEY = 'kithmoot.blossom-server'
export const FILE_STORAGE_REQUIRED = 'File uploads are off. Private Bothy storage is not connected in this app yet. To use shared storage instead, open Add a file and explicitly allow the displayed server.'
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** A URL is not proof of private storage. Only the explicit shared-storage
 * consent is implemented here; a Bothy adapter must authenticate reads too.
 * Never promote an old URL preference into consent or fall back to the host. */
export function sharedFileServer(store: Store): string {
  try {
    const value: unknown = JSON.parse(store.getItem(FILE_STORAGE_KEY) ?? 'null')
    if (!value || typeof value !== 'object') return ''
    const entry = value as Record<string, unknown>
    if (entry.mode !== 'shared' || entry.disclosure !== 1 || typeof entry.origin !== 'string') return ''
    const origin = normaliseBlossomServer(entry.origin)
    return origin === entry.origin ? origin : ''
  } catch { return '' }
}

export function requireSharedFileServer(store: Store): string {
  const origin = sharedFileServer(store)
  if (!origin) throw new Error(FILE_STORAGE_REQUIRED)
  return origin
}

export function allowSharedFileServer(store: Store, value: string, acknowledged: boolean): string {
  if (!acknowledged) throw new Error('Confirm that encrypted files may be publicly downloadable before allowing shared storage.')
  const origin = normaliseBlossomServer(value)
  store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: 1, origin }))
  return origin
}

export function stopFileUploads(store: Store): void {
  store.removeItem(FILE_STORAGE_KEY)
}

/** Display only. A previous destination is useful context, never authority. */
export function suggestedFileServer(store: Store, appOrigin: string): string {
  const approved = sharedFileServer(store)
  if (approved) return approved
  try { return normaliseBlossomServer(store.getItem(LEGACY_FILE_STORAGE_KEY) ?? appOrigin) }
  catch { return appOrigin }
}
