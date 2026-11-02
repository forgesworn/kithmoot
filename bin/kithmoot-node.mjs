#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { operatorCommand, systemReadOnly } from '../dist/src/node/kithmoot-node/operator-cli.js'
import { doctorNode } from '../dist/src/node/kithmoot-node/doctor.js'
import { runFront } from '../dist/src/node/kithmoot-node/front-runtime.js'
import { initialise, localControl, readConfiguration, runNode } from '../dist/src/node/kithmoot-node/runtime.js'

const [command, ...args] = process.argv.slice(2)
async function main() {
if (['install', 'resume', 'update', 'uninstall', 'certificates'].includes(command)) return operatorCommand(command, args, fileURLToPath(new URL('../', import.meta.url)))
if (['pair', 'status', 'doctor'].includes(command) && !args.length && process.getuid?.() === 0) { process.exitCode = systemReadOnly(command); return }
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (!['--state', '--configuration'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw Error('Use --state DIRECTORY and, for init, --configuration FILE')
  options.set(args[i], args[i + 1])
}
if (command === '--help' || !command) {
  console.log('kithmoot-node install --name HOST [setup options]\nkithmoot-node resume\nkithmoot-node update\nkithmoot-node uninstall --delete-everything\nkithmoot-node pair|status|doctor (installed operator commands)\nkithmoot-node init --state DIRECTORY --configuration FILE\nkithmoot-node run|pair|status|doctor --state DIRECTORY\nkithmoot-node front --configuration FILE\nPrivate development implementation. A public installer requires approved signed backend releases.')
  process.exit(0)
}
try {
  if (command === 'front') {
    if (options.has('--state') || !options.has('--configuration')) throw Error('front requires only --configuration FILE')
    const front = await runFront(resolve(options.get('--configuration')))
    let stopping = false
    const stop = async () => { if (stopping) return; stopping = true; try { await front.close() } catch { process.exitCode = 1 } }
    process.once('SIGTERM', stop); process.once('SIGINT', stop)
    process.on('SIGHUP', () => { try { front.reload() } catch { console.error('Certificate reload refused; the current certificate remains active.') } })
  } else {
  if (!options.has('--state')) throw Error('--state is required')
  const directory = resolve(options.get('--state'))
  if (command === 'init' || command === 'resume-init') {
    if (!options.has('--configuration')) throw Error('--configuration is required')
    initialise(directory, JSON.parse(readFileSync(options.get('--configuration'), 'utf8')), command === 'resume-init')
    console.log('Private node state prepared. Start its unprivileged service, then run pair locally.')
  } else if (command === 'run') {
    const node = await runNode(directory)
    let stopping = false
    const stop = async () => { if (stopping) return; stopping = true; try { await node.close() } catch { process.exitCode = 1 } }
    process.once('SIGTERM', stop); process.once('SIGINT', stop)
  } else if (command === 'pair') {
    if (!process.stdout.isTTY) throw Error('Pairing needs a local terminal; its secret must not enter service logs')
    const result = await localControl(directory, 'pair')
    if (!result.ok) throw Error(result.error)
    const c = readConfiguration(directory)
    const value = Buffer.from(JSON.stringify({ v: 1, node: `https://${c.host}`, code: result.result.code, expiresAt: result.result.expiresAt })).toString('base64url')
    const link = `https://kithmoot.app/j/#kithmoot-node=${value}`
    console.log(await QRCode.toString(link, { type: 'terminal', small: true }))
    console.log(link)
    console.log('One use. Expires in six minutes. Open only on the owner’s device.')
  } else if (command === 'doctor') {
    const report = await doctorNode(directory)
    console.log(JSON.stringify(report))
    if (!report.localReady) process.exitCode = 1
  } else if (command === 'status') {
    const result = await localControl(directory, 'status')
    console.log(JSON.stringify(result))
    if (!result.ok || !result.result.ready) process.exitCode = 1
  } else throw Error('Unknown command; use --help')
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Node command failed'); process.exitCode = 1 }

}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Node command failed'); process.exitCode = 1 })
