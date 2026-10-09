import { artworkFallbackText, type ChatArtwork } from '../../src/artwork.js'
import { resolveCatalogueArtwork } from './media-catalogue.js'
import './chat-artwork.css'

/** Keep captions, and hide only our exact generated fallback when all artwork resolves. */
export function artworkMessageText(text: string, artwork: readonly ChatArtwork[] = []): string {
  return artwork.length && artwork.every(reference => resolveCatalogueArtwork(reference)) && text === artworkFallbackText(artwork) ? '' : text
}

/** Every image URL comes from the compiled catalogue; unknown references remain text. */
export function artworkCards(artwork: readonly ChatArtwork[] = [], expand?: (file: { url: string; name: string }, trigger: HTMLElement) => void, text = ''): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const reference of artwork) {
    const item = resolveCatalogueArtwork(reference)
    if (!item) {
      if (text === artworkFallbackText(artwork)) continue
      const fallback = document.createElement('span'); fallback.className = 'chatArtworkFallback'; fallback.textContent = artworkFallbackText([reference]); fragment.append(fallback)
      continue
    }
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    const url = reducedMotion ? item.preview : item.url
    const card = document.createElement('span'); card.className = 'chatArtwork'; card.dataset.artworkId = reference.id; card.dataset.artworkKind = reference.kind
    const image = document.createElement('img'); image.src = url; image.alt = `${reference.kind === 'gif' ? 'GIF' : 'Sticker'}: ${item.name.replace(/\.(gif|png)$/i, '')}`; image.width = 160; image.height = 160; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'
    if (expand) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-label', `Expand ${item.name}`); button.append(image)
      button.onclick = event => { event.stopPropagation(); expand({ url: new URL(url, document.baseURI).href, name: item.name }, button) }; card.append(button)
    } else card.append(image)
    fragment.append(card)
  }
  return fragment
}
