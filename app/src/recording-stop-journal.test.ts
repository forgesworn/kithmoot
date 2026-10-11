import { expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { signRecordingNotice } from '../../src/meeting.js'
import { memoryDeviceStore } from './device-store.js'
import { RecordingStopJournal, type SignedRecordingOff } from './recording-stop-journal.js'

const room = 'ab'.repeat(32), participant = 'aa'.repeat(32), device = 'bb'.repeat(32)
const authoritySk = new Uint8Array(32).fill(7), authority = getPublicKey(authoritySk)
const off = (version = 18): SignedRecordingOff => {
  const notice = { on: false as const, id: '12'.repeat(16), version }
  return { op: 'recording', ...notice, sig: signRecordingNotice({ roomId: room, notice, authoritySk }) }
}
it('recovers the exact Off after controller recreation and exposes no mutable stored state', () => {
  const store = memoryDeviceStore(), journal = new RecordingStopJournal(store, room, participant, device, authority)
  const signed = off(); journal.arm(signed)
  const restored = new RecordingStopJournal(store, room, participant, device, authority)
  expect(restored.pending()).toEqual(signed)
  restored.pending()!.version = 19
  expect(restored.pending()).toEqual(signed)
  restored.confirm(signed)
  expect(restored.pending()).toBeUndefined()
})
it('cannot lend the retained stop to another room, participant, device or authority', () => {
  const store = memoryDeviceStore(), journal = new RecordingStopJournal(store, room, participant, device, authority)
  journal.arm(off())
  for (const scope of [['cd'.repeat(32), participant, device, authority], [room, 'cc'.repeat(32), device, authority],
    [room, participant, 'dd'.repeat(32), authority], [room, participant, device, 'ee'.repeat(32)]]) {
    expect(new RecordingStopJournal(store, scope[0]!, scope[1]!, scope[2]!, scope[3]!).pending()).toBeUndefined()
  }
})
it('rejects tampering and storage refusal before recording can start', () => {
  const store = memoryDeviceStore(), journal = new RecordingStopJournal(store, room, participant, device, authority)
  expect(() => journal.arm({ ...off(), sig: '00'.repeat(64) })).toThrow('not authorised')
  journal.arm(off())
  store.set(store.keys()[0]!, JSON.stringify({ ...off(), on: true }))
  expect(() => journal.pending()).toThrow('needs recovery')
  const refusing = { ...memoryDeviceStore(), set: () => {} }
  expect(() => new RecordingStopJournal(refusing, room, participant, device, authority).arm(off())).toThrow('could not retain')
})
it('cannot clear a later stop with an earlier completion', () => {
  const store = memoryDeviceStore(), journal = new RecordingStopJournal(store, room, participant, device, authority)
  const first = off(), second = off(20)
  journal.arm(first)
  expect(() => journal.arm(second)).toThrow('previous recording stop')
  journal.confirm(first); journal.arm(second); journal.confirm(first)
  expect(journal.pending()).toEqual(second)
})

it('accepts the same signed stop regardless of JSON property ordering', () => {
  const store = memoryDeviceStore(), journal = new RecordingStopJournal(store, room, participant, device, authority)
  const signed = off()
  journal.arm(signed)
  journal.arm({ sig: signed.sig, version: signed.version, id: signed.id, on: false, op: 'recording' })
  expect(journal.pending()).toEqual(signed)
})

it('retires recovery only for a strictly newer state signed by the pinned room authority', () => {
  const store = memoryDeviceStore(), journal = new RecordingStopJournal(store, room, participant, device, authority)
  const retained = off(); journal.arm(retained)
  const notice = { on: true, id: '34'.repeat(16), version: retained.version + 1 }
  const newer = { op: 'recording' as const, ...notice, sig: signRecordingNotice({ roomId: room, notice, authoritySk }) }
  expect(journal.retireSuperseded({ ...newer, sig: '00'.repeat(64) })).toBe(false)
  expect(journal.retireSuperseded(retained)).toBe(false)
  expect(journal.retireSuperseded({ ...newer, sig: signRecordingNotice({ roomId: 'cd'.repeat(32), notice, authoritySk }) })).toBe(false)
  expect(journal.pending()).toEqual(retained)
  expect(journal.retireSuperseded(newer)).toBe(true)
  expect(journal.pending()).toBeUndefined()
})
