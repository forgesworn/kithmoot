import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { base64 } from '@scure/base'
import { createLogoImage, logoDataUrl, logoFromCanvasEncoding, MAX_LOGO_BYTES, readLogoImage } from './logo-image.js'

const png = new Uint8Array(readFileSync(new URL('../desktop/icons/kithmoot-128.png', import.meta.url)))
const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/logo-canvas-webp.json', import.meta.url), 'utf8'))
const rawWebp = base64.decode(fixture.canvasWebp)
const webkitCanvas = JSON.parse(readFileSync(new URL('../test/fixtures/logo-canvas-webkit.json', import.meta.url), 'utf8'))[0]

describe('bounded private logo images', () => {
  it('keeps a real local PNG inline with its intrinsic dimensions and integrity hash', () => {
    const image = createLogoImage(png, 'image/png')
    expect(image.width).toBe(128); expect(image.height).toBe(128)
    expect(readLogoImage(image)).toEqual(image)
    expect(logoDataUrl(image)).toBe(`data:image/png;base64,${image.data}`)
  })
  it('removes the actual ICC chunk added by a browser canvas WebP encoder', () => {
    expect(Buffer.from(rawWebp).includes(Buffer.from('ICCP'))).toBe(true)
    expect(() => createLogoImage(rawWebp, 'image/webp')).toThrow()
    const image = logoFromCanvasEncoding(rawWebp, 'image/webp')
    expect(image.width).toBe(2); expect(image.height).toBe(2)
    expect(Buffer.from(base64.decode(image.data)).includes(Buffer.from('ICCP'))).toBe(false)
    expect(readLogoImage(image)).toEqual(image)
  })
  it('handles WebKit PNG fallback by stripping the EXIF added to its fresh canvas output', () => {
    expect(webkitCanvas.requested).toBe('image/webp'); expect(webkitCanvas.mime).toBe('image/png')
    const png = base64.decode(webkitCanvas.data)
    expect(Buffer.from(png).includes(Buffer.from('eXIf'))).toBe(true)
    expect(() => createLogoImage(png, 'image/png')).toThrow()
    const image = logoFromCanvasEncoding(png, 'image/png')
    expect(image.width).toBe(2); expect(image.height).toBe(2)
    expect(Buffer.from(base64.decode(image.data)).includes(Buffer.from('eXIf'))).toBe(false)
    expect(readLogoImage(image)).toEqual(image)
  })
  it('refuses remote sources, SVG, extra fields and tampered hashes or dimensions', () => {
    const image = createLogoImage(png, 'image/png')
    for (const value of ['https://tracker.invalid/logo.png', 'data:image/svg+xml,<svg/>',
      { ...image, url: 'https://tracker.invalid/logo.png' }, { ...image, data: 'https://tracker.invalid/logo.png' },
      { ...image, mime: 'image/svg+xml' }, { ...image, sha256: '00'.repeat(32) }, { ...image, width: 64 },
      { ...image, data: image.data.replace(/=+$/, '') }]) {
      expect(readLogoImage(value)).toBeUndefined(); expect(logoDataUrl(value)).toBeUndefined()
    }
  })
  it('refuses oversized images and bytes outside either signed container', () => {
    expect(() => createLogoImage(new Uint8Array(MAX_LOGO_BYTES + 1), 'image/png')).toThrow('limit')
    const withTrailing = new Uint8Array(png.length + 1); withTrailing.set(png)
    expect(() => createLogoImage(withTrailing, 'image/png')).toThrow()
    const image = logoFromCanvasEncoding(rawWebp, 'image/webp'), webp = base64.decode(image.data)
    const trailing = new Uint8Array(webp.length + 2); trailing.set(webp)
    expect(() => createLogoImage(trailing, 'image/webp')).toThrow()
    const corrupt = png.slice(); corrupt[corrupt.length - 1] ^= 1
    expect(() => createLogoImage(corrupt, 'image/png')).toThrow()
  })
  it('rejects animation and excessive intrinsic WebP canvas sizes before decoding pixels', () => {
    const image = logoFromCanvasEncoding(rawWebp, 'image/webp'), bytes = base64.decode(image.data)
    const animated = bytes.slice(); animated[20] |= 2
    expect(() => createLogoImage(animated, 'image/webp')).toThrow()
    expect(() => logoFromCanvasEncoding(animated, 'image/webp')).toThrow('still')
    const oversized = bytes.slice()
    oversized[24] = oversized[27] = 0; oversized[25] = oversized[28] = 1
    expect(() => createLogoImage(oversized, 'image/webp')).toThrow()
  })
})
