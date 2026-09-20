import { describe, expect, it } from 'vitest'
import { ShareMarks, type LiveMark, type MarkAuthor } from './share-marks.js'
import { markLegendEntries } from './share-mark-legend.js'
import type { AnnotationPoint, ScreenAnnotation } from '../../src/signal.js'

const alice: MarkAuthor = { key: 'alice-key', label: 'Alice (a1ice)' }
const bob: MarkAuthor = { key: 'bob-key', label: 'Bob (b0b)' }

function stroke(id: string, author: MarkAuthor, colour: string, points: AnnotationPoint[], alpha: number): LiveMark {
  return {
    alpha,
    color: colour,
    author,
    annotation: { op: 'stroke', shareId: 'share-1', strokeId: id, points } as ScreenAnnotation,
  }
}

function points(n: number): AnnotationPoint[] {
  return Array.from({ length: n }, (_, i) => ({ x: i / 10, y: i / 10 }))
}

function pending(author: MarkAuthor, colour: string, n: number) {
  return { author, color: colour, points: points(n) }
}

describe('markLegendEntries', () => {
  it('collapses one author with many segments into a single entry', () => {
    const marks = Array.from({ length: 100 }, (_, i) => stroke(`s${i}`, alice, '#ffd447', points(2), 1))
    const entries = markLegendEntries(marks)
    expect(entries).toEqual([{ key: alice.key, label: alice.label, color: '#ffd447', alpha: 1 }])
  })

  it('keeps two authors separate, each with their own colour', () => {
    const marks = [
      stroke('a1', alice, '#ffd447', points(3), 1),
      stroke('b1', bob, '#5ec8ff', points(3), 1),
      stroke('a2', alice, '#ffd447', points(3), 1),
    ]
    const entries = markLegendEntries(marks)
    expect(entries).toEqual([
      { key: alice.key, label: alice.label, color: '#ffd447', alpha: 1 },
      { key: bob.key, label: bob.label, color: '#5ec8ff', alpha: 1 },
    ])
  })

  it('reports the max alpha across an author’s fading strokes', () => {
    const marks = [
      stroke('a1', alice, '#ffd447', points(2), 0.2),
      stroke('a2', alice, '#ffd447', points(2), 0.75),
      stroke('a3', alice, '#ffd447', points(2), 0.4),
    ]
    const entries = markLegendEntries(marks)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.alpha).toBe(0.75)
  })

  it('folds a pending stroke into the same author rather than a second entry', () => {
    const marks = [stroke('a1', alice, '#ffd447', points(2), 0.3)]
    const entries = markLegendEntries(marks, pending(alice, '#ffd447', 2))
    expect(entries).toEqual([{ key: alice.key, label: alice.label, color: '#ffd447', alpha: 1 }])
  })

  it('adds a pending stroke on its own as a fresh entry', () => {
    const entries = markLegendEntries([], pending(bob, '#5ec8ff', 4))
    expect(entries).toEqual([{ key: bob.key, label: bob.label, color: '#5ec8ff', alpha: 1 }])
  })

  it('ignores a pending stroke with fewer than two points', () => {
    expect(markLegendEntries([], pending(alice, '#ffd447', 1))).toEqual([])
  })

  it('returns nothing when there are no marks and no pending stroke', () => {
    expect(markLegendEntries([])).toEqual([])
  })

  it('excludes strokes with a single point, whatever their alpha', () => {
    const marks = [stroke('a1', alice, '#ffd447', [{ x: 0.5, y: 0.5 }], 1)]
    expect(markLegendEntries(marks)).toEqual([])
  })

  it('excludes fully faded strokes (alpha <= 0)', () => {
    const marks = [stroke('a1', alice, '#ffd447', points(3), 0)]
    expect(markLegendEntries(marks)).toEqual([])
  })

  it('dedupes an anonymous key safely', () => {
    const anon: MarkAuthor = { key: '', label: '' }
    const marks = [
      stroke('a1', anon, '#ffd447', points(2), 1),
      stroke('a2', anon, '#ffd447', points(2), 0.5),
    ]
    const entries = markLegendEntries(marks, pending(anon, '#ffd447', 2))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ key: '', label: '', color: '#ffd447', alpha: 1 })
  })

  it('does not mutate its input', () => {
    const marks = [stroke('a1', alice, '#ffd447', points(2), 0.4)]
    const snapshot = JSON.parse(JSON.stringify(marks))
    markLegendEntries(marks, pending(bob, '#5ec8ff', 2))
    expect(marks).toEqual(snapshot)
  })

  it('drops an author’s entry once ShareMarks lets their last stroke expire', () => {

    let now = 0
    const share = new ShareMarks(
      () => now,
      () => {},
    )
    share.remember(
      { op: 'stroke', shareId: 'share-1', strokeId: 's1', points: points(3) } as ScreenAnnotation,
      alice,
    )
    expect(markLegendEntries(share.alive('share-1'))).toEqual([
      { key: alice.key, label: alice.label, color: share.alive('share-1')[0]!.color, alpha: 1 },
    ])

    now = 5000
    expect(share.alive('share-1')).toEqual([])
    expect(markLegendEntries(share.alive('share-1'))).toEqual([])
  })

  it('removes only the author whose final mark has expired', () => {
    let now = 0
    const share = new ShareMarks(() => now, () => {})
    share.remember({ op: 'stroke', shareId: 'share-1', strokeId: 'alice', points: points(2) }, alice)
    now = 2000
    share.remember({ op: 'stroke', shareId: 'share-1', strokeId: 'bob', points: points(2) }, bob)
    expect(markLegendEntries(share.alive('share-1'))).toHaveLength(2)
    now = 3100
    expect(markLegendEntries(share.alive('share-1')).map(entry => entry.key)).toEqual([bob.key])
    now = 5100
    expect(markLegendEntries(share.alive('share-1'))).toEqual([])
  })

  it('drops every entry on a share after a clear arrives', () => {
    const now = () => 0
    const share = new ShareMarks(now, () => {})
    share.remember(
      { op: 'stroke', shareId: 'share-1', strokeId: 's1', points: points(3) } as ScreenAnnotation,
      alice,
    )
    share.remember(
      { op: 'stroke', shareId: 'share-1', strokeId: 's2', points: points(3) } as ScreenAnnotation,
      bob,
    )
    expect(markLegendEntries(share.alive('share-1'))).toHaveLength(2)

    share.remember({ op: 'clear', shareId: 'share-1' } as ScreenAnnotation, alice)
    expect(markLegendEntries(share.alive('share-1'))).toEqual([])
  })

  it('agrees with coloursForShare on which colour belongs to whom', () => {
    const now = () => 0
    const share = new ShareMarks(now, () => {})
    share.remember(
      { op: 'stroke', shareId: 'share-1', strokeId: 's1', points: points(3) } as ScreenAnnotation,
      alice,
    )
    share.remember(
      { op: 'stroke', shareId: 'share-1', strokeId: 's2', points: points(3) } as ScreenAnnotation,
      bob,
    )
    const live = share.alive('share-1')
    const entries = markLegendEntries(live)
    for (const entry of entries) {
      const matching = live.find(mark => mark.author.key === entry.key)!
      expect(entry.color).toBe(matching.color)
    }

  })
})
