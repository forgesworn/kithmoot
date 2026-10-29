import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spryNodeCard, spryStandardCard } from '../src/spry-link.js'
import { isSpryStandardOffer, isSpryStandardTurnUrls, parseSpryOffer, type SpryOffer } from '../src/spry.js'

const vectors = JSON.parse(readFileSync(new URL('./spry-standard-offer-v1.json', import.meta.url), 'utf8'))

describe('spry-standard-offer-v1 vectors', () => {
  it('covers acceptance and refusal in every group', () => {
    for (const group of ['cards', 'offers', 'urls'] as const) {
      const key = group === 'urls' ? 'accept' : 'standard'
      expect(vectors[group].some((v: Record<string, unknown>) => v[key] === true), group).toBe(true)
      expect(vectors[group].some((v: Record<string, unknown>) => v[key] === false), group).toBe(true)
    }
  })
  for (const v of vectors.cards) {
    it(`card: ${v.name}`, () => {
      expect(!!spryStandardCard(v.event, v.now), 'standard verifier').toBe(v.standard)
      expect(!!spryNodeCard(v.event, v.now), 'peer verifier').toBe(v.peer)
    })
  }
  for (const v of vectors.offers) {
    it(`offer: ${v.name}`, () => {
      expect(isSpryStandardOffer(v.offer as SpryOffer)).toBe(v.standard)
    })
  }
  for (const v of vectors.urls) {
    it(`urls: ${v.name}`, () => {
      expect(isSpryStandardTurnUrls(v.urls)).toBe(v.accept)
    })
  }
  it('keeps a standard card on an offer read while it is fresh, and the offer stays standard after the card expires', () => {
    const card = vectors.cards[0].event
    const raw = { v: 1, endpoint: vectors.endpoint, token: 'a'.repeat(43), expiresAt: 1_800_000_000, node: card }
    const realNow = Date.now
    try {
      Date.now = () => card.created_at * 1000
      const offer = parseSpryOffer(raw)
      expect(offer?.node?.id).toBe(card.id)
      Date.now = () => (card.created_at + 3600) * 1000
      expect(isSpryStandardOffer(offer!)).toBe(true)
      // Read once the card has expired, the offer carries no card and is not standard.
      expect(parseSpryOffer(raw)?.node).toBeUndefined()
    } finally { Date.now = realNow }
  })
})
