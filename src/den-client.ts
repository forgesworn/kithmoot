import { nip44 } from 'nostr-tools'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { hexToBytes } from '@noble/hashes/utils'
import { RoomAgent } from './agent.js'
import { localIdentity } from './identity.js'
import { CONTROL_CHANNEL, decodeControl, type ControlMessage } from './control.js'
import { assignmentHumanAction, assignmentId, validAssignmentOperation, type AssignmentOperation } from './assignments.js'
import type { AssignmentLog } from './assignment-log.js'
import type { RelayTransport } from './relay-pool.js'

export interface DenWorkStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}
interface SavedRoom { room: string; name: string; link: string }
interface ConnectedRoom { saved: SavedRoom; member: RoomAgent; log: AssignmentLog; catalogues: Map<string, Extract<ControlMessage, { op: 'catalogue' }>> }

/** The complete shared-work client consumed by Den. Its API accepts a sharing
 * projection, never a DenTask, notes collection or focus record. Den's secret
 * derives separate room identities and encrypts only this adapter's storage;
 * it is never included in a room message or returned in a snapshot. */
export class DenAssignmentClient {
  readonly #key: Uint8Array
  readonly #rooms = new Map<string, ConnectedRoom>()
  readonly #connecting = new Map<string, Promise<unknown>>()
  #saved: SavedRoom[] = []
  #error?: string
  #closed = false
  #saveTail: Promise<void> = Promise.resolve()
  constructor(readonly options: { secret: string; device: string; store: DenWorkStore; changed: () => void; transport?: (relays: string[]) => RelayTransport }) {
    if (!/^[0-9a-f]{64}$/.test(options.secret) || !options.device || options.device.length > 100) throw new Error('Invalid Den work identity')
    this.#key = hexToBytes(options.secret)
  }
  async open(): Promise<void> {
    const raw = await this.options.store.get('connections')
    if (!raw) return
    const rooms = JSON.parse(nip44.v2.decrypt(raw, this.#key)) as SavedRoom[]
    if (!Array.isArray(rooms) || rooms.length > 30 || rooms.some(r => !/^[0-9a-f]{64}$/.test(r.room) || typeof r.link !== 'string' || typeof r.name !== 'string')) throw new Error('Invalid saved room connections')
    this.#saved = rooms
    // Explicitly connected rooms may be restored. A failed room does not
    // hide other rooms; the saved connection and retry route stay visible.
    await Promise.all(rooms.map(r => this.connect(r.link, r.name).catch(e => { this.#error = e instanceof Error ? e.message : 'Room connection failed'; this.options.changed() })))
  }
  async connect(link: string, name: string): Promise<unknown> {
    if (this.#closed) throw new Error('Work client is closed')
    const existing = [...this.#rooms.values()].find(r => r.saved.link === link)
    if (existing) return this.room(existing.saved.room)
    const pending = this.#connecting.get(link)
    if (pending) return pending
    const task = this.#connect(link, name).finally(() => this.#connecting.delete(link))
    this.#connecting.set(link, task)
    return task
  }
  async #connect(link: string, name: string): Promise<unknown> {
    if (!name.trim() || name.length > 64) throw new Error('Give this connection a name')
    const derive = (room: string, purpose: string) => hkdf(sha256, this.#key, new TextEncoder().encode(room), `den/kithmoot/v1/${purpose}`, 32)
    const member = await RoomAgent.join({ link, name: 'Den', agent: false, hostInvitation: false,
      identityForRoom: room => localIdentity(derive(room, 'participant')),
      deviceKeyForRoom: room => derive(room, `device/${this.options.device}`), transport: this.options.transport })
    try {
      if (this.#closed) throw new Error('Work client closed while connecting')
      const existing = this.#rooms.get(member.roomId)
      if (existing) { member.leave(); return this.room(existing.saved.room) }
      const saved = { room: member.roomId, name: name.trim(), link }
      // Save the connection before subscribing or returning success. Serial
      // merge preserves other rooms that connected during this admission.
      const save = this.#saveTail.then(async () => {
        const next = [...this.#saved.filter(r => r.room !== saved.room), saved]
        if (next.length > 30) throw new Error('At most 30 room connections')
        await this.options.store.set('connections', nip44.v2.encrypt(JSON.stringify(next), this.#key))
        this.#saved = next
      })
      this.#saveTail = save.catch(() => {}); await save
      const log = await member.session.assignments({
        load: () => this.options.store.get(`room.${member.roomId}`),
        save: value => this.options.store.set(`room.${member.roomId}`, value),
      })
      const room: ConnectedRoom = { saved, member, log, catalogues: new Map() }
      this.#rooms.set(member.roomId, room)
      log.onChange(() => this.options.changed())
      member.onRoster(() => this.options.changed())
      const control = member.channel(CONTROL_CHANNEL)
      const ingest = () => {
        for (const m of control.messages()) {
          const c = decodeControl(m.text)
          if (c?.op === 'catalogue' && c.host === m.participant) room.catalogues.set(c.host, c)
        }
        this.options.changed()
      }
      control.onChange(ingest); ingest()
      this.#error = undefined; this.options.changed()
      return this.room(member.roomId)
    } catch (e) { member.leave(); throw e }
  }
  room(id: string) {
    const r = this.#rooms.get(id)
    if (!r) throw new Error('Room is not connected')
    const present = r.member.roster()
    const hosts = new Set(present.map(p => p.participant))
    return { room: id, name: r.saved.name, participant: r.member.participant, ...r.log.snapshot(),
      members: present.filter(p => p.participant !== r.member.participant).map(p => ({
        pubkey: p.participant, name: p.name ?? p.participant.slice(0, 12), agent: p.agent,
        ...(p.agent && p.devices.length ? { ownerDevice: [...p.devices].sort()[0] } : {}),
        principal: p.owner?.principal,
        actions: [...r.catalogues.values()].filter(c => hosts.has(c.host)).flatMap(c => c.agents.filter(a => c.running.some(run => run.id === a.id && run.participant === p.participant)).flatMap(a => a.actions ?? [])),
      })),
    }
  }
  snapshot() {
    return { rooms: this.#saved.map(r => this.#rooms.has(r.room) ? this.room(r.room) : { room: r.room, name: r.name, ready: false, error: 'Room disconnected; reconnect using its invitation', assignments: [], members: [] }),
      ...(this.#error ? { error: this.#error } : {}),
      attention: [...this.#rooms.values()].flatMap(r => r.log.snapshot().assignments.filter(s => s.creator === r.member.participant).map(s => ({ room: r.saved.room, assignment: s.id, head: s.head, status: s.status, action: assignmentHumanAction(s), objective: s.objective }))),
    }
  }
  async submit(room: string, assignment: string | undefined, operation: AssignmentOperation, request: string) {
    const r = this.#rooms.get(room)
    if (!r) throw new Error('Connect the assignment’s room first')
    return r.log.submit(assignment, operation, request)
  }
  prepare(room: string, operation: unknown, request: string) {
    const r = this.#rooms.get(room)
    if (!r || !r.log.snapshot().ready) throw new Error('Wait for the room to connect')
    if (!validAssignmentOperation(operation) || operation.op !== 'create' || !/^[a-zA-Z0-9_-]{16,80}$/.test(request)) throw new Error('Invalid sharing projection')
    return { room, assignment: assignmentId(r.member.participant, request), request, operation: structuredClone(operation) }
  }
  async retry(room: string): Promise<void> { const r = this.#rooms.get(room); if (!r) throw new Error('Room is not connected'); await r.log.retry() }
  close(): void { this.#closed = true; for (const r of this.#rooms.values()) r.member.leave(); this.#rooms.clear(); this.#key.fill(0) }
}
