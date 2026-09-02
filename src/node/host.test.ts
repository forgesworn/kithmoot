import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomAgent } from '../agent.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from '../control.js'
import type { ControlMessage } from '../control.js'
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

async function room() {
  const relay = new SimRelay()
  const transport = () => new SimTransport(relay)
  const person = await RoomAgent.create({ base: BASE, name: 'Person', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false })
  const hostAgent = await RoomAgent.join({ link: person.url, name: 'Laptop', transport, announceJitterMs: 0 })
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
  return { relay, person, hostAgent, control, heard }
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
})
