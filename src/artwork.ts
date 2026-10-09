/** A reference to artwork bundled with the recipient's app. Never a URL or
 * an uploaded file. Resolve only against a trusted local catalogue whose
 * pack, id, kind and byte hash all match. Unknown versions keep the text
 * fallback instead of fetching artwork supplied by a sender. */
export interface ChatArtwork {
  pack: string
  id: string
  kind: 'sticker' | 'gif'
  sha256: string
  label: string
}

export const MAX_CHAT_ARTWORK = 4
export const MAX_ARTWORK_LABEL_LENGTH = 80
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const HASH = /^[a-fA-F0-9]{64}$/

/** Canonicalise untrusted references without resolving or fetching them. */
export function normaliseArtwork(raw: unknown): ChatArtwork | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.pack !== 'string' || !SLUG.test(a.pack) ||
      typeof a.id !== 'string' || !SLUG.test(a.id) ||
      (a.kind !== 'sticker' && a.kind !== 'gif') ||
      typeof a.sha256 !== 'string' || !HASH.test(a.sha256) ||
      typeof a.label !== 'string') return null
  const label = a.label.replace(/\s+/gu, ' ').replace(/\p{C}/gu, '')
    .replace(/\s+/gu, ' ').trim()
  return {
    pack: a.pack, id: a.id, kind: a.kind, sha256: a.sha256.toLowerCase(),
    label: [...label].slice(0, MAX_ARTWORK_LABEL_LENGTH).join('').trim() || a.id,
  }
}

/** Sending invalid artwork is a caller error: do not silently discard it. */
export function normaliseOutgoingArtwork(raw: unknown): ChatArtwork[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('artwork must be a list of catalogue references')
  if (raw.length > MAX_CHAT_ARTWORK) throw new Error(`a message carries at most ${MAX_CHAT_ARTWORK} artwork references`)
  const artwork = raw.map(a => {
    const valid = normaliseArtwork(a)
    if (!valid) throw new Error('artwork is not a catalogue reference')
    return valid
  })
  return artwork.length ? artwork : undefined
}

/** Readable on clients which do not have this artwork or this protocol. */
export function artworkFallbackText(artwork: readonly ChatArtwork[]): string {
  return artwork.map(a => `${a.kind === 'gif' ? 'GIF' : 'Sticker'}: ${a.label}`).join('; ')
}
