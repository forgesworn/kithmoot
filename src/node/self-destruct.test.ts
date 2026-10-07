import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomAgent } from '../agent.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { destructDeviceKey, removeRoomFiles, selfDestructOnce } from './self-destruct.js'

const BASE = 'https://example.test/j/'

async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

describe('destructDeviceKey', () => {
  it('is stable for one identity and room, and differs between rooms and identities', () => {
    const a = new Uint8Array(32).fill(1)
    const b = new Uint8Array(32).fill(2)
    expect(destructDeviceKey(a, 'room1')).toEqual(destructDeviceKey(a, 'room1'))
    expect(destructDeviceKey(a, 'room1')).not.toEqual(destructDeviceKey(a, 'room2'))
    expect(destructDeviceKey(a, 'room1')).not.toEqual(destructDeviceKey(b, 'room1'))
    expect(destructDeviceKey(a, 'room1')).toHaveLength(32)
  })
})

describe('removeRoomFiles', () => {
  it('removes files and directories, ignores what is already gone, and keeps the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kith-destruct-'))
    await mkdir(join(dir, 'assignments', 'r'), { recursive: true })
    await writeFile(join(dir, 'assignments', 'r', 'x.json'), '{}')
    await writeFile(join(dir, 'state.json'), '{}')
    await writeFile(join(dir, 'other.txt'), 'keep')
    const left = await removeRoomFiles({ files: [join(dir, 'state.json'), join(dir, 'missing')], dirs: [join(dir, 'assignments', 'r')] })
    expect(left).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(['assignments', 'other.txt'])
  })
})

describe('selfDestructOnce', () => {
  it('at a keeper\'s end: closes with the flag, asks the relays to delete, removes the files, once', async () => {
    const relay = new SimRelay({ replay: true })
    const transport = () => new SimTransport(relay)
    const dir = await mkdtemp(join(tmpdir(), 'kith-destruct-'))
    const state = join(dir, 'room.json')
    for (const f of [state, `${state}.link`, `${state}.lock`]) await writeFile(f, 'x')
    await mkdir(join(dir, 'memory'))
    await writeFile(join(dir, 'memory', 'log.jsonl'), 'secret chat\n')
    const now = Math.floor(Date.now() / 1000)
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false, destruct: true, endsAt: now + 2 })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    await ada.chat.send('hello')
    const lines: string[] = []
    let stopped = 0
    let released = 0
    const wipe = selfDestructOnce({
      agent: keeper,
      log: (l) => lines.push(l),
      stop: async () => { stopped++ },
      files: () => ({ files: [state, `${state}.link`, `${state}.lock`], dirs: [join(dir, 'memory')] }),
      done: () => { released++ },
    })
    keeper.onEnded(() => { void wipe('its end has come') })
    keeper.onClosed(() => { void wipe('closed') })
    await until(() => released > 0)
    expect(released).toBe(1)
    expect(stopped).toBe(1)
    expect(await readdir(dir)).toEqual([])
    expect(keeper.session.closed).toBe(true)
    const invitation = relay.published.find((e) => e.kind === 1463)
    expect(invitation).toBeDefined()
    expect(relay.published.some((e) => e.kind === 5)).toBe(true)
    expect(lines.some((l) => l.includes('asked the relays to delete'))).toBe(true)
    await ada.leave()
  })
})
