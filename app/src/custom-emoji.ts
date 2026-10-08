import { CULT_EMOJIS, isCultEmoji } from '../../src/custom-emoji.js'
const logo = new URL('./assets/600-original/600-cult-cutout.png', import.meta.url).href
const artwork: Record<string, string> = {
  ':600_facepalm:': new URL('./assets/600-original/600-facepalm.png', import.meta.url).href,
  ':600_moon:': new URL('./assets/600-original/600-moon.png', import.meta.url).href,
  ':600_laser:': new URL('./assets/600-original/600-laser.png', import.meta.url).href,
}
const accents: Record<string, string> = { ':600_moon:': '🚀', ':600_fire:': '🔥', ':600_facepalm:': '🤦', ':600_handshake:': '🤝', ':600_laser:': '⚡' }
export function emojiGlyph(emoji: string): HTMLElement {
  const glyph = document.createElement('span')
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
    const parts = node.data.split(/(:600(?:_spin|_rainbow|_moon|_fire|_facepalm|_handshake|_laser)?:)/g)
    if (parts.length === 1) continue
    node.replaceWith(...parts.map(part => isCultEmoji(part) ? emojiGlyph(part) : document.createTextNode(part)))
  }
}
