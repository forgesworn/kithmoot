import {describe, expect, it, vi} from 'vitest'
import type {RoomSession} from '../../src/session.js'
import type {AssignmentLog} from '../../src/assignment-log.js'
import type {KnownRoom} from './rooms-store.js'
import {boardAgentRoomCurrent, borrowBoardAgentRoom} from './board-agent-room.js'

function fixture(overrides: Partial<KnownRoom> = {}) {
  let current = true
  const scope: KnownRoom = {roomId: 'room-a', link: 'standing-invitation', openedAt: 1, readAt: 0, ...overrides}
  const off = vi.fn(), publish = vi.fn(async () => ({}))
  const room = {roomId: 'room-a', participant: 'person-a', device: 'device-a',
    participants: () => [{participant: 'tally', name: 'Tally', agent: true, devices: ['agent-device']}],
    onChange: vi.fn(() => off), leave: vi.fn(),
    channel: vi.fn(() => ({messages: () => [], onChange: () => off, send: publish})),
  }
  const source = {roomId: room.roomId, participant: room.participant,
    snapshot: () => ({assignments: [], ready: true, pendingHistory: 0, pendingSends: 0, historyComplete: true}),
    onChange: vi.fn(() => off), close: vi.fn(),
    submit: vi.fn(async (...args: unknown[]) => {
      if (!(args[4] as () => boolean)()) throw new Error('source changed')
      return {id: 'canonical-assignment'}
    }),
  }
  return {room, source, off, publish, scope, change: () => {current = false},
    borrowed: borrowBoardAgentRoom(room as unknown as RoomSession, source as unknown as AssignmentLog, () => current && boardAgentRoomCurrent(scope, room.roomId, 'standing-invitation'))}
}

describe('board assignment uses the existing admitted chat', () => {
  it('uses the canonical log and installation; closing the card leaves the chat open', async () => {
    const f = fixture(), b = f.borrowed
    expect(b.room.device).toBe('device-a')
    b.log.onChange(() => {})
    const operation = {op: 'create' as const, owner: 'tally', objective: 'Selected card', criteria: 'Return evidence'}
    await expect(b.submitReviewed(() => true, () => b.log.submit(undefined, operation, 'stable-request', null))).resolves.toEqual({id: 'canonical-assignment'})
    expect(f.source.submit.mock.calls[0].slice(0, 4)).toEqual([undefined, operation, 'stable-request', null])
    await b.close()
    expect(f.off).toHaveBeenCalledOnce()
    expect(f.source.close).not.toHaveBeenCalled()
    expect(f.room.leave).not.toHaveBeenCalled()
    expect(b.isCurrent()).toBe(false)
  })

  it('keeps a popped-out card bound to its original room and refuses after switching account or chat', async () => {
    const f = fixture()
    f.change()
    expect(() => f.borrowed.room.roster()).toThrow('linked chat')
    await expect(f.borrowed.submitReviewed(() => true, async () => 'should not run')).rejects.toThrow('linked chat')
    expect(f.source.submit).not.toHaveBeenCalled()
  })

  it('checks the card review at the canonical publication boundary and exposes no arbitrary chat sender', async () => {
    const f = fixture()
    const b = f.borrowed
    await expect(b.submitReviewed(() => false, async () => 'should not run')).rejects.toThrow('current card request')
    await expect(b.room.channel('control').send('send arbitrary card data')).rejects.toThrow('agent directory')
    expect(() => b.room.channel('chat')).toThrow('agent directory')
    expect(f.publish).not.toHaveBeenCalled()
    await b.room.channel('control').send(JSON.stringify({op: 'catalogue?'}))
    expect(f.publish).toHaveBeenCalledOnce()
  })
})

describe('standing board room scope', () => {
  it.each([{endsAt: 1}, {endsAt: 9_999_999_999}, {destruct: true as const}, {endedAt: 0}])('refuses retained restricted context %j before a channel opens or a card submits', async scope => {
    const f = fixture(scope)
    expect(f.borrowed.isCurrent()).toBe(false)
    expect(() => f.borrowed.room.channel('control')).toThrow('linked chat')
    await expect(f.borrowed.submitReviewed(() => true, async () => 'must not run')).rejects.toThrow('linked chat')
    expect(f.room.channel).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.source.submit).not.toHaveBeenCalled()
  })
  it.each(['expiry', 'destruct', 'invitation'] as const)('holds an open card before refresh or publication when its %s changes', async change => {
    const f = fixture(), channel = f.borrowed.room.channel('control')
    if (change === 'expiry') f.scope.endsAt = 9_999_999_999
    if (change === 'destruct') f.scope.destruct = true
    if (change === 'invitation') f.scope.link = 'replacement-invitation'
    await expect(channel.send(JSON.stringify({op: 'catalogue?'}))).rejects.toThrow('linked chat')
    await expect(f.borrowed.submitReviewed(() => true, () => f.borrowed.log.submit(undefined, {op: 'create', owner: 'tally', objective: 'Card', criteria: ''}, 'request', null))).rejects.toThrow('linked chat')
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.source.submit).not.toHaveBeenCalled()
  })
})
