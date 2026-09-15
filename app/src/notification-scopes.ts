import type { DeviceStore } from './device-store.js'

export type NotificationScope = { kind: 'default' } | { kind: 'project' | 'room'; id: string }
export type NotificationMode = 'inherit' | 'all' | 'off'
const PREFIX = 'kithmoot.notification-scopes.v1.'

function key(account: string | undefined, scope: NotificationScope): string {
  return PREFIX + JSON.stringify([account ?? 'visitor', scope.kind, scope.kind === 'default' ? '' : scope.id])
}

export function notificationMode(store: DeviceStore, account: string | undefined, scope: NotificationScope): NotificationMode {
  const value = store.get(key(account, scope))
  return value === 'all' || value === 'off' ? value : scope.kind === 'default' ? 'all' : 'inherit'
}

export function setNotificationMode(store: DeviceStore, account: string | undefined, scope: NotificationScope, mode: NotificationMode): void {
  if (mode === 'inherit') store.remove(key(account, scope))
  else store.set(key(account, scope), mode)
}

/** Room override > project default > account default. The caller applies
 * the device's master permission switch separately. Project names never
 * need to leave this browser to decide whether an activity alert is wanted. */
export function roomNotificationsEnabled(store: DeviceStore, account: string | undefined, roomId: string, project?: string | readonly string[]): boolean {
  const room = notificationMode(store, account, { kind: 'room', id: roomId })
  if (room !== 'inherit') return room === 'all'
  const projects = typeof project === 'string' ? [project] : project ?? []
  const modes = projects.map(id => notificationMode(store, account, { kind: 'project', id }))
  // A room can belong to several shared projects. An explicit project mute
  // wins over another project's On, unless the room itself overrides it.
  if (modes.includes('off')) return false
  if (modes.includes('all')) return true
  return notificationMode(store, account, { kind: 'default' }) !== 'off'
}
