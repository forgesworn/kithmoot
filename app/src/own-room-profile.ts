import { sanitiseDisplayName } from '../../src/display-name.js'
import { logoDataUrl } from '../../src/logo-image.js'
import { newerProfile, readRoomProfile, type RoomProfile } from '../../src/room-profile.js'
import type { DeviceStore } from './device-store.js'
import { cachedPhotoThumbnail } from './logo-editor.js'
import { cachedPeoplePicture } from './people-pictures.js'
import { safePicture } from './profiles.js'

const PREFIX = 'kithmoot.own-room-profile.v1.'
const display = new WeakMap<RoomProfile, { name?: string; picture?: string }>()
type SavedProfile = RoomProfile & { omitPhoto?: true }

export function roomProfileDisplay(profile: RoomProfile): { name?: string; picture?: string } {
  const held = display.get(profile)
  if (held) return held
  const content = JSON.parse(profile.event.content) as Record<string, unknown>
  const result = {
    name: sanitiseDisplayName(content.display_name) ?? sanitiseDisplayName(content.name),
    picture: logoDataUrl(profile.photo),
  }
  display.set(profile, result)
  return result
}

/** Only the local account's own profile is kept here. Peer profiles live
 * in the encrypted room session and are never used to seed public lookups. */
export class OwnRoomProfile {
  #last?: { account: string; raw: string | null; profile?: SavedProfile }

  constructor(private readonly store: DeviceStore, private readonly now: () => number) {}

  get(account: string): SavedProfile | undefined {
    const raw = this.store.get(PREFIX + account)
    if (this.#last?.account === account && this.#last.raw === raw) return this.#last.profile
    let profile: SavedProfile | undefined
    try {
      if (raw && raw.length <= 40_000) {
        const saved = JSON.parse(raw)
        profile = readRoomProfile(saved, account, this.now())
        if (profile && saved.omitPhoto === true) profile.omitPhoto = true
      }
    } catch { /* An unreadable cache has no profile. */ }
    this.#last = { account, raw, profile }
    return profile
  }

  save(account: string, value: RoomProfile, omitPhoto = false): void {
    const profile = readRoomProfile(value, account, this.now())
    if (!profile) throw new Error('Paste a signed kind 0 from this Nostr account.')
    const previous = this.get(account)
    if (previous && newerProfile(previous.event, profile.event)) throw new Error('This device has a newer signed profile from this account.')
    this.store.set(PREFIX + account, JSON.stringify({ ...profile, ...(omitPhoto ? { omitPhoto: true } : {}) }))
  }

  async forRoom(account: string): Promise<RoomProfile | undefined> {
    const profile = this.get(account)
    if (!profile || profile.photo || profile.omitPhoto) return profile
    const picture = safePicture(JSON.parse(profile.event.content).picture)
    if (!picture) return profile
    const bytes = await cachedPeoplePicture(picture)
    const photo = bytes && await cachedPhotoThumbnail(bytes)
    // An account's newer profile may have arrived during the cache read.
    if (this.get(account) !== profile) return this.get(account)
    return photo ? { event: profile.event, photo } : profile
  }
}
