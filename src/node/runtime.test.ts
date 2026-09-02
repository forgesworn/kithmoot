import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { RoomAgent } from '../agent.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { AgentRuntime } from './runtime.js'
import type { RuntimeEvent } from './runtime.js'
import { ModelBrain, StdioBrain, parseReply } from './brains.js'
import { FixedTranscriber } from './transcriber.js'
import type { Utterance } from './utterances.js'
import type { RtpTrackLike } from './audio.js'
import { createFakeFactory } from '../../test/fake-rtc.js'

const BASE = 'https://example.test/j/'

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

async function room() {
  const relay = new SimRelay()
  const transport = () => new SimTransport(relay)
  const keeper = await RoomAgent.create({ base: BASE, name: 'Person', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false })
  const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
  await settle()
  return { relay, keeper, ada }
}

describe('AgentRuntime', () => {
  it('turns the three conversations and the roster into one stream of events', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada, { persona: { name: 'Ada', system: 'You are Ada.' } }).start()
    const person = new AgentRuntime(keeper, { persona: { name: 'Person', system: '' } }).start()
    const events: RuntimeEvent[] = []
    runtime.on((e) => events.push(e))

    await person.say('Ada, are you there?')
    await person.whisper('note to agents')
    await settle()

    const chat = events.filter((e) => e.type === 'chat')
    expect(chat).toHaveLength(1)
    expect(chat[0]!.type === 'chat' && chat[0]!.message.text).toBe('Ada, are you there?')
    expect(events.some((e) => e.type === 'backchannel')).toBe(true)
    expect(runtime.history('chat').map((m) => m.text)).toEqual(['Ada, are you there?'])
    expect(runtime.history('backchannel').map((m) => m.text)).toEqual(['note to agents'])

    const described = runtime.describe()
    expect(described).toContain('Person (')
    expect(described).toContain('Ada, are you there?')
    expect(described).toContain('note to agents')
    expect(runtime.nameOf(ada.participant)).toContain('you')
    await runtime.close()
    await person.close()
  })

  it('treats what was said before it arrived as history, not news', async () => {
    const { keeper, ada } = await room()
    const early = ada.chat
    await keeper.chat.send('old news')
    expect(early.messages()).toHaveLength(1)
    // The runtime starts two minutes later, by its own clock: what was
    // said before it arrived is context, not something said to it.
    const events: RuntimeEvent[] = []
    const runtime = new AgentRuntime(ada, { now: () => Date.now() + 120_000 }).start()
    runtime.on((e) => events.push(e))
    await settle()
    expect(events.filter((e) => e.type === 'chat')).toHaveLength(0)
    expect(runtime.history('chat').map((m) => m.text)).toEqual(['old news'])
    await runtime.close()
    keeper.leave()
  })

  it('waits for the next event, and gives up on time', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada).start()
    expect(await runtime.next(20)).toBeUndefined()
    const waiting = runtime.next(5_000, ['chat'])
    await keeper.chat.send('ping')
    const event = await waiting
    expect(event?.type === 'chat' && event.message.text).toBe('ping')
    await runtime.close()
    keeper.leave()
  })

  it('writes what it hears into the transcript channel, with the speaker named', async () => {
    const relay = new SimRelay()
    const transport = () => new SimTransport(relay)
    const factory = createFakeFactory()
    const keeper = await RoomAgent.create({ base: BASE, name: 'Person', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0, factory })
    await settle()
    const runtime = new AgentRuntime(ada).start()
    const person = new AgentRuntime(keeper).start()
    const heard: RuntimeEvent[] = []
    person.on((e) => heard.push(e))

    const transcriber = new FixedTranscriber('we should ship on friday')
    let feed: ((u: Utterance) => void) | undefined
    runtime.listen(transcriber, {
      attach: async (_track: RtpTrackLike, onUtterance) => {
        feed = onUtterance
        return () => {}
      },
    })
    expect(runtime.listening).toBe(true)

    // The person's microphone reaches the agent on the connection the mesh
    // opened to them - the same path a real track takes.
    const pc = factory.to(keeper.device)
    expect(pc).toBeDefined()
    const track = { kind: 'audio', id: 'mic-1', onReceiveRtp: { subscribe: () => ({ unSubscribe() {} }) } }
    pc!.ontrack?.({ track: track as unknown as MediaStreamTrack })
    await settle()
    expect(feed).toBeDefined()

    feed!({ pcm: new Float32Array(16_000), sampleRate: 16_000, startedAt: 0, endedAt: 1000 })
    await settle()
    await new Promise((r) => setTimeout(r, 10))
    await settle()

    const transcript = heard.find((e) => e.type === 'transcript')
    expect(transcript).toBeDefined()
    expect(transcript!.type === 'transcript' && transcript!.message).toMatchObject({
      kind: 'transcript',
      speaker: keeper.participant,
      text: 'we should ship on friday',
      participant: ada.participant,
    })
    expect(person.line(transcript!.type === 'transcript' ? transcript!.message : (undefined as never))).toContain('said: we should ship on friday')
    expect(transcriber.heard).toHaveLength(1)
    await runtime.close()
    await person.close()
  })
})

class ScriptedBrain extends ModelBrain {
  readonly prompts: string[] = []
  constructor(private readonly replies: string[], opts = {}) {
    super({ debounceMs: 0, minGapMs: 0, ...opts })
  }
  protected async complete(_system: string, user: string): Promise<string> {
    this.prompts.push(user)
    return this.replies.shift() ?? '/quiet'
  }
}

describe('ModelBrain', () => {
  it('speaks when named, whispers when told to, and stays quiet otherwise', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada, { persona: { name: 'Ada', system: 'Be brief.' } }).start()
    const brain = new ScriptedBrain(['/whisper I have this one\nOn it.'])
    const stop = await brain.start(runtime)
    keeper.chat
    keeper.backchannel

    await keeper.chat.send('nothing to do with anybody')
    await settle()
    expect(brain.prompts).toHaveLength(0)

    await keeper.chat.send('Ada, can you look into this?')
    await new Promise((r) => setTimeout(r, 20))
    await settle()
    expect(brain.prompts).toHaveLength(1)
    expect(brain.prompts[0]).toContain('New since your last turn')
    expect(brain.prompts[0]).toContain('Ada, can you look into this?')
    expect(keeper.chat.messages().map((m) => m.text)).toContain('On it.')
    expect(keeper.backchannel.messages().map((m) => m.text)).toEqual(['I have this one'])
    await stop()
    await runtime.close()
    keeper.leave()
  })

  it('answers everything from a person when told to, and never itself', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada, { persona: { name: 'Ada', system: '' } }).start()
    const brain = new ScriptedBrain(['sure', 'again'], { respond: 'always' })
    const stop = await brain.start(runtime)
    keeper.chat
    await keeper.chat.send('anyone?')
    await new Promise((r) => setTimeout(r, 20))
    await settle()
    expect(keeper.chat.messages().map((m) => m.text).sort()).toEqual(['anyone?', 'sure'])
    // Its own reply must not trigger another turn.
    await new Promise((r) => setTimeout(r, 20))
    await settle()
    expect(brain.prompts).toHaveLength(1)
    await stop()
    await runtime.close()
    keeper.leave()
  })

  it('stops agents talking among themselves once the budget is spent', async () => {
    const relay = new SimRelay()
    const transport = () => new SimTransport(relay)
    const keeper = await RoomAgent.create({ base: BASE, name: 'Person', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport, announceJitterMs: 0 })
    await settle()
    const adaRuntime = new AgentRuntime(ada, { persona: { name: 'Ada', system: '' } }).start()
    const bobRuntime = new AgentRuntime(bob, { persona: { name: 'Bob', system: '' } }).start()
    const adaBrain = new ScriptedBrain(Array(20).fill('/whisper agreed'), { maxAgentTurns: 2 })
    const bobBrain = new ScriptedBrain(Array(20).fill('/whisper agreed'), { maxAgentTurns: 2 })
    const stopA = await adaBrain.start(adaRuntime)
    const stopB = await bobBrain.start(bobRuntime)
    keeper.backchannel
    await adaRuntime.whisper('shall we?')
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 10))
      await settle()
    }
    // Bounded: two turns each, not a conversation that never ends.
    expect(keeper.backchannel.messages().length).toBeLessThanOrEqual(1 + 2 * 2 + 1)
    await stopA()
    await stopB()
    await adaRuntime.close()
    await bobRuntime.close()
    keeper.leave()
  })
})

describe('parseReply', () => {
  it('splits spoken lines from whispered ones and drops /quiet', () => {
    expect(parseReply('/quiet')).toEqual({})
    expect(parseReply('hello')).toEqual({ say: 'hello' })
    expect(parseReply('/whisper psst\nhello there')).toEqual({ say: 'hello there', whisper: 'psst' })
    expect(parseReply('  /whisper   only this  ')).toEqual({ whisper: 'only this' })
  })
})

describe('StdioBrain', () => {
  it('streams events out and takes commands in, one JSON line each', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada, { persona: { name: 'Ada', system: '' } }).start()
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)))
    const brain = new StdioBrain(input, output)
    const stop = await brain.start(runtime)
    keeper.chat

    input.write(JSON.stringify({ op: 'say', text: 'hello from the pipe' }) + '\n')
    input.write(JSON.stringify({ op: 'roster' }) + '\n')
    await new Promise((r) => setTimeout(r, 20))
    await keeper.chat.send('hi Ada')
    await settle()

    const parsed = lines.map((l) => JSON.parse(l) as { type: string; op?: string; text?: string; participants?: unknown[] })
    expect(parsed[0]!.type).toBe('ready')
    expect(parsed.some((e) => e.type === 'ok' && e.op === 'say')).toBe(true)
    expect(parsed.some((e) => e.type === 'roster' && (e.participants?.length ?? 0) >= 2)).toBe(true)
    expect(parsed.some((e) => e.type === 'chat' && e.text === 'hi Ada')).toBe(true)
    expect(keeper.chat.messages().map((m) => m.text)).toContain('hello from the pipe')
    await stop()
    await runtime.close()
    keeper.leave()
  })
})
