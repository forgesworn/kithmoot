import { describe, it, expect } from 'vitest'
import { RoomAgent, MINUTES_CHANNEL } from '../agent.js'
import { MAX_CHAT_TEXT_LENGTH } from '../chat.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { createFakeFactory } from '../../test/fake-rtc.js'
import { AgentRuntime } from './runtime.js'
import { ModelBrain } from './brains.js'
import type { Transcriber, Transcript } from './transcriber.js'
import type { Utterance } from './utterances.js'
import type { RtpTrackLike } from './audio.js'
import { Scribe, MINUTES_PROTOCOL, chunkMinutes, formatWhen, isMinutesRequest } from './scribe.js'

const BASE = 'https://example.test/j/'

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting')
    await wait(5)
  }
}

/** Numbers what it hears, so a test can tell the lines apart. */
class CountingTranscriber implements Transcriber {
  #n = 0
  async transcribe(_utterance: Utterance): Promise<Transcript | null> {
    return { text: `line ${++this.#n}` }
  }
}

/**
 * The existing brain seam with a deterministic model behind it. What it
 * answers is a function of the prompt, so a test can check the prompt
 * reached it and the answer reached the room.
 */
class SummarisingBrain extends ModelBrain {
  readonly prompts: { system: string; user: string }[] = []
  constructor(private readonly reply: (user: string) => string = (user) => `Decisions: ${user.split('\n').filter((l) => l.includes(' said: ')).length} things were said.\nActions: none.\nOpen questions: none.`) {
    super({ debounceMs: 0, minGapMs: 0 })
  }
  protected async complete(system: string, user: string): Promise<string> {
    this.prompts.push({ system, user })
    return this.reply(user)
  }
}

const MIC = [{ trackId: 'mic-1', role: 'mic' as const }]

async function room(opts: { brain?: SummarisingBrain; callEndsAfterMs?: number; personHasMedia?: boolean } = {}) {
  const relay = new SimRelay()
  const transport = () => new SimTransport(relay)
  const factory = createFakeFactory()
  const personFactory = createFakeFactory()
  const person = await RoomAgent.create({
    base: BASE,
    name: 'Person',
    relays: ['wss://sim'],
    transport,
    announceJitterMs: 0,
    agent: false,
    ...(opts.personHasMedia ? { factory: personFactory } : {}),
  })
  const agent = await RoomAgent.join({ link: person.url, name: 'Scribe', transport, announceJitterMs: 0, factory })
  await settle()
  // Opened before anybody writes: the simulator replays nothing.
  person.minutes
  person.transcripts
  const runtime = new AgentRuntime(agent, { persona: { name: 'Scribe', system: '' } }).start()
  let feed: ((u: Utterance) => void) | undefined
  runtime.listen(new CountingTranscriber(), {
    attach: async (_track: RtpTrackLike, onUtterance) => {
      feed = onUtterance
      return () => {}
    },
  })
  const scribe = new Scribe(runtime, { completer: opts.brain?.completer(), callEndsAfterMs: opts.callEndsAfterMs ?? 40 })
  const stop = await scribe.start()

  /** The person's microphone, arriving on the connection the mesh opened
   *  to them, exactly as the runtime test does it. */
  const hear = async () => {
    const pc = factory.to(person.device)
    expect(pc).toBeDefined()
    const track = { kind: 'audio', id: 'mic-1', onReceiveRtp: { subscribe: () => ({ unSubscribe() {} }) } }
    pc!.ontrack?.({ track: track as unknown as MediaStreamTrack })
    await settle()
    expect(feed).toBeDefined()
  }
  const say = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      feed!({ pcm: new Float32Array(16_000), sampleRate: 16_000, startedAt: 0, endedAt: 1000 })
      await settle()
      await wait(10)
      await settle()
    }
  }
  const minutes = () => person.minutes.messages().map((m) => m.text)
  const chat = () => person.chat.messages().map((m) => m.text)
  const close = async () => {
    await stop()
    await runtime.close()
    await person.leave()
  }
  return { person, agent, runtime, scribe, factory, personFactory, hear, say, minutes, chat, close }
}

describe('Scribe', () => {
  it('turns utterances into transcript lines and writes minutes when somebody asks', async () => {
    const brain = new SummarisingBrain()
    const r = await room({ brain })
    await r.hear()
    await r.say(2)

    const transcript = r.person.transcripts.messages()
    expect(transcript.map((m) => m.text)).toEqual(['line 1', 'line 2'])
    expect(transcript[0]).toMatchObject({ kind: 'transcript', speaker: r.person.participant, participant: r.agent.participant })
    expect(r.scribe.pending).toBe(2)
    expect(r.minutes()).toEqual([])

    await r.person.chat.send('!minutes please')
    await until(() => r.minutes().length > 0)

    expect(brain.prompts).toHaveLength(1)
    expect(brain.prompts[0]!.system).toBe(MINUTES_PROTOCOL)
    expect(brain.prompts[0]!.user).toContain('Attendees:')
    expect(brain.prompts[0]!.user).toContain('- Person (')
    expect(brain.prompts[0]!.user).toContain('said: line 1')
    expect(brain.prompts[0]!.user).toContain('said: line 2')

    const [written] = r.minutes()
    expect(written).toMatch(/^Minutes, \d+ \w+ \d{4}, \d\d:\d\d UTC, on request, taken by Scribe \([0-9a-f]{8}, agent\)\./)
    expect(written).toContain('Attendees: Person (')
    expect(written).toContain('Decisions: 2 things were said.')
    expect(written).toContain('Open questions: none.')
    expect(r.person.minutes.channel).toBe(MINUTES_CHANNEL)
    expect(r.person.minutes.messages()[0]!.participant).toBe(r.agent.participant)
    expect(r.scribe.pending).toBe(0)

    // Asked again with nothing new said: an answer in the chat, no minutes.
    await r.person.chat.send('!minutes')
    await until(() => r.chat().some((t) => t.startsWith('Nothing to minute')))
    expect(r.minutes()).toHaveLength(1)
    expect(brain.prompts).toHaveLength(1)
    await r.close()
  })

  it('writes minutes once when the call ends, and not when the media merely flaps', async () => {
    const brain = new SummarisingBrain()
    const r = await room({ brain, callEndsAfterMs: 40 })
    await r.hear()
    expect(r.scribe.inCall).toBe(false)

    await r.person.advertise(MIC)
    await settle()
    expect(r.scribe.inCall).toBe(true)
    await r.say(1)

    // Media goes and comes back inside the quiet period: the same call.
    await r.person.advertise([])
    await settle()
    await wait(15)
    await r.person.advertise(MIC)
    await settle()
    await wait(60)
    expect(r.scribe.inCall).toBe(true)
    expect(r.minutes()).toEqual([])

    // Media goes and stays gone: the call is over, once.
    await r.person.advertise([])
    await until(() => r.minutes().length > 0)
    expect(r.scribe.inCall).toBe(false)
    expect(r.minutes()[0]).toContain('at the end of the call')
    expect(r.minutes()[0]).toContain('Decisions: 1 things were said.')
    await wait(100)
    expect(r.minutes()).toHaveLength(1)
    expect(brain.prompts).toHaveLength(1)

    // A call in which nothing reached the scribe leaves nothing behind.
    await r.person.advertise(MIC)
    await settle()
    await r.person.advertise([])
    await wait(100)
    expect(r.minutes()).toHaveLength(1)
    expect(r.chat().some((t) => t.startsWith('Nothing to minute'))).toBe(false)
    await r.close()
  })

  it('keeps long minutes in order across several messages', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')} ${'x'.repeat(70)}`)
    const brain = new SummarisingBrain(() => lines.join('\n'))
    const r = await room({ brain })
    await r.hear()
    await r.say(1)
    await r.person.chat.send('!minutes')
    await until(() => r.minutes().length >= 3, 8_000)
    await wait(20)

    const parts = r.minutes()
    expect(parts).toHaveLength(3)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_CHAT_TEXT_LENGTH)
    expect(parts[0]).toMatch(/^Minutes, /)
    expect(parts[1]).toMatch(/^\(continued, 2 of 3\)\n/)
    expect(parts[2]).toMatch(/^\(continued, 3 of 3\)\n/)
    // In the order the log holds them, which is the order every reader sees.
    const joined = parts.map((p) => p.replace(/^\(continued, \d+ of \d+\)\n/, '')).join('\n')
    expect(joined.endsWith(lines.join('\n'))).toBe(true)
    const stamps = r.person.minutes.messages().map((m) => m.sentAt)
    expect(stamps[0]).toBeLessThan(stamps[1]!)
    expect(stamps[1]).toBeLessThan(stamps[2]!)
    await r.close()
  }, 15_000)

  it('writes the transcript grouped by speaker when there is no model', async () => {
    const r = await room()
    await r.hear()
    await r.say(3)
    await r.person.chat.send('!minutes')
    await until(() => r.minutes().length > 0)

    const [written] = r.minutes()
    expect(written).toContain('on request')
    expect(written).toContain('What was said, by speaker:')
    const speaker = written!.indexOf('\nPerson (')
    expect(speaker).toBeGreaterThan(0)
    const said = written!.slice(speaker).split('\n').slice(2)
    expect(said).toEqual([expect.stringMatching(/^\d\d:\d\d line 1$/), expect.stringMatching(/^\d\d:\d\d line 2$/), expect.stringMatching(/^\d\d:\d\d line 3$/)])
    await r.close()
  })

  it('hears nothing, and writes nothing, from a person whose switch is off', async () => {
    const brain = new SummarisingBrain()
    const r = await room({ brain, personHasMedia: true })
    // The person's microphone goes to everybody who is not an agent, which
    // in this room is nobody: the connection to the scribe carries nothing.
    const mic = { kind: 'audio', id: 'mic-1' } as unknown as MediaStreamTrack
    r.person.publishTracks([mic], { audience: (view) => view.agent !== true })
    await r.person.advertise(MIC)
    await settle()
    const toScribe = r.personFactory.to(r.agent.device)
    expect(toScribe).toBeDefined()
    expect(toScribe!.tracks).toEqual([])
    expect(r.scribe.inCall).toBe(true)

    // The call ends. There was a call, and there is nothing to minute.
    await r.person.advertise([])
    await wait(100)
    expect(r.scribe.inCall).toBe(false)
    expect(r.person.transcripts.messages()).toEqual([])
    expect(r.minutes()).toEqual([])

    // Asked outright, it says so, and still writes no minutes.
    await r.person.chat.send('!minutes')
    await until(() => r.chat().some((t) => t.startsWith('Nothing to minute')))
    expect(r.minutes()).toEqual([])
    expect(brain.prompts).toHaveLength(0)
    await r.close()
  })
})

describe('chunkMinutes', () => {
  it('leaves a short text alone and cuts a long one at line ends, marked and reassemblable', () => {
    expect(chunkMinutes('short')).toEqual(['short'])
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'y'.repeat(50)}`)
    const text = lines.join('\n')
    const parts = chunkMinutes(text, 500)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500)
    expect(parts[0]!.startsWith('line 0 ')).toBe(true)
    parts.slice(1).forEach((part, i) => expect(part.startsWith(`(continued, ${i + 2} of ${parts.length})\n`)).toBe(true))
    expect(parts.map((p) => p.replace(/^\(continued, \d+ of \d+\)\n/, '')).join('\n')).toBe(text)
  })

  it('falls back to a space, and then to a hard cut, when there is no line end', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')
    const bySpace = chunkMinutes(words, 120)
    for (const part of bySpace) expect(part.length).toBeLessThanOrEqual(120)
    expect(bySpace.map((p) => p.replace(/^\(continued, \d+ of \d+\)\n/, '')).join(' ')).toBe(words)
    const solid = 'z'.repeat(1_000)
    const hard = chunkMinutes(solid, 300)
    for (const part of hard) expect(part.length).toBeLessThanOrEqual(300)
    expect(hard.map((p) => p.replace(/^\(continued, \d+ of \d+\)\n/, '')).join('')).toBe(solid)
  })
})

describe('isMinutesRequest and formatWhen', () => {
  it('matches the request as a first word, whatever the case', () => {
    expect(isMinutesRequest('!minutes')).toBe(true)
    expect(isMinutesRequest('  !Minutes please ')).toBe(true)
    expect(isMinutesRequest('can we have the !minutes')).toBe(false)
    expect(isMinutesRequest('!minutesy')).toBe(false)
    expect(isMinutesRequest('')).toBe(false)
  })

  it('writes the date the way a person here would', () => {
    expect(formatWhen(Date.UTC(2026, 8, 2, 14, 5))).toBe('2 September 2026, 14:05 UTC')
    expect(formatWhen(Date.UTC(2026, 0, 31, 9, 0))).toBe('31 January 2026, 09:00 UTC')
  })
})
