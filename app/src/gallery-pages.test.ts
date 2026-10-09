import { expect, test } from 'vitest'
import { GalleryPages, galleryPageSize } from './gallery-pages.js'

test('roster reorder and a newcomer cannot reorder existing pages or follow a speaker', () => {
  const pages = new GalleryPages()
  pages.update(['a', 'b', 'c', 'd', 'e'], 2)
  pages.go(1)
  pages.update(['e', 'c', 'a', 'f', 'd', 'b'], 2)
  expect(pages.visible).toEqual(['c', 'd'])
  expect(pages.pages).toBe(3)
  pages.go(2)
  expect(pages.visible).toEqual(['e', 'f'])
})

test('departure before a selected page keeps a surviving selected person visible', () => {
  const pages = new GalleryPages()
  pages.update(['a', 'b', 'c', 'd', 'e', 'f'], 2)
  pages.go(2)
  pages.update(['b', 'c', 'd', 'e', 'f'], 2)
  expect(pages.visible).toContain('e')
  expect(pages.page).toBe(1)
})

test('a responsive page resize retains the selected person and clamps empty pages', () => {
  const pages = new GalleryPages()
  pages.update(['a', 'b', 'c', 'd', 'e', 'f'], 2)
  pages.go(2)
  pages.update(['a', 'b', 'c', 'd', 'e', 'f'], 3)
  expect(pages.visible).toContain('e')
  pages.update(['a'], 3)
  expect(pages.page).toBe(0)
  expect(pages.pages).toBe(1)
  expect(pages.visible).toEqual(['a'])
})

test('duplicate identities cannot consume extra slots and a new call clears selection', () => {
  const pages = new GalleryPages()
  pages.update(['a', 'a', 'b', 'c'], 1)
  expect(pages.count).toBe(3)
  pages.go(99)
  expect(pages.visible).toEqual(['c'])
  pages.clear()
  pages.update(['new-a', 'new-b'], 2)
  expect(pages.page).toBe(0)
  expect(pages.visible).toEqual(['new-a', 'new-b'])
})

test('page capacity is bounded and responds to the actual stage dimensions', () => {
  expect(galleryPageSize(1000, 700)).toBe(9)
  expect(galleryPageSize(540, 220)).toBe(6)
  expect(galleryPageSize(330, 220)).toBe(2)
  expect(galleryPageSize(0, 0)).toBe(1)
})
