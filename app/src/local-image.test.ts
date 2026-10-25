import { expect, it } from 'vitest'
import { setLocalImage } from './local-image.js'

class FakeImage extends EventTarget {
  srcset = ''
  sizes = ''
  readonly srcAssignments: string[] = []
  #src = ''
  get src() { return this.#src }
  set src(value: string) { this.#src = value; this.srcAssignments.push(value) }
  removeAttribute(name: string) {
    if (name === 'srcset') this.srcset = ''
    if (name === 'sizes') this.sizes = ''
  }
}

const image = () => new FakeImage() as unknown as HTMLImageElement

it('keeps a single original URL unchanged for attachment and blob callers', () => {
  const value = image()
  expect(setLocalImage(value, { fallbackUrl: 'blob:decrypted-image' })).toBe(value)
  expect(value.src).toBe('blob:decrypted-image')
  expect(value.srcset).toBe('')
  value.dispatchEvent(new Event('error'))
  expect((value as unknown as FakeImage).srcAssignments).toEqual(['blob:decrypted-image'])
})

it('prefers WebP and restores the original exactly once after an error', () => {
  const value = image(), fake = value as unknown as FakeImage
  setLocalImage(value, { fallbackUrl: '/j/chat-art/coffee.gif', displayUrl: '/j/chat-art/coffee.animated.webp', sizes: '160px' })
  expect(value.src).toBe('/j/chat-art/coffee.gif')
  expect(value.srcset).toBe('/j/chat-art/coffee.animated.webp')
  expect(value.sizes).toBe('160px')
  value.dispatchEvent(new Event('error'))
  expect(value.src).toBe('/j/chat-art/coffee.gif')
  expect(value.srcset).toBe('')
  expect(value.sizes).toBe('')
  value.dispatchEvent(new Event('error'))
  expect(fake.srcAssignments).toEqual(['/j/chat-art/coffee.gif', '/j/chat-art/coffee.gif'])
})

it('accepts responsive WebP candidates and removes a stale recovery when reused', () => {
  const value = image(), fake = value as unknown as FakeImage
  const srcset = '/j/assets/600-moon-64.webp 64w, /j/assets/600-moon-128.webp 128w'
  setLocalImage(value, { fallbackUrl: '/j/assets/600-moon.png', srcset, sizes: '32px' })
  expect(value.srcset).toBe(srcset)
  expect(value.sizes).toBe('32px')
  setLocalImage(value, { fallbackUrl: 'blob:replacement' })
  value.dispatchEvent(new Event('error'))
  expect(fake.srcAssignments).toEqual(['/j/assets/600-moon.png', 'blob:replacement'])
  expect(value.srcset).toBe('')
})
