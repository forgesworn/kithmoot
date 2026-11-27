import { readLogoImage, type LogoImage } from '../../src/logo-image.js'
import type { DeviceStore } from './device-store.js'

const KEY = /^[0-9a-f]{64}$/
const PREFIX = 'kithmoot.participant-photo.v1.'
const MAX_RECENT = 64

interface Photo {
  image: LogoImage
  src: string
}

/** A device preference for one viewer and one participant. Only local image
 * bytes reach the renderer, even if the storage entry is malformed. */
export class ParticipantPhotos {
  readonly #recent = new Map<string, { raw: string; photo: Photo }>()

  constructor(private readonly store: DeviceStore) {}

  get(viewer: string, participant: string): Photo | undefined {
    if (viewer === participant || !KEY.test(viewer) || !KEY.test(participant)) return
    const key = PREFIX + viewer + '.' + participant
    try {
      const raw = this.store.get(key)
      const cached = this.#recent.get(key)
      if (cached && raw === cached.raw) return cached.photo
      this.#recent.delete(key)
      if (!raw) return
      const image = readLogoImage(JSON.parse(raw))
      if (!image) return
      const photo = { image, src: `data:${image.mime};base64,${image.data}` }
      this.#recent.set(key, { raw, photo })
      if (this.#recent.size > MAX_RECENT) this.#recent.delete(this.#recent.keys().next().value!)
      return photo
    } catch { /* Unavailable or invalid local data leaves initials. */ }
  }

  save(viewer: string, participant: string, image: LogoImage | null): void {
    if (viewer === participant || !KEY.test(viewer) || !KEY.test(participant)) throw new Error('Choose another participant.')
    const key = PREFIX + viewer + '.' + participant
    if (image === null) this.store.remove(key)
    else {
      const checked = readLogoImage(image)
      if (!checked) throw new Error('Choose a valid photo.')
      this.store.set(key, JSON.stringify(checked))
    }
    this.#recent.delete(key)
  }
}
