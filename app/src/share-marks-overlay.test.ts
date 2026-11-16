import { describe, it, expect } from 'vitest'
import { ShareMarksOverlay } from './share-marks-overlay.js'
import type { ScreenAnnotation } from '../../src/signal.js'

describe('native compositor presentation ownership', () => {
  function fixture(begin: () => Promise<boolean> = async () => true) {
    const leases: string[] = [], ended: string[] = [], drawn: ScreenAnnotation[] = [], painted: unknown[] = []
    let receive: ((lease: string, command: { op: 'stroke' | 'clear' | 'stop'; points?: { x: number; y: number }[] }) => void) | undefined
    let watching = false, stopped = false
    const overlay = new ShareMarksOverlay({
      supportsCompositorMarks: true,
      compositorMarksBegin: async lease => { leases.push(lease); return begin() },
      compositorMarksEnd: lease => { ended.push(lease) },
      compositorMarksPaint: (lease, marks) => { painted.push({ lease, marks }) },
      onCompositorMark: callback => { receive = callback; return () => { if (receive === callback) receive = undefined } },
    } satisfies Partial<NonNullable<Window['kithmootDesktop']>> as unknown as NonNullable<Window['kithmootDesktop']>, {
      paint: () => () => {},
      watch: (_id, paint) => { watching = true; paint([]); return () => { watching = false } },
      draw: annotation => drawn.push(annotation), stop: () => { stopped = true },
    })
    return { overlay, leases, ended, drawn, painted, get receive() { return receive }, get watching() { return watching }, get stopped() { return stopped } }
  }
  it('binds native commands to the active presentation and closes its subscriptions', async () => {
    const f = fixture()
    expect(await f.overlay.openCompositor('window', () => 'share-one')).toBe(true)
    const lease = f.leases[0]!
    f.receive?.('old-lease', { op: 'clear' })
    expect(f.drawn).toEqual([])
    f.receive?.(lease, { op: 'stroke', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
    expect(f.drawn[0]).toMatchObject({ op: 'stroke', shareId: 'share-one' })
    expect(f.watching).toBe(true)
    f.receive?.(lease, { op: 'stop' })
    expect(f.stopped).toBe(true)
    f.overlay.close()
    expect(f.ended).toEqual([lease])
    expect(f.watching).toBe(false)
    expect(f.receive).toBeUndefined()
  })
  it('cannot revive an overlay when acquisition completes after the share ended', async () => {
    let resolve!: (ready: boolean) => void
    const f = fixture(() => new Promise<boolean>(done => { resolve = done }))
    const opening = f.overlay.openCompositor('screen', () => 'old-share')
    f.overlay.close()
    resolve(true)
    expect(await opening).toBe(false)
    expect(f.watching).toBe(false)
    expect(f.ended).toEqual(f.leases)
  })
})
