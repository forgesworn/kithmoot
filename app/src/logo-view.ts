import { logoDataUrl, type LogoImage } from '../../src/logo-image.js'
const shown = new WeakMap<HTMLElement, string>()

/** Display a private inline image only. Names stay in the caller's adjacent
 * text, and failure restores initials without a network fallback. */
export function renderLogo(container: HTMLElement, image: LogoImage | null | undefined, name: string): void {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?'
  const source = logoDataUrl(image), identity = `${initial}:${source ?? ''}`
  if (shown.get(container) === identity && container.childNodes.length > 0) return
  shown.set(container, identity)
  container.replaceChildren(document.createTextNode(initial))
  container.setAttribute('aria-hidden', 'true')
  if (!source) return
  const picture = document.createElement('img')
  picture.alt = ''; picture.decoding = 'async'; picture.src = source
  picture.addEventListener('error', () => picture.remove(), { once: true })
  container.append(picture)
}
