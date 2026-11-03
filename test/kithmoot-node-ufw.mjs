/** Explicitly opt-in: run only inside a disposable root Linux UFW fixture. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { manageFirewall } from '../src/node/kithmoot-node/operator.js'

assert.equal(process.env.E2E_NODE_UFW_FIXTURE, 'disposable-offline-ufw')
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0)
assert.equal(existsSync('/fixture/disposable-ufw'), true)
assert.equal(existsSync('/etc/kithmoot-node'), false)
function ufw(...args) {
  const child = spawnSync('ufw', args, { encoding: 'utf8', timeout: 20000 })
  assert.equal(child.status, 0, 'UFW fixture command failed')
  return child.stdout
}
const added = () => ufw('show', 'added').split('\n').filter(line => line.startsWith('ufw '))
ufw('--force', 'reset'); ufw('--force', 'enable')
ufw('allow', '22/tcp', 'comment', 'operator-ssh')
ufw('allow', 'proto', 'tcp', 'to', 'any', 'port', '443', 'comment', 'operator-dashboard')
ufw('allow', '34790/tcp', 'comment', 'operator-turn')
const before = added()
// The tempting plain `allow` mutates equivalent-rule comments. Insertion must
// preserve ownership even when UFW recognises a differently written rule.
ufw('insert', '1', 'allow', '443/tcp', 'comment', 'KithMoot-node-managed')
assert.deepEqual(added(), before)
const configuration = { v: 1, host: 'node.example', hosting: 'archy', relayIp: '1.2.3.4', aggregateBytesPerSecond: 1000000,
  maxBytes: 16777216, minFreeBytes: 16777216, maxRooms: 8, origins: ['https://kithmoot.app'],
  spryBinary: '/opt/bin/spry-node', shelterBinary: '/opt/bin/bothyd', deskPort: 3746, spryPort: 3744, shelterPort: 3745,
  tlsGate: true, turnPorts: { udpTcp: 34790, tls: 53499 }, relayPortFirst: 49192 }
mkdirSync('/etc/kithmoot-node', { mode: 0o755 })
const marker = '/etc/kithmoot-node/installation.json'
writeFileSync(marker, JSON.stringify({ v: 1, phase: 'ready', directory: '/opt/kithmoot-node/releases/fixture', configuration }), { mode: 0o644 })
manageFirewall()
const once = added(), installed = JSON.parse(readFileSync(marker, 'utf8'))
assert.deepEqual(installed.firewall.sort(), ['34790/udp', '49192:49223/udp', '53499/tcp'])
for (const line of before) assert(once.includes(line), 'Existing operator rule changed')
manageFirewall(); assert.deepEqual(added(), once)
// Exercise the removal command against the actual UFW rule set. Only journalled
// rules with the exact managed tag are removed by the installer.
for (const rule of installed.firewall) ufw('--force', 'delete', 'allow', rule, 'comment', 'KithMoot-node-managed')
assert.deepEqual(added(), before)
console.log(JSON.stringify({ schema: 'kithmoot-node-ufw/1', result: 'passed', existingRules: before.length,
  ownRules: installed.firewall.length, insertionPreservesComments: true, repeatIdempotent: true,
  removalPreservesExistingRules: true, actualInstallerRemoval: false }))
