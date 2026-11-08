import { DatabaseSync } from 'node:sqlite'
import { constants, closeSync, fstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { parseGroupEvent, isHostName, MAX_GRANT_SECONDS, type GroupEvent, type ParsedGrant } from '../../group-grants.js'

export class NodeRefusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export interface NodeRoom { room: string; authority: string; inviter: string; ends?: number; existing?: true }
export interface DeviceAccess { room: string; device: string; expires: number; turn: boolean; read: boolean; write: boolean }
export interface NodeOperation { id: string; room: string; binding: string; phase: string; payload: Record<string, unknown>; result: Record<string, unknown> }
type RoomRow = NodeRoom & { state: 'active' | 'closing' }
const KEY = /^[0-9a-f]{64}$/
const SCOPES = new Set(['turn', 'relay-read', 'relay-write'])
function refusal(status: number, code: string): never { throw new NodeRefusal(status, code) }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown => v && typeof v === 'object'
    ? Array.isArray(v) ? v.map(sorted) : Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]))
    : v
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(value))))
}

/** Durable authorisation and work records. No room or authority secret enters
 * this store. Network work always happens after a committed transaction. */
export class NodeLedger {
  readonly #db: DatabaseSync
  readonly #guard: DatabaseSync
  readonly #clock: () => number
  readonly #host: string
  readonly #serviceKey: string
  readonly #salt: string
  readonly #maxRooms: number
  readonly #parsed = new Map<string, ParsedGrant>()

  constructor(path: string, options: { host: string; serviceKey: string; salt: string; maxRooms?: number; now?: () => number }) {
    if (!isHostName(options.host) || !KEY.test(options.serviceKey) || !options.salt) throw new Error('Invalid node identity')
    this.#host = options.host; this.#serviceKey = options.serviceKey; this.#salt = options.salt
    this.#maxRooms = options.maxRooms ?? 32
    if (!Number.isSafeInteger(this.#maxRooms) || this.#maxRooms < 1 || this.#maxRooms > 64) throw new Error('Invalid room limit')
    const clock = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#clock = () => {
      const now = clock(), floor = Number(this.meta('clock-floor') ?? 0)
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(floor) || now < floor - 30) refusal(503, 'node-clock-moved-backwards')
      const current = Math.max(now, floor)
      if (current > floor) this.setMeta('clock-floor', String(current))
      return current
    }
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = statSync(directory)
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('Node state needs a private directory')
    for (const file of [path, `${path}.writers.sqlite`]) {
      const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      try { const info = fstatSync(fd); if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Node state needs private regular files') }
      finally { closeSync(fd) }
    }
    const guard = new DatabaseSync(`${path}.writers.sqlite`)
    try { guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') } catch { guard.close(); throw new Error('Node state is already in use') }
    this.#guard = guard
    let db: DatabaseSync
    try { db = new DatabaseSync(path) } catch (error) { guard.close(); throw error }
    this.#db = db
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      if (![0, 1, 2].includes(version)) throw new Error('Unsupported node state version')
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY,authority TEXT NOT NULL,inviter TEXT NOT NULL,ends INTEGER,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY,room TEXT NOT NULL REFERENCES rooms(room) ON DELETE CASCADE,
          device TEXT NOT NULL,created INTEGER NOT NULL,expiration INTEGER NOT NULL,status TEXT NOT NULL,event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS floors (room TEXT PRIMARY KEY REFERENCES rooms(room) ON DELETE CASCADE,created INTEGER NOT NULL,event TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS children (room TEXT NOT NULL REFERENCES rooms(room) ON DELETE CASCADE,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(room,name));
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,room TEXT NOT NULL,binding TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS closed (room_hash TEXT PRIMARY KEY,closed_at INTEGER NOT NULL,proof TEXT);
        `)
      // One durable schema step prevents an older daemon interpreting a migrated
      // room as the restricted v1 profile after a restart or rollback.
      if (version < 2) this.#transaction(() => {
        db.exec("ALTER TABLE rooms ADD COLUMN existing INTEGER NOT NULL DEFAULT 0 CHECK(existing IN (0,1)); PRAGMA user_version=2")
      })
      const identity = hash(canonical({ host: this.#host, service: this.#serviceKey, salt: this.#salt }))
      const storedIdentity = this.meta('identity')
      if (storedIdentity && storedIdentity !== identity) throw new Error('Node state identity changed')
      this.setMeta('identity', identity)
      this.#clock()
    } catch (error) { db.close(); guard.close(); throw error }
  }
  close(): void { this.#db.close(); this.#guard.close() }
  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const value = run(); this.#db.exec('COMMIT'); return value }
    catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  meta(key: string): string | undefined { return this.#db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value as string | undefined }
  setMeta(key: string, value: string): void { this.#db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  prepareDeletion(): void {
    this.#transaction(() => {
      if (this.rooms().length || this.devices().length || this.operations().length) refusal(409, 'close-rooms-before-delete')
      this.setMeta('deleting', '1')
    })
  }
  claimOwner(key: string): void {
    if (this.meta('deleting') === '1') refusal(409, 'node-deleting')
    if (!KEY.test(key) || key === this.#serviceKey) refusal(400, 'invalid-owner')
    this.#transaction(() => { const owner = this.meta('owner'); if (owner && owner !== key) refusal(409, 'node-already-paired'); this.setMeta('owner', key) })
  }
  #roomHash(room: string): string { return hash(`${this.#salt}:${room}`) }
  room(room: string): RoomRow | undefined {
    const row = this.#db.prepare('SELECT * FROM rooms WHERE room=?').get(room)
    return row ? { room: String(row.room), authority: String(row.authority), inviter: String(row.inviter),
      ...(row.ends === null ? {} : { ends: Number(row.ends) }), ...(row.existing === 1 ? { existing: true as const } : {}), state: row.state as RoomRow['state'] } : undefined
  }
  rooms(): RoomRow[] { return (this.#db.prepare('SELECT room FROM rooms ORDER BY room').all() as { room: string }[]).map(r => this.room(r.room)!) }
  enrol(room: NodeRoom): void {
    const now = this.#clock()
    if (!KEY.test(room.room) || !KEY.test(room.authority) || room.inviter !== room.authority || room.authority === this.#serviceKey
      || room.existing !== undefined && room.existing !== true
      || room.ends !== undefined && (!Number.isSafeInteger(room.ends) || room.ends <= now || room.ends > now + 30 * 86400)) refusal(400, 'invalid-room')
    this.#transaction(() => {
      if (this.meta('deleting') === '1') refusal(409, 'node-deleting')
      if (this.#db.prepare('SELECT 1 FROM closed WHERE room_hash=?').get(this.#roomHash(room.room))) refusal(409, 'room-closed')
      const old = this.room(room.room)
      if (old) {
        if (old.authority !== room.authority || old.inviter !== room.inviter || old.ends !== room.ends || old.existing !== room.existing || old.state !== 'active') refusal(409, 'room-already-enrolled')
        return
      }
      if (this.rooms().length >= this.#maxRooms) refusal(429, 'too-many-rooms')
      if (this.#db.prepare('SELECT 1 FROM grants WHERE device=? AND expiration>?').get(room.authority, now)) refusal(403, 'authority-is-device')
      this.#db.prepare('INSERT INTO rooms(room,authority,inviter,ends,state,existing) VALUES(?,?,?,?,?,?)')
        .run(room.room, room.authority, room.inviter, room.ends ?? null, 'active', room.existing ? 1 : 0)
    })
  }
  apply(value: unknown): { changed: boolean; room: string } {
    if (this.meta('deleting') === '1') refusal(409, 'node-deleting')
    const now = this.#clock()
    const verdict = parseGroupEvent(value, { now, servers: [this.#host] })
    if (!verdict.ok) refusal(verdict.status, `grant-${verdict.reason}`)
    const event = verdict.parsed
    if (event.type === 'grant') this.#parsed.set(event.event.id, event)
    if (this.#parsed.size > 4096) this.#parsed.clear()
    return this.#transaction(() => {
      const room = this.room(event.roomId)
      if (!room || room.authority !== event.signer) refusal(403, 'room-authority-required')
      if (room.ends !== undefined && room.ends <= now) refusal(403, 'room-ended')
      const floor = this.#db.prepare('SELECT created,event FROM floors WHERE room=?').get(event.roomId)
      if (event.type === 'reset') {
        if (event.expiration !== event.createdAt + MAX_GRANT_SECONDS) refusal(400, 'reset-lifetime')
        if (floor && JSON.parse(String(floor.event)).id === event.event.id) return { changed: false, room: event.roomId }
        if (floor && event.createdAt <= Number(floor.created)) refusal(409, 'stale-reset')
        this.#db.prepare('INSERT INTO floors(room,created,event) VALUES(?,?,?) ON CONFLICT(room) DO UPDATE SET created=excluded.created,event=excluded.event')
          .run(event.roomId, event.createdAt, JSON.stringify(event.event))
      } else {
        if (floor && event.createdAt <= Number(floor.created)) refusal(409, 'reset-covers-grant')
        if (room.state !== 'active' && event.status === 'active') refusal(409, 'room-closing')
        if (event.scopes.some(scope => !SCOPES.has(scope))) refusal(400, 'unsupported-node-scope')
        if ([this.meta('owner'), this.#serviceKey, ...this.rooms().map(r => r.authority)].includes(event.device)) refusal(403, 'protected-key')
        if (this.#db.prepare('SELECT 1 FROM grants WHERE device=? AND room<>? AND expiration>?').get(event.device, event.roomId, now)) refusal(403, 'device-belongs-to-another-room')
        const old = this.#db.prepare('SELECT * FROM grants WHERE id=?').get(event.grantId)
        if (old) {
          const prior = JSON.parse(String(old.event)) as GroupEvent
          if (prior.id === event.event.id) return { changed: false, room: event.roomId }
          if (old.room !== event.roomId || old.device !== event.device) refusal(409, 'grant-id-rebound')
          if (event.createdAt <= Number(old.created)) refusal(409, 'stale-grant')
          if (old.status === 'revoked' && event.status === 'active') refusal(409, 'grant-revoked')
          const parsed = parseGroupEvent(prior)
          if (!parsed.ok || parsed.parsed.type !== 'grant') refusal(503, 'stored-grant-invalid')
          if (event.status === 'revoked' && (event.expiration < Number(old.expiration)
            || JSON.stringify(event.scopes.slice().sort()) !== JSON.stringify(parsed.parsed.scopes.slice().sort()))) refusal(409, 'revocation-tags-changed')
          // Older clients saved a newer confirmation even when the room end
          // prevented extension. Accept only those unchanged rights at that end,
          // so their durable journal can recover without extending access.
          const cappedConfirmation = room.ends !== undefined && event.expiration === room.ends && event.expiration === Number(old.expiration)
            && JSON.stringify(event.scopes.slice().sort()) === JSON.stringify(parsed.parsed.scopes.slice().sort())
          if (event.status === 'active' && event.expiration <= Number(old.expiration) && !cappedConfirmation) refusal(409, 'renewal-must-extend')
        }
        if (event.status === 'active' && this.active().some(g => g.roomId === event.roomId && g.device === event.device && g.grantId !== event.grantId)) refusal(409, 'device-already-granted')
        if (!old && Number(this.#db.prepare('SELECT count(*) AS n FROM grants').get()?.n) >= 4096) refusal(429, 'grant-record-limit')
        this.#db.prepare('INSERT INTO grants(id,room,device,created,expiration,status,event) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created=excluded.created,expiration=excluded.expiration,status=excluded.status,event=excluded.event')
          .run(event.grantId, event.roomId, event.device, event.createdAt, event.expiration, event.status, JSON.stringify(event.event))
        const active = this.active()
        if (active.length > 512 || active.filter(g => g.roomId === event.roomId).length > 256) refusal(429, 'device-limit')
      }
      return { changed: true, room: event.roomId }
    })
  }
  active(): ParsedGrant[] {
    const now = this.#clock()
    const rows = this.#db.prepare("SELECT g.event FROM grants g JOIN rooms r ON r.room=g.room LEFT JOIN floors f ON f.room=g.room WHERE g.status='active' AND g.expiration>? AND (r.ends IS NULL OR r.ends>?) AND (f.created IS NULL OR g.created>f.created) ORDER BY g.room,g.device").all(now, now)
    return rows.map(row => {
      const raw = JSON.parse(String(row.event)) as GroupEvent
      const cached = this.#parsed.get(raw.id)
      if (cached) return structuredClone(cached)
      const verdict = parseGroupEvent(raw)
      if (!verdict.ok || verdict.parsed.type !== 'grant') return refusal(503, 'stored-grant-invalid')
      this.#parsed.set(raw.id, verdict.parsed)
      return structuredClone(verdict.parsed)
    })
  }
  devices(): DeviceAccess[] {
    return this.active().map(g => ({ room: g.roomId, device: g.device, expires: Math.min(g.expiration, this.room(g.roomId)?.ends ?? Infinity),
      turn: g.scopes.includes('turn'), read: g.scopes.includes('relay-read'), write: g.scopes.includes('relay-write') }))
  }
  /** Return only this device's signed revocation, never another member list. */
  revocation(room: string, device: string, grantId: string): GroupEvent | undefined {
    const row = this.#db.prepare("SELECT event FROM grants WHERE id=? AND room=? AND device=? AND status='revoked'").get(grantId, room, device)
    return row ? JSON.parse(String(row.event)) : undefined
  }
  reset(room: string): GroupEvent | undefined {
    const row = this.#db.prepare('SELECT event FROM floors WHERE room=?').get(room)
    return row ? JSON.parse(String(row.event)) : undefined
  }
  consumeNonce(id: string, until: number): void {
    this.#transaction(() => {
      const now = this.#clock()
      this.#db.exec('CREATE TABLE IF NOT EXISTS nonces(id TEXT PRIMARY KEY,expiration INTEGER NOT NULL)')
      this.#db.prepare('DELETE FROM nonces WHERE expiration<?').run(now)
      if (this.#db.prepare('SELECT 1 FROM nonces WHERE id=?').get(id)) refusal(409, 'request-replayed')
      if (Number(this.#db.prepare('SELECT count(*) AS n FROM nonces').get()?.n) >= 8192) refusal(429, 'request-limit')
      this.#db.prepare('INSERT INTO nonces(id,expiration) VALUES(?,?)').run(id, until)
    })
  }
  collect(): void {
    const now = this.#clock()
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM grants WHERE expiration<=?').run(now)
      this.#db.prepare('DELETE FROM floors WHERE created+?<?').run(MAX_GRANT_SECONDS + 30, now)
      this.#db.prepare('UPDATE closed SET proof=NULL WHERE closed_at+?<?').run(30 * 86400, now)
      // Keep the opaque anti-replay marker for the longest possible signed grant.
      this.#db.prepare('DELETE FROM closed WHERE closed_at+?<?').run(MAX_GRANT_SECONDS + 30, now)
      this.#db.prepare("DELETE FROM operations WHERE phase='done' AND json_extract(result,'$.completedAt')+?<?").run(30 * 86400, now)
    })
    this.#parsed.clear()
  }
  child(room: string, name: 'spry' | 'shelter'): Record<string, unknown> | undefined {
    const row = this.#db.prepare('SELECT value FROM children WHERE room=? AND name=?').get(room, name)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  setChild(room: string, name: 'spry' | 'shelter', value: Record<string, unknown>): void {
    this.#db.prepare('INSERT INTO children(room,name,value) VALUES(?,?,?) ON CONFLICT(room,name) DO UPDATE SET value=excluded.value').run(room, name, JSON.stringify(value))
  }
  beginOperation(id: string, room: string, payload: Record<string, unknown>): NodeOperation {
    if (!/^[0-9a-f]{32}$/.test(id)) refusal(400, 'invalid-operation')
    return this.#transaction(() => {
      const binding = hash(canonical({ room, payload }))
      const old = this.operation(id)
      if (old) { if (old.binding !== binding) refusal(409, 'operation-rebound'); return old }
      if (!this.room(room)) refusal(404, 'room-not-found')
      if (Number(this.#db.prepare('SELECT count(*) AS n FROM operations').get()?.n) >= 4096) refusal(429, 'operation-limit')
      if (this.operations().some(op => op.room === room)) refusal(409, 'room-already-closing')
      this.#db.prepare("UPDATE rooms SET state='closing' WHERE room=?").run(room)
      this.#db.prepare("INSERT INTO operations(id,room,binding,phase,payload,result) VALUES(?,?,?,'publishing',?,'{}')").run(id, room, binding, JSON.stringify(payload))
      return this.operation(id)!
    })
  }
  operation(id: string): NodeOperation | undefined {
    const row = this.#db.prepare('SELECT * FROM operations WHERE id=?').get(id)
    return row ? { id: String(row.id), room: String(row.room), binding: String(row.binding), phase: String(row.phase), payload: JSON.parse(String(row.payload)), result: JSON.parse(String(row.result)) } : undefined
  }
  operations(): NodeOperation[] { return this.#db.prepare("SELECT id FROM operations WHERE phase<>'done' ORDER BY id").all().map(row => this.operation(String(row.id))!) }
  advance(id: string, phase: string, result: Record<string, unknown>): void { this.#db.prepare('UPDATE operations SET phase=?,result=? WHERE id=?').run(phase, JSON.stringify(result), id) }
  /** Erase identifying records before publishing a completion receipt. An
   * interrupted WAL checkpoint remains an erasing operation and is retryable. */
  eraseRoom(id: string, proof: Record<string, unknown> | undefined): void {
    const operation = this.operation(id)
    if (!operation) refusal(404, 'operation-not-found')
    if (operation.phase === 'erasing' || operation.phase === 'done') return
    this.#transaction(() => {
      this.#db.prepare('INSERT OR IGNORE INTO closed(room_hash,closed_at,proof) VALUES(?,?,?)').run(this.#roomHash(operation.room), this.#clock(), proof ? JSON.stringify(proof) : null)
      this.#db.prepare('DELETE FROM rooms WHERE room=?').run(operation.room)
      this.#db.prepare("UPDATE operations SET room='',phase='erasing',payload='{}' WHERE id=?").run(id)
    })
  }
  finishErasure(id: string, receipt: Record<string, unknown>): void {
    if (this.operation(id)?.phase !== 'erasing') refusal(409, 'erasure-not-ready')
    const checkpoint = this.#db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (Number(checkpoint?.busy) !== 0) refusal(503, 'erasure-pending')
    this.advance(id, 'done', receipt)
  }
  closedProof(room: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare('SELECT closed_at,proof FROM closed WHERE room_hash=?').get(this.#roomHash(room))
    return row ? { closedAt: Number(row.closed_at), proof: row.proof === null ? null : JSON.parse(String(row.proof)) } : undefined
  }
}
