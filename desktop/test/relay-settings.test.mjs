import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelaySettings, defaultSettings, localDay, DAILY_LIMIT_BYTES } from '../relay-settings.mjs'

test('settings default to off with nothing relayed, and a 5 GB daily limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kithmoot-relay-settings-'))
  try {
    const settings = createRelaySettings({ dir })
    assert.deepEqual(await settings.load(), defaultSettings())
    assert.equal(DAILY_LIMIT_BYTES, 5_000_000_000)
    await settings.save({ v: 1, startOnOpen: true, day: '2026-10-30', dayBytes: 12 })
    assert.deepEqual(await settings.load(), { v: 1, startOnOpen: true, day: '2026-10-30', dayBytes: 12 })
    if (process.platform !== 'win32') assert.equal((await stat(settings.file)).mode & 0o777, 0o600)
    await assert.rejects(settings.save({ v: 1, startOnOpen: 'yes', day: '', dayBytes: 0 }))
    await writeFile(settings.file, '{"v":1,"startOnOpen":true,"day":"not a day","dayBytes":0}')
    assert.deepEqual(await settings.load(), defaultSettings(), 'a damaged file reads as the defaults')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the day is the computer\'s own date', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})
