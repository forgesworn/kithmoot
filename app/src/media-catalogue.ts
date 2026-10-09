import { ORIGINAL_ART } from './original-art-data.js'
import type { ChatArtwork } from '../../src/artwork.js'

export interface CatalogueImage { slug: string; name: string; url: string; preview: string; type: 'image/gif' | 'image/png'; bytes: number; sha256: string }
const localURL = (slug: string, extension: string): string => `${import.meta.env.BASE_URL}chat-art/${slug}.${extension}`
export const ORIGINAL_ART_PACK = 'kithmoot-original-v1'

/** Received references never supply a URL: only an exact bundled entry resolves. */
export function resolveCatalogueArtwork(reference: ChatArtwork): CatalogueImage | undefined {
  if (reference.pack !== ORIGINAL_ART_PACK || !['sticker', 'gif'].includes(reference.kind)) return undefined
  const art = ORIGINAL_ART.find(item => item.slug === reference.id)
  if (!art || (reference.kind === 'gif' && !art.animated)) return undefined
  const extension = reference.kind === 'gif' ? 'gif' : 'png'
  if (reference.sha256 !== art[extension].sha256) return undefined
  return { slug: art.slug, name: `${art.title}.${extension}`, url: localURL(art.slug, extension),
    preview: extension === 'gif' ? `${import.meta.env.BASE_URL}chat-art/${art.animationPreview}` : localURL(art.slug, 'png'),
    type: extension === 'gif' ? 'image/gif' : 'image/png', bytes: art[extension].bytes, sha256: art[extension].sha256 }
}

/** Choosing built-in artwork stages metadata, without opening or uploading a file. */
export function catalogueArtwork(item: CatalogueImage): ChatArtwork {
  const reference: ChatArtwork = { pack: ORIGINAL_ART_PACK, id: item.slug, kind: item.type === 'image/gif' ? 'gif' : 'sticker', sha256: item.sha256, label: item.name.replace(/\.(gif|png)$/i, '') }
  const known = resolveCatalogueArtwork(reference)
  if (!known || item.url !== known.url || item.preview !== known.preview || item.bytes !== known.bytes || item.name !== known.name || item.type !== known.type) throw new Error('Unknown artwork file.')
  return reference
}

/** Searching the bundled artwork does not make a network request. */
export async function searchMediaCatalogue(query: string, stickers: boolean, signal: AbortSignal): Promise<CatalogueImage[]> {
  signal.throwIfAborted()
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const extension = stickers ? 'png' : 'gif'
  return ORIGINAL_ART.filter(item => (stickers || item.animated) && words.every(word => `${item.title} ${item.keywords} ${item.caption}`.toLocaleLowerCase().includes(word))).map(item => ({
    slug: item.slug, name: `${item.title}.${extension}`, url: localURL(item.slug, extension), preview: !stickers ? `${import.meta.env.BASE_URL}chat-art/${item.animationPreview}` : localURL(item.slug, 'png'),
    type: stickers ? 'image/png' : 'image/gif', bytes: item[extension].bytes, sha256: item[extension].sha256,
  }))
}
