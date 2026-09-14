/**
 * How loud each other participant is, on this device, remembered between
 * visits.
 *
 * One line per person this browser has actually moved off 100%: the default
 * costs nothing to remember because there is nothing to say about it, and a
 * browser that has never touched a slider keeps this empty for ever. Never
 * published - see remote-volume.ts for what a level changes locally, and
 * `render()` in main.ts for the one-speaker rule and Leave, which no stored
 * level can override.
 *
 * Pure functions over the injected store, like `device-store.ts` and
 * `verified-store.ts`. Reads and writes are wrapped in their own try/catch
 * on top of that: a browser that refuses storage (private mode, quota) must
 * lose only the memory of the setting, never the slider itself or the call
 * it is sitting next to.
 */
import type { DeviceStore } from './device-store.js'

export const VOLUME_PREFIX = 'kithmoot.volume.v1.'

const PARTICIPANT = /^[0-9a-f]{64}$/

interface StoredVolume {
  level: number
}

function keyFor(participant: string): string {
  return VOLUME_PREFIX + participant
}

/**
 * This browser's remembered level for `participant`, or undefined for the
 * ordinary case: nobody has touched their slider, nothing was ever written,
 * or what is there cannot be trusted - a malformed record is treated the
 * same as no record, never as a level to apply.
 */
export function loadVolumeLevel(store: DeviceStore, participant: string): number | undefined {
  if (!PARTICIPANT.test(participant)) return undefined
  let raw: string | null
  try {
    raw = store.get(keyFor(participant))
  } catch {
    return undefined
  }
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<StoredVolume>
    if (typeof parsed.level !== 'number' || !Number.isFinite(parsed.level)) return undefined
    if (parsed.level < 0 || parsed.level > 2) return undefined
    return parsed.level
  } catch {
    return undefined
  }
}

/**
 * Remembers `level` for `participant`, or forgets it at exactly 100% - the
 * untouched default is not worth a line in storage, and this is also how a
 * slider dragged back to the middle clears whatever was there before.
 */
export function storeVolumeLevel(store: DeviceStore, participant: string, level: number): void {
  if (!PARTICIPANT.test(participant)) return
  if (level === 1) {
    try {
      store.remove(keyFor(participant))
    } catch {
      // Best effort: the default is what a missing record already means.
    }
    return
  }
  try {
    store.set(keyFor(participant), JSON.stringify({ level } satisfies StoredVolume))
  } catch {
    // The slider still works for the rest of this visit; only the memory of
    // it is lost, which must never be the thing that breaks a call.
  }
}

/**
 * How many participants this browser holds a non-default level for - a
 * count for diagnostics, never the keys or the levels themselves. See
 * `collectDiagnostics` in main.ts.
 */
export function volumeLevelCount(store: DeviceStore): number {
  try {
    return store.keys().filter((key) => key.startsWith(VOLUME_PREFIX)).length
  } catch {
    return 0
  }
}
