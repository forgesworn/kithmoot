import type { DeviceStore } from './device-store.js'

export type NotificationScope = { kind: 'default' } | { kind: 'project' | 'room'; id: string }
export type NotificationMode = 'inherit' | 'all' | 'mentions' | 'off'
const PREFIX = 'kithmoot.notification-scopes.v1.'

function key(account: string | undefined, scope: NotificationScope): string {
  return PREFIX + JSON.stringify([account ?? 'visitor', scope.kind, scope.kind === 'default' ? '' : scope.id])
}

export function notificationMode(store: DeviceStore, account: string | undefined, scope: NotificationScope): NotificationMode {
  const value = store.get(key(account, scope))
  return value === 'all' || value === 'mentions' || value === 'off' ? value : scope.kind === 'default' ? 'all' : 'inherit'
}

export function setNotificationMode(store: DeviceStore, account: string | undefined, scope: NotificationScope, mode: NotificationMode): void {
  if (mode === 'inherit') store.remove(key(account, scope))
  else store.set(key(account, scope), mode)
  // Nothing already says "silent until I change it"; a timer under it would
  // only be a second, shorter answer to the same question.
  if (scope.kind === 'room' && mode === 'off') unmuteRoom(store, account, scope.id)
}

export const MUTE_PREFIX = 'kithmoot.mute-until.v1.'
/** The four lengths of a timed mute, in seconds. */
export const MUTE_FOR = { '1h': 3600, '8h': 28_800, '1d': 86_400, '1w': 604_800 } as const
/** A timed mute with its end, or 'always' when the room is set to Nothing. */
export type RoomMute = { until: number } | 'always' | undefined

const muteKey = (account: string | undefined, roomId: string): string => MUTE_PREFIX + (account ?? 'visitor') + '.' + roomId

function muteEnd(raw: string | null): number | undefined {
  if (raw === null || !/^[1-9][0-9]{0,15}$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/** Whether the room is muted now: set to Nothing, or a timed mute still running. */
export function roomMute(store: DeviceStore, account: string | undefined, roomId: string, now: number): RoomMute {
  if (notificationMode(store, account, { kind: 'room', id: roomId }) === 'off') return 'always'
  const until = muteEnd(store.get(muteKey(account, roomId)))
  return until !== undefined && until > now ? { until } : undefined
}

export function muteRoom(store: DeviceStore, account: string | undefined, roomId: string, until: number): void {
  store.set(muteKey(account, roomId), String(Math.floor(until)))
}

export function unmuteRoom(store: DeviceStore, account: string | undefined, roomId: string): void {
  store.remove(muteKey(account, roomId))
}

/** Removes every ended (or unreadable) mute, whichever account it belongs to. */
export function pruneMutes(store: DeviceStore, now: number): void {
  for (const name of store.keys()) {
    if (!name.startsWith(MUTE_PREFIX)) continue
    const until = muteEnd(store.get(name))
    if (until === undefined || until <= now) store.remove(name)
  }
}

/** The soonest end still in the future, whichever account it belongs to. */
export function nextMuteEnd(store: DeviceStore, now: number): number | undefined {
  let soonest: number | undefined
  for (const name of store.keys()) {
    if (!name.startsWith(MUTE_PREFIX)) continue
    const until = muteEnd(store.get(name))
    if (until !== undefined && until > now && (soonest === undefined || until < soonest)) soonest = until
  }
  return soonest
}

/** A timed mute > room override > project default > account default. The
 * caller applies the device's master permission switch separately. Project
 * names never need to leave this browser to decide whether an activity alert
 * is wanted. */
export function roomNotificationLevel(store: DeviceStore, account: string | undefined, roomId: string, project?: string | readonly string[], now: number = Date.now() / 1000): 'all' | 'mentions' | 'off' {
  const mute = roomMute(store, account, roomId, now)
  if (mute !== undefined) return 'off'
  const room = notificationMode(store, account, { kind: 'room', id: roomId })
  if (room !== 'inherit') return room
  const projects = typeof project === 'string' ? [project] : project ?? []
  const modes = projects.map(id => notificationMode(store, account, { kind: 'project', id }))
  // A room can belong to several shared projects. An explicit project
  // Nothing wins over another project's choice, then Every message over
  // Only mentions, unless the room itself overrides them.
  if (modes.includes('off')) return 'off'
  if (modes.includes('all')) return 'all'
  if (modes.includes('mentions')) return 'mentions'
  const fallback = notificationMode(store, account, { kind: 'default' })
  return fallback === 'inherit' ? 'all' : fallback
}

export function roomNotificationsEnabled(store: DeviceStore, account: string | undefined, roomId: string, project?: string | readonly string[], now?: number): boolean {
  return roomNotificationLevel(store, account, roomId, project, now) !== 'off'
}
