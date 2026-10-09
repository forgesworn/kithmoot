import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { deriveRoom, deriveEpoch, encodeLivePersistentRequest, decodeLivePersistentAnswer, encodeRekeyEvent } from '@forgesworn/fold-kit'
import { LiveKeeperJournal, type LiveKeeperStore } from './live-keeper.js'
import type { KeeperState } from './agent.js'

const NOW = 1_800_000_000
function storage() {
  const disk = { raw: undefined as string | undefined, fail: '' }
  const open = (): LiveKeeperStore => ({
    load: () => disk.raw,
    save: raw => { if (disk.fail === 'before') throw new Error('disk failed'); disk.raw = raw; if (disk.fail === 'after') throw new Error('uncertain fsync') },
    close: () => {},
  })
  return { disk, open }
}
function requestFor(state: KeeperState, now = NOW) {
  const requesterSk = generateSecretKey()
  const context = { invitation: { bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true as const }, roomId: deriveRoom(state.secret).roomId }
  return { requesterSk, context, request: encodeLivePersistentRequest({ ...context, now, requesterSk }) }
}
function transition(state: KeeperState, now = NOW, closed = false) {
  const nextSecret = generateSecretKey(), epoch = state.epoch! + 1
  const removed = [getPublicKey(generateSecretKey())]
  const members: string[] = []
  const event = encodeRekeyEvent({ roomId: deriveRoom(state.secret).roomId, authoritySk: state.inviterSk,
    current: deriveEpoch({ epoch: state.epoch!, secret: state.epoch === 0 ? state.secret : state.epochSecret! }),
    next: { epoch, secret: nextSecret }, recipients: [], removed, members, now, commit: true, closed, destruct: closed })
  const next: KeeperState = { ...state, epoch, epochSecret: nextSecret, removed: [...new Set([...(state.removed ?? []), ...removed])].sort(), members,
    epochAt: now, ...(closed ? { closed: true, destruct: true as const } : {}) }
  return { event, next }
}

describe('durable live keeper lifecycle', () => {
  it('can create a mesh-only authority without relay configuration', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { now: () => NOW })
    const ask = requestFor(j.snapshot())
    expect(await j.answer(ask.request, async event => {
      const proof = decodeLivePersistentAnswer(event, { ...ask.context, request: ask.request, requesterSk: ask.requesterSk, now: NOW })
      expect(proof).not.toBeNull()
      expect(proof!.admission.relays).toBeUndefined()
    })).toBe(true)
    await j.close()
  })
  it('checkpoints room metadata without allowing an epoch or lifecycle change', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { now: () => NOW })
    const state = j.snapshot(), member = getPublicKey(generateSecretKey())
    await j.checkpoint({ ...state, members: [member], channels: ['radio'] })
    expect(j.snapshot().members).toEqual([member])
    for (const patch of [{ secret: generateSecretKey() }, { inviterSk: generateSecretKey() },
      { bearer: generateSecretKey() }, { epoch: 1, epochSecret: generateSecretKey() },
      { removed: [member] }, { closed: true }, { destruct: true as const }, { endsAt: NOW + 100 }]) {
      await expect(j.checkpoint({ ...j.snapshot(), ...patch })).rejects.toThrow()
    }
    const change = transition(j.snapshot())
    await j.prepareRekey(change.event, change.next)
    await expect(j.checkpoint(j.snapshot())).rejects.toThrow(/pending/)
    await j.close()
    const back = LiveKeeperJournal.open(s.open(), () => NOW)
    expect(back.snapshot().channels).toEqual(['radio'])
    expect(back.pendingEvents()[0]!.id).toBe(change.event.id)
    await back.close()
  })

  it('creates its own room and reopens, refusing missing, legacy, malformed and conflicting state', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW })
    const state = j.snapshot()
    await j.close()
    const back = LiveKeeperJournal.open(s.open(), () => NOW)
    expect(back.snapshot()).toEqual(state)
    expect(() => LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'] })).toThrow(/exists/)
    expect(() => LiveKeeperJournal.open(storage().open())).toThrow(/missing/)
    s.disk.raw = JSON.stringify({ v: 2, secret: 'legacy' })
    expect(() => LiveKeeperJournal.open(s.open())).toThrow()
    await back.close()
  })

  it('persists before handoff and reuses exactly one signed answer after ambiguous acceptance', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW })
    const ask = requestFor(j.snapshot())
    let offered: Event | undefined
    await expect(j.answer(ask.request, async event => {
      expect(s.disk.raw).toContain(event.id)
      offered = event
      throw new Error('lost acceptance')
    })).rejects.toThrow('lost acceptance')
    await j.close()
    const reopened = LiveKeeperJournal.open(s.open(), () => NOW)
    expect(await reopened.answer(ask.request, async event => { expect(event).toEqual(offered) })).toBe(true)
    expect(decodeLivePersistentAnswer(offered!, { ...ask.context, request: ask.request, requesterSk: ask.requesterSk, now: NOW })?.epochHint).toBe(0)
    expect(await reopened.answer(ask.request, async () => {})).toBe(true)
    expect(await reopened.answer(ask.request, async () => { throw new Error('fourth offer') })).toBe(false)
    await reopened.close()
  })

  it('makes retirement durable before any tombstone handoff and never reactivates it', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW })
    const ask = requestFor(j.snapshot())
    await j.retire()
    const ids = j.pendingEvents().map(e => e.id)
    await j.close()
    const back = LiveKeeperJournal.open(s.open(), () => NOW)
    expect(back.status).toBe('pending')
    expect(await back.answer(ask.request, async () => { throw new Error('retired answer') })).toBe(false)
    const events: string[] = []
    expect(await back.offerPending(async e => { events.push(e.id) })).toBe(true)
    expect(events).toEqual(ids)
    expect(back.status).toBe('retired')
    expect(await back.answer(ask.request, async () => { throw new Error('retired answer') })).toBe(false)
    await back.close()
    expect(LiveKeeperJournal.open(s.open(), () => NOW).status).toBe('retired')
  })

  it('keeps a pending rekey secret and ID across failure, blocks competing preparation and old cached proofs', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW })
    const ask = requestFor(j.snapshot())
    await j.answer(ask.request, async () => {})
    const change = transition(j.snapshot())
    await j.prepareRekey(change.event, change.next)
    expect(await j.answer(ask.request, async () => { throw new Error('pending answer') })).toBe(false)
    await expect(j.prepareRekey(change.event, change.next)).rejects.toThrow(/pending/)
    await expect(j.offerPending(async () => { throw new Error('lost acceptance') })).rejects.toThrow('lost acceptance')
    await j.close()
    const back = LiveKeeperJournal.open(s.open(), () => NOW)
    expect(back.pendingEvents()).toEqual([JSON.parse(JSON.stringify(change.event))])
    await back.offerPending(async event => { expect(event.id).toBe(change.event.id) })
    expect({ ...back.snapshot(), members: back.snapshot().members ?? [] }).toEqual(change.next)
    expect(await back.answer(ask.request, async () => { throw new Error('old epoch proof') })).toBe(false)
    const fresh = requestFor(back.snapshot())
    await back.answer(fresh.request, async event => {
      expect(decodeLivePersistentAnswer(event, { ...fresh.context, request: fresh.request, requesterSk: fresh.requesterSk, now: NOW })?.epochHint).toBe(1)
    })
    await back.close()
    const final = LiveKeeperJournal.open(s.open(), () => NOW)
    expect({ ...final.snapshot(), members: final.snapshot().members ?? [] }).toEqual(change.next)
    await final.close()
  })

  it('stages closure and retirement together and retains sticky self-destruct on reopen', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW })
    const change = transition(j.snapshot(), NOW, true)
    await j.prepareRekey(change.event, change.next)
    expect(j.pendingEvents().map(e => e.kind)).toEqual([1461, 1462])
    await j.close()
    const back = LiveKeeperJournal.open(s.open(), () => NOW)
    await back.offerPending(async () => {})
    await back.close()
    const closed = LiveKeeperJournal.open(s.open(), () => NOW)
    expect(closed.status).toBe('closed')
    expect(closed.snapshot()).toMatchObject({ closed: true, destruct: true, epoch: 1 })
    expect(await closed.answer(requestFor(closed.snapshot()).request, async () => { throw new Error('closed answer') })).toBe(false)
    await closed.close()
  })

  it('rejects another authority, wrong next secret, membership rollback and weakened lifetime', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW, endsAt: NOW + 1000, destruct: true })
    const change = transition(j.snapshot())
    for (const patch of [{ epochSecret: generateSecretKey() }, { secret: generateSecretKey() }, { inviterSk: generateSecretKey() },
      { removed: [] }, { endsAt: NOW + 2000 }, { destruct: undefined }, { epoch: 2 }]) {
      await expect(j.prepareRekey(change.event, { ...change.next, ...patch })).rejects.toThrow()
    }
    expect(j.status).toBe('active')
    await j.close()
  })

  it('persists challenge limits and clock high-water across reopen', async () => {
    let at = NOW
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => at })
    for (let i = 0; i < 16; i++) expect(await j.answer(requestFor(j.snapshot(), at).request, async () => {})).toBe(true)
    expect(await j.answer(requestFor(j.snapshot(), at).request, async () => { throw new Error('over quota') })).toBe(false)
    await j.close()
    const back = LiveKeeperJournal.open(s.open(), () => at)
    expect(await back.answer(requestFor(back.snapshot(), at).request, async () => { throw new Error('reset quota') })).toBe(false)
    at--
    await expect(back.answer(requestFor(back.snapshot(), at).request, async () => {})).rejects.toThrow(/backwards/)
    at = NOW + 60
    expect(await back.answer(requestFor(back.snapshot(), at).request, async () => {})).toBe(true)
    await back.close()
  })

  it.each(['before', 'after'])('poisons the owner on a %s-save failure and offers nothing', async failure => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW })
    const ask = requestFor(j.snapshot())
    s.disk.fail = failure
    await expect(j.answer(ask.request, async () => { throw new Error('must not offer') })).rejects.toThrow()
    expect(j.status).toBe('poisoned')
    s.disk.fail = ''
    await expect(j.answer(ask.request, async () => {})).rejects.toThrow(/unavailable/)
    await j.close()
    const back = LiveKeeperJournal.open(s.open(), () => NOW)
    expect(await back.answer(ask.request, async () => {})).toBe(true)
    await back.close()
  })

  it('serialises retirement with an outstanding handoff and snapshots cannot mutate authority', async () => {
    const s = storage(), j = LiveKeeperJournal.create(s.open(), { relays: ['wss://relay.example/'], now: () => NOW })
    const original = j.snapshot(), ask = requestFor(original)
    j.snapshot().secret.fill(0)
    expect(j.snapshot()).toEqual(original)
    let finish!: () => void, entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    const offered = j.answer(ask.request, () => new Promise<void>(r => { finish = r; entered() }))
    await started
    const retiring = j.retire()
    await Promise.resolve()
    expect(j.status).toBe('active')
    finish(); await offered; await retiring
    expect(j.status).toBe('pending')
    await j.close()
  })
})
