import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLogoImage, readLogoImage } from './logo-image.js'

const fixture: { vectors: { id: string; payload: unknown; accepted: boolean }[] } =
  JSON.parse(readFileSync(new URL('../vectors/logo-images-v1.json', import.meta.url), 'utf8'))

describe('cross-client logo image vectors', () => {
  it.each(fixture.vectors)('$id', ({ payload, accepted }) => {
    const image = readLogoImage(payload)
    expect(image !== undefined).toBe(accepted)
    if (image) {
      expect(image).toEqual(payload)
      expect(createLogoImage(Buffer.from(image.data, 'base64'), image.mime)).toEqual(payload)
    }
  })
})
