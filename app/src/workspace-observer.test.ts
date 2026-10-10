import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createDeviceCredential } from '../../src/credential.js'
import { localIdentity } from '../../src/identity.js'
import { deriveRoom } from '../../src/room.js'
import { encodeChatEvent } from '../../src/chat.js'
import { deriveEpoch, encodeRekeyEvent, generateEpochSecret } from '../../src/epoch.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { observeWorkspaceActivity } from './workspace-observer.js'

const NOW = 1_800_000_000
async function fixture(loadJournal: () => Promise<string | undefined> = async () => undefined) {
  const root = deriveRoom(generateSecretKey()), relay = new SimRelay({ replay: true })
  const transport = new SimTransport(relay), sender = new SimTransport(relay)
  const authoritySk = generateSecretKey(), deviceSk = generateSecretKey(), authorDevice = generateSecretKey()
  const identity = localIdentity(generateSecretKey())
  const credential = await createDeviceCredential({ identity, devicePubkey: getPublicKey(authorDevice), roomId: root.roomId, expiresAt: NOW + 3600, now: () => NOW })
  const publish = vi.spyOn(transport, 'publish'), subscribe = vi.spyOn(transport, 'subscribe'), close = vi.spyOn(transport, 'close')
  const changed = vi.fn(), moved = vi.fn(), ended = vi.fn()
  const observation = observeWorkspaceActivity({ ...root, transport, participant: getPublicKey(generateSecretKey()), name: 'Ada',
    authority: getPublicKey(authoritySk), deviceSk, loadJournal, isBlocked: () => false, valid: () => true,
    now: () => NOW, changed, onEpoch: moved, onClosed: ended })
  const send = async (text: string, epoch?: ReturnType<typeof deriveEpoch>) => sender.publish(encodeChatEvent({ id: text, text,
    participant: identity.pubkey, device: getPublicKey(authorDevice), credential, sentAt: NOW }, { ...root, deviceSk: authorDevice, epoch }))
  return { root, relay, transport, sender, authoritySk, deviceSk, observation, publish, subscribe, close, changed, moved, ended, send }
}

describe('workspace observer lifetime and authority', () => {
  it('reads bounded activity without publishing presence, signing work or writing a journal', async () => {
    const f = await fixture()
    try {
      await vi.waitFor(() => expect(f.observation.snapshot().work.ready).toBe(true))
      await f.send('A room message')
      expect(f.observation.snapshot().messages.map(message => message.text)).toEqual(['A room message'])
      expect(f.publish).not.toHaveBeenCalled()
      const filters = f.subscribe.mock.calls.flatMap(call => call[0]).filter(filter => filter.kinds?.includes(1460))
      expect(filters.length).toBeGreaterThan(0)
      expect(filters.every(filter => filter.limit === 128 && filter.since === NOW - 86_400)).toBe(true)
      expect(f.observation.snapshot().work.historyComplete).toBe(false)
    } finally { f.observation.close() }
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.observation.snapshot().messages).toEqual([])
  })
  it('follows its own authorised rekey, then clears activity if a later rekey omits this device', async () => {
    const f = await fixture()
    try {
      const zero = { epoch: 0, id: f.root.roomId, key: f.root.roomKey }
      const one = { epoch: 1, secret: generateEpochSecret() }
      await f.sender.publish(encodeRekeyEvent({ roomId: f.root.roomId, authoritySk: f.authoritySk, current: zero, next: one,
        recipients: [getPublicKey(f.deviceSk)], removed: [], commit: true, now: NOW - 1 }))
      expect(f.moved).toHaveBeenCalledOnce()
      await f.send('After the authorised rekey', deriveEpoch(one))
      expect(f.observation.snapshot().messages.map(message => message.text)).toEqual(['After the authorised rekey'])
      await f.sender.publish(encodeRekeyEvent({ roomId: f.root.roomId, authoritySk: f.authoritySk, current: deriveEpoch(one),
        next: { epoch: 2, secret: generateEpochSecret() }, recipients: [getPublicKey(generateSecretKey())], removed: [], commit: true, now: NOW }))
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
      expect(f.observation.snapshot().error).toContain('Room access changed')
      expect(f.observation.snapshot().messages).toEqual([])
      expect(f.observation.snapshot().work.assignments).toEqual([])
      await f.send('Old epoch activity must not reappear', deriveEpoch(one))
      expect(f.observation.snapshot().messages).toEqual([])
    } finally { f.observation.close() }
  })
  it('cannot start a delayed assignment subscription after the view closes', async () => {
    let resolve!: (value: undefined) => void
    const loaded = new Promise<undefined>(done => { resolve = done })
    const f = await fixture(() => loaded)
    const before = f.subscribe.mock.calls.length
    f.observation.close(); resolve(undefined)
    await new Promise(done => setTimeout(done, 0))
    expect(f.subscribe).toHaveBeenCalledTimes(before)
    expect(f.observation.snapshot().work.ready).toBe(false)
    expect(f.observation.snapshot().messages).toEqual([])
  })
  it('drops activity and reports an authoritative self-destructing closure to room cleanup', async () => {
    const f = await fixture()
    try {
      await f.send('Before room closure')
      expect(f.observation.snapshot().messages).toHaveLength(1)
      await f.sender.publish(encodeRekeyEvent({ roomId: f.root.roomId, authoritySk: f.authoritySk,
        current: { epoch: 0, id: f.root.roomId, key: f.root.roomKey }, next: { epoch: 1, secret: generateEpochSecret() },
        recipients: [], removed: [], commit: true, closed: true, destruct: true, now: NOW }))
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
      expect(f.ended).toHaveBeenCalledWith(true)
      expect(f.observation.snapshot().messages).toEqual([])
      expect(f.observation.snapshot().error).toContain('room has ended')
    } finally { f.observation.close() }
  })
})
