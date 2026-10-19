import { describe, expect, it } from 'vitest'
import { ICONS, iconSprite } from './icons.js'

describe('icon sprite', () => {
  it('has one symbol per icon, each on a 24 grid', () => {
    const sprite = iconSprite()
    const ids = [...sprite.matchAll(/<symbol id="i-([A-Za-z]+)" viewBox="0 0 24 24">/g)].map(match => match[1])
    expect(ids.sort()).toEqual(Object.keys(ICONS).sort())
  })

  it('draws with the ink of the button it sits in and loads nothing', () => {
    const sprite = iconSprite().replace(' xmlns="http://www.w3.org/2000/svg"', '')
    expect(sprite).not.toMatch(/https?:|url\(|xlink:href|<image|<script/)
    for (const [name, shapes] of Object.entries(ICONS)) {
      expect(shapes, name).not.toMatch(/#[0-9a-fA-F]{3,6}|rgb\(/)
    }
  })

  it('names every icon the shell asks for', () => {
    for (const name of ['back', 'more', 'phone', 'search', 'info', 'plus', 'smile', 'send', 'lock', 'personAdd', 'agent', 'board', 'close']) {
      expect(ICONS, name).toHaveProperty(name)
    }
  })
})
