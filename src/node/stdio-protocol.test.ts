import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { STDIO_PROTOCOL } from './stdio-protocol.js'

it('the built CLI reports compatibility without using room configuration or creating identity files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kithmoot-stdio-cli-'))
  try {
    const stdout = execFileSync(process.execPath, [resolve('bin/kithmoot-agent.mjs'), '--stdio-protocol'], {
      cwd, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, KITHMOOT_LINK: 'invalid-room-link', KITHMOOT_IDENTITY: join(cwd, 'must-not-exist.key'), KITHMOOT_NSEC: 'invalid-secret' },
    })
    expect(JSON.parse(stdout)).toEqual(STDIO_PROTOCOL)
    expect(readdirSync(cwd)).toEqual([])
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
