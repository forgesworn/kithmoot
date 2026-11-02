#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initialise, localControl, readConfiguration, runNode } from '../dist/src/node/kithmoot-node/runtime.js'

const [command, ...args] = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (!['--state', '--configuration'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw Error('Use --state DIRECTORY and, for init, --configuration FILE')
  options.set(args[i], args[i + 1])
}
if (command === '--help' || !command) {
  console.log('kithmoot-node init --state DIRECTORY --configuration FILE\nkithmoot-node run|pair|status|doctor --state DIRECTORY\nPrivate development implementation. A public installer requires approved signed backend releases.')
  process.exit(0)
}
try {
  if (!options.has('--state')) throw Error('--state is required')
  const directory = resolve(options.get('--state'))
  if (command === 'init') {
    if (!options.has('--configuration')) throw Error('--configuration is required')
    initialise(directory, JSON.parse(readFileSync(options.get('--configuration'), 'utf8')))
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
    console.log(`https://kithmoot.app/j/#kithmoot-node=${value}`)
    console.log('One use. Expires in six minutes. Open only on the owner’s device.')
  } else if (command === 'status' || command === 'doctor') {
    const result = await localControl(directory, 'status')
    console.log(JSON.stringify(result))
    if (!result.ok || !result.result.ready) process.exitCode = 1
    if (command === 'doctor') console.log('External DNS, certificate trust, UDP/TCP/TLS 443 and mobile network reachability need checks from another network. Local readiness does not establish them.')
  } else throw Error('Unknown command; use --help')
} catch (error) { console.error(error instanceof Error ? error.message : 'Node command failed'); process.exitCode = 1 }
