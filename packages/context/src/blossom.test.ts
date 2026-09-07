import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalEnvelopeName, decryptEnvelope, encryptEnvelope, verifyEnvelopeHash } from './blossom.js'

const vectors = JSON.parse(readFileSync(new URL('../test/fixtures/unicode-filenames.json', import.meta.url), 'utf8')) as {
  keyHex: string
  source: string
  cases: { id: string; inputName: string; expectedName: string; envelopeSha256: string; envelopeBase64: string }[]
}

describe('Wildbloom Unicode filename compatibility', () => {
  for (const fixture of vectors.cases) {
    it(`reads the published ${fixture.id} envelope and writes its canonical name`, () => {
      expect(canonicalEnvelopeName(fixture.inputName)).toBe(fixture.expectedName)
      const published = new Uint8Array(Buffer.from(fixture.envelopeBase64, 'base64'))
      expect(verifyEnvelopeHash(published, fixture.envelopeSha256)).toBe(true)
      const opened = decryptEnvelope(published, vectors.keyHex)
      expect(opened.name).toBe(fixture.expectedName)
      expect(new TextDecoder().decode(opened.source)).toBe(vectors.source)
      const sealed = encryptEnvelope(opened.source, { name: fixture.inputName, type: opened.type })
      expect(sealed.name).toBe(fixture.expectedName)
      expect(decryptEnvelope(sealed.envelope, sealed.key).name).toBe(fixture.expectedName)
    })
  }

  it.each([
    ['a'.repeat(178) + '😀', 'a'.repeat(178) + '😀'],
    ['a'.repeat(178) + '😀.txt', 'a'.repeat(178) + '😀'],
    ['a'.repeat(180) + '😀.txt', 'a'.repeat(180)],
    ['a'.repeat(181), 'a'.repeat(180)],
  ])('retains complete characters at the filename boundary (%#)', (input, expected) => {
    expect(canonicalEnvelopeName(input)).toBe(expected)
    expect(canonicalEnvelopeName(expected)).toBe(expected)
  })
})
