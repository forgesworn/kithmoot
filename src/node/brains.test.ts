/**
 * The stdio protocol carries who asked.
 *
 * Kill condition: a presence request that reaches a brain without the
 * asking participant. Every rule about who may bring an agent into a room
 * is a rule about that key, so dropping it makes the rule unenforceable and
 * the omission is invisible: the click still works, for everybody.
 */
import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'

import { StdioBrain, toStdioEvent } from './brains.js'
import type { AgentRuntime } from './runtime.js'

it('carries a model catalogue and refusals from the actual stdio brain to the room', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const lines: string[] = []
  output.on('data', bytes => lines.push(bytes.toString()))
  const sendControl = vi.fn(async () => {})
  const participant = 'a'.repeat(64)
  const runtime = {
    agent: { participant, device: 'b'.repeat(64), roomId: 'c'.repeat(64), url: 'https://example.invalid/j/', hosting: false, sendControl },
    persona: { name: 'Tally', system: '' }, roster: () => [], on: () => () => {},
  } as unknown as AgentRuntime
  const stop = await new StdioBrain(input, output).start(runtime)
  try {
    const agents = [{ id: 'tally', name: 'Tally', models: [{ id: 'astra', label: 'Astra' }] }]
    input.write(JSON.stringify({ op: 'announce', host: 'forged', agents, running: [] }) + '\n')
    await vi.waitFor(() => expect(sendControl).toHaveBeenCalledWith({ op: 'catalogue', host: participant, name: 'Tally', agents, running: [] }))
    expect(lines.join('')).toContain('"op":"announce"')
    input.write(JSON.stringify({ op: 'refuse', agent: 'tally', message: 'Only its principal may invite it.' }) + '\n')
    await vi.waitFor(() => expect(sendControl).toHaveBeenCalledWith({ op: 'error', host: participant, agent: 'tally', message: 'Only its principal may invite it.' }))
    input.write(JSON.stringify({ op: 'announce', agents: null }) + '\n')
    await vi.waitFor(() => expect(lines.join('')).toContain('invalid catalogue'))
    expect(sendControl).toHaveBeenCalledTimes(2)
  } finally { await stop(); input.destroy(); output.destroy() }
})

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
