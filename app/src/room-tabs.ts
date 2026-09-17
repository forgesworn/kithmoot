/**
 * Other tabs of this browser in the same room.
 *
 * Tabs share one device key per room, so a tab still in a room keeps
 * publishing under the key a tidy-up is deleting for. Before tidying, every
 * tab in the room is asked to leave and must say it did. A tab that is
 * frozen cannot answer; the storage listener in main.ts takes it out when
 * it wakes and finds the room's keys gone.
 */

type Message =
  | { t: 'probe'; room: string; nonce: string }
  | { t: 'here'; room: string; nonce: string; tab: string }
  | { t: 'leave'; room: string; nonce: string }
  | { t: 'left'; room: string; nonce: string; tab: string }

export interface RoomTabsChannel {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
}

const ROOM = /^[0-9a-f]{64}$/

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  if (typeof m.room !== 'string' || !ROOM.test(m.room) || typeof m.nonce !== 'string' || m.nonce.length > 64) return false
  if (m.t === 'probe' || m.t === 'leave') return true
  return (m.t === 'here' || m.t === 'left') && typeof m.tab === 'string' && m.tab.length <= 64
}

export class RoomTabs {
  readonly tab = crypto.randomUUID()
  #channel: RoomTabsChannel
  #listener = (event: MessageEvent) => { void this.#receive(event.data) }

  constructor(
    private readonly currentRoom: () => string | undefined,
    private readonly leave: (roomId: string) => Promise<void>,
    channel: RoomTabsChannel = new BroadcastChannel('kithmoot.room-tabs'),
  ) {
    this.#channel = channel
    this.#channel.addEventListener('message', this.#listener)
  }

  async #receive(data: unknown): Promise<void> {
    if (!isMessage(data) || data.room !== this.currentRoom()) return
    if (data.t === 'probe') this.#channel.postMessage({ t: 'here', room: data.room, nonce: data.nonce, tab: this.tab })
    else if (data.t === 'leave') {
      try { await this.leave(data.room) } finally {
        this.#channel.postMessage({ t: 'left', room: data.room, nonce: data.nonce, tab: this.tab })
      }
    }
  }

  #collect(kind: 'here' | 'left', room: string, nonce: string, waitMs: number, until?: (seen: Set<string>) => boolean): Promise<Set<string>> {
    return new Promise(resolve => {
      const seen = new Set<string>()
      const done = () => { clearTimeout(timer); this.#channel.removeEventListener('message', listen); resolve(seen) }
      const listen = (event: MessageEvent) => {
        const m = event.data
        if (!isMessage(m) || m.t !== kind || m.room !== room || m.nonce !== nonce || !('tab' in m)) return
        seen.add(m.tab)
        if (until?.(seen)) done()
      }
      const timer = setTimeout(done, waitMs)
      this.#channel.addEventListener('message', listen)
    })
  }

  /** Ask every other tab in the room to leave. True when every tab that
   *  said it was there also said it left. */
  async leaveOthers(room: string, probeMs = 600, leaveMs = 8_000): Promise<boolean> {
    const probe = crypto.randomUUID()
    const answering = this.#collect('here', room, probe, probeMs)
    this.#channel.postMessage({ t: 'probe', room, nonce: probe })
    const present = await answering
    if (present.size === 0) return true
    const nonce = crypto.randomUUID()
    const leaving = this.#collect('left', room, nonce, leaveMs, seen => [...present].every(tab => seen.has(tab)))
    this.#channel.postMessage({ t: 'leave', room, nonce })
    const left = await leaving
    return [...present].every(tab => left.has(tab))
  }

  close(): void {
    this.#channel.removeEventListener('message', this.#listener)
    this.#channel.close()
  }
}
