import { memoryDeviceStore } from '../app/src/device-store.js'
import { saveBoardContext, type BoardContext } from '../app/src/board-context.js'

export const BOARD_CONTEXT_MODES = ['plain', 'project', 'room', 'both', 'fallbacks', 'limits'] as const
export type BoardContextMode = typeof BOARD_CONTEXT_MODES[number]
export function boardContextFixture(mode: BoardContextMode = 'both') {
  const store = memoryDeviceStore(), account = '3'.repeat(64)
  const value: BoardContext = { boardId: mode === 'limits' ? 'A'.repeat(160) : 'Board_opaque-1', boardName: ' Board 🧭 ' }
  if (['project', 'both', 'fallbacks', 'limits'].includes(mode)) value.project = { id: 'personal:Home 🧭', name: ' Project ' }
  if (['room', 'both', 'fallbacks', 'limits'].includes(mode)) value.room = { id: 'opaque room label', name: ' Chat ' }
  if (mode === 'fallbacks') { value.boardName = ''; value.project!.name = '\u202e'; value.room!.name = '' }
  if (mode === 'limits') { value.project!.id = '🧭'.repeat(100); value.room!.id = 'x'.repeat(200) }
  value.cardId = 'never persisted'
  saveBoardContext(store, account, value)
  const name = store.keys()[0]!, raw = store.get(name)!
  return { records: new Map([[name, raw]]), account, boardId: value.boardId, name, raw }
}
export const BOARD_CONTEXT_FAULTS = ['version', 'account', 'board-name-key', 'board-short-key', 'board-long-key', 'board-dot-key',
  'wrapped', 'nested-wrapped', 'board-id-mismatch', 'missing-name', 'dirty-name', 'empty-name', 'root-array', 'root-null',
  'root-extra', 'card-id', 'capability', 'duplicate-json', 'whitespace', 'field-order', 'project-null', 'project-array',
  'project-id-empty', 'project-id-long', 'project-id-number', 'project-name-dirty', 'project-name-empty', 'project-extra',
  'project-order', 'room-null', 'room-extra', 'room-id-long', 'room-name-dirty'] as const
export type BoardContextFault = typeof BOARD_CONTEXT_FAULTS[number]
export function damageBoardContextFixture(fixture: ReturnType<typeof boardContextFixture>, records: Map<string, string>, fault: BoardContextFault) {
  const { name, account } = fixture, raw = records.get(name)!
  const move = (next: string) => { records.delete(name); records.set(next, raw) }
  if (fault === 'version') return move(name.replace('.v1.', '.v2.'))
  if (fault === 'account') return move(name.replace(account, 'visitor'))
  if (fault === 'board-name-key') return move(name.replace(fixture.boardId, 'board with spaces'))
  if (fault === 'board-short-key') return move(name.slice(0, -fixture.boardId.length))
  if (fault === 'board-long-key') return move(name.replace(fixture.boardId, 'a'.repeat(161)))
  if (fault === 'board-dot-key') return move(name + '.extra')
  if (fault === 'wrapped') return move(`kithmoot.account.${account}.${name}`)
  if (fault === 'nested-wrapped') return move(`kithmoot.account.${account}.kithmoot.account.${account}.${name}`)
  if (fault === 'duplicate-json') { records.set(name, '{"boardName":"shadow",' + raw.slice(1)); return }
  if (fault === 'whitespace') { records.set(name, ' ' + raw); return }
  const row = JSON.parse(raw)
  if (fault === 'board-id-mismatch') row.boardId = 'other'
  if (fault === 'missing-name') delete row.boardName
  if (fault === 'dirty-name') row.boardName = ' Board\u202e '
  if (fault === 'empty-name') row.boardName = ''
  if (fault === 'root-extra') row.extra = true
  if (fault === 'card-id') row.cardId = 'private card'
  if (fault === 'capability') row.invite = 'private capability'
  if (fault === 'project-null') row.project = null
  if (fault === 'project-array') row.project = []
  if (fault === 'project-id-empty') row.project.id = ''
  if (fault === 'project-id-long') row.project.id = '🧭'.repeat(101)
  if (fault === 'project-id-number') row.project.id = 1
  if (fault === 'project-name-dirty') row.project.name = ' Project\u202e '
  if (fault === 'project-name-empty') row.project.name = ''
  if (fault === 'project-extra') row.project.secret = 'private'
  if (fault === 'project-order') row.project = { name: row.project.name, id: row.project.id }
  if (fault === 'room-null') row.room = null
  if (fault === 'room-extra') row.room.capability = 'private'
  if (fault === 'room-id-long') row.room.id = 'x'.repeat(201)
  if (fault === 'room-name-dirty') row.room.name = ' Chat '
  records.set(name, JSON.stringify(fault === 'root-array' ? [row] : fault === 'root-null' ? null :
    fault === 'field-order' ? { boardName: row.boardName, boardId: row.boardId, project: row.project, room: row.room } : row))
}
