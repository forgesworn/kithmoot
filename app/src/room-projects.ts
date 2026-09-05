import { sanitiseDisplayName } from '../../src/display-name.js'
import type { DeviceStore } from './device-store.js'

/** Personal organisation, separate from room membership and synced bookmarks. */
export function projectKey(account: string | undefined, roomId: string): string {
  return `kithmoot.project.v1.${account ?? 'visitor'}.${roomId}`
}

export function roomProject(store: DeviceStore, account: string | undefined, roomId: string): string | undefined {
  return sanitiseDisplayName(store.get(projectKey(account, roomId)))
}

export function setRoomProject(store: DeviceStore, account: string | undefined, roomId: string, name: string): void {
  const project = sanitiseDisplayName(name)
  const key = projectKey(account, roomId)
  if (project) store.set(key, project)
  else store.remove(key)
}
