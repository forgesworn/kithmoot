import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity, type ParticipantIdentity } from '../identity.js'
import { localPeerCrypt } from '../dm.js'
import { ContextFileStore } from './context-store.js'
import type { ContextRetrieval } from '../context.js'
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

async function room(identity?: ParticipantIdentity) {
  const relay = new SimRelay({ replay: true })
  const transport = () => new SimTransport(relay)
  const keeper = await RoomAgent.create({ base: BASE, name: 'Person', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false })
  const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0, identity })
  await settle()
  return { relay, keeper, ada }
}

describe('AgentRuntime', () => {
  it('briefs from bounded relevant evidence and reloads corrections from the encrypted cache', async () => {
    const sk = generateSecretKey()
    const identity = { ...localIdentity(sk), ...localPeerCrypt(sk) }
    const { keeper, ada } = await room(identity)
    const dir = await mkdtemp(join(tmpdir(), 'kith-brief-'))
    const context = new ContextFileStore(join(dir, 'context.json'), { identity, room: ada.roomId })
    const runtime = new AgentRuntime(ada, { context })
    const extract = (brief: string) => JSON.parse(brief.slice(brief.lastIndexOf('\n') + 1)) as ContextRetrieval[]
    try {
      const original = await context.run(async v => {
        let view = await v.create({ title: 'Workshop', scope: 'kith', room: ada.roomId })
        view = await v.append(view.id, view.head, { kind: 'evidence', text: 'Turbine inspection approved.', source: 'fixture://inspection/1', observedAt: 1 })
        const record = view.records[0]!
        for (let i = 0; i < 9; i++) view = await v.append(view.id, view.head, { kind: 'fact', text: `Catering update ${i}.`, source: `fixture://catering/${i}`, observedAt: i + 2 })
        return { collection: view.id, record }
      }, true)
      const first = extract(await runtime.brief('turbine'))[0]!
      expect(first.records).toHaveLength(1)
      expect(first.records[0]).toMatchObject(original.record)
      expect(first.records[0]).toMatchObject({ author: identity.pubkey, match: 'query' })
      expect(first.bytesUsed).toBe(Buffer.byteLength(JSON.stringify(first)))
      expect(first.bytesUsed).toBeLessThanOrEqual(2048)
      expect(await runtime.brief()).not.toContain(original.record.text)

      const writer = new ContextFileStore(context.path, context.options)
      const correction = await writer.run(async v => {
        const view = v.read(original.collection)
        return v.append(view.id, view.head, { kind: 'evidence', text: 'Turbine inspection refused pending repair.', source: 'fixture://inspection/2', observedAt: 20, supersedes: original.record.id })
      }, true)
      const current = extract(await runtime.brief('turbine'))[0]!
      expect(current.head).toBe(correction.head)
      expect(current.records.map(r => r.text)).toEqual(['Turbine inspection refused pending repair.'])
      expect(current.records[0]!.supersedes).toBe(original.record.id)
      expect(extract(await runtime.brief('zebras'))[0]!.records).toEqual([])
      expect(await readFile(context.path, 'utf8')).not.toContain('Turbine')
      expect(() => new AgentRuntime(ada, { context: new ContextFileStore(context.path, { ...context.options, room: 'ff'.repeat(32) }) })).toThrow('pinned')
      expect(() => new AgentRuntime(keeper, { context })).toThrow('pinned')
      await expect(runtime.brief(' ')).rejects.toThrow('query')
      await expect(runtime.brief('x'.repeat(501))).rejects.toThrow('query')
    } finally { await runtime.close(); keeper.leave(); await rm(dir, { recursive: true, force: true }) }
  // This integration repeatedly verifies signed history after encrypted disk
  // reloads; allow for the slower CPUs used by the hosted Node matrix.
  }, 20_000)

  it('omits oversized context whole and labels cache failures without implying no blockers', async () => {
    const sk = generateSecretKey()
    const identity = { ...localIdentity(sk), ...localPeerCrypt(sk) }
    const { keeper, ada } = await room(identity)
    const dir = await mkdtemp(join(tmpdir(), 'kith-brief-size-'))
    const context = new ContextFileStore(join(dir, 'context.json'), { identity, room: ada.roomId })
    const runtime = new AgentRuntime(ada, { context })
    try {
      await context.run(async v => {
        let view = await v.create({ title: 'Evidence', scope: 'kith', room: ada.roomId })
        view = await v.append(view.id, view.head, { kind: 'evidence', text: 'Turbine ' + '界'.repeat(3000), source: 'fixture://large', observedAt: 1 })
        await v.append(view.id, view.head, { kind: 'evidence', text: 'Turbine bearing replaced.', source: 'fixture://small', observedAt: 2 })
      }, true)
      const brief = await runtime.brief('turbine')
      const result = JSON.parse(brief.slice(brief.lastIndexOf('\n') + 1))[0] as ContextRetrieval
      expect(result.records.map(r => r.text)).toEqual(['Turbine bearing replaced.'])
      expect(result.omitted).toBe(1)
      expect(result.bytesUsed).toBeLessThanOrEqual(2048)
      expect(brief).toContain('omitted records are not evidence of absence')
      vi.spyOn(context, 'run').mockRejectedValueOnce(new Error('unreadable cache'))
      expect(await runtime.brief('turbine')).toContain('Do not assume there are no blockers')
    } finally { await runtime.close(); keeper.leave(); await rm(dir, { recursive: true, force: true }) }
  })

  it('follows named conversations and emits one signed receipt in the addressed conversation', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada, { persona: { name: 'Ada', system: '' } }).start()
    const events: RuntimeEvent[] = []
    runtime.on(event => events.push(event))
    try {
      await keeper.setChannel('security', true)
      await settle()
      await keeper.channel('security').send('Can you check this?', { mentions: [ada.participant] })
      const request = keeper.channel('security').messages().find(m => m.text === 'Can you check this?')!
      await settle()
      expect(events).toContainEqual(expect.objectContaining({ type: 'channel', channel: 'security', addressed: true, message: expect.objectContaining({ id: request.id }) }))
      const started = Date.now()
      const pending = runtime.acknowledge('security', request.id)
      const duplicate = runtime.acknowledge('security', request.id)
      await settle()
      expect(keeper.channel('security').messages().filter(m => m.reaction)).toHaveLength(0)
      await Promise.all([pending, duplicate])
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_450)
      await runtime.acknowledge('security', request.id)
      const receipts = keeper.channel('security').messages().filter(m => m.reaction?.messageId === request.id)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ participant: ada.participant, reaction: { emoji: '👍', receipt: 'received', active: true } })
      expect(keeper.chat.messages().filter(m => m.reaction)).toHaveLength(0)
      await expect(runtime.acknowledge('chat', request.id)).rejects.toThrow('target')
      await expect(runtime.sayIn('control', 'not permitted')).rejects.toThrow('not open')
      await runtime.sayIn('security', 'Review result here.')
      const response = keeper.channel('security').messages().find(m => m.text === 'Review result here.')!
      await keeper.channel('security').send('Thanks, one more thing', { replyTo: { id: response.id, participant: ada.participant } })
      const reply = keeper.channel('security').messages().find(m => m.text === 'Thanks, one more thing')!
      await settle()
      expect(events).toContainEqual(expect.objectContaining({ type: 'channel', addressed: true, message: expect.objectContaining({ id: reply.id }) }))
      await keeper.setChannel('security', false)
      await settle()
      await expect(runtime.sayIn('security', 'closed')).rejects.toThrow('not open')
    } finally { await runtime.close(); keeper.leave() }
  })
  it('cancels a pending acknowledgement when the agent leaves', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada).start()
    try {
      await keeper.chat.send('morning @all')
      await settle()
      const target = keeper.chat.messages().find(m => m.text === 'morning @all')!
      const pending = runtime.acknowledge('chat', target.id)
      await runtime.close()
      await pending
      expect(keeper.chat.messages().filter(m => m.reaction)).toHaveLength(0)
    } finally { await runtime.close(); keeper.leave() }
  })
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
    const relay = new SimRelay({ replay: true })
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
    await vi.waitFor(() => expect(heard.some((e) => e.type === 'transcript')).toBe(true))

    const transcript = heard.find((e) => e.type === 'transcript')
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
  it('uses incoming text for bounded context lookup while keeping the full request in the model turn', async () => {
    const { keeper, ada } = await room()
    const runtime = new AgentRuntime(ada, { persona: { name: 'Ada', system: '' } }).start()
    const brief = vi.spyOn(runtime, 'brief')
    const brain = new ScriptedBrain(['/quiet'])
    const stop = await brain.start(runtime)
    try {
      const message = 'Ada, inspect the turbine. ' + 'inspection detail '.repeat(40) + ' Preserve this final constraint.'
      await keeper.chat.send(message)
      await vi.waitFor(() => expect(brain.prompts).toHaveLength(1))
      expect(brief).toHaveBeenCalledWith(message.slice(0, 500))
      expect(brain.prompts[0]).toContain(message)
    } finally { await stop(); await runtime.close(); keeper.leave() }
  })

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
    await vi.waitFor(() => expect(brain.prompts).toHaveLength(1))
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
    await vi.waitFor(() => expect(keeper.chat.messages().map((m) => m.text).sort()).toEqual(['anyone?', 'sure']))
    // Its own reply must not trigger another turn. A window has to elapse to
    // show that: waiting for a condition would return on the turn already
    // taken and say nothing about the one that must not happen.
    await new Promise((r) => setTimeout(r, 20))
    await settle()
    expect(brain.prompts).toHaveLength(1)
    await stop()
    await runtime.close()
    keeper.leave()
  })

  it('stops agents talking among themselves once the budget is spent', async () => {
    const relay = new SimRelay({ replay: true })
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
    // A fixed window on purpose: the claim is that the two of them stop
    // talking, and an absence of further messages only shows up in elapsed
    // time. There is no condition to wait for when nothing more must arrive.
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
    const parsed = () => lines.map((l) => JSON.parse(l) as { type: string; op?: string; text?: string; participants?: unknown[] })
    await vi.waitFor(() => {
      expect(parsed().some((e) => e.type === 'ok' && e.op === 'say')).toBe(true)
      expect(parsed().some((e) => e.type === 'roster' && (e.participants?.length ?? 0) >= 2)).toBe(true)
    })
    await keeper.chat.send('hi Ada')
    await vi.waitFor(() => expect(parsed().some((e) => e.type === 'chat' && e.text === 'hi Ada')).toBe(true))

    expect(parsed()[0]!.type).toBe('ready')
    expect(keeper.chat.messages().map((m) => m.text)).toContain('hello from the pipe')
    const brief = vi.spyOn(runtime, 'brief')
    input.write(JSON.stringify({ op: 'context', query: 'turbine inspection' }) + '\n')
    await vi.waitFor(() => expect(parsed().some(e => e.type === 'context')).toBe(true))
    expect(brief).toHaveBeenCalledWith('turbine inspection')
    input.write(JSON.stringify({ op: 'context', query: 42 }) + '\n')
    await vi.waitFor(() => expect(parsed().some(e => e.type === 'error')).toBe(true))
    await stop()
    await runtime.close()
    keeper.leave()
  })
})
