import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialise, validateConfiguration, readConfiguration, runNode, localControl } from './runtime.js'

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true }) })
const configuration = () => ({ v: 1, host: 'node.example', hosting: 'rented', relayIp: '8.8.8.8', aggregateBytesPerSecond: 1000000,
  maxBytes: 1073741824, minFreeBytes: 1073741824, maxRooms: 8, origins: ['https://app.example'],
  spryBinary: '/opt/kithmoot-node/bin/spry-node', shelterBinary: '/opt/kithmoot-node/bin/bothyd', certificate: '/var/lib/kithmoot-node/tls/fullchain.pem',
  certificateKey: '/var/lib/kithmoot-node/tls/privkey.pem', deskPort: 3746, spryPort: 3744, shelterPort: 3745 })
it('requires explicit hosted deployment and resource choices, refusing unsafe or colliding settings', () => {
  expect(validateConfiguration(configuration()).maxRooms).toBe(8)
  for (const patch of [{ hosting: 'home' }, { relayIp: '192.168.1.1' }, { relayIp: '100.64.0.1' }, { relayIp: '192.0.2.1' },
    { relayIp: '203.0.113.2' }, { publicIp: '127.0.0.1' }, { aggregateBytesPerSecond: 0 }, { maxBytes: 1 }, { minFreeBytes: 0 },
    { maxRooms: 65 }, { deskPort: 3744 }, { deskPort: 5349 }, { origins: ['https://app.example/path'] }, { turnSecret: 'not a configuration field' }]) {
    expect(() => validateConfiguration({ ...configuration(), ...patch })).toThrow()
  }
})
it('creates private independent service secrets and never overwrites an existing installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-init-')); paths.push(directory)
  initialise(directory, configuration())
  expect(readConfiguration(directory)).toEqual(configuration())
  const values = ['service.key', 'turn.secret', 'state.salt'].map(name => {
    const path = join(directory, name); expect(statSync(path).mode & 0o777).toBe(0o600)
    const value = readFileSync(path, 'utf8').trim(); expect(value).toMatch(/^[0-9a-f]{64}$/); return value
  })
  expect(new Set(values).size).toBe(3)
  expect(() => initialise(directory, configuration())).toThrow()
  expect(readFileSync(join(directory, 'service.key'), 'utf8').trim()).toBe(values[0])
  expect(readConfiguration(directory)).toEqual(configuration())
})
it('runs a private local control socket and cleans up its children, socket and writer lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-run-')); paths.push(directory)
  const binary = join(directory, 'backend')
  writeFileSync(binary, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 })
  const ports: number[] = []
  for (let i = 0; i < 3; i++) {
    const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('listener')
    ports.push(address.port); await new Promise<void>(r => server.close(() => r()))
  }
  initialise(directory, { ...configuration(), spryBinary: binary, shelterBinary: binary, deskPort: ports[0], spryPort: ports[1], shelterPort: ports[2] })
  const node = await runNode(directory)
  try {
    expect(statSync(join(directory, 'node.sock')).mode & 0o777).toBe(0o600)
    expect(await localControl(directory, 'status')).toMatchObject({ ok: true, result: { ready: false, rooms: 0, paired: false } })
    expect(await localControl(directory, 'info')).toMatchObject({ ok: true, result: { v: 1, version: '0.1.0-rc.1', origin: 'https://node.example', serviceKey: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(await localControl(directory, 'pair')).toMatchObject({ ok: true, result: { code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } })
    await expect(runNode(directory)).rejects.toThrow('already in use')
  } finally { await node.close() }
  expect(existsSync(join(directory, 'node.sock'))).toBe(false)
})

it('recovers interrupted first-time setup without changing existing service identity or accepting changed configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-resume-')); paths.push(directory)
  initialise(directory, configuration())
  const original = readFileSync(join(directory, 'service.key'), 'utf8')
  writeFileSync(join(directory, 'initialising'), '', { mode: 0o600 })
  unlinkSync(join(directory, 'turn.secret')); unlinkSync(join(directory, 'state.salt'))
  expect(() => initialise(directory, { ...configuration(), maxRooms: 7 }, true)).toThrow('does not match')
  expect(existsSync(join(directory, 'turn.secret'))).toBe(false)
  initialise(directory, configuration(), true)
  expect(readFileSync(join(directory, 'service.key'), 'utf8')).toBe(original)
  expect(readFileSync(join(directory, 'turn.secret'), 'utf8').trim()).toMatch(/^[a-f0-9]{64}$/)
  expect(readConfiguration(directory)).toEqual(configuration())
  expect(existsSync(join(directory, 'initialising'))).toBe(false)
  expect(() => initialise(directory, configuration(), true)).toThrow()
})
