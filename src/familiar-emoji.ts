import { FAMILIAR_ART, FAMILIAR_DRAWINGS } from './familiar-art-data.js'
export { FAMILIAR_ART, FORGEMOJI_SOURCE } from './familiar-art-data.js'

export const HUMAN_SKIN_TONES = ['', '🏻', '🏼', '🏽', '🏾', '🏿'] as const
const canonical = (emoji: string): string => emoji.replaceAll('\uFE0F', '')
const drawings = new Map<string, string>(FAMILIAR_DRAWINGS.map(item => [canonical(item.emoji), item.file]))
const definitions = new Map<string, (typeof FAMILIAR_ART)[number]>(FAMILIAR_ART.map(item => [canonical(item.emoji), item]))

/** Preserve standard Unicode meanings, including explicitly chosen human skin tones. */
export function withSkinTone(emoji: string, tone: number): string {
  if (!Number.isInteger(tone) || tone < 0 || tone >= HUMAN_SKIN_TONES.length) throw new RangeError('Unknown skin tone')
  return tone && definitions.get(canonical(emoji))?.toneable ? canonical(emoji) + HUMAN_SKIN_TONES[tone] : emoji
}
export function familiarArtwork(emoji: string): string | undefined { return drawings.get(canonical(emoji)) }
export function isFamiliarEmoji(value: unknown): value is string { return typeof value === 'string' && drawings.has(canonical(value)) }
export const FAMILIAR_SHORTCODES: readonly string[] = FAMILIAR_ART.map(item => item.emoji).filter(emoji => /^:fs_[a-z0-9_]+:$/.test(emoji))
export function familiarLabel(emoji: string): string | undefined { return definitions.get(canonical(emoji).replace(/[\u{1F3FB}-\u{1F3FF}]/u, ''))?.title }

/** Match complete graphemes: unfamiliar ZWJ sequences and other variants remain untouched. */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })
export function familiarTextParts(text: string): { text: string; artwork?: string }[] {
  const parts: { text: string; artwork?: string }[] = []
  const chunks = FAMILIAR_SHORTCODES.length ? text.split(new RegExp(`(${FAMILIAR_SHORTCODES.join('|')})`, 'g')) : [text]
  for (const chunk of chunks) {
    if (FAMILIAR_SHORTCODES.includes(chunk)) { parts.push({ text: chunk, artwork: familiarArtwork(chunk)! }); continue }
    for (const { segment } of graphemes.segment(chunk)) {
      const artwork = familiarArtwork(segment)
      if (artwork) parts.push({ text: segment, artwork })
      else if (parts.length && !parts[parts.length - 1]!.artwork) parts[parts.length - 1]!.text += segment
      else parts.push({ text: segment })
    }
  }
  return parts
}
