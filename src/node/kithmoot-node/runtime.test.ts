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
it('accepts an explicit group allocation range but refuses invalid budgets and newly covered collisions', () => {
  const group = { ...configuration(), relayPortFirst: 49192, relayPortCount: 256 }
  expect(validateConfiguration(group)).toEqual(group)
  expect(validateConfiguration({ ...group, relayPortFirst: 65280 }).relayPortCount).toBe(256)
  for (const patch of [{ relayPortCount: 0 }, { relayPortCount: 257 }, { relayPortCount: 1.5 }, { relayPortCount: null },
    { relayPortCount: '256' }, { relayPortFirst: 65281 }, { relayPortFirst: 3300 }, { spryPort: 49300 }]) {
    expect(() => validateConfiguration({ ...group, ...patch }), JSON.stringify(patch)).toThrow()
  }
  expect(validateConfiguration(configuration()).relayPortCount).toBeUndefined()
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

const hostConfiguration = () => {
  const { certificate: _certificate, certificateKey: _key, ...rest } = configuration()
  return { ...rest, hosting: 'archy', tlsGate: true, turnPorts: { udpTcp: 34790, tls: 53499 }, relayPortFirst: 49192 }
}
const manifestSecrets = () => ({ serviceKey: '11'.repeat(32), turnSecret: '22'.repeat(32), stateSalt: '33'.repeat(32) })
it('accepts a separate hosted port profile while refusing collisions and app-readable host certificate keys', () => {
  expect(validateConfiguration(hostConfiguration())).toEqual(hostConfiguration())
  for (const patch of [{ hosting: 'rented' }, { certificate: '/private/host.pem' }, { certificateKey: '/private/host.key' }, { tlsGate: false },
    { turnPorts: { udpTcp: 3744, tls: 53499 } }, { turnPorts: { udpTcp: 443, tls: 53499 } }, { turnPorts: { udpTcp: 34790, tls: 34790 } },
    { relayPortFirst: 65505 }, { relayPortFirst: 34780 }, { relayPortFirst: 49192.5 }]) expect(() => validateConfiguration({ ...hostConfiguration(), ...patch })).toThrow()
})
it('imports only independent declared secrets and preserves them through interrupted setup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-declared-')); paths.push(directory)
  expect(() => initialise(directory, hostConfiguration())).toThrow('manifest-declared')
  const secrets = manifestSecrets(); initialise(directory, hostConfiguration(), false, secrets)
  expect(readFileSync(join(directory, 'service.key'), 'utf8').trim()).toBe(secrets.serviceKey)
  expect(readFileSync(join(directory, 'turn.secret'), 'utf8').trim()).toBe(secrets.turnSecret)
  writeFileSync(join(directory, 'initialising'), '', { mode: 0o600 }); unlinkSync(join(directory, 'state.salt'))
  expect(() => initialise(directory, hostConfiguration(), true, { ...secrets, serviceKey: '44'.repeat(32) })).toThrow('Manifest secrets differ')
  expect(existsSync(join(directory, 'state.salt'))).toBe(false)
  initialise(directory, hostConfiguration(), true, secrets)
  expect(readFileSync(join(directory, 'state.salt'), 'utf8').trim()).toBe(secrets.stateSalt)
  expect(readConfiguration(directory)).toEqual(hostConfiguration())
  for (const invalid of [{ ...secrets, serviceKey: '00'.repeat(32) }, { ...secrets, stateSalt: secrets.turnSecret }]) {
    const rejected = mkdtempSync(join(tmpdir(), 'kithmoot-node-declared-bad-')); paths.push(rejected)
    expect(() => initialise(rejected, hostConfiguration(), false, invalid)).toThrow()
    expect(existsSync(join(rejected, 'node.json'))).toBe(false)
  }
})

it.each([undefined, 256])('launches the host-gated backend with allocation count %s and without host certificate paths', async (count) => {
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-node-host-env-')); paths.push(directory)
  const binary = join(directory, 'backend'), capture = join(directory, 'ports.txt')
  writeFileSync(binary, '#!/bin/sh\nif [ -n "${SPRY_TURN_PORT:-}" ]; then\n  printf "%s\\n" "$SPRY_TURN_PORT" "$SPRY_TLS_PORT" "$SPRY_RELAY_PORTS" "$SPRY_TLS_GATE" "${SPRY_TLS_CERT_FILE+present}" "${SPRY_TLS_KEY_FILE+present}" "$SPRY_MAX_ALLOCATIONS" "$SPRY_MAX_ALLOCATIONS_PER_USER" "$SPRY_MAX_TCP_CONNECTIONS" > "' + capture + '"\nfi\nexec /bin/sleep 30\n', { mode: 0o700 })
  const ports: number[] = []
  for (let i = 0; i < 3; i++) {
    const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('listener')
    ports.push(address.port); await new Promise<void>(r => server.close(() => r()))
  }
  const secrets = manifestSecrets()
  initialise(directory, { ...hostConfiguration(), ...(count === undefined ? {} : { relayPortCount: count }), spryBinary: binary, shelterBinary: binary, deskPort: ports[0], spryPort: ports[1], shelterPort: ports[2] }, false, secrets)
  await expect(runNode(directory, { ...secrets, stateSalt: '44'.repeat(32) })).rejects.toThrow('Manifest secrets differ')
  const node = await runNode(directory, secrets)
  try {
    for (let i = 0; i < 500 && !existsSync(capture); i++) await new Promise(r => setTimeout(r, 10))
    expect(readFileSync(capture, 'utf8').split('\n')).toEqual(['34790', '53499', count === 256 ? '49192:49447' : '49192:49223',
      'true', '', '', String(count ?? 32), count === 256 ? '32' : '8', count === 256 ? '256' : '64', ''])
    const info = await (await fetch(`http://127.0.0.1:${ports[0]}/node/v1/info`)).json()
    expect(info.turnPorts).toEqual({ udpTcp: 34790, tls: 53499 })
    // The client half-closes its request before the serial operation resolves.
    // The server must keep its writable half open for the asynchronous reply.
    await expect(localControl(directory, 'prepare-delete')).resolves.toEqual({ ok: false, error: 'node-reconciling' })
    await expect(localControl(directory, 'cancel-delete')).resolves.toEqual({ ok: true, result: { deleteReady: false } })
  } finally { await node.close() }
})
