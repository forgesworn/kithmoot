import { describe, expect, test } from 'vitest'
import {
  ActiveSpeaker, ANNOUNCE_KEY, CORNER_KEY, HIDE_SELF_KEY, MIN_TILE_WIDTH, TILE_ASPECT, TILE_GAP, Throttle, VIEW_KEY,
  bestGrid, cornerRect, effectiveMode, fitRect, gridRects, initialsOf, layoutCall, loadPrefs, nearestCorner, nextCorner, savePref, sideStrip, splitStage, underStrip,
  type Rect,
} from './call-layout.js'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)
const same = (rects: Rect[]) => rects.every(r => r.width === rects[0].width && r.height === rects[0].height)
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('bestGrid', () => {
  test('two people in a wide room sit side by side', () => {
    const grid = bestGrid(1200, 600, 2)
    expect(grid.columns).toBe(2)
    expect(grid.rows).toBe(1)
  })

  test('four people in a 16:9 room make two by two', () => {
    const grid = bestGrid(1600, 900, 4)
    expect([grid.columns, grid.rows]).toEqual([2, 2])
  })

  test('picks the column count with the biggest tile, whatever the count', () => {
    for (const [w, h] of [[1000, 700], [1400, 800], [700, 900], [1900, 500]]) {
      for (let n = 1; n <= 12; n++) {
        const grid = bestGrid(w, h, n)
        for (let columns = 1; columns <= n; columns++) {
          const rows = Math.ceil(n / columns)
          const other = Math.floor(Math.min((w - (columns - 1) * TILE_GAP) / columns, ((h - (rows - 1) * TILE_GAP) / rows) * TILE_ASPECT))
          expect(grid.tileWidth, `${n} in ${w}x${h}: ${columns} columns does better`).toBeGreaterThanOrEqual(other)
        }
        // And it fits.
        expect(grid.columns * grid.tileWidth + (grid.columns - 1) * TILE_GAP).toBeLessThanOrEqual(w)
        expect(grid.rows * grid.tileHeight + (grid.rows - 1) * TILE_GAP).toBeLessThanOrEqual(h)
      }
    }
  })

  test('holds the tile at the floor and lets rows run on rather than shrinking to thumbnails', () => {
    const grid = bestGrid(900, 300, 20, { minWidth: MIN_TILE_WIDTH })
    expect(grid.tileWidth).toBeGreaterThanOrEqual(MIN_TILE_WIDTH)
    expect(grid.columns * grid.tileWidth + (grid.columns - 1) * TILE_GAP).toBeLessThanOrEqual(900)
    expect(grid.rows * grid.columns).toBeGreaterThanOrEqual(20)
  })

  test('tiles are 16:9 in whole pixels', () => {
    const grid = bestGrid(1033, 677, 5)
    expect(Number.isInteger(grid.tileWidth) && Number.isInteger(grid.tileHeight)).toBe(true)
    expect(Math.abs(grid.tileWidth / grid.tileHeight - TILE_ASPECT)).toBeLessThan(0.02)
  })
})

describe('gridRects', () => {
  test('every tile is the same box, none overlap, all inside the area', () => {
    const area = { x: 10, y: 10, width: 1000, height: 640 }
    for (let n = 1; n <= 10; n++) {
      const rects = gridRects(area, n)
      expect(rects).toHaveLength(n)
      expect(same(rects)).toBe(true)
      for (const [i, a] of rects.entries()) {
        expect(a.x).toBeGreaterThanOrEqual(area.x)
        expect(a.y).toBeGreaterThanOrEqual(area.y)
        expect(a.x + a.width).toBeLessThanOrEqual(area.x + area.width)
        expect(a.y + a.height).toBeLessThanOrEqual(area.y + area.height)
        for (const b of rects.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
      }
    }
  })

  test('a short last row is centred, not hung off the left', () => {
    const rects = gridRects({ x: 0, y: 0, width: 1000, height: 800 }, 3)
    expect(rects.filter(r => r.y === rects[0].y)).toHaveLength(2)
    const last = rects[2]
    expect(last.y).toBeGreaterThan(rects[0].y)
    expect(Math.abs(last.x + last.width / 2 - 500)).toBeLessThanOrEqual(1)
  })
})

describe('layoutCall', () => {
  const room = { width: 1000, height: 700 }

  test('gallery: every person gets the identical box, with 2, 4 and 8 people', () => {
    for (const n of [3, 4, 8]) {
      const out = layoutCall({ ...room, view: 'gallery', people: ids(n), self: 'p0', shares: [] })
      expect(out.mode).toBe('gallery')
      expect(same([...out.people.values()])).toBe(true)
    }
  })

  test('the answer depends on the room and the list, never on a share\'s picture', () => {
    const a = layoutCall({ ...room, view: 'share', people: ids(4), self: 'p0', shares: [{ id: 's', aspect: 16 / 9 }] })
    const b = layoutCall({ ...room, view: 'share', people: ids(4), self: 'p0', shares: [{ id: 's', aspect: 9 / 16 }] })
    expect(b).toEqual(a)
  })

  test('two people: the other fills the stage and your own picture floats in the corner you left it', () => {
    const out = layoutCall({ ...room, view: 'gallery', people: ['me', 'you'], self: 'me', shares: [], selfCorner: 'top-left' })
    expect(out.mode).toBe('solo')
    expect(out.floating).toBe('me')
    const main = out.people.get('you')!
    const mine = out.people.get('me')!
    expect(main.width).toBeGreaterThan(room.width * 0.9)
    expect(mine.width).toBeLessThan(main.width / 3)
    // Inside the main picture, in its top left.
    expect(mine.x).toBeGreaterThan(main.x)
    expect(mine.y).toBeGreaterThan(main.y)
    expect(mine.x + mine.width).toBeLessThan(main.x + main.width / 2)
    expect(mine.y + mine.height).toBeLessThan(main.y + main.height / 2)
  })

  test('two people without yourself among them is an ordinary gallery', () => {
    expect(layoutCall({ ...room, view: 'gallery', people: ['a', 'b'], self: 'me', shares: [] }).mode).toBe('gallery')
  })

  test('speaker: the featured person is big and everybody else is one size in a strip', () => {
    const out = layoutCall({ ...room, width: 1400, view: 'speaker', people: ids(6), self: 'p0', shares: [], featured: 'p3' })
    expect(out.mode).toBe('speaker')
    expect(out.featured).toBe('p3')
    const main = out.people.get('p3')!
    const strip = ids(6).filter(id => id !== 'p3').map(id => out.people.get(id)!)
    expect(same(strip)).toBe(true)
    expect(main.width).toBeGreaterThan(strip[0].width * 2)
    for (const tile of strip) expect(overlaps(tile, main)).toBe(false)
  })

  test('speaker with nobody featured yet shows somebody other than yourself', () => {
    const out = layoutCall({ ...room, view: 'speaker', people: ['p0', 'p1', 'p2'], self: 'p0', shares: [] })
    expect(out.featured).toBe('p1')
  })

  test('share: the share takes the stage and people keep one size in a strip', () => {
    const out = layoutCall({ ...room, width: 1400, view: 'share', people: ids(5), self: 'p0', shares: [{ id: 's' }] })
    expect(out.mode).toBe('share')
    const stage = out.shares.get('s')!
    const strip = [...out.people.values()]
    expect(strip).toHaveLength(5)
    expect(same(strip)).toBe(true)
    expect(stage.width * stage.height).toBeGreaterThan(strip[0].width * strip[0].height * 5)
    for (const tile of strip) expect(overlaps(tile, stage)).toBe(false)
  })

  test('share is the view only while there is a share', () => {
    expect(effectiveMode({ view: 'share', people: ids(3), self: 'p0', shares: [] })).toBe('gallery')
    // And a share on the stage wins over the call-of-two picture.
    expect(effectiveMode({ view: 'share', people: ['me', 'you'], self: 'me', shares: [{ id: 's' }] })).toBe('share')
  })

  test('gallery with a share puts it in the grid at the same size as people', () => {
    const out = layoutCall({ ...room, view: 'gallery', people: ids(3), self: 'p0', shares: [{ id: 's' }] })
    expect(same([...out.people.values(), out.shares.get('s')!])).toBe(true)
  })

  test('a tall room puts the strip underneath, a wide one beside', () => {
    const tall = splitStage({ x: 0, y: 0, width: 700, height: 900 }, 4)
    for (const tile of tall.strip) expect(tile.y).toBeGreaterThanOrEqual(tall.stage.y + tall.stage.height)
    const wide = splitStage({ x: 0, y: 0, width: 1600, height: 700 }, 4)
    for (const tile of wide.strip) expect(tile.x).toBeGreaterThanOrEqual(wide.stage.x + wide.stage.width)
  })

  test('the strip goes wherever it leaves the bigger stage', () => {
    const area16x9 = (stage: Rect) => { const box = fitRect(stage, TILE_ASPECT); return box.width * box.height }
    for (const [width, height, count] of [[790, 430, 7], [1200, 700, 5], [900, 700, 9], [1400, 500, 3], [700, 900, 4]]) {
      const area = { x: 0, y: 0, width, height }
      const chosen = area16x9(splitStage(area, count).stage)
      expect(chosen, `${width}x${height} with ${count}`).toBe(Math.max(area16x9(sideStrip(area, count, TILE_GAP).stage), area16x9(underStrip(area, count, TILE_GAP).stage)))
    }
  })

  test('a crowded gallery scrolls rather than shrinking below the floor', () => {
    const out = layoutCall({ width: 800, height: 400, view: 'gallery', people: ids(30), self: 'p0', shares: [] })
    const tile = out.people.get('p0')!
    expect(tile.width).toBeGreaterThanOrEqual(MIN_TILE_WIDTH)
    expect(out.contentHeight).toBeGreaterThan(400)
  })
})

describe('corners', () => {
  const area = { x: 0, y: 0, width: 1000, height: 600 }
  test('snaps to the nearest one', () => {
    expect(nearestCorner(area, 100, 100)).toBe('top-left')
    expect(nearestCorner(area, 900, 100)).toBe('top-right')
    expect(nearestCorner(area, 900, 500)).toBe('bottom-right')
    expect(nearestCorner(area, 100, 500)).toBe('bottom-left')
  })
  test('the keyboard walks all four, clockwise', () => {
    expect(nextCorner('top-left')).toBe('top-right')
    expect(nextCorner('top-right')).toBe('bottom-right')
    expect(nextCorner('bottom-right')).toBe('bottom-left')
    expect(nextCorner('bottom-left')).toBe('top-left')
  })
  test('a corner box sits inside its area', () => {
    const r = cornerRect(area, 'bottom-right', 200, 112, 16)
    expect(r.x + r.width).toBe(984)
    expect(r.y + r.height).toBe(584)
  })
  test('fitRect centres the biggest box', () => {
    expect(fitRect({ x: 0, y: 0, width: 1600, height: 450 }, 16 / 9)).toEqual({ x: 400, y: 0, width: 800, height: 450 })
  })
})

describe('ActiveSpeaker', () => {
  const everyone = ['a', 'b', 'c']

  test('starts on whoever is talking, or the first candidate', () => {
    expect(new ActiveSpeaker().update(new Set(), everyone, 0).current).toBe('a')
    expect(new ActiveSpeaker().update(new Set(['c']), everyone, 0).current).toBe('c')
  })

  test('holds for the hold time before following a new voice', () => {
    const speaker = new ActiveSpeaker(1500)
    speaker.update(new Set(['a']), everyone, 0)
    const early = speaker.update(new Set(['b']), everyone, 500)
    expect(early.current).toBe('a')
    expect(early.recheckIn).toBe(1000)
    expect(speaker.update(new Set(['b']), everyone, 1500).current).toBe('b')
  })

  test('nobody takes the picture from somebody still talking', () => {
    const speaker = new ActiveSpeaker(1500)
    speaker.update(new Set(['a']), everyone, 0)
    expect(speaker.update(new Set(['a', 'b']), everyone, 5000).current).toBe('a')
  })

  test('silence keeps the last speaker', () => {
    const speaker = new ActiveSpeaker(1500)
    speaker.update(new Set(['b']), everyone, 0)
    expect(speaker.update(new Set(), everyone, 9000).current).toBe('b')
  })

  test('the longest talker wins when several start', () => {
    const speaker = new ActiveSpeaker(1500)
    speaker.update(new Set(['a']), everyone, 0)
    speaker.update(new Set(['c']), everyone, 100)
    speaker.update(new Set(['c', 'b']), everyone, 200)
    expect(speaker.update(new Set(['c', 'b']), everyone, 2000).current).toBe('c')
  })

  test('somebody who leaves hands the picture on at once', () => {
    const speaker = new ActiveSpeaker(1500)
    speaker.update(new Set(['a']), everyone, 0)
    expect(speaker.update(new Set(['b']), ['b', 'c'], 100).current).toBe('b')
  })
})

test('Throttle lets one through per gap', () => {
  const t = new Throttle(4000)
  expect(t.allow(0)).toBe(true)
  expect(t.allow(3999)).toBe(false)
  expect(t.allow(4000)).toBe(true)
})

test('initials', () => {
  expect(initialsOf('Ada Lovelace')).toBe('AL')
  expect(initialsOf('bob')).toBe('B')
  expect(initialsOf('  ')).toBe('?')
  expect(initialsOf('Jean Luc Picard')).toBe('JP')
})

describe('prefs', () => {
  const store = () => {
    const map = new Map<string, string>()
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map }
  }
  test('defaults: gallery, bottom right, nothing hidden, announcements off', () => {
    expect(loadPrefs(store())).toEqual({ view: 'gallery', corner: 'bottom-right', hideSelf: false, hideNoVideo: false, announce: false })
  })
  test('round trip, under kithmoot. keys', () => {
    const s = store()
    savePref(s, VIEW_KEY, 'speaker')
    savePref(s, CORNER_KEY, 'top-left')
    savePref(s, HIDE_SELF_KEY, true)
    savePref(s, ANNOUNCE_KEY, true)
    expect(loadPrefs(s)).toMatchObject({ view: 'speaker', corner: 'top-left', hideSelf: true, announce: true })
    for (const key of s.map.keys()) expect(key.startsWith('kithmoot.')).toBe(true)
  })
  test('rubbish and a storage that throws both fall back to defaults', () => {
    const s = store()
    s.setItem(VIEW_KEY, 'share')
    s.setItem(CORNER_KEY, 'middle')
    expect(loadPrefs(s)).toMatchObject({ view: 'gallery', corner: 'bottom-right' })
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(loadPrefs(throwing).view).toBe('gallery')
    expect(() => savePref(throwing, VIEW_KEY, 'speaker')).not.toThrow()
  })
})
