import type { LiveMark, MarkAuthor } from './share-marks.js'
import type { AnnotationPoint } from '../../src/signal.js'

export interface MarkLegendEntry { key: string; label: string; color: string; alpha: number }

/** One entry per author, fading with their last visible stroke. */
export function markLegendEntries(
  marks: LiveMark[],
  pending?: { author: MarkAuthor; color: string; points: AnnotationPoint[] },
): MarkLegendEntry[] {

  const byAuthor = new Map<string, MarkLegendEntry>()

  for (const mark of marks) {
    if (mark.alpha <= 0) continue
    const points = mark.annotation.points ?? []
    if (points.length < 2) continue
    const key = mark.author.key
    const previous = byAuthor.get(key)
    if (!previous) {
      byAuthor.set(key, { key, label: mark.author.label, color: mark.color, alpha: mark.alpha })
    } else {

      previous.label = mark.author.label
      previous.color = mark.color
      if (mark.alpha > previous.alpha) previous.alpha = mark.alpha
    }
  }

  if (pending && pending.points.length >= 2) {
    const key = pending.author.key
    const previous = byAuthor.get(key)
    if (!previous) {
      byAuthor.set(key, { key, label: pending.author.label, color: pending.color, alpha: 1 })
    } else {
      previous.label = pending.author.label
      previous.color = pending.color
      previous.alpha = 1
    }
  }

  return [...byAuthor.values()]
}
