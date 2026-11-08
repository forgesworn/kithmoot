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
    video,
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
    async start(opts: { portrait?: boolean } = {}) {
      const pipeline = new CameraPipeline({ mode: 'off', facePrivacy: 'off', framing: false, portrait: opts.portrait })
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

// -- the frame-level path (Chromium: MediaStreamTrackProcessor and MediaStreamTrackGenerator) --

class FakeFrame {
  closed = false
  constructor(readonly source: unknown, readonly timestamp: number) {}
  close() { this.closed = true }
}

function setupFrameApi(opts: { mode?: 'off' | 'blur'; portrait?: boolean } = {}) {
  const f = setup()
  const cameras = new Map<unknown, ReadableStreamDefaultController<FakeFrame>>()
  const cancelled: unknown[] = []
  const written: FakeFrame[] = []
  const generators: Array<FakeTrack & { writable: WritableStream<FakeFrame> }> = []
  vi.stubGlobal('MediaStreamTrackProcessor', class {
    readonly readable: ReadableStream<FakeFrame>
    constructor({ track }: { track: unknown }) {
      this.readable = new ReadableStream<FakeFrame>({
        start: (controller) => { cameras.set(track, controller) },
        cancel: () => { cancelled.push(track) },
      })
    }
  })
  vi.stubGlobal('MediaStreamTrackGenerator', class extends FakeTrack {
    readonly writable = new WritableStream<FakeFrame>({ write: (frame) => { written.push(frame) } })
    constructor() {
      super('generator')
      generators.push(this)
    }
  })
  vi.stubGlobal('VideoFrame', class extends FakeFrame {
    constructor(source: unknown, init: { timestamp: number }) { super(source, init.timestamp) }
  })
  let clock = 1_000_000_000
  return {
    ...f,
    written,
    generators,
    cancelled,
    /** One camera frame from `camera` (default: the newest), stamped after the last. */
    async cameraFrame(camera = f.sources.at(-1)) {
      const frame = new FakeFrame(camera, (clock += 41_667))
      cameras.get(camera)!.enqueue(frame)
      await vi.advanceTimersByTimeAsync(0)
      return frame
    },
    async start() {
      const pipeline = new CameraPipeline({ mode: opts.mode ?? 'off', facePrivacy: 'off', framing: false, portrait: opts.portrait })
      running.push(pipeline)
      const track = await pipeline.start()
      return { pipeline, track }
    },
  }
}

const canvasFrames = (f: ReturnType<typeof setupFrameApi>) => f.written.filter((frame) => frame.source === f.output())
const cameraFrames = (f: ReturnType<typeof setupFrameApi>) => f.written.filter((frame) => frame.source !== f.output())

test('with nothing asked of the picture, camera frames are published as they come, on a generator track', async () => {
  const f = setupFrameApi()
  const { pipeline, track } = await f.start()
  expect(track).toBe(f.generators[0])
  expect(pipeline.track).toBe(track)
  const first = await f.cameraFrame()
  const second = await f.cameraFrame()
  f.decode()
  expect(f.written).toEqual([first, second])
  expect(canvasFrames(f)).toHaveLength(0)
  expect(pipeline.stats.directFrameCount).toBe(2)
})

test('with blur on, no camera frame is ever written: each is closed and only the finished canvas goes out', async () => {
  const f = setupFrameApi({ mode: 'blur' })
  const { pipeline } = await f.start()
  const frames = [await f.cameraFrame(), await f.cameraFrame()]
  f.decode()
  await vi.advanceTimersByTimeAsync(0)
  expect(cameraFrames(f)).toHaveLength(0)
  for (const frame of frames) expect(frame.closed).toBe(true)
  expect(canvasFrames(f).length).toBeGreaterThan(0)
  expect(pipeline.stats.directFrameCount).toBe(0)
})

test('switching an effect on stops camera frames from the very next one, before any render', async () => {
  const f = setupFrameApi()
  const { pipeline } = await f.start()
  await f.cameraFrame()
  pipeline.setMode('blur')
  const after = await f.cameraFrame()
  expect(after.closed).toBe(true)
  expect(f.written).not.toContain(after)
  expect(cameraFrames(f)).toHaveLength(1)
  f.decode()
  await vi.advanceTimersByTimeAsync(0)
  expect(canvasFrames(f).length).toBeGreaterThan(0)
})

test('face privacy on stops camera frames and puts the cover out at once', async () => {
  const f = setupFrameApi()
  const { pipeline } = await f.start()
  await f.cameraFrame()
  pipeline.setFacePrivacyMode('avatar')
  await vi.advanceTimersByTimeAsync(0)
  expect(canvasFrames(f)).toHaveLength(1)
  const after = await f.cameraFrame()
  expect(after.closed).toBe(true)
  expect(cameraFrames(f)).toHaveLength(1)
})

test('switching the effect back off resumes camera frames, never older than the last canvas frame', async () => {
  const f = setupFrameApi({ mode: 'blur' })
  const { pipeline } = await f.start()
  await f.cameraFrame()
  f.decode()
  await vi.advanceTimersByTimeAsync(0)
  const lastCanvas = canvasFrames(f).at(-1)!
  pipeline.setMode('off')
  const next = await f.cameraFrame()
  for (const frame of cameraFrames(f)) expect(frame.timestamp).toBeGreaterThan(lastCanvas.timestamp)
  expect(f.written.at(-1) === next || next.closed).toBe(true)
  const later = await f.cameraFrame()
  expect(f.written.at(-1)).toBe(later)
  const stamps = f.written.map((frame) => frame.timestamp)
  expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
})

test('a camera flip with the effect off reads the new camera and stops reading the old one; the published track stays the same', async () => {
  const f = setupFrameApi()
  const { pipeline, track } = await f.start()
  const old = f.sources[0]
  await f.cameraFrame(old)
  await pipeline.useCamera({ facingMode: 'environment' })
  const fresh = f.sources[1]
  expect(fresh).toBeDefined()
  expect(pipeline.track).toBe(track)
  expect(f.cancelled).toContain(old)
  const next = await f.cameraFrame(fresh)
  expect(f.written.at(-1)).toBe(next)
})

test('a camera flip with blur on still writes no camera frame from either camera', async () => {
  const f = setupFrameApi({ mode: 'blur' })
  const { pipeline } = await f.start()
  await f.cameraFrame()
  await pipeline.useCamera({ facingMode: 'environment' })
  await f.cameraFrame()
  f.decode()
  await vi.advanceTimersByTimeAsync(0)
  expect(cameraFrames(f)).toHaveLength(0)
})

test('stop ends the generator and the camera reader', async () => {
  const f = setupFrameApi()
  const { pipeline, track } = await f.start()
  await f.cameraFrame()
  pipeline.stop()
  running.splice(running.indexOf(pipeline), 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(track.readyState).toBe('ended')
  expect(f.cancelled).toContain(f.sources[0])
})


test('portrait publication centre-crops the processed picture and remains portrait while hidden', async () => {
  const f = setup()
  const pipeline = await f.start({ portrait: true })
  f.decode()
  expect(f.output().width).toBe(270)
  expect(f.output().height).toBe(480)
  expect(f.output().ctx.drawImage).toHaveBeenLastCalledWith(f.stage(), 185, 0, 270, 480, 0, 0, 270, 480)
  f.document.visibilityState = 'hidden'
  await vi.advanceTimersByTimeAsync(1_000)
  expect(pipeline.stats.keepAliveCount).toBe(1)
  expect(f.output().ctx.drawImage).toHaveBeenLastCalledWith(f.stage(), 185, 0, 270, 480, 0, 0, 270, 480)
})

test('portrait publication cannot bypass the crop through the native frame generator', async () => {
  const f = setupFrameApi({ portrait: true })
  const { pipeline } = await f.start()
  const raw = await f.cameraFrame()
  f.decode()
  await vi.advanceTimersByTimeAsync(0)
  expect(raw.closed).toBe(true)
  expect(cameraFrames(f)).toHaveLength(0)
  expect(canvasFrames(f).length).toBeGreaterThan(0)
  expect(pipeline.stats.directFrameCount).toBe(0)
  expect(f.output().width / f.output().height).toBe(9 / 16)
})

test('portrait publication follows a camera size change without stretching', async () => {
  const f = setup()
  const pipeline = await f.start({ portrait: true })
  f.decode()
  f.video.videoWidth = 720
  f.video.videoHeight = 1280
  await pipeline.useCamera({ deviceId: 'portrait-camera' })
  f.decode()
  expect(f.output().ctx.drawImage).toHaveBeenLastCalledWith(f.stage(), 0, 0, 720, 1280, 0, 0, 720, 1280)
  expect(f.output().width).toBe(720)
  expect(f.output().height).toBe(1280)
})
