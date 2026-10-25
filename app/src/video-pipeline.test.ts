import { afterEach, expect, test, vi } from 'vitest'
import { CameraPipeline } from './video-pipeline.js'

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  muted = false
  requestFrame?: ReturnType<typeof vi.fn>

  constructor(readonly deviceId: string) { super() }

  getSettings() { return { deviceId: this.deviceId } }
  stop() { this.readyState = 'ended' }
}

function stream(track: FakeTrack): MediaStream {
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
}

function fakeContext() {
  return {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    resetTransform: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    fill: vi.fn(),
  }
}

class FakeImage {
  decoding = ''
  naturalWidth = 640
  naturalHeight = 480
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
}

const running: CameraPipeline[] = []

afterEach(() => {
  for (const pipeline of running.splice(0)) pipeline.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function setup(withRequestFrame = true) {
  vi.useFakeTimers()
  const sources: FakeTrack[] = []
  const capture = vi.fn(async () => {
    const track = new FakeTrack(`camera-${sources.length}`)
    sources.push(track)
    return stream(track)
  })
  const outputTrack = new FakeTrack('output')
  if (withRequestFrame) outputTrack.requestFrame = vi.fn()
  const video = {
    videoWidth: 640,
    videoHeight: 480,
    srcObject: null,
    play: vi.fn(async () => {}),
  }
  const canvases: Array<{ width: number; height: number; ctx: ReturnType<typeof fakeContext> }> = []
  const document = {
    visibilityState: 'visible',
    createElement: vi.fn((tag: string) => {
      if (tag === 'video') return video
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
      const canvas = {
        width: 300,
        height: 150,
        ctx: fakeContext(),
        getContext() { return this.ctx },
        captureStream: () => stream(outputTrack),
      }
      canvases.push(canvas)
      return canvas
    }),
  }
  const images: FakeImage[] = []
  vi.stubGlobal('Image', class extends FakeImage {
    constructor() {
      super()
      images.push(this)
    }
  })
  vi.stubGlobal('Path2D', class { constructor(_path: string) {} })
  vi.stubGlobal('document', document)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } })
  let frameCallback: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frameCallback = callback
    return 1
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())

  return {
    document,
    images,
    outputTrack,
    sources,
    output: () => canvases[0]!,
    stage: () => canvases[1]!,
    decode() {
      const callback = frameCallback
      if (!callback) throw new Error('no decoded-frame callback scheduled')
      callback(performance.now())
    },
    async start() {
      const pipeline = new CameraPipeline({ mode: 'off', facePrivacy: 'off', framing: false })
      running.push(pipeline)
      await pipeline.start()
      return pipeline
    },
  }
}

test('hidden callbacks and watchdog repeat the safe frame by blitting, without re-rendering effects', async () => {
  const f = setup()
  const pipeline = await f.start()
  f.decode()
  f.document.visibilityState = 'hidden'
  for (let tick = 0; tick < 50; tick += 1) {
    await vi.advanceTimersByTimeAsync(100)
    f.decode()
  }
  expect(f.outputTrack.requestFrame).toHaveBeenCalledTimes(5)
  // One full render blitted the stage onto the output; each keep-alive
  // repeated that safe frame with one more blit and nothing else.
  expect(f.stage().ctx.drawImage).toHaveBeenCalledOnce()
  expect(f.output().ctx.drawImage).toHaveBeenCalledTimes(6)
  for (const call of f.output().ctx.drawImage.mock.calls) expect(call[0]).toBe(f.stage())
  expect(pipeline.totals.passthrough).toBe(1)
  expect(pipeline.stats).toMatchObject({ fullRenderCount: 1, keepAliveCount: 5 })
  expect(pipeline.stats.lastKeepAliveAt).toBeGreaterThan(pipeline.stats.lastFullRenderAt)

  f.document.visibilityState = 'visible'
  f.decode()
  expect(f.stage().ctx.drawImage).toHaveBeenCalledTimes(2)
  expect(f.output().ctx.drawImage).toHaveBeenCalledTimes(7)
  expect(f.outputTrack.requestFrame).toHaveBeenCalledTimes(5)
  expect(pipeline.stats).toMatchObject({ fullRenderCount: 2, keepAliveCount: 5 })
})

test('keep-alive blits only the safe stage when the track has no requestFrame', async () => {
  const f = setup(false)
  const pipeline = await f.start()
  f.decode()
  f.document.visibilityState = 'hidden'
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.outputTrack.requestFrame).toBeUndefined()
  expect(f.stage().ctx.drawImage).toHaveBeenCalledOnce()
  expect(f.output().ctx.drawImage).toHaveBeenCalledTimes(6)
  for (const call of f.output().ctx.drawImage.mock.calls) expect(call[0]).toBe(f.stage())
  expect(pipeline.totals.passthrough).toBe(1)
  expect(pipeline.stats).toMatchObject({ fullRenderCount: 1, keepAliveCount: 5 })
})

const invalidatingChanges: Array<readonly [string, (pipeline: CameraPipeline) => void | Promise<void>]> = [
  ['camera source', pipeline => pipeline.useCamera({ deviceId: 'another-camera' })],
  ['effect mode', pipeline => { pipeline.setMode('blur') }],
  ['face privacy off', pipeline => { pipeline.setFacePrivacyMode('off') }],
  ['framing', pipeline => { pipeline.setFraming(true) }],
  ['strength', pipeline => { pipeline.setStrength(0.8) }],
]

for (const [name, change] of invalidatingChanges) {
  test(`${name} requires a fresh render before hidden keep-alive resumes`, async () => {
    const f = setup()
    const pipeline = await f.start()
    f.decode()
    f.document.visibilityState = 'hidden'
    await change(pipeline)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.outputTrack.requestFrame).not.toHaveBeenCalled()
    expect(pipeline.stats).toMatchObject({ fullRenderCount: 2, keepAliveCount: 0 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.outputTrack.requestFrame).toHaveBeenCalledOnce()
    expect(pipeline.stats).toMatchObject({ fullRenderCount: 2, keepAliveCount: 1 })
  })
}

test('async background application invalidates again when the image lands', async () => {
  const f = setup()
  const pipeline = await f.start()
  f.decode()
  f.document.visibilityState = 'hidden'
  const applying = pipeline.setBackground({ id: 'test', label: 'Test', url: 'test.svg' })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(pipeline.stats).toMatchObject({ fullRenderCount: 2, keepAliveCount: 0 })

  f.images[0]!.onload!()
  await applying
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.outputTrack.requestFrame).not.toHaveBeenCalled()
  expect(pipeline.stats).toMatchObject({ fullRenderCount: 3, keepAliveCount: 0 })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.outputTrack.requestFrame).toHaveBeenCalledOnce()
})

test('privacy cover is synchronous and privacy off cannot keep alive the old cover', async () => {
  const f = setup()
  const pipeline = await f.start()
  f.decode()
  f.document.visibilityState = 'hidden'
  pipeline.setFacePrivacyMode('avatar')
  expect(f.output().ctx.drawImage).toHaveBeenCalledTimes(2)
  expect(f.stage().ctx.fillRect).toHaveBeenCalled()
  expect(f.stage().ctx.drawImage).toHaveBeenCalledOnce()

  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.outputTrack.requestFrame).not.toHaveBeenCalled()
  expect(f.output().ctx.drawImage).toHaveBeenCalledTimes(3)
  expect(f.stage().ctx.drawImage).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.outputTrack.requestFrame).toHaveBeenCalledOnce()

  pipeline.setFacePrivacyMode('off')
  await vi.advanceTimersByTimeAsync(100)
  expect(f.outputTrack.requestFrame).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(900)
  expect(f.outputTrack.requestFrame).toHaveBeenCalledOnce()
  expect(f.stage().ctx.drawImage).toHaveBeenCalledTimes(2)
  // Three full renders, one keep-alive repeat of the safe frame, and the
  // synchronous privacy-off clear that replaces the cover.
  expect(f.output().ctx.drawImage).toHaveBeenCalledTimes(5)
  expect(pipeline.stats).toMatchObject({ fullRenderCount: 3, keepAliveCount: 1 })
})
