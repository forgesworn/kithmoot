/**
 * Read positions, kept the same on every device that holds the identity.
 *
 * One record per room, signed by the participant key and encrypted to it,
 * the way bookmarks are kept - see `src/read-position.ts` and
 * `docs/messages.md`. This class follows the records for the rooms this
 * device knows, merges what arrives with what the device already knew,
 * and publishes when the device is ahead. It never publishes from a
 * device that is behind, so two devices converge on the furthest position
 * rather than fighting over the newest event.
 */
import type { Event } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import {
  decodeReadPositions,
  encodeReadPositions,
  mergeReadPositions,
  readPositionId,
  READ_POSITION_KIND,
  READ_POSITION_LABEL,
  type ReadPositions,
  type SelfCrypt,
} from '../../src/read-position.js'

/** How long a device waits after reading before it says so, so a scroll
 *  through a busy room is one record rather than fifty. */
const PUBLISH_DELAY_MS = 4_000

interface Followed {
  roomKey: Uint8Array
  positions: ReadPositions
  off: () => void
  timer?: ReturnType<typeof setTimeout>
  busy: boolean
  again: boolean
  /** `created_at` of the last record this device published, so a relay
   *  replaying something older does not provoke the same record again. */
  publishedAt?: number
}

export class ReadPositionSync {
  readonly #rooms = new Map<string, Followed>()
  #closed = false

  constructor(
    private readonly identity: ParticipantIdentity,
    private readonly crypt: SelfCrypt,
    private readonly relay: RelayTransport,
    /** The record moved this device on: apply it locally. */
    private readonly onRemoteAhead: (roomId: string, positions: ReadPositions) => void,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Follow one room's record, starting from what this device knows. */
  follow(roomId: string, roomKey: Uint8Array, local: ReadPositions): void {
    if (this.#closed || this.#rooms.has(roomId)) return
    const followed: Followed = { roomKey, positions: { ...local }, off: () => {}, busy: false, again: false }
    this.#rooms.set(roomId, followed)
    followed.off = this.relay.subscribe(
      [{ kinds: [READ_POSITION_KIND], authors: [this.identity.pubkey], '#d': [readPositionId(roomKey)], '#l': [READ_POSITION_LABEL] }],
      (event) => { void this.#receive(roomId, event) },
    )
  }

  /** This device read to here. Merged, and published if it is ahead. */
  note(roomId: string, positions: ReadPositions): void {
    const followed = this.#rooms.get(roomId)
    if (!followed || this.#closed) return
    const { merged, localAhead } = mergeReadPositions(positions, followed.positions)
    if (!localAhead) return
    followed.positions = merged
    this.#schedule(roomId, followed)
  }

  /** What this device holds for a room, merged from every source. */
  positions(roomId: string): ReadPositions | undefined {
    return this.#rooms.get(roomId)?.positions
  }

  forget(roomId: string): void {
    const followed = this.#rooms.get(roomId)
    if (!followed) return
    followed.off()
    if (followed.timer !== undefined) clearTimeout(followed.timer)
    this.#rooms.delete(roomId)
  }

  close(): void {
    this.#closed = true
    for (const roomId of [...this.#rooms.keys()]) this.forget(roomId)
  }

  async #receive(roomId: string, event: Event): Promise<void> {
    const followed = this.#rooms.get(roomId)
    if (!followed || this.#closed) return
    const record = await decodeReadPositions(event, { participant: this.identity.pubkey, roomId, roomKey: followed.roomKey, crypt: this.crypt })
    if (!record || !this.#rooms.has(roomId)) return
    const { merged, localAhead, remoteAhead } = mergeReadPositions(followed.positions, record.read)
    followed.positions = merged
    if (remoteAhead) this.onRemoteAhead(roomId, merged)
    // Ahead of a record older than our own last one is not news to anybody:
    // what we published already replaced it.
    if (localAhead && (followed.publishedAt === undefined || event.created_at > followed.publishedAt)) this.#schedule(roomId, followed)
  }

  #schedule(roomId: string, followed: Followed): void {
    if (followed.timer !== undefined) return
    followed.timer = setTimeout(() => {
      followed.timer = undefined
      void this.#publish(roomId, followed)
    }, PUBLISH_DELAY_MS)
  }

  async #publish(roomId: string, followed: Followed): Promise<void> {
    if (this.#closed) return
    if (followed.busy) { followed.again = true; return }
    followed.busy = true
    try {
      const event = await encodeReadPositions(followed.positions, {
        roomId,
        roomKey: followed.roomKey,
        identity: this.identity,
        crypt: this.crypt,
        createdAt: this.now(),
      })
      await this.relay.publish(event)
      followed.publishedAt = event.created_at
    } catch {
      // A signer that declined, or relays that are away: the local position
      // stands and the next read tries again.
    } finally {
      followed.busy = false
      if (followed.again) {
        followed.again = false
        this.#schedule(roomId, followed)
      }
    }
  }
}
