import { logoDataUrl, type LogoImage } from '../../src/logo-image.js'
const shown = new WeakMap<HTMLElement, string>()
const requests = new WeakMap<HTMLElement, symbol>()
const decoded = new Map<string, Promise<boolean>>()
const MAX_DECODED_LOGOS = 128

/** Clear a hidden or unavailable logo and invalidate any unfinished decode. */
export function clearLogo(container: HTMLElement): void {
  requests.set(container, Symbol())
  shown.delete(container)
  container.replaceChildren()
}

/** An img can accept dimensions while its compressed pixels are invalid.
 * Validate a local bitmap, release it, and retain only a bounded verdict. */
function decodedLogo(image: LogoImage): Promise<boolean> {
  const known = decoded.get(image.sha256)
  if (known) return known
  const pending = (async () => {
    let bitmap: ImageBitmap | undefined
    try {
      const bytes = Uint8Array.from(atob(image.data), character => character.charCodeAt(0))
      bitmap = await createImageBitmap(new Blob([bytes], { type: image.mime }))
      if (bitmap.width !== image.width || bitmap.height !== image.height) return false
      // Some decoders recover a header-only image as transparent pixels.
      // An empty image has no useful logo; keep the visible initials.
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return false
      context.drawImage(bitmap, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      for (let at = 3; at < pixels.length; at += 4) if (pixels[at]! > 0) return true
      return false
    } catch { return false }
    finally { bitmap?.close() }
  })()
  decoded.set(image.sha256, pending)
  if (decoded.size > MAX_DECODED_LOGOS) decoded.delete(decoded.keys().next().value!)
  return pending
}

/** Display a private inline image only. Names stay in the caller's adjacent
 * text, and failure restores initials without a network fallback. */
export function renderLogo(container: HTMLElement, image: LogoImage | null | undefined, name: string): void {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?'
  const source = logoDataUrl(image), identity = `${initial}:${source ?? ''}`
  if (shown.get(container) === identity && container.childNodes.length > 0) return
  shown.set(container, identity)
  const request = Symbol()
  requests.set(container, request)
  container.replaceChildren(document.createTextNode(initial))
  container.setAttribute('aria-hidden', 'true')
  if (!source || !image) return
  void decodedLogo(image).then(valid => {
    if (!valid || requests.get(container) !== request) return
    const picture = document.createElement('img')
    picture.alt = ''; picture.decoding = 'async'; picture.src = source
    picture.addEventListener('error', () => picture.remove(), { once: true })
    container.append(picture)
  })
}
