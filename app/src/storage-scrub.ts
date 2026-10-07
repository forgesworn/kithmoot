/**
 * Take every trace of a room out of a browser's storage, for a room that
 * self-destructed. Keys that name the room go whole (`clearRoomLocally`);
 * this is for the shared records that name it inside their value: a map of
 * every room's relays, a list of pinned rooms, a project's rooms. The room's
 * entry is cut out and the rest of the record is written back untouched.
 *
 * A value that names the room in a way this cannot cut out cleanly (plain
 * text, or JSON with the id inside a longer string) is left alone and
 * reported, rather than guessed at.
 */
import type { DeviceStore } from './device-store.js'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** The value with every mention of `names` cut out, and whether anything
 *  was. A property whose name contains one goes; an array element that is one, or an
 *  object whose own string property is one, goes. */
export function scrubJson(value: Json, names: ReadonlySet<string>): { value: Json; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false
    const out: Json[] = []
    for (const item of value) {
      if (typeof item === 'string' && names.has(item)) { changed = true; continue }
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).some(v => typeof v === 'string' && names.has(v))) { changed = true; continue }
      const inner = scrubJson(item, names)
      changed ||= inner.changed
      out.push(inner.value)
    }
    return { value: out, changed }
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: { [key: string]: Json } = {}
    for (const [key, item] of Object.entries(value)) {
      // A key naming the room, alone or scoped (`room:<id>`), goes whole.
      if ([...names].some(name => key.includes(name))) { changed = true; continue }
      const inner = scrubJson(item, names)
      changed ||= inner.changed
      out[key] = inner.value
    }
    return { value: out, changed }
  }
  return { value, changed: false }
}

/** Scrub every record in `store` that mentions one of `names`. Returns the
 *  keys still mentioning one afterwards, which is what could not be cut. */
export function scrubStore(store: DeviceStore, names: readonly string[]): string[] {
  const wanted = new Set(names.filter(name => name.length > 0))
  const left: string[] = []
  for (const key of store.keys()) {
    if ([...wanted].some(name => key.includes(name))) { store.remove(key); continue }
    const raw = store.get(key)
    if (raw === null || ![...wanted].some(name => raw.includes(name))) continue
    try {
      const scrubbed = scrubJson(JSON.parse(raw) as Json, wanted)
      if (scrubbed.changed) store.set(key, JSON.stringify(scrubbed.value))
    } catch { /* Not JSON: reported below. */ }
    const after = store.get(key)
    if (after !== null && [...wanted].some(name => after.includes(name))) left.push(key)
  }
  return left.sort()
}
