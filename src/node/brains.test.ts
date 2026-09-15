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

import { ModelBrain, StdioBrain, toStdioEvent } from './brains.js'
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
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'ready', protocolVersion: 1 })
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


it('returns room history as a correlated snapshot without replaying messages as new requests', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const events: Array<Record<string, unknown>> = []
  output.on('data', bytes => events.push(JSON.parse(bytes.toString())))
  const message = { id: 'original', participant: 'd'.repeat(64), name: 'Room visitor', text: 'The latest comment', sentAt: 123 }
  const conversation = vi.fn(() => ({ messages: () => [message, { ...message, id: 'reaction', reaction: { emoji: '👍' } }, { ...message, id: 'removed' }, { ...message, id: 'tombstone', retracts: 'removed', text: '' }, { ...message, id: 'edit', replaces: 'original', text: 'Corrected latest comment', sentAt: 124 }] }))
  const runtime = {
    agent: { participant: 'a'.repeat(64), device: 'b'.repeat(64), roomId: 'c'.repeat(64), url: 'https://example.invalid/', hosting: false },
    persona: { name: 'Tally', system: '' }, roster: () => [], on: () => () => {}, conversation,
  } as unknown as AgentRuntime
  const stop = await new StdioBrain(input, output).start(runtime)
  try {
    input.write(JSON.stringify({ op: 'history-snapshot', id: 'request-1', channel: 'chat', limit: 20 }) + '\n')
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'ok', op: 'history-snapshot', id: 'request-1' }))
    expect(events).toContainEqual({ type: 'history-snapshot', id: 'request-1', room: 'c'.repeat(64), channel: 'chat', messages: [{ ...message, text: 'Corrected latest comment' }] })
    expect(events.some(e => e.type === 'chat')).toBe(false)
    expect(conversation).toHaveBeenCalledWith('chat')
    input.write(JSON.stringify({ op: 'history-snapshot', id: 'bad', channel: 'chat', limit: 100000 }) + '\n')
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'error', message: 'History limit must be from 1 to 200' }))
    expect(conversation).toHaveBeenCalledTimes(1)
  } finally { await stop(); input.destroy(); output.destroy() }
})


describe('model request outcomes', () => {
  async function fixture(complete: (signal?: AbortSignal) => Promise<string>, opts = {}) {
    const send = vi.fn(async (_text: string, _options?: unknown) => {})
    let listener: (event: import('./runtime.js').RuntimeEvent) => void = () => {}
    const runtime = {
      agent: { participant: 'agent' }, persona: { name: 'Tally', system: '' },
      roster: () => [{ participant: 'person', agent: false }],
      on: (fn: typeof listener) => { listener = fn; return () => { listener = () => {} } },
      brief: async () => 'context', line: (m: { text: string }) => m.text,
      acknowledge: vi.fn(async () => {}),
      conversation: vi.fn(() => ({ send })), whisper: vi.fn(async () => {}),
    } as unknown as AgentRuntime
    class TestBrain extends ModelBrain {
      protected complete(_system: string, _user: string, signal?: AbortSignal) { return complete(signal) }
    }
    const stop = await new TestBrain({ debounceMs: 1, minGapMs: 0, turnTimeoutMs: 100, ...opts }).start(runtime)
    const emit = (id: string, channel = 'chat') => {
      const message = { id, participant: 'person', text: '@Tally help', sentAt: Date.now() / 1000 } as import('../chat.js').ChatMessage
      listener(channel === 'chat' ? { type: 'chat', message, at: Date.now(), addressed: true }
        : { type: 'channel', channel, message, at: Date.now(), addressed: true })
      return message
    }
    return { runtime, send, stop, emit }
  }

  it('reports a failed provider in the request conversation without exposing its error', async () => {
    vi.useFakeTimers()
    const f = await fixture(async () => { throw new Error('private-provider-key') })
    try {
      const request = f.emit('request', 'workshop')
      await vi.advanceTimersByTimeAsync(2)
      expect(f.runtime.conversation).toHaveBeenCalledWith('workshop')
      expect(f.send).toHaveBeenCalledWith('I received your request, but could not complete the reply. Please retry.', { replyTo: request })
      expect(JSON.stringify(f.send.mock.calls)).not.toContain('private-provider-key')
    } finally { await f.stop(); vi.useRealTimers() }
  })

  it('makes an empty or quiet answer visible for a direct human request', async () => {
    vi.useFakeTimers()
    const f = await fixture(async () => '/quiet')
    try {
      f.emit('request')
      await vi.advanceTimersByTimeAsync(2)
      expect(f.send.mock.calls[0]?.[0]).toContain('did not produce an answer')
    } finally { await f.stop(); vi.useRealTimers() }
  })

  it('aborts a hung turn, serves queued requests, and discards a late provider answer', async () => {
    vi.useFakeTimers()
    let finish!: (reply: string) => void
    let firstSignal: AbortSignal | undefined
    let calls = 0
    const f = await fixture(signal => {
      calls++
      if (calls > 1) return Promise.resolve('Second request answered')
      firstSignal = signal
      return new Promise(resolve => { finish = resolve })
    })
    try {
      f.emit('first')
      await vi.advanceTimersByTimeAsync(2)
      const second = f.emit('second')
      await vi.advanceTimersByTimeAsync(110)
      expect(firstSignal?.aborted).toBe(true)
      expect(f.send).toHaveBeenCalledWith(expect.stringContaining('in time'), expect.anything())
      expect(f.send).toHaveBeenCalledWith('Second request answered', { replyTo: second })
      finish('Too late')
      await vi.advanceTimersByTimeAsync(1)
      expect(f.send).toHaveBeenCalledTimes(2)
    } finally { await f.stop(); vi.useRealTimers() }
  })

  it('does not publish a response or failure notice after being stopped', async () => {
    vi.useFakeTimers()
    let finish!: (reply: string) => void
    const f = await fixture(() => new Promise(resolve => { finish = resolve }))
    try {
      f.emit('first')
      await vi.advanceTimersByTimeAsync(2)
      f.emit('queued')
      await f.stop()
      finish('Must not be sent')
      await vi.advanceTimersByTimeAsync(200)
      expect(f.send).not.toHaveBeenCalled()
    } finally { await f.stop(); vi.useRealTimers() }
  })
})
