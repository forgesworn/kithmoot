/** Local-only MIT camera lab. Serves an explicit static allow-list; no uploads. */
import { createServer } from 'node:http'
import { readFile, access } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url)), vision = resolve(here, '..')
const data = join(vision, 'runs/lab-drawings-v1'), model = join(vision, 'runs/lab-model-1000-v1')
const wasm = join(vision, 'runtime/target/wasm32-unknown-unknown/release/kithmoot_vision.wasm')
export const labHeaders = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(self), microphone=(self)',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
})

function run(command, args, cwd = vision) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status})`)
}

export async function prepare(device = 'cpu') {
  if (process.env.CARGO_TARGET_DIR && resolve(process.env.CARGO_TARGET_DIR) !== join(vision, 'runtime/target')) {
    throw new Error('Use the worktree’s existing vision/runtime/target; unset CARGO_TARGET_DIR')
  }
  run('cargo', ['build', '--locked', '--release', '--lib', '--target', 'wasm32-unknown-unknown'], join(vision, 'runtime'))
  const python = process.env.VISION_PYTHON ?? 'python3'
  try { await access(join(data, 'manifest.jsonl')) } catch {
    run(python, ['-m', 'kithmoot_vision.synthetic', data, '--count', '18'])
  }
  try { await access(join(model, 'model-card.json')) } catch {
    run(python, ['-m', 'kithmoot_vision.train', join(data, 'manifest.jsonl'), model, '--steps', '1000', '--device', device])
  }
  try { await access(join(model, 'experimental.kvm')) } catch {
    run(python, ['-m', 'kithmoot_vision.export', join(model, 'experimental.pt'), join(model, 'experimental.kvm')])
  }
}

export async function labAssets({ modelDirectory = model, dataDirectory = data, wasmPath = wasm } = {}) {
  const routes = new Map()
  for (const name of ['index.html', 'lab.mjs', 'lab.css', 'core.mjs', 'worker.mjs', 'audio.mjs']) routes.set('/' + name, join(here, name))
  routes.set('/', join(here, 'index.html'))
  routes.set('/runtime.mjs', join(vision, 'web/runtime.mjs'))
  routes.set('/runtime.wasm', wasmPath)
  routes.set('/default.kvm', join(modelDirectory, 'experimental.kvm'))
  routes.set('/default.json', join(modelDirectory, 'experimental.json'))
  routes.set('/LICENSE', join(vision, 'LICENSE'))
  routes.set('/mask.svg', resolve(vision, '../art/face-mask/kithmoot-mask.svg'))
  const notices = ['Apache-2.0.txt', 'COPYRIGHT-library.html', 'MIT.txt', 'Unicode-3.0.txt', 'BSD-2-Clause.txt']
  for (const name of notices) routes.set('/notices/' + name, join(vision, 'runtime/third_party/rust-1.94.1', name))
  const manifest = await readFile(join(dataDirectory, 'manifest.jsonl'))
  const rows = manifest.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  const examples = ['train', 'validation', 'test'].map((split, index) => {
    const matches = rows.filter(row => row.split === split)
    const row = matches.find(row => row.faces.length >= 2) ?? matches[0]
    if (!row?.synthetic) throw new Error('The default lab examples must be original procedural drawings')
    const example = { split, sequence: row.sequence, faces: row.faces, synthetic: true }
    for (const kind of ['rgb', 'alpha', 'reference', 'held_objects']) {
      if (!row[kind]) continue
      const path = resolve(dataDirectory, row[kind].path)
      if (!path.startsWith(resolve(dataDirectory) + '/')) throw new Error('Example path escapes its directory')
      const url = `examples/${index}/${kind}.png`
      routes.set('/' + url, path); example[kind] = url
    }
    return example
  })
  return { routes, examples, rows, manifest, dataDirectory }
}

export async function createLabServer(options = {}) {
  const { routes, examples } = await labAssets(options)
  const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' }
  return createServer(async (request, response) => {
    const host = request.headers.host ?? ''
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { response.writeHead(403); response.end(); return }
    for (const [name, value] of Object.entries(labHeaders)) response.setHeader(name, value)
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
    let pathname
    try { pathname = new URL(request.url, 'http://localhost').pathname }
    catch { response.writeHead(400); response.end(); return }
    try {
      let bytes, type
      if (pathname === '/examples.json') { bytes = Buffer.from(JSON.stringify(examples)); type = mime['.json'] }
      else {
        const path = routes.get(pathname)
        if (!path) { response.writeHead(404); response.end(); return }
        bytes = await readFile(path)
        const extension = path.slice(path.lastIndexOf('.'))
        type = mime[extension] ?? 'text/plain; charset=utf-8'
      }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length })
      response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch { response.writeHead(404); response.end('Run npm run vision:lab -- --prepare to build the local lab assets.\n') }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => !['--prepare', '--device', 'cpu', 'mps', 'cuda', '--port'].includes(arg) && !/^\d+$/.test(arg))) throw new Error('Use --prepare [--device cpu|mps|cuda] [--port 4388]')
    const device = args.includes('--device') ? args[args.indexOf('--device') + 1] : 'cpu'
    const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 4388
    if (!['cpu', 'mps', 'cuda'].includes(device) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid lab device or port')
    if (args.includes('--prepare')) await prepare(device)
    const server = await createLabServer()
    server.on('error', error => { console.error(error.message); process.exitCode = 1 })
    server.listen(port, '127.0.0.1', () => console.log(`Local camera lab: http://localhost:${port}\nDefault weights: procedural drawings only; load a personal experiment for real-camera testing.\nCtrl-C stops the lab. Captures stay in the browser unless you explicitly export them.`))
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit()) })
  } catch (error) { console.error(error.message); console.error('First run: npm run vision:lab -- --prepare'); process.exitCode = 1 }
}
