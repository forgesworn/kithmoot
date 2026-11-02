import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildGrant, buildReset, buildRevocation, parseGroupEvent, MAX_GRANT_SECONDS } from '../../group-grants.js'
import { NodeLedger } from './ledger.js'

const NOW = 1_900_000_000
const paths: string[] = [], ledgers: NodeLedger[] = []
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-ledger-')); paths.push(directory)
  const authority = generateSecretKey(), owner = getPublicKey(generateSecretKey()), device = getPublicKey(generateSecretKey())
  const options = { host: 'node.example', serviceKey: getPublicKey(generateSecretKey()), salt: 'test-salt', now: () => NOW }
  const path = join(directory, 'ledger.sqlite')
  const ledger = new NodeLedger(path, options); ledgers.push(ledger); ledger.claimOwner(owner)
  const room = '01'.repeat(32)
  ledger.enrol({ room, authority: getPublicKey(authority), inviter: getPublicKey(authority) })
  const grant = (patch: Record<string, unknown> = {}) => buildGrant({ authoritySk: authority, roomId: room, device, server: 'node.example',
    scopes: ['turn', 'relay-read', 'relay-write'], grantId: '01'.repeat(16), createdAt: NOW, expiration: NOW + 3600, ...patch })
  return { ledger, authority, owner, device, room, grant, path, options }
}
describe('node authorisation ledger', () => {
  it('persists grants, answers identical retries and refuses stale or rebound grant ids', () => {
    const f = fixture(), grant = f.grant()
    expect(f.ledger.apply(grant).changed).toBe(true)
    expect(f.ledger.apply(grant).changed).toBe(false)
    expect(() => f.ledger.apply(f.grant({ createdAt: NOW, expiration: NOW + 4000 }))).toThrow('stale-grant')
    expect(() => f.ledger.apply(f.grant({ createdAt: NOW + 1, expiration: NOW + 4000, device: getPublicKey(generateSecretKey()) }))).toThrow('grant-id-rebound')
    expect(f.ledger.devices()).toEqual([{ room: f.room, device: f.device, expires: NOW + 3600, turn: true, read: true, write: true }])
    ledgers.splice(ledgers.indexOf(f.ledger), 1); f.ledger.close()
    const reopened = new NodeLedger(f.path, f.options); ledgers.push(reopened)
    expect(reopened.devices()).toHaveLength(1)
    expect(reopened.apply(grant).changed).toBe(false)
  })
  it('keeps revocation terminal, including when it arrives before the grant', () => {
    const f = fixture(), active = f.grant(), parsed = parseGroupEvent(active)
    if (!parsed.ok || parsed.parsed.type !== 'grant') throw Error('fixture')
    const revoked = buildRevocation(parsed.parsed, f.authority, NOW + 1)
    expect(f.ledger.apply(revoked).changed).toBe(true)
    expect(f.ledger.devices()).toEqual([])
    expect(() => f.ledger.apply(active)).toThrow('stale-grant')
    expect(() => f.ledger.apply(f.grant({ createdAt: NOW + 2, expiration: NOW + 4000 }))).toThrow('grant-revoked')
    expect(f.ledger.apply(f.grant({ grantId: '02'.repeat(16), createdAt: NOW + 2, expiration: NOW + 4000 })).changed).toBe(true)
  })
  it('enforces reset floors and requires a new, later grant for re-admission', () => {
    const f = fixture(); f.ledger.apply(f.grant())
    const reset = buildReset({ authoritySk: f.authority, roomId: f.room, server: 'node.example', createdAt: NOW + 1 })
    f.ledger.apply(reset); expect(f.ledger.apply(reset).changed).toBe(false)
    expect(f.ledger.devices()).toEqual([])
    expect(() => f.ledger.apply(f.grant())).toThrow('reset-covers-grant')
    expect(() => f.ledger.apply(buildReset({ authoritySk: f.authority, roomId: f.room, server: 'node.example', createdAt: NOW }))).toThrow('stale-reset')
    f.ledger.apply(f.grant({ grantId: '02'.repeat(16), createdAt: NOW + 2, expiration: NOW + MAX_GRANT_SECONDS }))
    expect(f.ledger.devices()).toHaveLength(1)
  })
  it('refuses unknown authorities, foreign servers, unsupported scopes and protected or cross-room device keys', () => {
    const f = fixture()
    expect(() => f.ledger.apply(f.grant({ authoritySk: generateSecretKey() }))).toThrow('room-authority-required')
    expect(() => f.ledger.apply(f.grant({ server: 'other.example' }))).toThrow('grant-server')
    expect(() => f.ledger.apply(f.grant({ scopes: ['get'] }))).toThrow('unsupported-node-scope')
    expect(() => f.ledger.apply(f.grant({ device: f.owner }))).toThrow('protected-key')
    f.ledger.apply(f.grant())
    const other = '02'.repeat(32); f.ledger.enrol({ room: other, authority: getPublicKey(f.authority), inviter: getPublicKey(f.authority) })
    expect(() => f.ledger.apply(f.grant({ roomId: other, grantId: '02'.repeat(16) }))).toThrow('device-belongs-to-another-room')
  })
  it('refuses a second active id and permits only a later expiry on renewal', () => {
    const f = fixture(); f.ledger.apply(f.grant())
    expect(() => f.ledger.apply(f.grant({ grantId: '02'.repeat(16) }))).toThrow('device-already-granted')
    expect(() => f.ledger.apply(f.grant({ createdAt: NOW + 1, expiration: NOW + 3000 }))).toThrow('renewal-must-extend')
    f.ledger.apply(f.grant({ createdAt: NOW + 1, expiration: NOW + 4000 }))
    expect(f.ledger.devices()[0]?.expires).toBe(NOW + 4000)
  })
  it('resumes a close operation after restart and erases its room data before completion', () => {
    const f = fixture(); f.ledger.apply(f.grant())
    const id = '01'.repeat(16), payload = { opaqueClosingEvents: ['sealed fixture'], deadline: NOW + 5 }
    f.ledger.beginOperation(id, f.room, payload)
    expect(() => f.ledger.beginOperation('02'.repeat(16), f.room, payload)).toThrow('room-already-closing')
    expect(() => f.ledger.apply(f.grant({ createdAt: NOW + 1, expiration: NOW + 4000 }))).toThrow('room-closing')
    ledgers.splice(ledgers.indexOf(f.ledger), 1); f.ledger.close()
    const reopened = new NodeLedger(f.path, f.options); ledgers.push(reopened)
    expect(reopened.operations()[0]?.phase).toBe('publishing')
    reopened.eraseRoom(id, { sig: 'compact-signature-fixture' })
    expect(reopened.rooms()).toEqual([]); expect(reopened.devices()).toEqual([])
    expect(reopened.operation(id)?.payload).toEqual({}); expect(reopened.operation(id)?.room).toBe('')
    expect(reopened.closedProof(f.room)?.proof).toEqual({ sig: 'compact-signature-fixture' })
    reopened.finishErasure(id, { completedAt: NOW, eventsDeleted: 1 })
    expect(reopened.operation(id)?.phase).toBe('done')
    expect(reopened.beginOperation(id, f.room, { deadline: NOW + 5, opaqueClosingEvents: ['sealed fixture'] }).phase).toBe('done')
    expect(() => reopened.beginOperation(id, '02'.repeat(32), payload)).toThrow('operation-rebound')
    expect(() => reopened.enrol({ room: f.room, authority: getPublicKey(f.authority), inviter: getPublicKey(f.authority) })).toThrow('room-closed')
  })
  it('holds an OS-released exclusive writer lock', () => {
    const f = fixture()
    expect(() => new NodeLedger(f.path, f.options)).toThrow('already in use')
  })
  it('does not revive expired access after the system clock moves backwards, including restart', () => {
    const f = fixture(); f.ledger.apply(f.grant())
    ledgers.splice(ledgers.indexOf(f.ledger), 1); f.ledger.close()
    const later = new NodeLedger(f.path, { ...f.options, now: () => NOW + 4000 })
    later.collect(); expect(later.devices()).toEqual([]); later.close()
    expect(() => new NodeLedger(f.path, f.options)).toThrow('clock-moved-backwards')
  })
  it('binds stored authorisation and closed-room hashes to the original node identity', () => {
    const f = fixture(); ledgers.splice(ledgers.indexOf(f.ledger), 1); f.ledger.close()
    expect(() => new NodeLedger(f.path, { ...f.options, salt: 'changed-salt' })).toThrow('identity changed')
    expect(() => new NodeLedger(f.path, { ...f.options, host: 'other.example' })).toThrow('identity changed')
    const reopened = new NodeLedger(f.path, f.options); ledgers.push(reopened)
    expect(reopened.rooms()).toHaveLength(1)
  })
})
