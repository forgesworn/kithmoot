import { it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { searchMediaCatalogue, downloadCatalogueImage } from './media-catalogue.js'

afterEach(() => vi.unstubAllGlobals())
it('searches original reaction artwork locally and offers no flags or external URLs', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  const all = await searchMediaCatalogue('', false, signal)
  expect(all).toHaveLength(24); expect(all.every(item => item.url.startsWith('/') && item.url.includes('/chat-art/'))).toBe(true)
  expect(await searchMediaCatalogue('flag', false, signal)).toEqual([])
  const found = await searchMediaCatalogue('facepalm', true, signal)
  expect(found).toHaveLength(1); expect(found[0]!.type).toBe('image/png'); expect(found[0]!.slug).toBe('facepalm')
  expect(fetch).not.toHaveBeenCalled()
})
it('rejects substituted URLs and checks exact bundled bytes before encrypted sharing', async () => {
  const signal = new AbortController().signal
  const item = (await searchMediaCatalogue('laugh', false, signal))[0]!
  const bytes = readFileSync(new URL('../public/chat-art/laugh.gif', import.meta.url))
  const fetch = vi.fn().mockImplementation(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch)
  await expect(downloadCatalogueImage({ ...item, url: 'https://tracker.example/laugh.gif' }, signal)).rejects.toThrow('Unknown artwork')
  expect(fetch).not.toHaveBeenCalled()
  const file = await downloadCatalogueImage(item, signal)
  expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes)
  fetch.mockImplementation(async () => new Response('substituted data'))
  await expect(downloadCatalogueImage(item, signal)).rejects.toThrow('does not match')
})
