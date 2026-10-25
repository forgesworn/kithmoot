import { isCultEmoji } from './custom-emoji.js'
import { isOriginalEmoji } from './original-art.js'
import { isFamiliarEmoji } from './familiar-emoji.js'
import { REACTION_GLYPHS } from './reaction-emoji-data.js'

const valid = new Set(REACTION_GLYPHS.split(' '))

export function isReactionEmoji(value: unknown): value is string {
  return typeof value === 'string' && (valid.has(value) || isCultEmoji(value) || isOriginalEmoji(value) || isFamiliarEmoji(value))
}
