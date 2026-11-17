import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { bytesToHex } from '@noble/hashes/utils.js'
import { build } from 'esbuild'

const root = mkdtempSync(resolve(tmpdir(), 'kithmoot-wok-room-'))
const binary = resolve(process.env.WOKD_BIN ?? '../wok/target/debug/wokd')
const server = 'wss://relay.example.org/events'
const external = process.env.WOK_EXTERNAL === '1'
const keeperSecret = external ? new Uint8Array(32).fill(1) : generateSecretKey()
const keeper = getPublicKey(keeperSecret)
let child, failure
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const port = external ? 443 : await new Promise(resolve => {
  const listener = createServer()
  listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)) })
})
const config = `listen = "127.0.0.1:${port}"\nurl = "${server}"\ndata_dir = "${root}/state"\nmax_store_bytes = 67108864\nmin_free_bytes = 0\nmembers = ["${npubEncode(keeper)}"]\n`
const configPath = resolve(root, 'wokd.toml')
writeFileSync(configPath, config)

async function start() {
  if (!external) {
    child = spawn(binary, ['--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', chunk => { failure = `${failure ?? ''}${chunk}`.slice(-4000) })
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!external && child.exitCode !== null) throw new Error(`wokd exited: ${failure}`)
    try {
      await new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => { socket.end(); resolve() })
        socket.on('error', reject)
      })
      return
    } catch { await sleep(50) }
  }
  throw new Error(`wokd did not listen: ${failure}`)
}
async function stop() {
  if (external || !child || child.exitCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(10_000).then(() => { child.kill('SIGKILL') })])
}

try {
  await start()
  const outfile = resolve(root, 'client.mjs')
  await build({ entryPoints: ['test/wok-room-client.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    external: ['node:*'], logLevel: 'silent' })
  const { runWokRoomAcceptance } = await import(pathToFileURL(outfile).href)
  const result = await runWokRoomAcceptance({ server, port, keeperSecret: bytesToHex(keeperSecret), directWss: external, restart: async () => {
    if (external) {
      await new Promise((resolve, reject) => {
        const request = http.request({ socketPath: '/var/run/docker.sock', path: '/v1.51/containers/forgesworn-node-wok-1/restart', method: 'POST' }, response => {
          response.resume()
          response.on('end', () => response.statusCode === 204 ? resolve() : reject(new Error(`Wok restart returned ${response.statusCode}`)))
        })
        request.on('error', reject)
        request.end()
      })
      await start()
    } else { await stop(); await start() }
  } })
  assert.deepEqual(result, { activated: true, scopedReadback: true, restart: true, renewed: true, withdrawn: true })
  console.log(JSON.stringify({ passed: true, ...result }))
} catch (error) {
  console.error(error)
  if (failure) console.error(failure)
  process.exitCode = 1
} finally {
  await stop()
  rmSync(root, { recursive: true, force: true })
}
