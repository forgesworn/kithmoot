import { ORIGINAL_ART } from './original-art-data.js'

export interface CatalogueImage { slug: string; name: string; url: string; preview: string; type: 'image/gif' | 'image/png'; bytes: number; sha256: string }
const MAX_BYTES = 8 * 1024 * 1024
const localURL = (slug: string, extension: string): string => `${import.meta.env.BASE_URL}chat-art/${slug}.${extension}`

/** Searching the bundled artwork does not make a network request. */
export async function searchMediaCatalogue(query: string, stickers: boolean, signal: AbortSignal): Promise<CatalogueImage[]> {
  signal.throwIfAborted()
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const extension = stickers ? 'png' : 'gif'
  return ORIGINAL_ART.filter(item => words.every(word => `${item.title} ${item.keywords} ${item.caption}`.toLocaleLowerCase().includes(word))).map(item => ({
    slug: item.slug, name: `${item.title}.${extension}`, url: localURL(item.slug, extension), preview: localURL(item.slug, 'png'),
    type: stickers ? 'image/png' : 'image/gif', bytes: item[extension].bytes, sha256: item[extension].sha256,
  }))
}

/** Only an exact bundled file can enter the existing encrypted attachment flow. */
export async function downloadCatalogueImage(item: CatalogueImage, signal: AbortSignal): Promise<File> {
  const art = ORIGINAL_ART.find(art => art.slug === item.slug)
  const extension = item.type === 'image/gif' ? 'gif' : 'png'
  if (!art || item.url !== localURL(art.slug, extension) || item.bytes !== art[extension].bytes || item.sha256 !== art[extension].sha256) throw new Error('Unknown artwork file.')
  const response = await fetch(item.url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'force-cache', signal })
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('This artwork could not be opened.')
  const reader = response.body?.getReader(); if (!reader) throw new Error('The artwork has no data.')
  const chunks: Uint8Array<ArrayBuffer>[] = []; let length = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_BYTES) throw new Error('The artwork is too large.'); chunks.push(part.value.slice()) } } finally { await reader.cancel() }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
  if (length !== item.bytes || hash !== item.sha256) throw new Error('The artwork file does not match this version of KithMoot.')
  return new File([bytes], `${art.title}.${extension}`, { type: item.type })
}
