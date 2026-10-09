import { expect, it } from 'vitest'
import { FAMILIAR_ART, familiarArtwork, familiarTextParts, withSkinTone } from './familiar-emoji.js'
import { isReactionEmoji } from './emoji-catalog.js'

it('uses recognised Unicode meanings with complete local artwork and human tones', () => {
  for (const item of FAMILIAR_ART) {
    expect(isReactionEmoji(item.emoji), item.emoji).toBe(true)
    expect(familiarArtwork(item.emoji), item.emoji).toMatch(/^[a-z0-9-]+\.png$/)
    for (let tone = 0; tone < 6; tone++) {
      const emoji = withSkinTone(item.emoji, tone)
      expect(isReactionEmoji(emoji), emoji).toBe(true)
      expect(familiarArtwork(emoji), emoji).toBeDefined()
      if (!item.toneable) expect(emoji).toBe(item.emoji)
    }
  }
  expect(withSkinTone('👍', 3)).toBe('👍🏽')
  expect(withSkinTone('👎', 5)).toBe('👎🏿')
  expect(withSkinTone('✌️', 1)).toBe('✌🏻')
})

it('renders exact received graphemes without splitting unfamiliar emoji or changing copied text', () => {
  const text = 'Nice 👍🏽 ❤️ 👎🏿. Keep 👩🏽‍💻 👨‍👩‍👧‍👦 1️⃣ 🏴‍☠️ 🫏‍🦄 intact.'
  const parts = familiarTextParts(text)
  expect(parts.map(part => part.text).join('')).toBe(text)
  expect(parts.filter(part => part.artwork).map(part => part.text)).toEqual(['👍🏽', '❤️', '👎🏿'])
  expect(familiarArtwork('👍🏽‍🦄')).toBeUndefined()
  expect(familiarArtwork('❤')).toBe(familiarArtwork('❤️'))
  expect(() => withSkinTone('👍', 6)).toThrow()
})
