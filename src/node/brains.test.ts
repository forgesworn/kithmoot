/**
 * The stdio protocol carries who asked.
 *
 * Kill condition: a presence request that reaches a brain without the
 * asking participant. Every rule about who may bring an agent into a room
 * is a rule about that key, so dropping it makes the rule unenforceable and
 * the omission is invisible: the click still works, for everybody.
 */
import { describe, expect, it } from 'vitest'

import { toStdioEvent } from './brains.js'

describe('presence requests reach the brain', () => {
  it('carries the asking participant, because every rule about invitation is a rule about who asked', () => {
    // The sender is on the control message already. Not passing it up was
    // the omission; a brain that cannot see who asked cannot refuse anyone.
    const event = {
      type: 'presence' as const,
      op: 'invite' as const,
      host: 'host-key',
      agent: 'tally',
      by: 'asker-key',
      at: 1,
    }
    expect(toStdioEvent(event)).toEqual({
      type: 'presence',
      op: 'invite',
      host: 'host-key',
      agent: 'tally',
      by: 'asker-key',
    })
  })

  it('keeps catalogue? without a host or an agent, since it addresses everyone', () => {
    expect(toStdioEvent({ type: 'presence', op: 'catalogue?', by: 'asker-key', at: 1 })).toEqual({
      type: 'presence',
      op: 'catalogue?',
      by: 'asker-key',
    })
  })
})
