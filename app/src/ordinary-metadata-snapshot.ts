import { sanitiseDisplayName } from '../../src/display-name.js'
import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'
import { VOLUME_PREFIX } from './volume-store.js'

const HEX = /^[0-9a-f]{64}$/
const PIN_KEY = 'kithmoot.pinned-rooms.v1'
const NOTIFICATION_PREFIX = 'kithmoot.notification-scopes.v1.'
const PROJECT_PREFIX = 'kithmoot.project.v1.'
const BOARD_PREFIX = 'kithmoot.board-context.v1.'
const BOARD_ID = /^[A-Za-z0-9_-]{1,160}$/
const families = ['kithmoot.volume', 'kithmoot.pinned-rooms', 'kithmoot.notification-scopes', 'kithmoot.project', 'kithmoot.board-context']
function hold(): never { throw new OrdinaryStateHold() }
const account = (value: unknown): boolean => value === 'visitor' || typeof value === 'string' && HEX.test(value)
function json(raw: string): unknown {
  if (raw.length > ORDINARY_VALUE_UNITS) hold()
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { hold() }
  // These writers use JSON.stringify. Never normalise duplicate keys,
  // rounded integers, whitespace alternatives or partially readable rows.
  if (JSON.stringify(parsed) !== raw) hold()
  return parsed
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function boardScope(value: unknown): { id: string; name: string } {
  if (!object(value) || Object.keys(value).join(',') !== 'id,name' || typeof value.id !== 'string' ||
      !value.id || value.id.length > 200 || typeof value.name !== 'string' || !value.name || sanitiseDisplayName(value.name) !== value.name) hold()
  return { id: value.id, name: value.name }
}
function boardContext(name: string, raw: string): void {
  if (!name.startsWith(BOARD_PREFIX)) hold()
  const parts = name.slice(BOARD_PREFIX.length).split('.')
  if (parts.length !== 2 || !HEX.test(parts[0]!) || !BOARD_ID.test(parts[1]!)) hold()
  const row = json(raw)
  if (!object(row) || row.boardId !== parts[1] || typeof row.boardName !== 'string' ||
      !row.boardName || sanitiseDisplayName(row.boardName) !== row.boardName) hold()
  // Match the actual saveBoardContext writer, including field order. Never
  // use its permissive reader to drop capabilities, extras or damaged labels.
  const canonical = { boardId: row.boardId, boardName: row.boardName,
    ...(Object.hasOwn(row, 'project') ? { project: boardScope(row.project) } : {}),
    ...(Object.hasOwn(row, 'room') ? { room: boardScope(row.room) } : {}) }
  if (JSON.stringify(canonical) !== raw) hold()
}

/** Strict custody of private UI metadata. No room membership, notification
 * permission, signer account or current project authority is returned. */
export function validateOrdinaryMetadataSnapshot(records: ReadonlyMap<string, string>, _migrated: boolean,
  options: { kind: 'browser' | 'tab' }): Readonly<{ volumes: number; pinLists: number; notificationScopes: number; projects: number; boardContexts: number }> {
  if (!['browser', 'tab'].includes(options.kind)) hold()
  const counts = { volumes: 0, pinLists: 0, notificationScopes: 0, projects: 0, boardContexts: 0 }
  for (const [name, raw] of records) {
    if (name.startsWith('kithmoot.account.') && families.some(family => name.includes('.' + family))) hold()
    const family = families.find(value => name === value || name.startsWith(value + '.'))
    if (!family) continue // The complete composite must classify other families.
    if (options.kind !== 'browser' || name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string' || raw.length > ORDINARY_VALUE_UNITS) hold()
    if (family === 'kithmoot.volume') {
      if (!name.startsWith(VOLUME_PREFIX) || !HEX.test(name.slice(VOLUME_PREFIX.length))) hold()
      const row = json(raw)
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 1 || !Object.hasOwn(row, 'level')) hold()
      const level = (row as { level: unknown }).level
      if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 2 || level === 1) hold()
      counts.volumes++
    } else if (family === 'kithmoot.pinned-rooms') {
      if (name !== PIN_KEY) hold()
      const rows = json(raw)
      if (!Array.isArray(rows) || rows.some((id, index) => typeof id !== 'string' || !HEX.test(id) || index > 0 && rows[index - 1] >= id)) hold()
      counts.pinLists++
    } else if (family === 'kithmoot.notification-scopes') {
      if (!name.startsWith(NOTIFICATION_PREFIX) || !['all', 'off'].includes(raw)) hold()
      const scope = json(name.slice(NOTIFICATION_PREFIX.length))
      if (!Array.isArray(scope) || scope.length !== 3 || !account(scope[0]) || !['default', 'project', 'room'].includes(scope[1]) || typeof scope[2] !== 'string') hold()
      if (scope[1] === 'default' ? scope[2] !== '' : scope[2].length === 0) hold()
      // Project selectors include shared keys and personal labels. Preserve
      // their exact opaque strings; they are not grants or membership proofs.
      if (scope[1] === 'room' && !HEX.test(scope[2])) hold()
      counts.notificationScopes++
    } else if (family === 'kithmoot.board-context') {
      boardContext(name, raw)
      counts.boardContexts++
    } else {
      if (!name.startsWith(PROJECT_PREFIX)) hold()
      const parts = name.slice(PROJECT_PREFIX.length).split('.')
      if (parts.length !== 2 || !account(parts[0]) || !HEX.test(parts[1]) || !raw || sanitiseDisplayName(raw) !== raw) hold()
      counts.projects++
    }
  }
  return Object.freeze(counts)
}
