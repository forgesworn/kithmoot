export interface LocalImageSource {
  fallbackUrl: string
  displayUrl?: string
  srcset?: string
  sizes?: string
}

const clearRecoveries = new WeakMap<HTMLImageElement, () => void>()

export function setLocalImage(image: HTMLImageElement, source: LocalImageSource): HTMLImageElement {
  clearRecoveries.get(image)?.()
  image.removeAttribute('srcset')
  image.removeAttribute('sizes')
  const candidates = source.srcset ?? source.displayUrl
  if (!candidates) {
    image.src = source.fallbackUrl
    return image
  }
  const recover = () => {
    image.removeAttribute('srcset')
    image.removeAttribute('sizes')
    image.src = source.fallbackUrl
    clearRecoveries.delete(image)
  }
  image.addEventListener('error', recover, { once: true })
  clearRecoveries.set(image, () => {
    image.removeEventListener('error', recover)
    clearRecoveries.delete(image)
  })
  if (source.sizes) image.sizes = source.sizes
  image.srcset = candidates
  image.src = source.fallbackUrl
  return image
}
