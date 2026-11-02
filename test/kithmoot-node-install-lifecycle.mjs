/** Root lifecycle proof, exclusively in the task-owned offline systemd container. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readlinkSync, openSync, closeSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
assert.equal(process.env.E2E_NODE_INSTALLED_FIXTURE, 'disposable-offline-systemd')
assert.match(process.env.E2E_NODE_UPDATE_BUNDLE ?? '', /^\/candidate-[0-9]+$/)
const node = process.env.E2E_NODE_UPDATE_BUNDLE + '/kithmoot-node', marker = '/etc/kithmoot-node/installation.json'
const run = (program, args, expected = 0) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 90000 })
  assert.equal(result.status, expected, program + ' ' + args[0] + ': ' + result.stderr)
  return result.stdout
}
async function until(check) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { if (check()) return; await delay(100) }
  throw Error('Fixture transition did not occur')
}
const info = async () => ({ ...await (await fetch('https://node.example/node/v1/info', { headers: { connection: 'close' } })).json(), ...await (await fetch('https://node.example/node/v1/status', { headers: { connection: 'close' } })).json() })
const before = await info(), previous = JSON.parse(readFileSync(marker, 'utf8'))
assert.equal(before.paired, true)
const unit = '/etc/systemd/system/kithmoot-node.service', originalUnit = readFileSync(unit)
try {
  writeFileSync(unit, Buffer.concat([originalUnit, Buffer.from('\n# owner modification\n')]))
  const refused = run(node, ['update'], 1)
  assert.match(refused, /Updating/)
  assert.equal((await info()).serviceKey, before.serviceKey)
} finally { writeFileSync(unit, originalUnit) }
mkdirSync('/fixture/update-bin', { mode: 0o700 })
writeFileSync('/fixture/update-bin/systemctl', '#!/bin/sh\nif [ "$1" = start ]; then echo $$ > /fixture/update-wait.pid; exec /bin/sleep 120; fi\nexec /usr/bin/systemctl "$@"\n', { mode: 0o700 })
const output = openSync('/fixture/interrupted-update.log', 'w', 0o600)
const child = spawn(node, ['update'], { env: { ...process.env, PATH: '/fixture/update-bin:/usr/sbin:/usr/bin:/sbin:/bin' }, stdio: ['ignore', output, output] })
const exited = new Promise(resolve => child.once('exit', resolve))
try {
  await until(() => existsSync('/fixture/update-wait.pid'))
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).phase, 'updating')
  assert.notEqual(readlinkSync('/opt/kithmoot-node/current'), previous.directory)
  child.kill('SIGKILL'); await exited
} finally {
  if (child.exitCode === null) child.kill('SIGKILL')
  if (existsSync('/fixture/update-wait.pid')) {
    try { process.kill(Number(readFileSync('/fixture/update-wait.pid', 'utf8')), 'SIGKILL') } catch {}
    rmSync('/fixture/update-wait.pid')
  }
  closeSync(output); rmSync('/fixture/update-bin', { recursive: true, force: true })
}
run(node, ['resume'])
assert.equal(JSON.parse(readFileSync(marker, 'utf8')).phase, 'ready')
assert.equal(readlinkSync('/opt/kithmoot-node/current'), previous.directory)
assert.equal((await info()).serviceKey, before.serviceKey); assert.equal((await info()).paired, true)
run(node, ['update'])
assert.equal((await info()).serviceKey, before.serviceKey); assert.equal((await info()).paired, true)
const doctor = JSON.parse(run('/opt/kithmoot-node/current/kithmoot-node', ['doctor']))
assert.equal(doctor.localReady, true)
run(node, ['uninstall', '--delete-everything'])
for (const path of ['/etc/kithmoot-node', '/var/lib/kithmoot-node', '/opt/kithmoot-node', unit, '/etc/systemd/system/kithmoot-node-front.service']) assert.equal(existsSync(path), false)
run(node, ['install', '--configuration', '/fixture/setup.json', '--certificate', '/fixture/cert.pem', '--certificate-key', '/fixture/key.pem'])
// Model a kill between exclusive first-time secret writes, before any room or owner.
assert.equal((await info()).paired, false)
run('systemctl', ['stop', 'kithmoot-node-front.service', 'kithmoot-node.service'])
// Discard only this empty fixture's runtime files, modelling the point before first launch.
for (const entry of readdirSync('/var/lib/kithmoot-node')) if (!['node.json', 'service.key'].includes(entry)) rmSync('/var/lib/kithmoot-node/' + entry, { recursive: true, force: true })
const identity = createHash('sha256').update(readFileSync('/var/lib/kithmoot-node/service.key')).digest('hex')
const fresh = JSON.parse(readFileSync(marker, 'utf8')); fresh.phase = 'prepared'; writeFileSync(marker, JSON.stringify(fresh))
writeFileSync('/var/lib/kithmoot-node/initialising', '', { mode: 0o600 })
run('chown', ['kithmoot-node:kithmoot-node', '/var/lib/kithmoot-node/initialising'])
run(node, ['resume'])
assert.equal(createHash('sha256').update(readFileSync('/var/lib/kithmoot-node/service.key')).digest('hex'), identity)
assert.equal(existsSync('/var/lib/kithmoot-node/initialising'), false)
assert.equal(JSON.parse(run('/opt/kithmoot-node/current/kithmoot-node', ['doctor'])).localReady, true)
run(node, ['uninstall', '--delete-everything'])
for (const path of ['/etc/kithmoot-node', '/var/lib/kithmoot-node', '/opt/kithmoot-node', unit]) assert.equal(existsSync(path), false)
console.log(JSON.stringify({ schema: 'kithmoot-node-install-lifecycle/1', result: 'passed', isolatedLinux: true,
  modifiedUnitPreserved: true, killedUpdateRecovered: true, ownerAndIdentityRetained: true, normalUpdate: true,
  cleanUninstall: true, freshInstall: true, interruptedInitialisationResumed: true, originalServiceIdentityPreserved: true, finalUninstall: true }))
