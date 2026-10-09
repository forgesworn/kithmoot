import { ActiveSpeaker, fitRect, gridRects, type Rect } from './call-layout.js'

export type VideoRecordingLayout = 'gallery' | 'speaker' | 'screen-camera'

/** Tracks here must already be authorised and privacy-processed by the call. */
export interface RecordingPerson {
  id: string
  label: string
  camera?: MediaStreamTrack
  fallback: string
  speaking: boolean
  muted: boolean
}

export interface RecordingVideoSnapshot {
  origin: string
  people: RecordingPerson[]
  /** The selected participant/device, never whichever share happens to lead. */
  share?: { label: string; track?: MediaStreamTrack; camera?: MediaStreamTrack; fallback: string }
}

interface Decoder {
  video: HTMLVideoElement
  seenAt: number
  callback?: number
}

const WIDTH = 1280, HEIGHT = 720, FRAME_MS = 1000 / 15
const MAX_GALLERY_TILES = 24

/** One local, muted canvas composition. It never captures the page or display.
 * Independent decoders keep recording independent of gallery paging, hidden
 * tiles and popouts. Only the chosen layout's live inputs are decoded. */
export class RecordingVideo {
  readonly track: MediaStreamTrack
  readonly #canvas: HTMLCanvasElement
  readonly #context: CanvasRenderingContext2D
  readonly #layout: VideoRecordingLayout
  readonly #snapshot: () => RecordingVideoSnapshot | undefined
  readonly #onFailure: (reason: string) => void
  readonly #decoders = new Map<MediaStreamTrack, Decoder>()
  readonly #speaker = new ActiveSpeaker()
  #timer?: ReturnType<typeof setTimeout>
  #paused = false
  #closed = false

  constructor(options: { layout: VideoRecordingLayout; snapshot: () => RecordingVideoSnapshot | undefined; onFailure: (reason: string) => void }) {
    this.#layout = options.layout
    this.#snapshot = options.snapshot
    this.#onFailure = options.onFailure
    this.#canvas = document.createElement('canvas')
    this.#canvas.width = WIDTH; this.#canvas.height = HEIGHT
    const context = this.#canvas.getContext('2d', { alpha: false })
    if (!context || typeof this.#canvas.captureStream !== 'function') throw new Error('This browser cannot compose a video recording.')
    this.#context = context
    try {
      this.#paint()
      const track = this.#canvas.captureStream(15).getVideoTracks()[0]
      if (!track) throw new Error('This browser did not provide a recording video track.')
      this.track = track
    } catch (error) { this.#retain(new Set()); throw error }
    this.#schedule()
  }

  pause(): void {
    this.#paused = true
    clearTimeout(this.#timer)
    this.#retain(new Set())
  }

  resume(): void {
    if (this.#closed || !this.#paused) return
    this.#paused = false
    this.#paint()
    this.#schedule()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#retain(new Set())
    this.track.stop()
  }

  #schedule(): void {
    if (this.#closed || this.#paused) return
    this.#timer = setTimeout(() => {
      try {
        if (this.track.readyState !== 'live') throw new Error('The composed video track ended.')
        this.#paint(); this.#schedule()
      }
      catch { this.pause(); this.#onFailure('video composition failed') }
    }, FRAME_MS)
  }

  #paint(): void {
    const snapshot = this.#snapshot()
    if (!snapshot) throw new Error('The originating call is no longer available.')
    const ctx = this.#context
    ctx.fillStyle = '#10151d'; ctx.fillRect(0, 0, WIDTH, HEIGHT)
    this.#text(snapshot.origin, { x: 20, y: 0, width: WIDTH - 40, height: 46 }, 22)
    const area: Rect = { x: 16, y: 52, width: WIDTH - 32, height: HEIGHT - 72 }
    const wanted = new Set<MediaStreamTrack>()
    const people = snapshot.people
    if (this.#layout === 'gallery') {
      const visible = people.slice(0, MAX_GALLERY_TILES)
      const extra = people.length - visible.length
      const rects = gridRects(area, visible.length + (extra > 0 ? 1 : 0))
      visible.forEach((person, i) => this.#person(person, rects[i]!, wanted))
      if (extra > 0) this.#picture(undefined, rects.at(-1)!, `${extra} more call devices`, 'Audio only: gallery limit reached', wanted)
      if (!people.length) this.#picture(undefined, area, 'Waiting for call participants', '', wanted)
    } else if (this.#layout === 'speaker') {
      const selected = this.#speaker.update(new Set(people.filter(person => person.speaking).map(person => person.id)), people.map(person => person.id), performance.now()).current
      const person = people.find(person => person.id === selected)
      if (person) this.#person(person, area, wanted)
      else this.#picture(undefined, area, 'Waiting for a speaker', '', wanted)
    } else {
      const share = snapshot.share
      this.#picture(share?.track, area, share?.label ?? 'Selected screen share', share?.fallback ?? 'Share unavailable', wanted)
      if (share) this.#picture(share.camera, { x: WIDTH - 304, y: HEIGHT - 218, width: 280, height: 174 }, `${share.label} · camera`, 'Camera off or unavailable', wanted)
    }
    this.#retain(wanted)
  }

  #person(person: RecordingPerson, area: Rect, wanted: Set<MediaStreamTrack>): void {
    this.#picture(person.camera, area, person.label + (person.muted ? ' · muted' : ''), person.fallback, wanted)
    if (person.speaking) {
      this.#context.strokeStyle = '#f49a42'; this.#context.lineWidth = 4
      this.#context.strokeRect(area.x + 2, area.y + 2, area.width - 4, area.height - 4)
    }
  }

  #picture(track: MediaStreamTrack | undefined, area: Rect, label: string, fallback: string, wanted: Set<MediaStreamTrack>): void {
    const ctx = this.#context
    ctx.fillStyle = '#252e3d'; ctx.fillRect(area.x, area.y, area.width, area.height)
    let painted = false
    if (track?.kind === 'video' && track.readyState === 'live' && track.enabled && !track.muted) {
      wanted.add(track)
      const decoder = this.#decoder(track), video = decoder.video
      // Never present the last decoded frame indefinitely as live video.
      if (video.readyState >= 2 && video.videoWidth && performance.now() - decoder.seenAt < 5000) {
        const box = fitRect({ ...area, height: Math.max(1, area.height - 34) }, video.videoWidth / video.videoHeight)
        ctx.drawImage(video, box.x, box.y, box.width, box.height)
        painted = true
      }
    }
    if (!painted) this.#text(track ? 'Video unavailable or reconnecting' : fallback, { ...area, height: Math.max(1, area.height - 34) }, Math.min(24, Math.max(13, area.width / 22)))
    ctx.fillStyle = '#10151de8'; ctx.fillRect(area.x, area.y + area.height - 34, area.width, 34)
    this.#text(label, { x: area.x + 8, y: area.y + area.height - 34, width: area.width - 16, height: 34 }, Math.min(20, Math.max(12, area.width / 30)))
  }

  #text(value: string, area: Rect, size: number): void {
    const ctx = this.#context
    ctx.font = `${size}px sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'
    let text = value
    while (text.length > 1 && ctx.measureText(text).width > area.width - 8) text = text.slice(0, -1)
    if (text !== value) text = text.slice(0, -1) + '…'
    ctx.fillText(text, area.x + area.width / 2, area.y + area.height / 2)
  }

  #decoder(track: MediaStreamTrack): Decoder {
    const existing = this.#decoders.get(track)
    if (existing) return existing
    const video = document.createElement('video')
    video.muted = true; video.playsInline = true; video.autoplay = true
    video.srcObject = new MediaStream([track])
    const decoder: Decoder = { video, seenAt: performance.now() }
    this.#decoders.set(track, decoder)
    if (typeof video.requestVideoFrameCallback === 'function') {
      const seen = () => {
        if (this.#decoders.get(track) !== decoder) return
        decoder.seenAt = performance.now()
        decoder.callback = video.requestVideoFrameCallback(seen)
      }
      decoder.callback = video.requestVideoFrameCallback(seen)
    } else {
      // Unsupported frame monitoring is explicit: a live-clock update is the
      // fallback, never a DOM tile that the gallery may have paused.
      video.addEventListener('timeupdate', () => { decoder.seenAt = performance.now() })
    }
    void video.play().catch(() => {})
    return decoder
  }

  #retain(wanted: Set<MediaStreamTrack>): void {
    for (const [track, decoder] of this.#decoders) {
      if (wanted.has(track)) continue
      if (decoder.callback !== undefined) decoder.video.cancelVideoFrameCallback(decoder.callback)
      decoder.video.pause(); decoder.video.srcObject = null
      this.#decoders.delete(track)
    }
  }
}
