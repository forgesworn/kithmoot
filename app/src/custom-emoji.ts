import { CULT_EMOJIS, isCultEmoji } from '../../src/custom-emoji.js'
import { ORIGINAL_EMOJIS, isOriginalEmoji } from '../../src/original-art.js'
import { familiarArtwork, familiarLabel, familiarTextParts } from '../../src/familiar-emoji.js'
import { setLocalImage } from './local-image.js'

export type EmojiDisplay = 'inline' | 'picker' | 'feedback' | 'sticker'
const DISPLAY_SIZE_PX: Record<EmojiDisplay, number> = { inline: 32, picker: 44, feedback: 72, sticker: 112 }
const CULT_THUMBNAILS: Record<string, { fallbackUrl: string; srcset: string }> = {
  '600-cult-cutout': {
    fallbackUrl: new URL('./assets/600-original/600-cult-cutout.png', import.meta.url).href,
    srcset: `${new URL('./assets/600-original/600-cult-cutout-64.webp', import.meta.url).href} 64w, ${new URL('./assets/600-original/600-cult-cutout-128.webp', import.meta.url).href} 128w, ${new URL('./assets/600-original/600-cult-cutout-256.webp', import.meta.url).href} 256w, ${new URL('./assets/600-original/600-cult-cutout-384.webp', import.meta.url).href} 384w`,
  },
  '600-facepalm': {
    fallbackUrl: new URL('./assets/600-original/600-facepalm.png', import.meta.url).href,
    srcset: `${new URL('./assets/600-original/600-facepalm-64.webp', import.meta.url).href} 64w, ${new URL('./assets/600-original/600-facepalm-128.webp', import.meta.url).href} 128w, ${new URL('./assets/600-original/600-facepalm-256.webp', import.meta.url).href} 256w, ${new URL('./assets/600-original/600-facepalm-384.webp', import.meta.url).href} 384w`,
  },
  '600-moon': {
    fallbackUrl: new URL('./assets/600-original/600-moon.png', import.meta.url).href,
    srcset: `${new URL('./assets/600-original/600-moon-64.webp', import.meta.url).href} 64w, ${new URL('./assets/600-original/600-moon-128.webp', import.meta.url).href} 128w, ${new URL('./assets/600-original/600-moon-256.webp', import.meta.url).href} 256w, ${new URL('./assets/600-original/600-moon-384.webp', import.meta.url).href} 384w`,
  },
  '600-laser': {
    fallbackUrl: new URL('./assets/600-original/600-laser.png', import.meta.url).href,
    srcset: `${new URL('./assets/600-original/600-laser-64.webp', import.meta.url).href} 64w, ${new URL('./assets/600-original/600-laser-128.webp', import.meta.url).href} 128w, ${new URL('./assets/600-original/600-laser-256.webp', import.meta.url).href} 256w, ${new URL('./assets/600-original/600-laser-384.webp', import.meta.url).href} 384w`,
  },
}
const IMAGE_NAMES: Record<string, string> = { ':600_facepalm:': '600-facepalm', ':600_moon:': '600-moon', ':600_laser:': '600-laser' }
const accents: Record<string, string> = { ':600_moon:': '🚀', ':600_fire:': '🔥', ':600_facepalm:': '🤦', ':600_handshake:': '🤝', ':600_laser:': '⚡' }
const known = [...CULT_EMOJIS, ...ORIGINAL_EMOJIS].map(([code]) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const customEmojiPattern = new RegExp(`(${known.join('|')})`, 'g')

function image600(name: string, display: EmojiDisplay): HTMLImageElement {
  const image = document.createElement('img')
  image.alt = ''
  image.width = 32
  image.height = 32
  image.loading = 'lazy'
  image.decoding = 'async'
  image.referrerPolicy = 'no-referrer'
  setLocalImage(image, { ...CULT_THUMBNAILS[name]!, sizes: `${DISPLAY_SIZE_PX[display]}px` })
  return image
}

export function emojiGlyph(emoji: string, display: EmojiDisplay = 'inline'): HTMLElement {
  const glyph = document.createElement('span')
  const familiar = familiarArtwork(emoji)
  if (familiar) {
    // Keep the Unicode text selectable and copyable beneath our local drawing.
    glyph.className = 'familiarEmoji'; glyph.textContent = emoji
    glyph.setAttribute('role', 'img'); glyph.setAttribute('aria-label', familiarLabel(emoji) ?? emoji)
    const image = document.createElement('img')
    image.alt = ''
    image.width = 32
    image.height = 32
    image.loading = 'lazy'
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    const fallbackUrl = `${import.meta.env.BASE_URL}emoji/${familiar}`
    setLocalImage(image, { fallbackUrl, displayUrl: familiar.endsWith('.png') ? `${import.meta.env.BASE_URL}emoji/${familiar.replace(/\.png$/, '.webp')}` : fallbackUrl })
    glyph.append(image)
    return glyph
  }
  if (isOriginalEmoji(emoji)) {
    glyph.className = 'cultEmoji originalEmoji'; glyph.setAttribute('role', 'img'); glyph.setAttribute('aria-label', ORIGINAL_EMOJIS.find(([code]) => code === emoji)![1])
    const slug = emoji.slice(4, -1)
    const image = document.createElement('img')
    image.alt = ''
    image.width = 32
    image.height = 32
    image.loading = 'lazy'
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    setLocalImage(image, { fallbackUrl: `${import.meta.env.BASE_URL}chat-art/${slug}.png`, displayUrl: `${import.meta.env.BASE_URL}chat-art/${slug}.webp` })
    glyph.append(image)
    return glyph
  }
  if (!isCultEmoji(emoji)) { glyph.textContent = emoji; return glyph }
  glyph.className = 'cultEmoji ' + emoji.slice(1, -1)
  glyph.setAttribute('role', 'img'); glyph.setAttribute('aria-label', CULT_EMOJIS.find(([code]) => code === emoji)![1])
  const name = IMAGE_NAMES[emoji]
  const image = name ? image600(name, display) : image600('600-cult-cutout', display)
  glyph.append(image)
  if (accents[emoji] && !IMAGE_NAMES[emoji]) { const accent = document.createElement('span'); accent.textContent = accents[emoji]; glyph.append(accent) }
  return glyph
}
/** Render known artwork without changing Unicode text, links or unsupported graphemes. */
export function paintCustomEmoji(container: HTMLElement, display: EmojiDisplay = 'inline'): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    if (node.parentElement?.closest('a, code, pre, .familiarEmoji, .cultEmoji')) continue
    const parts = node.data.split(customEmojiPattern)
    const rendered = parts.flatMap(part => isCultEmoji(part) || isOriginalEmoji(part)
      ? [emojiGlyph(part, display)]
      : familiarTextParts(part).map(item => item.artwork ? emojiGlyph(item.text, display) : document.createTextNode(item.text)))
    if (parts.length > 1 || rendered.some(item => item instanceof HTMLElement)) node.replaceWith(...rendered)
  }
}
