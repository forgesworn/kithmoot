import { localIdentity } from '../../src/identity.js'
import { nodeKeeperInbox, type NodeClientOptions } from '../../src/kithmoot-node.js'
import { openNodeKeeperAdmissions, type NodeKeeperAdmissions } from '../../src/node-admission.js'
import type { DeviceStore } from './device-store.js'
import { adoptSharedNodeAuthority, listNodeRooms, loadPendingNodeClose, nodeKeeperStore } from './node-rooms.js'
import { loadSharedOwner } from './room-owner-share.js'

/**
 * Lets known members' devices into the node rooms this device keeps while
 * those rooms are closed here, so a member's device that missed a move
 * follows as soon as any of the owner's devices is running. Unknown people
 * still wait for the open room's Let them in card.
 *
 * One keeper per room: an open room's runtime claims its room, which stops
 * the closed-room keeper here and, through a stolen Web Lock, in other tabs.
 * Without Web Locks nothing runs, because two keepers saving one journal
 * could lose a grant record.
 *
 * Any of the owner's devices may keep a room once its owner key has reached
 * them (room-owner-share.ts). Each keeps its own journal, so the members and
 * removals the others shared are applied here too: a person removed on
 * another device is not let back in, and this device's passes for them end.
 */
export interface ClosedRoomKeepers { refresh(): void; close(): void }

const lockName = (room: string) => `kithmoot.node-keeper.${room}`
const claimed = new Map<string, number>()
const running = new Map<string, () => void>()
let released: (() => void) | undefined

/** Called by an open room's runtime before it opens its own keeper. */
export function claimNodeKeeper(room: string): () => void {
  claimed.set(room, (claimed.get(room) ?? 0) + 1)
  running.get(room)?.()
  const release = new AbortController()
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  // Holding the stolen lock until release keeps other tabs' closed-room keepers off this room.
  void locks?.request(lockName(room), { steal: true }, () => new Promise<void>(resolve => release.signal.addEventListener('abort', () => resolve(), { once: true }))).catch(() => {})
  let done = false
  return () => {
    if (done) return
    done = true; release.abort()
    const left = (claimed.get(room) ?? 1) - 1
    if (left > 0) claimed.set(room, left); else claimed.delete(room)
    // A room closed here is kept in the background again straight away.
    if (left <= 0) setTimeout(() => released?.(), 0)
  }
}

export function keepClosedNodeRooms(opts: {
  store: DeviceStore
  /** The signed-in account whose rooms this device keeps, if any. */
  participant: () => string | undefined
  blocked: (participant: string) => boolean
  /** Checked minutes apart; a room that becomes due starts at the next refresh. */
  intervalMs?: number
} & NodeClientOptions): ClosedRoomKeepers {
  const { store, participant: account, blocked, intervalMs, ...client } = opts
  const now = client.now ?? (() => Math.floor(Date.now() / 1000))
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  let owner: string | undefined, stopped = false
  const starting = new Set<string>()
  const stopAll = () => { for (const stop of [...running.values()]) stop() }

  const start = (room: string, participant: string) => {
    if (!locks || starting.has(room) || running.has(room) || claimed.has(room)) return
    starting.add(room)
    const abort = new AbortController()
    let keeper: NodeKeeperAdmissions | undefined, inbox: ReturnType<typeof nodeKeeperInbox> | undefined, timer: ReturnType<typeof setInterval> | undefined
    let authoritySk: Uint8Array | undefined
    const live = () => !stopped && !abort.signal.aborted && owner === participant && account() === participant && !claimed.has(room)
    const stop = () => {
      if (abort.signal.aborted) return
      abort.abort(); clearInterval(timer); inbox?.close(); keeper?.close(); authoritySk?.fill(0)
      if (running.get(room) === stop) running.delete(room)
      starting.delete(room)
    }
    running.set(room, stop)
    // A Web Lock cannot combine ifAvailable with a signal; stop() ends the hold instead.
    void locks.request(lockName(room), { ifAvailable: true }, async lock => {
      if (!lock || !live()) { stop(); return }
      const held = listNodeRooms(store, participant, now()).find(value => value.node.room === room)
      if (!held?.authoritySk || held.phase !== 'active' || held.source?.activated === false || loadPendingNodeClose(store, participant, room, now())) { stop(); return }
      const node = held.node
      authoritySk = held.authoritySk.slice()
      const shared = () => loadSharedOwner(store, participant, room)
      try {
        keeper = await openNodeKeeperAdmissions({ ...client, node, authoritySk: held.authoritySk, roomSecret: held.secret,
          keeperParticipant: participant, epochHint: () => held.epochHint, store: nodeKeeperStore(store, participant, room), allowed: live,
          removed: person => shared()?.removed.includes(person) === true })
      } catch { stop(); return } finally { held.secret.fill(0); held.deviceSk.fill(0); held.authoritySk.fill(0) }
      if (!live()) { stop(); return }
      const applyShared = () => {
        const owner = shared()
        if (!owner || !keeper) return
        void keeper.learnMembers(owner.members).catch(() => {})
        for (const person of owner.removed) if (person !== participant) void keeper.remove(person).catch(() => {})
      }
      applyShared()
      starting.delete(room)
      inbox = nodeKeeperInbox(node, localIdentity(authoritySk), { ...client, allowed: live })
      const seen = new Set<string>()
      inbox.subscribe([{ kinds: [1059], '#p': [node.authority] }], event => {
        if (!live() || seen.has(event.id)) return
        const inspected = keeper!.inspect(event)
        if (!inspected?.known || blocked(inspected.request.participant)) return
        seen.add(event.id); if (seen.size > 4096) seen.delete(seen.values().next().value!)
        void keeper!.admit(event).then(answer => live() ? inbox!.publish(answer) : undefined).catch(() => {})
      })
      void keeper.retry().then(() => keeper!.renew()).catch(() => {})
      timer = setInterval(() => {
        if (!live()) { stop(); return }
        void inbox?.probe().catch(() => {})
        applyShared()
        void keeper?.renew().catch(() => {})
      }, 60_000)
      // Hold the lock until stopped; a runtime's steal rejects this request.
      await new Promise<void>(resolve => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
    }).catch(() => stop())
  }

  const refresh = () => {
    if (stopped) return
    const participant = account()
    if (participant !== owner) { stopAll(); owner = participant }
    if (!participant) return
    // An owner key that has arrived from another of the account's devices.
    try { adoptSharedNodeAuthority(store, participant, now()) } catch { /* Kept rooms still refresh. */ }
    const due = new Set(listNodeRooms(store, participant, now()).filter(value => {
      // A room being closed takes its reset floor from its last keeper: no new grant may follow it.
      // A move not yet activated here is still being prepared, or retried, by its own keeper.
      const keep = !!value.authoritySk && value.phase === 'active' && (value.node.endsAt ?? Infinity) > now()
        && value.source?.activated !== false && !loadPendingNodeClose(store, participant, value.node.room, now())
      value.secret.fill(0); value.deviceSk.fill(0); value.authoritySk?.fill(0)
      return keep
    }).map(value => value.node.room))
    for (const [room, stop] of [...running]) if (!due.has(room) || claimed.has(room)) stop()
    for (const room of due) if (!claimed.has(room)) start(room, participant)
  }
  const timer = setInterval(refresh, intervalMs ?? 60_000)
  released = refresh
  // Not synchronously: the embedding may still be setting up the account this reads.
  setTimeout(refresh, 0)
  return { refresh, close() { stopped = true; clearInterval(timer); if (released === refresh) released = undefined; stopAll() } }
}
