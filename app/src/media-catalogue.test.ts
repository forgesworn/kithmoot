import { it, expect, vi, afterEach } from 'vitest'
import { searchMediaCatalogue, catalogueArtwork, resolveCatalogueArtwork, ORIGINAL_ART_PACK } from './media-catalogue.js'

afterEach(() => vi.unstubAllGlobals())
it('searches original reaction artwork locally and offers no flags or external URLs', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  const all = await searchMediaCatalogue('', false, signal)
  expect(all.map(item => item.slug)).toEqual(['coffee', 'donkey-laugh', 'donkey-facepalm', 'donkey-bitcoin']); expect(all.every(item => item.url.startsWith('/') && item.url.includes('/chat-art/'))).toBe(true)
  expect(all.every(item => item.displayUrl.endsWith('.animated.webp') && item.displayPreview.endsWith('.webp'))).toBe(true)
  expect(await searchMediaCatalogue('', true, signal)).toHaveLength(27)
  expect(await searchMediaCatalogue('flag', false, signal)).toEqual([])
  const found = await searchMediaCatalogue('facepalm', true, signal)
  expect(found.map(item => item.slug)).toEqual(['facepalm', 'donkey-facepalm']); expect(found.every(item => item.type === 'image/png')).toBe(true)
  expect(found.every(item => item.url.endsWith('.png') && item.displayUrl.endsWith('.webp') && !item.displayUrl.endsWith('.animated.webp'))).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
})
it('resolves each Donkey GIF to its own bundled animation and still, without fetching a provider', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  const donkeys = await searchMediaCatalogue('Donkey', false, signal)
  expect(donkeys).toHaveLength(3)
  expect(await searchMediaCatalogue('TheCryptoDonkey', false, signal)).toEqual(donkeys)
  expect((await searchMediaCatalogue('donkey bitcoin', false, signal)).map(item => item.slug)).toEqual(['donkey-bitcoin'])
  for (const item of donkeys) {
    expect(item.type).toBe('image/gif')
    expect(item.url).toContain(`/chat-art/${item.slug}.gif`)
    expect(item.preview).toContain(`/chat-art/${item.slug}.png`)
    expect(item.displayUrl).toContain(`/chat-art/${item.slug}.animated.webp`)
    expect(item.displayPreview).toContain(`/chat-art/${item.slug}.webp`)
    expect(item.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(resolveCatalogueArtwork(catalogueArtwork(item))).toEqual(item)
    expect(resolveCatalogueArtwork({ ...catalogueArtwork(item), sha256: '0'.repeat(64) })).toBeUndefined()
  }
  expect(await searchMediaCatalogue('not again', false, signal)).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
})
it('stages only pinned original references and display derivatives without downloading', async () => {
  const signal = new AbortController().signal
  const item = (await searchMediaCatalogue('coffee', false, signal))[0]!
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  expect(item).toMatchObject({
    name: 'Coffee.gif', url: '/chat-art/coffee.gif', preview: '/chat-art/coffee-animation.png',
    displayUrl: '/chat-art/coffee.animated.webp', displayPreview: '/chat-art/coffee-animation.webp',
    type: 'image/gif', bytes: 5924981, sha256: '1ec70ce57a315e6dd13e8d451543eb529786a792f218121c9bfd67db718a61f1',
  })
  for (const field of ['url', 'preview', 'displayUrl', 'displayPreview'] as const) {
    expect(() => catalogueArtwork({ ...item, [field]: 'https://tracker.example/laugh.webp' })).toThrow('Unknown artwork')
  }
  expect(() => catalogueArtwork({ ...item, sha256: '0'.repeat(64) })).toThrow('Unknown artwork')
  const reference = catalogueArtwork(item)
  expect(reference).toEqual({ pack: ORIGINAL_ART_PACK, id: 'coffee', kind: 'gif', sha256: item.sha256, label: 'Coffee' })
  expect(resolveCatalogueArtwork(reference)).toEqual(item)
  expect(resolveCatalogueArtwork({ ...reference, pack: 'future-pack' })).toBeUndefined()
  expect(resolveCatalogueArtwork({ ...reference, id: 'https://tracker.example/picture' })).toBeUndefined()
  expect(resolveCatalogueArtwork({ ...reference, sha256: '0'.repeat(64) })).toBeUndefined()
  expect(resolveCatalogueArtwork({ ...reference, kind: 'sticker' })).toBeUndefined()
  const sticker = (await searchMediaCatalogue('facepalm', true, signal))[0]!
  expect(sticker).toMatchObject({ name: 'Facepalm.png', url: '/chat-art/facepalm.png', displayUrl: '/chat-art/facepalm.webp', type: 'image/png', bytes: 186838, sha256: 'd7de0056e35eff759d81f1625e84a5138cd1ef6633ff6d78b61a973c0fd18a84' })
  expect(catalogueArtwork(sticker)).toEqual({ pack: ORIGINAL_ART_PACK, id: 'facepalm', kind: 'sticker', sha256: sticker.sha256, label: 'Facepalm' })
  expect(resolveCatalogueArtwork(catalogueArtwork(sticker))).toEqual(sticker)
  expect(fetch).not.toHaveBeenCalled()
})
