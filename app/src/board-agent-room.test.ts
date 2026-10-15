import {describe, expect, it, vi} from 'vitest'
import type {RoomSession} from '../../src/session.js'
import type {AssignmentLog} from '../../src/assignment-log.js'
import {borrowBoardAgentRoom} from './board-agent-room.js'

function fixture() {
  let current = true
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
  return {room, source, off, publish, change: () => {current = false},
    borrowed: borrowBoardAgentRoom(room as unknown as RoomSession, source as unknown as AssignmentLog, () => current)}
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
