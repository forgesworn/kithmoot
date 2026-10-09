import { it, expect, vi, afterEach } from 'vitest'
import { searchMediaCatalogue, catalogueArtwork, resolveCatalogueArtwork, ORIGINAL_ART_PACK } from './media-catalogue.js'

afterEach(() => vi.unstubAllGlobals())
it('searches original reaction artwork locally and offers no flags or external URLs', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  const all = await searchMediaCatalogue('', false, signal)
  expect(all.map(item => item.slug)).toEqual(['coffee']); expect(all.every(item => item.url.startsWith('/') && item.url.includes('/chat-art/'))).toBe(true)
  expect(await searchMediaCatalogue('', true, signal)).toHaveLength(24)
  expect(await searchMediaCatalogue('flag', false, signal)).toEqual([])
  const found = await searchMediaCatalogue('facepalm', true, signal)
  expect(found).toHaveLength(1); expect(found[0]!.type).toBe('image/png'); expect(found[0]!.slug).toBe('facepalm')
  expect(fetch).not.toHaveBeenCalled()
})
it('stages only pinned catalogue references without downloading, and never resolves unknown artwork', async () => {
  const signal = new AbortController().signal
  const item = (await searchMediaCatalogue('coffee', false, signal))[0]!
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  expect(() => catalogueArtwork({ ...item, url: 'https://tracker.example/laugh.gif' })).toThrow('Unknown artwork')
  expect(() => catalogueArtwork({ ...item, sha256: '0'.repeat(64) })).toThrow('Unknown artwork')
  const reference = catalogueArtwork(item)
  expect(reference).toEqual({ pack: ORIGINAL_ART_PACK, id: 'coffee', kind: 'gif', sha256: item.sha256, label: 'Coffee' })
  expect(resolveCatalogueArtwork(reference)).toEqual(item)
  expect(resolveCatalogueArtwork({ ...reference, pack: 'future-pack' })).toBeUndefined()
  expect(resolveCatalogueArtwork({ ...reference, id: 'https://tracker.example/picture' })).toBeUndefined()
  expect(resolveCatalogueArtwork({ ...reference, sha256: '0'.repeat(64) })).toBeUndefined()
  expect(resolveCatalogueArtwork({ ...reference, kind: 'sticker' })).toBeUndefined()
  const sticker = (await searchMediaCatalogue('facepalm', true, signal))[0]!
  expect(resolveCatalogueArtwork(catalogueArtwork(sticker))).toEqual(sticker)
  expect(fetch).not.toHaveBeenCalled()
})
