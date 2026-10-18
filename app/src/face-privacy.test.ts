import { afterEach, expect, test, vi } from 'vitest'
import { FacePrivacy } from './face-privacy.js'
import type { FaceDetector } from '../../src/face-privacy.js'

afterEach(() => vi.unstubAllGlobals())

function fixture(load: () => Promise<FaceDetector>) {
  vi.stubGlobal('Path2D', class { constructor(_path: string) {} })
  const ctx = { save: vi.fn(), restore: vi.fn(), resetTransform: vi.fn(), fillRect: vi.fn(), translate: vi.fn(), scale: vi.fn(), fill: vi.fn() }
  const canvas = { width: 640, height: 480, getContext: () => ctx } as unknown as HTMLCanvasElement
  const privacy = new FacePrivacy(canvas, () => {}, load)
  const camera = vi.fn()
  return { privacy, ctx, camera, draw: (stamp = 100) => privacy.render({}, 640, 480, stamp, camera) }
}

test('avatar and loading never draw the camera, and avatar never loads a detector', async () => {
  const load = vi.fn(() => new Promise<FaceDetector>(() => {}))
  const f = fixture(load)
  f.privacy.setMode('avatar')
  f.draw()
  expect(f.ctx.fillRect).toHaveBeenCalledWith(0, 0, 640, 480)
  expect(load).not.toHaveBeenCalled()
  f.privacy.setMode('mask')
  f.draw()
  expect(load).toHaveBeenCalledOnce()
  expect(f.camera).not.toHaveBeenCalled()
})

test('loss and detection failure conceal; only a fresh detection permits the camera', async () => {
  const detector = { detect: vi.fn(() => [{ x: 100, y: 100, width: 100, height: 100 }]), close: vi.fn() }
  const f = fixture(async () => detector)
  f.privacy.setMode('mask')
  f.draw()
  await Promise.resolve()
  f.draw(101)
  expect(f.camera).toHaveBeenCalledOnce()
  detector.detect.mockReturnValueOnce([])
  f.draw(102)
  expect(f.camera).toHaveBeenCalledOnce()
  expect(f.privacy.state.covered).toBe(true)
  detector.detect.mockImplementationOnce(() => { throw new Error('lost device') })
  f.draw(103)
  expect(f.camera).toHaveBeenCalledOnce()
  expect(detector.close).toHaveBeenCalledOnce()
  f.draw(104)
  expect(f.camera).toHaveBeenCalledOnce()
})

test('a late model load cannot restore tracking after switching to avatar or closing', async () => {
  let finish!: (detector: FaceDetector) => void
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  const detector = { detect: vi.fn(), close: vi.fn() }
  f.privacy.setMode('mask')
  f.draw()
  f.privacy.setMode('avatar')
  finish(detector)
  await Promise.resolve()
  f.draw()
  expect(detector.close).toHaveBeenCalledOnce()
  expect(detector.detect).not.toHaveBeenCalled()
  expect(f.camera).not.toHaveBeenCalled()
  f.privacy.close()
})

test('model rejection and broken artwork both retain the opaque cover', async () => {
  const f = fixture(async () => { throw new Error('model unavailable') })
  f.ctx.fill.mockImplementation(() => { throw new Error('painting failed') })
  f.privacy.setMode('mask')
  f.draw()
  await Promise.resolve(); await Promise.resolve()
  expect(f.camera).not.toHaveBeenCalled()
  expect(f.ctx.resetTransform).toHaveBeenCalled()
  expect(f.ctx.fillRect).toHaveBeenLastCalledWith(0, 0, 640, 480)
  expect(f.privacy.state.covered).toBe(true)
})
