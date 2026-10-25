import { withSkinTone } from '../../src/familiar-emoji.js'

const toneKey = 'kithmoot:emoji:skinTone'

export function preferredSkinTone(): number {
  try { const value = Number(localStorage.getItem(toneKey)); return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 0 } catch { return 0 }
}

export function preferredReaction(emoji: string): string { return withSkinTone(emoji, preferredSkinTone()) }

export function setPreferredSkinTone(tone: number): void {
  if (!Number.isInteger(tone) || tone < 0 || tone > 5) throw new RangeError('Unknown skin tone')
  try { localStorage.setItem(toneKey, String(tone)) } catch { /* The current picker also works without storage. */ }
}
