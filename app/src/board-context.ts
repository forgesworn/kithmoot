import { sanitiseDisplayName } from '../../src/display-name.js'
import type { DeviceStore } from './device-store.js'

export interface BoardContext {
  boardId: string
  boardName: string
  cardId?: string
  project?: { id: string; name: string }
  room?: { id: string; name: string }
}
const ID = /^[a-zA-Z0-9_-]{1,160}$/
const PREFIX = 'kithmoot.board-context.v1.'
export function boardContextTitle(context: BoardContext): string {
  return ['KithMoot', context.project?.name, context.room?.name, context.boardName].filter(Boolean).join(' · ')
}
/** Personal labels associate a board with a workspace; they confer no access.
 * Store no board invite, signing secret, card contents or room capability here. */
export function saveBoardContext(store: DeviceStore, account: string, value: BoardContext): void {
  if (!/^[0-9a-f]{64}$/.test(account) || !ID.test(value.boardId)) throw new Error('Invalid board context')
  const safe: BoardContext = {boardId: value.boardId, boardName: sanitiseDisplayName(value.boardName) ?? 'Untitled board'}
  for (const field of ['project', 'room'] as const) {
    const scope = value[field]
    if (scope) {
      if (!scope.id || scope.id.length > 200) throw new Error('Invalid board scope')
      safe[field] = {id: scope.id, name: sanitiseDisplayName(scope.name) ?? (field === 'project' ? 'Project' : 'Chat')}
    }
  }
  store.set(`${PREFIX}${account}.${value.boardId}`, JSON.stringify(safe))
}
export function readBoardContext(store: DeviceStore, account: string, boardId: string): BoardContext | undefined {
  if (!/^[0-9a-f]{64}$/.test(account) || !ID.test(boardId)) return
  const raw = store.get(`${PREFIX}${account}.${boardId}`)
  if (!raw || raw.length > 2048) return
  try {
    const value = JSON.parse(raw)
    if (value.boardId !== boardId || typeof value.boardName !== 'string') return
    const scope = (v: unknown): v is {id: string; name: string} => !!v && typeof v === 'object' &&
      typeof (v as {id?: unknown}).id === 'string' && typeof (v as {name?: unknown}).name === 'string'
    if (value.project !== undefined && !scope(value.project) || value.room !== undefined && !scope(value.room)) return
    return {boardId, boardName: sanitiseDisplayName(value.boardName) ?? 'Untitled board',
      ...(value.project ? {project: {id: value.project.id, name: sanitiseDisplayName(value.project.name) ?? 'Project'}} : {}),
      ...(value.room ? {room: {id: value.room.id, name: sanitiseDisplayName(value.room.name) ?? 'Chat'}} : {})}
  } catch {return}
}

/** Enumerate this account's navigation labels without retaining invitations. */
export function listBoardContexts(store: DeviceStore, account: string): BoardContext[] {
  if (!/^[0-9a-f]{64}$/.test(account)) return []
  const prefix = `${PREFIX}${account}.`
  return store.keys().filter(key => key.startsWith(prefix))
    .map(key => readBoardContext(store, account, key.slice(prefix.length)))
    .filter((value): value is BoardContext => !!value)
    .sort((a, b) => a.boardName.localeCompare(b.boardName, 'en-GB') || a.boardId.localeCompare(b.boardId))
}
