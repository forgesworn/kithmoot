import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operationLock, acmeName, acmeHook, nodeFirewallRules } from './operator.js'

it('serialises operator changes and releases the OS lock without deleting or trusting a PID file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-operator-lock-')), path = join(directory, 'lock.sqlite')
  try {
    const release = operationLock(path)
    try { expect(() => operationLock(path)).toThrow('Another node installation') } finally { release() }
    operationLock(path)()
    const unsafe = join(directory, 'unsafe'); writeFileSync(unsafe, '', { mode: 0o644 })
    expect(() => operationLock(unsafe)).toThrow('Unsafe installer lock')
    symlinkSync(path, join(directory, 'link'))
    expect(() => operationLock(join(directory, 'link'))).toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('scopes the renewal hook to its own ACME lineage and rejects shell input', () => {
  const name = acmeName('node.example'), hook = acmeHook(name)
  expect(name).toMatch(/^kithmoot-node-[a-f0-9]{16}$/)
  expect(hook).toContain('/etc/letsencrypt/live/' + name + ')')
  expect(hook).toContain('"$RENEWED_LINEAGE/privkey.pem"')
  expect(() => acmeHook('x; touch /tmp/bad')).toThrow()
})
it('keeps the legacy firewall range and includes every explicitly configured group allocation port', () => {
  const configuration = { v: 1 as const, host: 'node.example', hosting: 'rented' as const, relayIp: '8.8.8.8',
    aggregateBytesPerSecond: 2000000, maxBytes: 1073741824, minFreeBytes: 1073741824, maxRooms: 8,
    origins: ['https://app.example'], spryBinary: '/opt/node/spry-node', shelterBinary: '/opt/node/bothyd',
    certificate: '/private/cert.pem', certificateKey: '/private/key.pem', deskPort: 3746, spryPort: 3744, shelterPort: 3745 }
  expect(nodeFirewallRules(configuration)).toEqual(['443/tcp', '3478/tcp', '3478/udp', '5349/tcp', '49160:49191/udp'])
  expect(nodeFirewallRules({ ...configuration, relayPortFirst: 49192, relayPortCount: 256 })).toEqual([
    '443/tcp', '3478/tcp', '3478/udp', '5349/tcp', '49192:49447/udp',
  ])
})
