import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomAgent } from '../agent.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from '../control.js'
import type { ControlMessage } from '../control.js'
import { localIdentity } from '../identity.js'
import { issueAgentOwnership } from '../ownership.js'
import { AgentHost, loadCatalogue } from './host.js'
import type { SpawnFn } from './host.js'

const BASE = 'https://example.test/j/'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A spawn that records what it was asked to run and can be told to exit. */
function fakeSpawn() {
  const calls: { file: string; args: string[]; child: FakeChild }[] = []
  class FakeChild extends EventEmitter {
    pid = 4242
    exitCode: number | null = null
    stderr = new EventEmitter()
    kill(): boolean {
      this.exitCode = 0
      setTimeout(() => this.emit('exit', 0), 0)
      return true
    }
  }
  const spawn: SpawnFn = (file, args) => {
    const child = new FakeChild()
    calls.push({ file, args, child })
    return child as unknown as ReturnType<SpawnFn>
  }
  return { spawn, calls }
}

/**
 * A room with a person in it and a laptop of theirs hosting agents.
 *
 * The person is the host's principal by default, which is the ordinary
 * shape: the laptop is theirs, and they attested to it once with
 * `kithmoot-agent attest`. Pass `owned: false` for a host started without
 * `--owner-proof`, which is a host nobody may invite from.
 */
async function room(opts: { owned?: boolean; ownerExpiresIn?: number } = {}) {
  const relay = new SimRelay()
  const transport = () => new SimTransport(relay)
  const personSk = generateSecretKey()
  const person = await RoomAgent.create({ base: BASE, name: 'Person', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false, identity: localIdentity(personSk) })
  const hostSk = generateSecretKey()
  const issuedAt = Math.floor(Date.now() / 1000)
  const owner =
    opts.owned === false
      ? undefined
      : issueAgentOwnership({
          principalSk: personSk,
          agent: getPublicKey(hostSk),
          issuedAt,
          ...(opts.ownerExpiresIn !== undefined ? { expiresAt: issuedAt + opts.ownerExpiresIn } : {}),
          label: 'Laptop',
        })
  const hostAgent = await RoomAgent.join({ link: person.url, name: 'Laptop', transport, announceJitterMs: 0, identity: localIdentity(hostSk), owner })
  await settle()
  const control = person.channel(CONTROL_CHANNEL)
  const heard: ControlMessage[] = []
  control.onChange((messages) => {
    heard.length = 0
    for (const m of messages) {
      const c = decodeControl(m.text)
      if (c) heard.push(c)
    }
  })
  return { relay, person, hostAgent, control, heard, transport }
}

/** Somebody else in the room. A link is forwarded by design, so this is
 *  not an attacker breaking in: it is the ordinary population of a room. */
async function stranger(person: RoomAgent, transport: () => SimTransport): Promise<RoomAgent> {
  const other = await RoomAgent.join({ link: person.url, name: 'Stranger', transport, announceJitterMs: 0, agent: false })
  await settle()
  return other
}

describe('AgentHost', () => {
  it('says what it can run, starts one when asked, and says so', async () => {
    const { person, hostAgent, control, heard } = await room()
    const { spawn, calls } = fakeSpawn()
    const state = await mkdtemp(join(tmpdir(), 'kithmoot-host-'))
    const host = new AgentHost({
      agent: hostAgent,
      catalogue: [{ id: 'ada', name: 'Ada', description: 'Research', brain: 'ollama', model: 'qwen3:32b', persona: '/tmp/ada.md' }],
      stateDir: state,
      command: { file: 'node', args: ['bin/kithmoot-agent.mjs'] },
      spawn,
    })
    await host.start()
    await settle()
    // Looked for, never "the last": messages inside one second order by
    // random id, so position says nothing.
    const catalogues = () => heard.filter((c): c is Extract<ControlMessage, { op: 'catalogue' }> => c.op === 'catalogue')
    expect(catalogues().at(0)).toMatchObject({ op: 'catalogue', host: hostAgent.participant, name: 'Laptop', agents: [{ id: 'ada', name: 'Ada', description: 'Research' }], running: [] })

    await control.send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(calls).toHaveLength(1)
    const args = calls[0]!.args
    expect(calls[0]!.file).toBe('node')
    expect(args.slice(0, 3)).toEqual(['bin/kithmoot-agent.mjs', 'join', hostAgent.url])
    expect(args).toContain('--name')
    expect(args[args.indexOf('--name') + 1]).toBe('Ada')
    expect(args[args.indexOf('--brain') + 1]).toBe('ollama')
    expect(args[args.indexOf('--model') + 1]).toBe('qwen3:32b')
    expect(args[args.indexOf('--persona') + 1]).toBe('/tmp/ada.md')
    // A stable identity, kept for next time.
    const identity = args[args.indexOf('--identity') + 1]!
    expect(identity.startsWith(state)).toBe(true)
    expect((await readFile(identity, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/)

    const invited = heard.find((c) => c.op === 'invited')
    expect(invited).toMatchObject({ op: 'invited', agent: 'ada', name: 'Ada' })
    expect(invited?.op === 'invited' && invited.participant).toMatch(/^[0-9a-f]{64}$/)
    expect(catalogues().some((c) => c.running.length === 1 && c.running[0]!.id === 'ada')).toBe(true)
    expect(host.running()).toHaveLength(1)

    // Asked again: already running, no second process.
    await control.send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    expect(calls).toHaveLength(1)

    // Dismissed: the process is stopped and the room told.
    await control.send(encodeControl({ op: 'dismiss', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await new Promise((r) => setTimeout(r, 5))
    await settle()
    expect(host.running()).toHaveLength(0)
    expect(heard.some((c) => c.op === 'dismissed' && c.agent === 'ada')).toBe(true)
    expect(catalogues().length).toBeGreaterThanOrEqual(3)

    await host.stop()
    hostAgent.leave()
    person.leave()
  })

  it('answers a catalogue? and refuses an agent it does not have or a host it is not', async () => {
    const { person, hostAgent, control, heard } = await room()
    const { spawn, calls } = fakeSpawn()
    const host = new AgentHost({ agent: hostAgent, catalogue: [{ id: 'ada', name: 'Ada', brain: 'none' }], stateDir: await mkdtemp(join(tmpdir(), 'kithmoot-host-')), spawn })
    await host.start()
    await settle()
    const before = heard.filter((c) => c.op === 'catalogue').length
    await control.send(encodeControl({ op: 'catalogue?' }))
    await settle()
    expect(heard.filter((c) => c.op === 'catalogue').length).toBe(before + 1)

    await control.send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'bob' }))
    await settle()
    expect(heard.some((c) => c.op === 'error' && c.agent === 'bob')).toBe(true)
    expect(calls).toHaveLength(0)

    await control.send(encodeControl({ op: 'invite', host: 'cd'.repeat(32), agent: 'ada' }))
    await settle()
    expect(calls).toHaveLength(0)
    await host.stop()
    hostAgent.leave()
    person.leave()
  })

  it('loads a catalogue directory, one agent per file, personas resolved against it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kithmoot-cat-'))
    await writeFile(join(dir, 'ada.json'), JSON.stringify({ name: 'Ada', brain: 'ollama', model: 'qwen3:32b', persona: 'ada.md', description: 'Research' }))
    await writeFile(join(dir, 'bob.json'), JSON.stringify({ name: 'Bob', brain: 'anthropic', listen: true }))
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    const catalogue = await loadCatalogue(dir)
    expect(catalogue.map((c) => c.id)).toEqual(['ada', 'bob'])
    expect(catalogue[0]!.persona).toBe(join(dir, 'ada.md'))
    expect(catalogue[1]!.listen).toBe(true)
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ name: 'Bad', brain: 'ollama' }))
    await expect(loadCatalogue(dir)).rejects.toThrow(/needs a model/)
  })

  it('starts nothing for anybody but its principal, and says the refusal out loud', async () => {
    const { person, hostAgent, control, heard, transport } = await room()
    const other = await stranger(person, transport)
    const { spawn, calls } = fakeSpawn()
    const host = new AgentHost({ agent: hostAgent, catalogue: [{ id: 'ada', name: 'Ada', brain: 'none' }], stateDir: await mkdtemp(join(tmpdir(), 'kithmoot-host-')), spawn })
    await host.start()
    await settle()
    const errors = () => heard.filter((c): c is Extract<ControlMessage, { op: 'error' }> => c.op === 'error')

    // A member of the room, holding the room key, asking properly. Before
    // the sender was consulted this started a process on the host's machine.
    await other.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(calls).toHaveLength(0)
    expect(host.running()).toHaveLength(0)
    // Refused where the click came from, not only in the host's own log.
    expect(errors().map((e) => e.message)).toContainEqual(expect.stringContaining('belongs to'))
    expect(errors().at(-1)?.agent).toBe('ada')

    // The same message from the principal is obeyed, so this is a rule
    // about who asked and not a host that has stopped working.
    await control.send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(calls).toHaveLength(1)
    expect(host.running()).toHaveLength(1)

    await host.stop()
    other.leave()
    hostAgent.leave()
    person.leave()
  })

  it('lets any member dismiss, because an agent that has to be invited again is recoverable', async () => {
    const { person, hostAgent, control, heard, transport } = await room()
    const other = await stranger(person, transport)
    const { spawn, calls } = fakeSpawn()
    const host = new AgentHost({ agent: hostAgent, catalogue: [{ id: 'ada', name: 'Ada', brain: 'none' }], stateDir: await mkdtemp(join(tmpdir(), 'kithmoot-host-')), spawn })
    await host.start()
    await settle()

    await control.send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(host.running()).toHaveLength(1)

    await other.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'dismiss', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await new Promise((r) => setTimeout(r, 5))
    await settle()
    expect(host.running()).toHaveLength(0)
    expect(heard.some((c) => c.op === 'dismissed' && c.agent === 'ada')).toBe(true)

    // Stopping is theirs; starting is not, so they cannot put it back.
    await other.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(calls).toHaveLength(1)
    expect(host.running()).toHaveLength(0)

    await host.stop()
    other.leave()
    hostAgent.leave()
    person.leave()
  })

  it('refuses every invitation when it has not been told whose it is, and says so at startup', async () => {
    const { person, hostAgent, control, heard } = await room({ owned: false })
    const { spawn, calls } = fakeSpawn()
    const lines: string[] = []
    const host = new AgentHost({
      agent: hostAgent,
      catalogue: [{ id: 'ada', name: 'Ada', brain: 'none' }],
      stateDir: await mkdtemp(join(tmpdir(), 'kithmoot-host-')),
      spawn,
      log: (line) => lines.push(line),
    })
    await host.start()
    await settle()
    // Loudly, at the top, rather than at the first click that goes nowhere.
    expect(lines.some((l) => l.includes('--owner-proof'))).toBe(true)

    // Not even the person who made the room and holds its keeper key: the
    // host has no way to know that key is anything to do with its machine.
    await control.send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(calls).toHaveLength(0)
    expect(host.running()).toHaveLength(0)
    expect(heard.some((c) => c.op === 'error' && c.message.includes('--owner-proof'))).toBe(true)

    await host.stop()
    hostAgent.leave()
    person.leave()
  })

  it('stops obeying a principal whose proof has expired', async () => {
    const { person, hostAgent, control, heard } = await room({ ownerExpiresIn: 5 })
    const { spawn, calls } = fakeSpawn()
    // Nine seconds ahead: past the proof's expiry, and still inside the ten
    // seconds of slack `#handle` allows, so live messages are still live.
    // A proof cannot be revoked any other way, which is why the expiry has
    // to be read at the moment it is relied on rather than once at boot.
    const host = new AgentHost({
      agent: hostAgent,
      catalogue: [{ id: 'ada', name: 'Ada', brain: 'none' }],
      stateDir: await mkdtemp(join(tmpdir(), 'kithmoot-host-')),
      spawn,
      now: () => Math.floor(Date.now() / 1000) + 9,
    })
    await host.start()
    await settle()

    await control.send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(calls).toHaveLength(0)
    expect(heard.some((c) => c.op === 'error' && c.message.includes('whose it is'))).toBe(true)

    await host.stop()
    hostAgent.leave()
    person.leave()
  })

  it('ignores its own messages rather than refusing them, so two hosts do not argue', async () => {
    const { person, hostAgent, heard } = await room()
    const { spawn, calls } = fakeSpawn()
    const host = new AgentHost({ agent: hostAgent, catalogue: [{ id: 'ada', name: 'Ada', brain: 'none' }], stateDir: await mkdtemp(join(tmpdir(), 'kithmoot-host-')), spawn })
    await host.start()
    await settle()
    const before = heard.filter((c) => c.op === 'error').length

    // A host is never its own principal - an ownership proof over your own
    // key is refused - so without the self check this would come back as a
    // refusal addressed to itself.
    await hostAgent.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'invite', host: hostAgent.participant, agent: 'ada' }))
    await settle()
    await settle()
    expect(calls).toHaveLength(0)
    expect(heard.filter((c) => c.op === 'error').length).toBe(before)

    await host.stop()
    hostAgent.leave()
    person.leave()
  })
})
