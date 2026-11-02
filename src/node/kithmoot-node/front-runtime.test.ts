import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFrontConfiguration, readFrontCredentials } from './front-runtime.js'
const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kithmoot-front-files-')); paths.push(directory)
  const certificate = join(directory, 'cert'), certificateKey = join(directory, 'key'), file = join(directory, 'front.json')
  writeFileSync(certificate, 'public-certificate', { mode: 0o644 }); writeFileSync(certificateKey, 'generated-test-key-placeholder', { mode: 0o640 })
  const configuration = { v: 1 as const, host: 'node.example', relayIp: '127.0.0.1', deskPort: 3746, spryPort: 3744, shelterPort: 3745, certificate, certificateKey }
  writeFileSync(file, JSON.stringify(configuration), { mode: 0o644 })
  return { directory, file, configuration }
}
it('accepts protected group-readable TLS material but refuses writable config, public keys and symlink substitution', () => {
  const { directory, file, configuration } = fixture()
  expect(readFrontConfiguration(file)).toEqual(configuration)
  expect(readFrontCredentials(configuration).key.toString()).toBe('generated-test-key-placeholder')
  chmodSync(configuration.certificateKey, 0o644); expect(() => readFrontCredentials(configuration)).toThrow()
  chmodSync(configuration.certificateKey, 0o640); chmodSync(file, 0o666); expect(() => readFrontConfiguration(file)).toThrow()
  chmodSync(file, 0o644)
  const target = join(directory, 'other-key'); writeFileSync(target, 'unrelated-test-material', { mode: 0o600 })
  unlinkSync(configuration.certificateKey); symlinkSync(target, configuration.certificateKey)
  expect(() => readFrontCredentials(configuration)).toThrow()
})
it('refuses remote targets, collisions and unrelated profile settings before exposing a listener', () => {
  const { file, configuration } = fixture()
  for (const patch of [{ relayIp: '192.0.2.1' }, { deskPort: 3478 }, { shelterPort: 3744 }, { public: true }, { v: 2 }]) {
    writeFileSync(file, JSON.stringify({ ...configuration, ...patch }))
    expect(() => readFrontConfiguration(file)).toThrow()
  }
})
