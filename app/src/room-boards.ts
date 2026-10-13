import type { RoomSession } from '../../src/session.js'
import type { SelfCrypt } from '../../src/read-position.js'
import { decodeRoomBoard, encodeRoomBoard, ROOM_BOARDS_CHANNEL, type RoomBoard } from '../../src/room-boards.js'
import type { DeviceStore } from './device-store.js'

/** Keep the catalogue encrypted to this account, and carry it to late room
 * members on request. Room chat retention must not make boards disappear. */
export class RoomBoards {
  #boards = new Map<string, RoomBoard>()
  #seen = new Set<string>()
  #stop?: () => void
  #closed = false
  #lastReply = 0
  #saving = Promise.resolve()
  #replying = false
  constructor(readonly session: RoomSession, readonly options: {
    account: string; store: DeviceStore; crypt: SelfCrypt
    current(): boolean; changed(): void; report(error: unknown): void
  }) {}
  private get key() {return `kithmoot.room-boards.v1.${this.options.account}.${this.session.roomId}`}
  get boards(): RoomBoard[] {return [...this.#boards.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-GB'))}
  private current() {return !this.#closed && this.options.current()}
  async open() {
    const saved = this.options.store.get(this.key)
    if (saved && saved.length < 250000) {
      try {
        const chunks: unknown = JSON.parse(saved).chunks
        if (Array.isArray(chunks) && chunks.length <= 10 && chunks.every(chunk => typeof chunk === 'string')) for (const chunk of chunks) {
          const boards: unknown = JSON.parse(await this.options.crypt.decrypt(chunk))
          if (!this.current()) return
          if (Array.isArray(boards)) for (const board of boards.slice(0, 50)) {
            const message = decodeRoomBoard(JSON.stringify({type: 'kithmoot.boards.v1', op: 'share', board}))
            if (message?.op === 'share' && this.#boards.size < 50) this.#boards.set(message.board.boardId, message.board)
          }
        }
      } catch { /* A corrupt or inaccessible cache grants no membership. */ }
    }
    if (!this.current()) return
    const log = this.session.channel(ROOM_BOARDS_CHANNEL)
    const ingest = () => {
      if (!this.current()) return
      let changed = false, requested = false
      for (const message of log.messages()) {
        if (this.#seen.has(message.id)) continue
        this.#seen.add(message.id)
        const decoded = decodeRoomBoard(message.text)
        if (decoded?.op === 'share') {
          const board = decoded.board
          if (JSON.stringify(this.#boards.get(board.boardId)) !== JSON.stringify(board)) {
            if (this.#boards.size >= 50 && !this.#boards.has(board.boardId)) continue
            this.#boards.set(board.boardId, board); changed = true
          }
        } else if (decoded?.op === 'list' && message.sentAt > Date.now() / 1000 - 60) requested = true
      }
      if (this.#seen.size > 2000) this.#seen = new Set(log.messages().map(message => message.id))
      if (changed) {this.save(); this.options.changed()}
      // A member carries only an already shared invitation, never a new grant.
      // Limit replies so replayed requests cannot flood the channel.
      if (requested && this.#boards.size && !this.#replying && Date.now() - this.#lastReply > 60000) {
        this.#lastReply = Date.now()
        this.#replying = true
        void (async () => {
          let first = true
          for (const board of this.boards) {
            if (!first) await new Promise(resolve => setTimeout(resolve, 2500))
            first = false
            if (!this.current()) return
            await log.send(encodeRoomBoard(board))
          }
        })().catch(this.options.report).finally(() => {this.#replying = false})
      }
    }
    this.#stop = log.onChange(ingest); ingest(); this.options.changed()
    await log.send(encodeRoomBoard())
  }
  private save() {
    // NIP-44 bounds a single plaintext; a sizeable room catalogue needs more
    // than one envelope. Store all chunks atomically after encryption succeeds.
    const groups: RoomBoard[][] = [[]]
    for (const board of this.boards) {
      let group = groups[groups.length - 1]!
      if (JSON.stringify(group).length + JSON.stringify(board).length > 20000) {group = []; groups.push(group)}
      group.push(board)
    }
    this.#saving = this.#saving.then(async () => {
      if (!this.current()) return
      const chunks: string[] = []
      for (const group of groups) {
        if (!this.current()) return
        chunks.push(await this.options.crypt.encrypt(JSON.stringify(group)))
      }
      if (this.current()) this.options.store.set(this.key, JSON.stringify({chunks}))
    }).catch(this.options.report)
  }
  async share(board: RoomBoard) {
    if (!this.current()) throw new Error('Join the linked chat before sharing this board.')
    if (this.#boards.size >= 50 && !this.#boards.has(board.boardId)) throw new Error('This chat already has 50 shared boards.')
    const changed = JSON.stringify(this.#boards.get(board.boardId)) !== JSON.stringify(board)
    await this.session.channel(ROOM_BOARDS_CHANNEL).send(encodeRoomBoard(board))
    if (!this.current()) throw new Error('The chat changed before the board was shared. Reopen it and try again.')
    // Older clients, including native Android, can open the same board from
    // the conversation even before they have a dedicated Boards destination.
    if (changed) await this.session.chat.send(`Shared board: ${board.name}\n${board.invitation}`)
    if (!this.current()) throw new Error('Reopen the chat to check the shared board.')
    this.#boards.set(board.boardId, board); this.save(); this.options.changed()
  }
  close() {this.#closed = true; this.#stop?.()}
}
