import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserMlsGrantForeground } from './mls-grant-custody.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { BrowserMlsKeeperPermissions, importKeeperInboxPermission, KEEPER_PERMISSION_RECORD } from './mls-keeper-permissions.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
const vector = JSON.parse(readFileSync(new URL('../../test/fixtures/keeper-inbox-permission.json', import.meta.url), 'utf8'))
class Tx implements PersonaTransaction {
  installation = '66'.repeat(32)
  constructor(readonly vault = new Map<string, Uint8Array>()) {}
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.vault.set(id, bytes.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
afterEach(() => vi.restoreAllMocks())
function fixture() {
  let now = vector.now, live = true, held = false, generation = 1, afterWork: (() => void) | undefined
  const tx = new Tx(), context = () => ({ vault: { principal: 'https://test', persona: vector.keeper, revision: 'one', generation }, current: () => live })
  const coordinator = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (held || !current()) return { state: 'pending', reason: 'stale', refused: false }
    const candidate = new Tx(new Map([...tx.vault].map(([key, bytes]) => [key, bytes.slice()])))
    const value = await work(candidate)
    afterWork?.()
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    tx.vault.clear(); for (const [key, bytes] of candidate.vault) tx.vault.set(key, bytes)
    return { state: 'active', value, marks: new Map() }
  } }
  const identity = { pubkey: vector.keeper, signEvent: vi.fn(async (event: any) => structuredClone(event.tags[5][1] === 'active' ? vector.active : vector.revoked)) }
  const endpoint = new BrowserMlsGrantEndpoint(new BrowserMlsGrantForeground(), () => identity, () => live)
  vi.spyOn(endpoint, 'pairedBoxes').mockResolvedValue([{ routeId: 'saved', eventUrl: vector.server }])
  const publish = vi.spyOn(endpoint, 'publishKeeperInboxPermission').mockResolvedValue(undefined)
  const custody = new BrowserMlsKeeperPermissions(coordinator as any, endpoint, context, () => now)
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => { new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength).fill(0x24); return array })
  const prepare = () => custody.prepare('saved', vector.device, 86400, identity, () => live)
  return { custody, tx, identity, endpoint, publish, prepare, current: () => live, stop: () => { live = false }, changeAccount: () => { generation++ }, clock: (n: number) => { now = n }, hold: () => { held = true }, afterWork: (work: () => void) => { afterWork = work } }
}
describe('keeper permission ordinary Event interchange and protected custody', () => {
  it('imports the independent shared active vector without changing signed values and refuses its revoked counterpart for sending', () => {
    const terms = importKeeperInboxPermission(JSON.stringify(vector.active), vector.now)
    expect(terms.event).toEqual(vector.active); expect(terms.event.id).toBe('111b0ac8d8b79a8038f4f08d697c141f047653834a9f8f8a7c39b9b83ff59753')
    expect(terms).toMatchObject({ node: vector.node, keeper: vector.keeper, device: vector.device, expiration: 1792994400 })
    expect(terms.event.sig).toBe(vector.active.sig)
    expect(() => importKeeperInboxPermission(JSON.stringify(vector.revoked), vector.now)).toThrow()
    expect(() => importKeeperInboxPermission(' '.repeat(8193), vector.now)).toThrow('8 KiB')
    expect(() => importKeeperInboxPermission(JSON.stringify({ ...vector.active, sig: '00'.repeat(64) }), vector.now)).toThrow('signature')
    expect(() => importKeeperInboxPermission(JSON.stringify({ ...vector.active, extra: true }), vector.now)).toThrow()
  })
  it('retains both exact statements before publication and exports only after matching installed state', async () => {
    const f = fixture(); f.tx.vault.set('old-unrelated-object', new TextEncoder().encode('preserve'))
    const prepared = await f.prepare() as any, row = prepared.value
    expect(row.state).toBe('prepared'); expect(JSON.parse(row.active)).toEqual(vector.active); expect(JSON.parse(row.revocation)).toEqual(vector.revoked)
    expect(f.identity.signEvent).toHaveBeenCalledTimes(2); expect(f.publish).not.toHaveBeenCalled()
    await expect(f.custody.exportInstalled(row.grant, row.revision)).rejects.toThrow('node-acknowledged')
    f.publish.mockImplementation(async (_box, event) => {
      const retained = JSON.parse(new TextDecoder().decode(f.tx.vault.get(KEEPER_PERMISSION_RECORD)!)).records[0]
      expect(retained.state).toBe('installing'); expect(retained.active).toBe(row.active); expect(retained.revocation).toBe(row.revocation)
      expect(JSON.stringify(event)).toBe(row.active)
    })
    expect(await f.custody.publish(row.grant, 0, false, f.current)).toMatchObject({ value: { state: 'installed', revision: 1 } })
    const exported = await f.custody.exportInstalled(row.grant, 1) as any
    expect(exported.value).toBe(row.active); expect(JSON.parse(exported.value)).toEqual(vector.active)
    expect(new TextDecoder().decode(f.tx.vault.get('old-unrelated-object'))).toBe('preserve')
  })
  it('retains unknown attempts and retries the same exact bytes without another signer operation', async () => {
    const f = fixture(), row = (await f.prepare() as any).value
    f.publish.mockRejectedValueOnce(new Error('no ACK'))
    await expect(f.custody.publish(row.grant, 0, false, f.current)).rejects.toThrow('no ACK')
    expect(await f.custody.records()).toMatchObject({ value: [{ state: 'installing', revision: 1, active: row.active, revocation: row.revocation }] })
    await expect(f.custody.publish(row.grant, 0, false, f.current)).rejects.toThrow('revision')
    expect(await f.custody.publish(row.grant, 1, false, f.current)).toMatchObject({ value: { state: 'installed', revision: 2 } })
    expect(f.publish.mock.calls.map(call => JSON.stringify(call[1]))).toEqual([row.active, row.active]); expect(f.identity.signEvent).toHaveBeenCalledTimes(2)
  })
  it('retains terminal intent before publication, forbids reactivation and retries exact revocation material', async () => {
    const f = fixture(), row = (await f.prepare() as any).value
    f.publish.mockRejectedValueOnce(new Error('unknown terminal ACK'))
    await expect(f.custody.publish(row.grant, 0, true, f.current)).rejects.toThrow('unknown terminal')
    await expect(f.custody.publish(row.grant, 1, false, f.current)).rejects.toThrow('cannot be reactivated')
    expect(await f.custody.publish(row.grant, 1, true, f.current)).toMatchObject({ value: { state: 'revoked', revision: 2 } })
    expect(f.publish.mock.calls.map(call => JSON.stringify(call[1]))).toEqual([row.revocation, row.revocation])
    await expect(f.custody.exportInstalled(row.grant, 2)).rejects.toThrow()
  })
  it('keeps expired material readable without claiming installation or revocation', async () => {
    const f = fixture(), row = (await f.prepare() as any).value; f.clock(vector.now + 86400)
    expect(await f.custody.records()).toMatchObject({ value: [{ state: 'prepared', active: row.active, revocation: row.revocation }] })
    await expect(f.custody.publish(row.grant, 0, true, f.current)).rejects.toThrow('expired')
    await expect(f.custody.exportInstalled(row.grant, 0)).rejects.toThrow(); expect(f.publish).not.toHaveBeenCalled()
  })
  it('refuses currentness loss during signing and during acknowledgement retention', async () => {
    const f = fixture(); f.identity.signEvent.mockImplementationOnce(async () => { f.stop(); return structuredClone(vector.active) })
    await expect(f.prepare()).rejects.toThrow('operation changed'); expect(f.tx.vault.has(KEEPER_PERMISSION_RECORD)).toBe(false)
    vi.restoreAllMocks()
    const g = fixture(), row = (await g.prepare() as any).value
    g.publish.mockImplementation(async () => { g.stop() })
    expect(await g.custody.publish(row.grant, 0, false, g.current)).toMatchObject({ state: 'pending' })
    expect(JSON.parse(new TextDecoder().decode(g.tx.vault.get(KEEPER_PERMISSION_RECORD)!)).records[0].state).toBe('installing')
  })
  it('does not release installed JSON when expiry arrives during the final confirmed read', async () => {
    const f = fixture(), row = (await f.prepare() as any).value
    await f.custody.publish(row.grant, 0, false, f.current)
    f.afterWork(() => f.clock(vector.now + 86400))
    expect(await f.custody.exportInstalled(row.grant, 1)).toMatchObject({ state: 'pending' })
  })
  it('checks the account again after a current predicate changes it while returning true at final release', async () => {
    const f = fixture(), row = (await f.prepare() as any).value
    let switchNow = false
    f.publish.mockImplementation(async () => { f.afterWork(() => { switchNow = true }) })
    const result = await f.custody.publish(row.grant, 0, false, () => { if (switchNow) f.changeAccount(); return true })
    expect(result).toMatchObject({ state: 'pending' })
    expect(JSON.parse(new TextDecoder().decode(f.tx.vault.get(KEEPER_PERMISSION_RECORD)!)).records[0].state).toBe('installing')
  })
  it('refuses unknown custody versions rather than discarding exact terminal material', async () => {
    const f = fixture(), row = (await f.prepare() as any).value
    const j = JSON.parse(new TextDecoder().decode(f.tx.vault.get(KEEPER_PERMISSION_RECORD)!)); j.version = 2
    f.tx.vault.set(KEEPER_PERMISSION_RECORD, new TextEncoder().encode(JSON.stringify(j)))
    await expect(f.custody.records()).rejects.toBeInstanceOf(InvalidPersonaRecord); expect(f.publish).not.toHaveBeenCalled(); expect(j.records[0].revocation).toBe(row.revocation)
  })
})
