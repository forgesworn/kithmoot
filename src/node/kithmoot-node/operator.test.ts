import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operationLock, acmeName, acmeHook } from './operator.js'

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
