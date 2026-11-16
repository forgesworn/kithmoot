import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, readFile, rename, rm, chmod, lstat } from 'node:fs/promises'
import { join } from 'node:path'

export function validPoints(points) {
  return Array.isArray(points) && points.length >= 2 && points.length <= 256
    && points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
}

/** Private loopback link to an opt-in compositor companion. Only ephemeral
 * points, colour and fade cross it, with a new capability per presentation.
 * Serialise acquisition/cleanup; stopping revokes in-flight requests at once. */
export class CompositorMarks {
  #queue = Promise.resolve()
  #revision = 0
  #owner
  constructor(directory) { this.directory = directory }
  #run(operation) {
    const result = this.#queue.then(operation)
    this.#queue = result.catch(() => {})
    return result
  }
  start(kind, emit) {
    if (!['window', 'screen'].includes(kind)) return Promise.resolve(false)
    const revision = ++this.#revision
    if (this.#owner) this.#owner.active = false
    return this.#run(async () => {
      await this.#close()
      if (revision !== this.#revision) return false
      const token = randomBytes(32).toString('hex')
      const owner = { active: true, seen: false, waiting: new Set(), state: { session: randomBytes(24).toString('hex'), kind, strokes: [] }, token }
      this.#owner = owner
      const server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        if (!owner.active || request.headers.origin || request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(403); response.end(); return
        }
        if (request.method === 'GET' && request.url === '/state') {
          owner.seen = true
          for (const ready of owner.waiting) ready(true)
          owner.waiting.clear()
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(owner.state)); return
        }
        if (request.method !== 'POST' || !['/stroke', '/action', '/target'].includes(request.url)) { response.writeHead(404); response.end(); return }
        let data = '', count = 0
        try {
          for await (const chunk of request) {
            count += chunk.length
            if (count > 32768) { response.writeHead(413); response.end(); return }
            data += chunk
          }
          const value = JSON.parse(data)
          // Recheck after reading a body: stop/rejoin may have revoked it.
          if (!owner.active || !value || value.session !== owner.state.session) { response.writeHead(409); response.end(); return }
          if (request.url === '/stroke') {
            if (!validPoints(value.points)) throw new Error('Invalid stroke')
            emit({ op: 'stroke', points: value.points.map(({ x, y }) => ({ x, y })) })
          } else if (request.url === '/target' && ['window', 'screen'].includes(value.kind)) owner.state = { ...owner.state, kind: value.kind }
          else if (request.url === '/action' && ['clear', 'stop'].includes(value.action)) emit({ op: value.action })
          else throw new Error('Invalid action')
          response.writeHead(204); response.end()
        } catch { if (!response.headersSent) response.writeHead(400); response.end() }
      })
      owner.server = server
      server.requestTimeout = 5000; server.headersTimeout = 5000
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
        if (revision !== this.#revision) { await this.#close(); return false }
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const directory = await lstat(this.directory)
        if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Unsafe companion directory')
        await chmod(this.directory, 0o700)
        owner.file = join(this.directory, 'annotations.json')
        const temporary = join(this.directory, `.annotations-${token}.tmp`)
        try {
          await writeFile(temporary, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token }), { mode: 0o600, flag: 'wx' })
          await rename(temporary, owner.file)
        } finally { await rm(temporary, { force: true }) }
        if (revision !== this.#revision) { await this.#close(); return false }
        return true
      } catch (error) { await this.#close(); throw error }
    })
  }
  waitForCompanion(timeout = 1500) {
    const owner = this.#owner
    if (!owner?.active) return Promise.resolve(false)
    if (owner.seen) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); owner.waiting.delete(done); resolve(value) }
      const timer = setTimeout(() => done(false), timeout)
      owner.waiting.add(done)
    })
  }
  render(strokes) {
    const owner = this.#owner
    if (!owner?.active || !Array.isArray(strokes) || strokes.length > 100) return false
    const clean = []
    for (const stroke of strokes) {
      if (!stroke || !validPoints(stroke.points) || !/^#[a-f\d]{6}$/i.test(stroke.color) || !Number.isFinite(stroke.alpha) || stroke.alpha < 0 || stroke.alpha > 1) return false
      clean.push({ points: stroke.points.map(({ x, y }) => ({ x, y })), color: stroke.color, alpha: stroke.alpha })
    }
    // Keep response size bounded even for a room drawing at the protocol limit.
    while (Buffer.byteLength(JSON.stringify(clean)) > 240000) clean.shift()
    owner.state = { ...owner.state, strokes: clean }
    return true
  }
  stop() {
    ++this.#revision
    if (this.#owner) this.#owner.active = false
    return this.#run(() => this.#close())
  }
  async #close() {
    const owner = this.#owner; this.#owner = undefined
    if (!owner) return
    owner.active = false
    for (const ready of owner.waiting) ready(false)
    owner.waiting.clear()
    if (owner.server) {
      owner.server.closeAllConnections()
      await new Promise(resolve => owner.server.close(resolve))
    }
    if (owner.file) {
      try {
        if (JSON.parse(await readFile(owner.file, 'utf8')).token === owner.token) await rm(owner.file, { force: true })
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    }
  }
}
