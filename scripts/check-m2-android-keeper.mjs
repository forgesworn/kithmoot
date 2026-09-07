// Synthetic v2 keeper + installed native app on a disposable emulator.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const { M2_BASELINE_DIR: baseline, ANDROID_HOME: sdk, ANDROID_SERIAL: serial } = process.env
if (!baseline || !sdk || !/^emulator-\d+$/.test(serial ?? '')) throw new Error('Set M2_BASELINE_DIR, ANDROID_HOME and a disposable ANDROID_SERIAL')
const adb = join(sdk, 'platform-tools/adb')
assert.equal(execFileSync(adb, ['-s', serial, 'shell', 'getprop', 'ro.kernel.qemu'], { encoding: 'utf8' }).trim(), '1')
const revision = execFileSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const { RoomAgent } = await import(pathToFileURL(join(baseline, 'dist/src/agent.js')).href)
const relay = spawn(process.execPath, ['test/ws-relay.mjs'], { env: { ...process.env, RELAY_PORT: '7779' }, stdio: ['ignore', 'pipe', 'inherit'] })
await Promise.race([once(relay.stdout, 'data'), once(relay, 'exit').then(() => { throw new Error('Fixture relay exited') })])
let keeper, instrument, timer
try {
  keeper = await RoomAgent.create({ base: 'https://kithmoot.forgesworn.dev/j/', name: 'Previous keeper', relays: ['ws://127.0.0.1:7779'], announceJitterMs: 0 })
  const link = new URL(keeper.url)
  const payload = JSON.parse(Buffer.from(link.hash.slice(1), 'base64url').toString())
  assert.equal(payload.v, 2)
  payload.r = ['ws://10.0.2.2:7779']
  link.hash = Buffer.from(JSON.stringify(payload)).toString('base64url')
  instrument = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class', 'dev.forgesworn.kithmoot.storage.M2KeeperInteropTest', '-e', 'm2RoomLink', link.href, 'dev.forgesworn.kithmoot.test/androidx.test.runner.AndroidJUnitRunner'])
  let report = ''
  instrument.stdout.on('data', bytes => { report += bytes })
  instrument.stderr.on('data', bytes => { report += bytes })
  let replied = false
  timer = setInterval(() => {
    if (replied || !keeper.chat.messages().some(m => m.text === 'M2 Android to previous keeper')) return
    replied = true
    void keeper.chat.send('Previous keeper to M2 Android').catch(error => { report += error.message })
  }, 50)
  const timeout = setTimeout(() => instrument.kill('SIGTERM'), 120_000)
  await once(instrument, 'exit')
  clearTimeout(timeout)
  assert.equal(replied, true, 'Previous keeper never received the native message')
  assert.match(report, /OK \(1 test\)/, report.replaceAll(link.href, '<synthetic room link>'))
  console.log(JSON.stringify({ baseline: revision, nativeInstalled: true, previousV2KeeperAdmission: 'passed', encryptedChatBothWays: 'passed', relay: 'local NIP-01', serviceChanges: 'none' }))
} finally { clearInterval(timer); instrument?.kill('SIGTERM'); await keeper?.leave(); relay.kill('SIGTERM') }
