import { memoryDeviceStore } from '../app/src/device-store.js'
import { setPinned } from '../app/src/room-pins.js'
import { storeVolumeLevel } from '../app/src/volume-store.js'
import { muteRoom, setNotificationMode } from '../app/src/notification-scopes.js'
import { setRoomProject } from '../app/src/room-projects.js'

export const METADATA_MODES = ['all', 'empty', 'volume', 'pins', 'notifications', 'projects', 'mutes'] as const
export type MetadataMode = typeof METADATA_MODES[number]
export function metadataFixture(mode: MetadataMode = 'all') {
  const store = memoryDeviceStore(), room = '1'.repeat(64), person = '2'.repeat(64), account = '3'.repeat(64)
  const storage = { getItem: (key: string) => store.get(key), setItem: (key: string, value: string) => store.set(key, value) }
  if (mode === 'all' || mode === 'volume') { storeVolumeLevel(store, person, 0); storeVolumeLevel(store, account, 1.375) }
  if (mode === 'all' || mode === 'pins') { setPinned(storage, person, true); setPinned(storage, room, true) }
  if (mode === 'all' || mode === 'notifications') {
    setNotificationMode(store, undefined, { kind: 'default' }, 'off')
    setNotificationMode(store, account, { kind: 'room', id: room }, 'all')
    setNotificationMode(store, account, { kind: 'project', id: 'project:Home 🧭' }, 'off')
    setNotificationMode(store, account, { kind: 'project', id: `shared:${person}:${room}` }, 'all')
  }
  if (mode === 'all' || mode === 'projects') {
    setRoomProject(store, undefined, room, ' Home 🧭 '); setRoomProject(store, account, room, 'Work')
  }
  if (mode === 'all' || mode === 'mutes') muteRoom(store, account, room, 1_900_000_000)
  return { records: new Map(store.keys().map(key => [key, store.get(key)!])), room, person, account }
}
export const METADATA_FAULTS = ['volume-version', 'volume-person', 'volume-null', 'volume-range', 'volume-default', 'volume-extra',
  'volume-duplicate-json', 'volume-whitespace', 'pins-version', 'pins-duplicate', 'pins-unsorted', 'pins-person', 'pins-shape',
  'notification-version', 'notification-account', 'notification-kind', 'notification-default-id', 'notification-empty-project',
  'notification-room', 'notification-key-json', 'notification-mode', 'project-version', 'project-account', 'project-room',
  'project-name', 'project-empty', 'mute-version', 'mute-account', 'mute-room', 'mute-value', 'wrapped', 'nested-wrapped'] as const
export type MetadataFault = typeof METADATA_FAULTS[number]
export function damageMetadataFixture(fixture: ReturnType<typeof metadataFixture>, records: Map<string, string>, fault: MetadataFault): void {
  const volume = `kithmoot.volume.v1.${fixture.person}`, pins = 'kithmoot.pinned-rooms.v1'
  const notification = 'kithmoot.notification-scopes.v1.', project = `kithmoot.project.v1.visitor.${fixture.room}`
  const move = (key: string, next: string) => { const raw = records.get(key)!; records.delete(key); records.set(next, raw) }
  if (fault === 'volume-version') move(volume, volume.replace('.v1.', '.v2.'))
  if (fault === 'volume-person') move(volume, volume + '.extra')
  if (fault === 'volume-null') records.set(volume, '{"level":null}')
  if (fault === 'volume-range') records.set(volume, '{"level":2.1}')
  if (fault === 'volume-default') records.set(volume, '{"level":1}')
  if (fault === 'volume-extra') records.set(volume, '{"level":0,"room":"private"}')
  if (fault === 'volume-duplicate-json') records.set(volume, '{"level":2,"level":0}')
  if (fault === 'volume-whitespace') records.set(volume, '{ "level":0}')
  if (fault === 'pins-version') move(pins, 'kithmoot.pinned-rooms.v2')
  if (fault === 'pins-duplicate') records.set(pins, JSON.stringify([fixture.room, fixture.room]))
  if (fault === 'pins-unsorted') records.set(pins, JSON.stringify([fixture.person, fixture.room]))
  if (fault === 'pins-person') records.set(pins, '["room"]')
  if (fault === 'pins-shape') records.set(pins, '{}')
  if (fault.startsWith('notification-')) {
    const key = [...records.keys()].find(name => name.startsWith(notification) && name.includes('"default"'))!
    if (fault === 'notification-version') move(key, key.replace('.v1.', '.v2.'))
    else if (fault === 'notification-key-json') move(key, notification + '[ "visitor","default",""]')
    else if (fault === 'notification-mode') records.set(key, 'inherit')
    else {
      const parts: string[] = JSON.parse(key.slice(notification.length))
      if (fault === 'notification-account') parts[0] = 'account'
      if (fault === 'notification-kind') parts[1] = 'channel'
      if (fault === 'notification-default-id') parts[2] = fixture.room
      if (fault === 'notification-empty-project') parts[1] = 'project'
      if (fault === 'notification-room') { parts[1] = 'room'; parts[2] = 'wrong' }
      move(key, notification + JSON.stringify(parts))
    }
  }
  if (fault === 'project-version') move(project, project.replace('.v1.', '.v2.'))
  if (fault === 'project-account') move(project, project.replace('visitor', 'account'))
  if (fault === 'project-room') move(project, project + '.extra')
  if (fault === 'project-name') records.set(project, ' Home\u202e ')
  if (fault === 'project-empty') records.set(project, '')
  const mute = `kithmoot.mute-until.v1.${fixture.account}.${fixture.room}`
  if (fault === 'mute-version') move(mute, mute.replace('.v1.', '.v2.'))
  if (fault === 'mute-account') move(mute, mute.replace(fixture.account, 'account'))
  if (fault === 'mute-room') move(mute, mute + '.extra')
  if (fault === 'mute-value') records.set(mute, '01')
  if (fault === 'wrapped') move(volume, `kithmoot.account.${fixture.account}.${volume}`)
  if (fault === 'nested-wrapped') move(project, `kithmoot.account.${fixture.account}.kithmoot.account.${fixture.account}.${project}`)
}
