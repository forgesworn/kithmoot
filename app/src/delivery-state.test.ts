import { describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import type { PublishEvidence, RelayAckEvidence } from '../../src/relay-pool.js'
import { memoryDeviceStore } from './device-store.js'
import { ASK_BACK_AFTER_MS, DELIVERY_KEPT_MS, GIVE_UP_AFTER_MS, DeliveryTicks, MAX_DELIVERY_KEPT, NO_EVIDENCE_AFTER_MS, deliveryWords, isTickMessage, sentState } from './delivery-state.js'

const ROOM = 'a'.repeat(64)
const relay = (url: string, patch: Partial<RelayAckEvidence> = {}): RelayAckEvidence => ({ url, readable: true, acked: true, at: 0, keeps: false, lost: false, ...patch })
const evidence = (...relays: RelayAckEvidence[]): PublishEvidence => ({ kind: 1460, pending: 0, relays })
const signed = (id: string): Event => ({ id: id.repeat(64).slice(0, 64), kind: 1460, pubkey: 'p', created_at: 1, tags: [], content: 'x', sig: 's' }) as Event

describe('what the relays have said about one message', () => {
  it('is sent when a relay returned this event, or has been seen to keep chat', () => {
    expect(sentState(evidence(relay('a', { found: true })))).toBe('sent')
    expect(sentState(evidence(relay('a', { keeps: true })))).toBe('sent')
    // One relay that kept it is enough, whatever the others did.
    expect(sentState(evidence(relay('a', { found: false, lost: true }), relay('b', { found: true })))).toBe('sent')
    expect(sentState(evidence(relay('a', { lost: true }), relay('b', { keeps: true })))).toBe('sent')
  })

  it('is checking until a relay has answered', () => {
    expect(sentState(evidence(relay('a')))).toBe('checking')
    expect(sentState(evidence(relay('a'), relay('b', { found: false })))).toBe('checking')
  })

  it('is not kept only when every acknowledging relay was seen to lose it', () => {
    expect(sentState(evidence(relay('a', { found: false, lost: true })))).toBe('not-kept')
    expect(sentState(evidence(relay('a', { lost: true }), relay('b', { found: false })))).toBe('not-kept')
  })

  it('counts a relay that returned the event though its OK never arrived, and waits for one not yet asked', () => {
    const silent = relay('b', { acked: false, at: 0 })
    expect(sentState(evidence(relay('a', { found: false, lost: true }), { ...silent, found: true }))).toBe('sent')
    expect(sentState(evidence(relay('a', { found: false, lost: true }), silent))).toBe('checking')
    // What it did with other events says nothing about an event it never acknowledged.
    expect(sentState(evidence(relay('a', { found: false, lost: true }), { ...silent, keeps: true }))).toBe('checking')
    // Nowhere: every relay that was asked, acknowledged or not, returned nothing.
    expect(sentState(evidence(relay('a', { found: false, lost: true }), { ...silent, found: false }))).toBe('not-kept')
  })

  it('is checking, not lost, while a relay is still working on the write', () => {
    const lost = relay('a', { found: false, lost: true })
    expect(sentState({ ...evidence(lost), pending: 1 })).toBe('checking')
    expect(sentState({ ...evidence(lost), pending: 0 })).toBe('not-kept')
    // What has been kept is kept, whoever is still working.
    expect(sentState({ ...evidence(lost, relay('b', { found: true })), pending: 2 })).toBe('sent')
  })

  it('does not hold an earlier failure against a write that has not been checked, once it was sent again', () => {
    const one = evidence(relay('a', { lost: true }))
    expect(sentState(one)).toBe('not-kept')
    expect(sentState(one, { trustRelayLoss: false })).toBe('checking')
    expect(sentState(evidence(relay('a', { lost: true, found: false })), { trustRelayLoss: false })).toBe('not-kept')
  })

  it('says nothing when a relay that took it cannot be asked, or when none is known', () => {
    expect(sentState(undefined)).toBeUndefined()
    expect(sentState(evidence())).toBeUndefined()
    expect(sentState(evidence(relay('a', { readable: false })))).toBeUndefined()
    // A write-only relay may hold it: never "not kept", but another relay's return still counts.
    expect(sentState(evidence(relay('a', { found: false, lost: true }), relay('w', { readable: false })))).toBeUndefined()
    expect(sentState(evidence(relay('a', { found: true }), relay('w', { readable: false })))).toBe('sent')
  })
})

describe('which messages get a tick', () => {
  it('is those that render as a row, and not reactions, edits, retractions, invitations, logos or shared-work operations', () => {
    expect(isTickMessage({})).toBe(true)
    expect(isTickMessage({ reaction: { emoji: 'x' } as never })).toBe(false)
    expect(isTickMessage({ replaces: 'a' })).toBe(false)
    expect(isTickMessage({ retracts: 'a' })).toBe(false)
    expect(isTickMessage({ invite: {} as never })).toBe(false)
    expect(isTickMessage({ roomLogo: 'x' as never })).toBe(false)
    expect(isTickMessage({ assignment: {} as never })).toBe(false)
  })
})

describe('the words', () => {
  it('names each state the same way for sight and for a screen reader, and offers Retry only when not kept', () => {
    expect(deliveryWords('checking')).toEqual({ label: 'Sending', title: 'Sending…' })
    expect(deliveryWords('sent')).toEqual({ label: 'Sent', title: 'Sent. Not yet confirmed on anyone else’s device.' })
    expect(deliveryWords('not-kept')).toEqual({ label: 'Not kept. Retry', title: 'Not kept: a relay accepted it but did not keep it.' })
  })
})

function rig(options: { evidence?: (id: string) => PublishEvidence | undefined } = {}) {
  const store = memoryDeviceStore()
  let clock = 1_800_000_000_000
  const known = new Map<string, PublishEvidence>()
  const askBack = vi.fn()
  const onChange = vi.fn()
  const make = () => new DeliveryTicks({ store, evidence: options.evidence ?? (id => known.get(id)), askBack, now: () => clock, onChange })
  return { store, known, askBack, onChange, make, ticks: make(), advance: (ms: number) => { clock += ms }, now: () => clock }
}

describe('ticks on this device’s own messages', () => {
  it('shows a clock from the acknowledgement, then one tick when a relay returns it', () => {
    const r = rig(), event = signed('1')
    r.ticks.note(ROOM, 'm1', event)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('checking')
    expect(r.ticks.waiting(ROOM)).toBe(true)
    r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('checking')
    r.known.set(event.id, evidence(relay('a', { found: true })))
    r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')).toMatchObject({ state: 'sent' })
    expect(r.ticks.get(ROOM, 'm1')).not.toHaveProperty('event')
    expect(r.ticks.waiting(ROOM)).toBe(false)
  })

  it('keeps the verdict across a reload, and the signed event of a message that was not kept', () => {
    const r = rig(), kept = signed('1'), lost = signed('2')
    r.ticks.note(ROOM, 'kept', kept); r.ticks.note(ROOM, 'lost', lost)
    r.known.set(kept.id, evidence(relay('a', { found: true })))
    r.known.set(lost.id, evidence(relay('a', { found: false, lost: true })))
    r.ticks.refresh(ROOM)
    const reloaded = r.make()
    expect(reloaded.get(ROOM, 'kept')).toMatchObject({ state: 'sent', eventId: kept.id })
    expect(reloaded.get(ROOM, 'lost')).toMatchObject({ state: 'not-kept', event: lost })
    expect(reloaded.get(ROOM, 'other')).toBeUndefined()
  })

  it('does not keep a verdict it has not reached, so a reload shows no tick rather than a guess', () => {
    const r = rig()
    r.ticks.note(ROOM, 'm1', signed('1'))
    expect(r.make().get(ROOM, 'm1')).toBeUndefined()
    expect(r.store.keys()).toEqual([])
  })

  it('retries the same signed event, and lets the new write answer for itself', () => {
    const r = rig(), event = signed('1')
    r.ticks.note(ROOM, 'm1', event)
    r.known.set(event.id, evidence(relay('a', { found: false, lost: true, at: r.now() })))
    r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('not-kept')
    r.advance(5_000)
    expect(r.ticks.retry(ROOM, 'm1')?.event).toEqual(event)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('checking')
    // What the relay did with the first write is not an answer about this one.
    r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('checking')
    // It has acknowledged the new write but not been asked for it yet: its mark from before still is not an answer.
    r.known.set(event.id, evidence(relay('a', { lost: true, at: r.now() + 10 })))
    r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('checking')
    r.known.set(event.id, evidence(relay('a', { found: true, keeps: true, at: r.now() + 10 })))
    r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('sent')
  })

  it('is not kept again when the relays still return nothing for the retried write', () => {
    const r = rig(), event = signed('1')
    r.ticks.note(ROOM, 'm1', event)
    r.known.set(event.id, evidence(relay('a', { found: false, lost: true, at: r.now() })))
    r.ticks.refresh(ROOM); r.advance(5_000); r.ticks.retry(ROOM, 'm1')
    r.known.set(event.id, evidence(relay('a', { found: false, lost: true, at: r.now() + 10 })))
    r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('not-kept')
  })

  it('goes back to not kept when the retry itself fails, and offers Retry only for what is not kept', () => {
    const r = rig(), event = signed('1')
    r.ticks.note(ROOM, 'm1', event)
    expect(r.ticks.retry(ROOM, 'm1')).toBeUndefined()
    r.known.set(event.id, evidence(relay('a', { found: false })))
    r.ticks.refresh(ROOM)
    r.ticks.retry(ROOM, 'm1')
    r.ticks.failed(ROOM, 'm1')
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('not-kept')
    expect(r.make().get(ROOM, 'm1')?.event).toEqual(event)
  })

  it('asks the relays about a message by name once it has waited, and only once', () => {
    const r = rig(), event = signed('1')
    r.known.set(event.id, evidence(relay('a')))
    r.ticks.note(ROOM, 'm1', event)
    r.advance(ASK_BACK_AFTER_MS - 1); r.ticks.refresh(ROOM)
    expect(r.askBack).not.toHaveBeenCalled()
    r.advance(1); r.ticks.refresh(ROOM); r.ticks.refresh(ROOM)
    expect(r.askBack).toHaveBeenCalledExactlyOnceWith(event.id)
  })

  it('drops the clock when nothing can ever say, rather than leaving it for ever', () => {
    const r = rig(), event = signed('1')
    r.ticks.note(ROOM, 'm1', event)
    r.advance(NO_EVIDENCE_AFTER_MS - 1); r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')).toBeDefined()
    r.advance(1); r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')).toBeUndefined()
    // A relay that cannot be asked is treated the same.
    r.known.set(signed('2').id, evidence(relay('w', { readable: false })))
    r.ticks.note(ROOM, 'm2', signed('2')); r.advance(NO_EVIDENCE_AFTER_MS); r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm2')).toBeUndefined()
  })

  it('gives up a clock that the relays never answer, rather than leaving it for ever', () => {
    const r = rig(), event = signed('1')
    r.known.set(event.id, evidence(relay('a'), relay('b', { acked: false, at: 0 })))
    r.ticks.note(ROOM, 'm1', event)
    r.advance(GIVE_UP_AFTER_MS - 1); r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('checking')
    r.advance(1); r.ticks.refresh(ROOM)
    expect(r.ticks.get(ROOM, 'm1')).toBeUndefined()
  })

  it('shows one tick at once in a quiet room, where the drop being accepted is all there is to say', () => {
    const r = rig()
    r.ticks.note(ROOM, 'm1', signed('1'), true)
    expect(r.ticks.get(ROOM, 'm1')?.state).toBe('sent')
    expect(r.make().get(ROOM, 'm1')?.state).toBe('sent')
  })

  it('forgets verdicts older than a week and keeps a bounded number', () => {
    const r = rig()
    r.ticks.note(ROOM, 'old', signed('1'), true)
    r.advance(DELIVERY_KEPT_MS + 1)
    r.ticks.note(ROOM, 'new', signed('2'), true)
    expect(r.make().get(ROOM, 'old')).toBeUndefined()
    expect(r.make().get(ROOM, 'new')?.state).toBe('sent')
    for (let i = 0; i < MAX_DELIVERY_KEPT + 5; i++) { r.advance(1000); r.ticks.note(ROOM, `m${i}`, signed(String(i % 10)), true) }
    const stored = JSON.parse(r.store.get(`kithmoot.delivery.v1.${ROOM}`)!) as unknown[]
    expect(stored).toHaveLength(MAX_DELIVERY_KEPT)
  })

  it('keeps rooms apart and forgets a room on request', () => {
    const r = rig(), other = 'b'.repeat(64)
    r.ticks.note(ROOM, 'm1', signed('1'), true); r.ticks.note(other, 'm1', signed('2'), true)
    expect(r.ticks.get(ROOM, 'm1')?.eventId).not.toBe(r.ticks.get(other, 'm1')?.eventId)
    r.ticks.forget(ROOM)
    expect(r.make().get(ROOM, 'm1')).toBeUndefined()
    expect(r.make().get(other, 'm1')).toBeDefined()
  })

  it('reads damaged or unavailable storage as no evidence', () => {
    const r = rig()
    r.store.set(`kithmoot.delivery.v1.${ROOM}`, '{not json')
    expect(r.make().get(ROOM, 'm1')).toBeUndefined()
    r.store.set(`kithmoot.delivery.v1.${ROOM}`, JSON.stringify([{ i: 1 }, null, { i: 'a', e: 'b', s: 'delivered', a: 1 }]))
    expect(r.make().get(ROOM, 'a')).toBeUndefined()
    const broken = new DeliveryTicks({ store: { get: () => { throw new Error('no') }, set: () => { throw new Error('no') }, remove: () => { throw new Error('no') }, keys: () => [] }, evidence: () => undefined })
    expect(() => { broken.note(ROOM, 'm', signed('1'), true); broken.forget(ROOM) }).not.toThrow()
  })
})
