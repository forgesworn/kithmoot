import { writeFileSync, rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { networkInterfaces } from 'node:os'
import { nodeBrowserFixture } from './node-browser-fixture.js'

// Private, opt-in loopback fixture. The config includes a one-use pairing code:
// keep it owner-readable, pass only its path, and never log its contents.
const config = process.argv[2]
if (!config || !isAbsolute(config) || process.argv.length !== 3) throw Error('Pass one absolute task-owned config path')
const relayIp = process.env.E2E_NODE_NATIVE_RELAY_IP
if (relayIp && !Object.values(networkInterfaces()).flat().some(address => address?.family === 'IPv4' && address.address === relayIp))
  throw Error('Native relay IP must be assigned to this fixture host')
const fixture = await nodeBrowserFixture('https://kithmoot.app', { relayIp })
let written = false
try {
  writeFileSync(config, JSON.stringify({ v: 1, ...fixture.native, pairing: 'https://kithmoot.app/j/' + fixture.pairing() }), { mode: 0o600, flag: 'wx' })
  written = true
  process.stdout.write('Native node fixture ready\n')
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve)
  })
} finally {
  if (written) rmSync(config, { force: true })
  await fixture.close()
}
