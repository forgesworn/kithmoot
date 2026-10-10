import { AssignmentLog } from '../../src/assignment-log.js'
import { ChatLog, type EpochRoot } from '../../src/chat.js'
import { deriveEpoch } from '../../src/epoch.js'
import { KINDS } from '../../src/kinds.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { RoomPolicy } from '../../src/types.js'
import { RoomWatch, type WatchedRekey } from './room-watch.js'
import type { WorkspaceObservation } from './workspace-work.js'

/** No archive, signer, presence publication or writable task storage. The
 * transport still honours the room's existing private/public route choice. */
export function observeWorkspaceActivity(options: {
  participant: string; name: string; roomId: string; roomKey: Uint8Array
  transport: RelayTransport; policy?: RoomPolicy; epoch?: EpochRoot & { epoch: number }
  authority?: string; deviceSk?: Uint8Array; sealSks?: () => Uint8Array[]
  loadJournal(): Promise<string | undefined>
  isBlocked(participant: string): boolean
  valid(): boolean
  onEpoch(moved: WatchedRekey): void
  onClosed(destruct: boolean): void
  changed(): void
  now?: () => number
}): WorkspaceObservation {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  let closed = false, error: string | undefined, watch: RoomWatch | undefined
  const removed = new Set<string>()
  // Even the ordinary chat reader's 500-message/30-day request is narrowed
  // here. This view cannot call archive paging or start a room session.
  const transport: RelayTransport = {
    async publish() { throw new Error('Workspace activity cannot publish room events') },
    close() {},
    subscribe(filters, receive, eose) {
      let historical = true, received = 0
      const limit = filters.every(f => f.kinds?.includes(KINDS.ROOM_REKEY)) ? 512 : 128
      const bounded = filters.map(f => ({ ...f, limit: Math.min(f.limit ?? limit, limit),
        ...(f.kinds?.includes(KINDS.CHAT) ? { since: Math.max(f.since ?? 0, now() - 86_400) } : {}) }))
      return options.transport.subscribe(bounded, (event, via) => {
        if (closed || (historical && ++received > 512)) return
        receive(event, via)
      }, () => { historical = false; eose?.() })
    },
  }
  const work = new AssignmentLog({ readOnly: true, participant: options.participant, roomId: options.roomId,
    roomKey: options.roomKey, transport, epoch: options.epoch, policy: options.policy,
    storage: { load: options.loadJournal }, now, historyLimit: 128 })
  const chat = new ChatLog({ roomId: options.roomId, roomKey: options.roomKey, policy: options.policy,
    epoch: options.epoch, transport, now, isBlocked: options.isBlocked, isRemoved: participant => removed.has(participant) })
  const close = () => { if (closed) return; closed = true; work.close(); chat.close(); watch?.close(); options.transport.close() }
  const changed = () => { if (!closed) options.changed() }
  let workDirty = true, workSnapshot = work.snapshot()
  work.onChange(() => { workDirty = true; changed() }); chat.onChange(changed)
  const unavailable = (message: string) => { error = message; queueMicrotask(() => { close(); options.changed() }) }
  watch = new RoomWatch({ roomId: options.roomId, roomKey: options.roomKey, policy: options.policy, quiet: true, transport,
    epoch: options.epoch, authority: options.authority, deviceSk: options.deviceSk, sealSks: options.sealSks, now,
    onChange: changed,
    onUnreachable: () => unavailable('Room access changed. Open the room to check your membership before viewing its work.'),
    onClosed: notice => {
      unavailable('This room has ended. Its work is no longer shown here.')
      options.onClosed(notice.destruct === true)
    },
    onEpoch: moved => {
      for (const participant of moved.notice.removed) removed.add(participant)
      options.onEpoch(moved)
      const root = deriveEpoch(moved.epoch)
      work.rekey(root); chat.rekey(root, { leftAt: moved.notice.at }); changed()
    },
  })
  void work.open().catch(e => { error = e instanceof Error ? e.message : 'Work could not load.'; close(); options.changed() })
  return {
    close, valid: options.valid,
    snapshot: () => {
      if (closed || workDirty) { workSnapshot = work.snapshot(); workDirty = false }
      return { work: workSnapshot, messages: closed ? [] : chat.messages(),
      people: closed ? [] : [...(watch?.present() ?? []), { participant: options.participant, name: options.name }],
      ...(error ? { error } : {}) }
    },
  }
}
