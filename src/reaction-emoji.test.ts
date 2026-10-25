import { describe, expect, it } from 'vitest'
import { EMOJI_CATALOG, REACTION_VALIDATION_GLYPHS } from './emoji-catalog.js'
import { CULT_EMOJIS } from './custom-emoji.js'
import { ORIGINAL_EMOJIS } from './original-art.js'
import { FAMILIAR_ART } from './familiar-emoji.js'
import { isReactionEmoji } from './reaction-emoji.js'
import { REACTION_GLYPHS } from './reaction-emoji-data.js'

describe('reaction emoji catalogue', () => {
  it('keeps the compact glyph set equivalent to the accepted Unicode variants', () => {
    expect(REACTION_GLYPHS.split(' ')).toEqual(REACTION_VALIDATION_GLYPHS)
    for (const [emoji] of EMOJI_CATALOG) expect(isReactionEmoji(emoji), emoji).toBe(true)
  })

  it('retains local artwork and rejects arbitrary reaction text', () => {
    for (const [emoji] of [...CULT_EMOJIS, ...ORIGINAL_EMOJIS]) expect(isReactionEmoji(emoji), emoji).toBe(true)
    for (const item of FAMILIAR_ART) expect(isReactionEmoji(item.emoji), item.emoji).toBe(true)
    for (const value of ['hello', '<img>', '👍👍', '\u202e👍', '', null, 1]) expect(isReactionEmoji(value)).toBe(false)
  })
})
