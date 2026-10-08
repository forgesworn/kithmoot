export interface CatalogueImage { name: string; url: string; type: 'image/gif' | 'image/png' | 'image/webp'; bytes: number; source: string; credit: string }
const MAX_BYTES = 8 * 1024 * 1024
function plain(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
}
export function commonsImageURL(value: unknown): string | undefined {
  try { const url = new URL(String(value)); if (url.protocol !== 'https:' || url.hostname !== 'upload.wikimedia.org' || !url.pathname.startsWith('/wikipedia/commons/') || url.username || url.password) return; url.search = ''; url.hash = ''; return url.href } catch { return }
}
export function catalogueResults(data: unknown): CatalogueImage[] {
  if (!data || typeof data !== 'object') return []
  const pages = (data as { query?: { pages?: Record<string, unknown> } }).query?.pages
  if (!pages || typeof pages !== 'object') return []
  const results: CatalogueImage[] = []
  for (const value of Object.values(pages).slice(0, 24)) {
    const page = value as { title?: string; imageinfo?: { url?: string; mime?: string; size?: number; width?: number; height?: number; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }[] }
    const info = page?.imageinfo?.[0]; if (!info) continue
    const url = commonsImageURL(info.url)
    if (!url || !['image/gif', 'image/png', 'image/webp'].includes(info.mime ?? '') || !Number.isSafeInteger(info.size) || info.size! <= 0 || info.size! > MAX_BYTES || !info.width || !info.height || info.width > 8192 || info.height > 8192 || info.width * info.height > 16_000_000) continue
    const source = info.descriptionurl
    if (!source?.startsWith('https://commons.wikimedia.org/wiki/File:')) continue
    const license = plain(info.extmetadata?.LicenseShortName?.value)
    if (!/^(CC0|Public domain|CC BY(?:-SA)?(?: \d\.\d)?)$/i.test(license)) continue
    const name = plain(page.title?.replace(/^File:/, ''))
    const artist = plain(info.extmetadata?.Artist?.value)
    results.push({ name, url, type: info.mime as CatalogueImage['type'], bytes: info.size!, source, credit: `${artist || 'Wikimedia Commons'} · ${license}` })
  }
  return results
}
export async function searchMediaCatalogue(query: string, stickers: boolean, signal: AbortSignal): Promise<CatalogueImage[]> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.search = new URLSearchParams({ action: 'query', generator: 'search', gsrsearch: `${stickers ? 'filemime:image/png' : 'filemime:image/gif'} ${query.trim().slice(0, 80)}`, gsrnamespace: '6', gsrlimit: '18', prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', format: 'json', origin: '*' }).toString()
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal })
  if (!response.ok) throw new Error('The catalogue could not be reached. Try again.')
  const reader = response.body?.getReader(); if (!reader) throw new Error('The catalogue returned no data.')
  const chunks: Uint8Array[] = []; let length = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 1_000_000) throw new Error('The catalogue response is too large.'); chunks.push(part.value) } } finally { await reader.cancel() }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return catalogueResults(JSON.parse(new TextDecoder().decode(bytes)))
}
export async function downloadCatalogueImage(item: CatalogueImage, signal: AbortSignal): Promise<File> {
  if (commonsImageURL(item.url) !== item.url || item.bytes <= 0 || item.bytes > MAX_BYTES) throw new Error('Invalid catalogue file.')
  const response = await fetch(item.url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal })
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('The selected file could not be downloaded.')
  const reader = response.body?.getReader(); if (!reader) throw new Error('The selected file has no data.')
  const chunks: ArrayBuffer[] = []; let length = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_BYTES) throw new Error('The selected file exceeds 8 MiB.'); chunks.push(part.value.slice().buffer) } } finally { await reader.cancel() }
  if (!length) throw new Error('The selected file is empty.')
  return new File(chunks, item.name, { type: item.type })
}
