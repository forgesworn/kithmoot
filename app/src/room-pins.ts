/**
 * Pinned rooms, and the order the rooms rail shows rooms in.
 *
 * Asked for by Morgs: the rail should put the room with the latest activity
 * at the top, and a person should be able to pin rooms into a section of
 * their own above the rest. Pinned rooms are ordered by activity too, inside
 * that section: pinning many does not freeze them, it only keeps them up
 * there.
 *
 * Pins belong to this device, like the rail's open or collapsed state. They
 * say nothing about the room to anybody else.
 */

const STORAGE_KEY = 'kithmoot.pinned-rooms.v1'

/** The room ids pinned on this device. A storage failure, or anything that
 *  is not a list of ids, pins nothing. */
export function loadPins(storage: Pick<Storage, 'getItem'>): Set<string> {
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (Array.isArray(raw)) return new Set(raw.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)))
  } catch {
    // Fall through: nothing pinned.
  }
  return new Set()
}

/** Pins or unpins `roomId`, remembers it, and returns the new set. Still
 *  returned when storage refuses, so the rail follows for this session. */
export function setPinned(storage: Pick<Storage, 'getItem' | 'setItem'>, roomId: string, pinned: boolean): Set<string> {
  const pins = loadPins(storage)
  if (pinned) pins.add(roomId)
  else pins.delete(roomId)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...pins].sort()))
  } catch {
    // Nothing to do: the rail still shows it this session.
  }
  return pins
}

/**
 * The rail's order: pinned rooms first, newest activity first among them,
 * then everything else, newest first. `held` is the order last shown, kept
 * while the person has the pointer or focus in the rail so nothing moves
 * under them; a room that has arrived since goes after the rooms already
 * shown in its section, and a room that changed section moves at once,
 * because pinning it is the person's own doing.
 */
export function arrangeRooms<T extends { roomId: string }>(
  rooms: readonly T[],
  pins: ReadonlySet<string>,
  activityOf: (room: T) => number,
  held?: readonly string[],
): { pinned: T[]; rest: T[] } {
  const byActivity = [...rooms].sort((a, b) => activityOf(b) - activityOf(a) || a.roomId.localeCompare(b.roomId))
  const keep = (list: T[]): T[] => {
    if (!held) return list
    const position = new Map(held.map((id, i) => [id, i]))
    return [...list].sort((a, b) => (position.get(a.roomId) ?? Infinity) - (position.get(b.roomId) ?? Infinity))
  }
  return {
    pinned: keep(byActivity.filter(room => pins.has(room.roomId))),
    rest: keep(byActivity.filter(room => !pins.has(room.roomId))),
  }
}
