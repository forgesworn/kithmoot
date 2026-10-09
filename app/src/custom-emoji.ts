import { CULT_EMOJIS, isCultEmoji } from '../../src/custom-emoji.js'
import { ORIGINAL_EMOJIS, isOriginalEmoji } from '../../src/original-art.js'
const logo = new URL('./assets/600-original/600-cult-cutout.png', import.meta.url).href
const artwork: Record<string, string> = {
  ':600_facepalm:': new URL('./assets/600-original/600-facepalm.png', import.meta.url).href,
  ':600_moon:': new URL('./assets/600-original/600-moon.png', import.meta.url).href,
  ':600_laser:': new URL('./assets/600-original/600-laser.png', import.meta.url).href,
}
const accents: Record<string, string> = { ':600_moon:': '🚀', ':600_fire:': '🔥', ':600_facepalm:': '🤦', ':600_handshake:': '🤝', ':600_laser:': '⚡' }
export function emojiGlyph(emoji: string): HTMLElement {
  const glyph = document.createElement('span')
  if (isOriginalEmoji(emoji)) {
    glyph.className = 'cultEmoji originalEmoji'; glyph.setAttribute('role', 'img'); glyph.setAttribute('aria-label', ORIGINAL_EMOJIS.find(([code]) => code === emoji)![1])
    const image = document.createElement('img'); image.src = `${import.meta.env.BASE_URL}chat-art/${emoji.slice(4, -1)}.png`; image.alt = ''; image.width = 32; image.height = 32; glyph.append(image); return glyph
  }
  if (!isCultEmoji(emoji)) { glyph.textContent = emoji; return glyph }
  glyph.className = 'cultEmoji ' + emoji.slice(1, -1)
  glyph.setAttribute('role', 'img'); glyph.setAttribute('aria-label', CULT_EMOJIS.find(([code]) => code === emoji)![1])
  const image = document.createElement('img'); image.src = artwork[emoji] ?? logo; image.alt = ''; image.width = 32; image.height = 32
  glyph.append(image)
  if (accents[emoji] && !artwork[emoji]) { const accent = document.createElement('span'); accent.textContent = accents[emoji]; glyph.append(accent) }
  return glyph
}
/** Replace only known shortcodes in text nodes; links and received markup stay inert. */
export function paintCustomEmoji(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    if (node.parentElement?.closest('a')) continue
    const known = [...CULT_EMOJIS, ...ORIGINAL_EMOJIS].map(([code]) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const parts = node.data.split(new RegExp(`(${known.join('|')})`, 'g'))
    if (parts.length === 1) continue
    node.replaceWith(...parts.map(part => isCultEmoji(part) || isOriginalEmoji(part) ? emojiGlyph(part) : document.createTextNode(part)))
  }
}
