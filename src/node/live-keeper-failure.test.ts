import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, fsyncSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey } from 'nostr-tools/pure'
import { deriveRoom, deriveEpoch, encodeRekeyEvent } from '@forgesworn/fold-kit'
import { LiveAdmissionBudget } from '../live-admission-responder.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { getPublicKey } from 'nostr-tools/pure'
import { encodeLivePersistentRequest } from '@forgesworn/fold-kit'
import { LiveKeeperJournal } from '../live-keeper.js'
import { EncryptedLiveKeeperStore } from './live-keeper-store.js'

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }
})
const directories: string[] = []
afterEach(() => { vi.mocked(fsyncSync).mockReset(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }) })

it('poisons after rename but before directory fsync, then reopens the exact pending transition', async () => {
  const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fsyncSync).mockImplementation(realFs.fsyncSync)
  const directory = mkdtempSync(join(tmpdir(), 'keeper-write-fault-')); directories.push(directory)
  const file = join(directory, 'room.enc'), key = new Uint8Array(32).fill(9), now = 1_800_000_000
  const journal = LiveKeeperJournal.create(new EncryptedLiveKeeperStore(file, key), { relays: ['wss://relay.example/'], now: () => now })
  const state = journal.snapshot(), secret = generateSecretKey()
  const event = encodeRekeyEvent({ roomId: deriveRoom(state.secret).roomId, authoritySk: state.inviterSk,
    current: deriveEpoch({ epoch: 0, secret: state.secret }), next: { epoch: 1, secret },
    recipients: [], removed: [], members: [], commit: true, now })
  vi.mocked(fsyncSync).mockImplementationOnce(realFs.fsyncSync).mockImplementationOnce(() => { throw new Error('directory fsync failed') })
  await expect(journal.prepareRekey(event, { ...state, epoch: 1, epochSecret: secret, epochAt: now })).rejects.toThrow('directory fsync failed')
  expect(journal.status).toBe('poisoned')
  await expect(journal.offerPending(async () => { throw new Error('must not offer') })).rejects.toThrow(/unavailable/)
  await journal.close()
  vi.mocked(fsyncSync).mockImplementation(realFs.fsyncSync)
  const recovered = LiveKeeperJournal.open(new EncryptedLiveKeeperStore(file, key), () => now)
  expect(recovered.status).toBe('pending')
  expect(recovered.pendingEvents()[0]!.id).toBe(event.id)
  await recovered.offerPending(async retained => { expect(retained.id).toBe(event.id) })
  expect(recovered.snapshot().epochSecret).toEqual(secret)
  await recovered.close()
})


it('reopens the charged budget after rename/fsync failure without handing out an answer', async () => {
  const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fsyncSync).mockImplementation(realFs.fsyncSync)
  const directory = mkdtempSync(join(tmpdir(), 'budget-write-fault-')); directories.push(directory)
  const file = join(directory, 'budget.enc'), key = new Uint8Array(32).fill(8), now = () => 1_800_000_000
  const budget = LiveAdmissionBudget.create(new EncryptedLiveKeeperStore(file, key), now)
  let raw: string | undefined
  const journal = LiveKeeperJournal.create({ load: () => raw, save: s => { raw = s }, close: () => {} }, { now })
  const relay = new SimRelay(), errors: unknown[] = []
  const host = budget.host(journal, new SimTransport(relay), e => errors.push(e))
  const state = journal.snapshot()
  const request = encodeLivePersistentRequest({ invitation: { bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true },
    roomId: deriveRoom(state.secret).roomId, requesterSk: generateSecretKey(), now: now() })
  try {
    vi.mocked(fsyncSync).mockImplementationOnce(realFs.fsyncSync).mockImplementationOnce(() => { throw new Error('budget directory fsync failed') })
    relay.publish(request)
    await journal.checkpoint(journal.snapshot())
    await new Promise(r => setTimeout(r, 0))
    expect(errors).toHaveLength(1)
    expect(relay.published.filter(e => e.kind === 20467)).toHaveLength(0)
    expect(() => budget.host(journal, new SimTransport(relay), () => {})).toThrow(/unavailable/)
  } finally { host.close(); await new Promise(r => setTimeout(r, 0)); budget.close() }
  vi.mocked(fsyncSync).mockImplementation(realFs.fsyncSync)
  const store = new EncryptedLiveKeeperStore(file, key)
  expect(JSON.parse(store.load()!).reservations).toEqual([{ at: now(), checks: 1, challenges: 0, bytes: 0 }])
  const recovered = LiveAdmissionBudget.open(store, now)
  const back = recovered.host(journal, new SimTransport(relay), e => errors.push(e))
  try {
    relay.publish(request); await journal.checkpoint(journal.snapshot())
    expect(relay.published.filter(e => e.kind === 20467)).toHaveLength(1)
  } finally { back.close(); await journal.close(); await new Promise(r => setTimeout(r, 0)); recovered.close() }
})
