import { expect, test } from 'vitest'
import { faceCovers } from './face-privacy.js'

test('cover includes forehead, cheeks and chin; every detected face is covered', () => {
  expect(faceCovers([{ x: 100, y: 100, width: 100, height: 100 }, { x: 400, y: 200, width: 50, height: 60 }], 640, 480)).toEqual([
    { x: 60, y: 50, width: 180, height: 185 },
    { x: 380, y: 170, width: 90, height: 111 },
  ])
})

test('frame edges clip covers without shrinking the visible face', () => {
  expect(faceCovers([{ x: -10, y: -10, width: 100, height: 100 }], 120, 120)).toEqual([
    { x: 0, y: 0, width: 120, height: 120 },
  ])
})

test('absent faces or any malformed box require a full-picture cover', () => {
  const good = { x: 1, y: 1, width: 10, height: 10 }
  expect(faceCovers([], 640, 480)).toBeNull()
  for (const bad of [{ ...good, x: NaN }, { ...good, width: 0 }, { ...good, x: 700 }, { ...good, height: Infinity }]) {
    expect(faceCovers([good, bad], 640, 480)).toBeNull()
  }
})
