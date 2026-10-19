/** MIT, loopback-only review UI. No uploads, training API or remote fetches. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const workshopHeaders = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
})
export function createWorkshopServer() {
  const files = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
    ['/workshop.mjs', ['workshop.mjs', 'text/javascript']], ['/workshop.css', ['workshop.css', 'text/css']],
    ['/sources.json', ['sources.json', 'application/json']], ['/LICENSE', ['../LICENSE', 'text/plain']]])
  return createServer(async (request, response) => {
    for (const [name, value] of Object.entries(workshopHeaders)) response.setHeader(name, value)
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host ?? '')) { response.writeHead(403); response.end(); return }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
    let path
    try { path = new URL(request.url, 'http://localhost').pathname } catch { response.writeHead(400); response.end(); return }
    const entry = files.get(path)
    if (!entry) { response.writeHead(404); response.end(); return }
    try {
      const bytes = await readFile(join(here, entry[0]))
      response.writeHead(200, { 'Content-Type': entry[1] + '; charset=utf-8', 'Content-Length': bytes.length })
      response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch { response.writeHead(500); response.end('Workshop file unavailable.'); }
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error('Use --port 4390')
  const port = args.length ? Number(args[1]) : 4390
  if (port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535')
  const server = createWorkshopServer()
  server.listen(port, '127.0.0.1', () => console.log(`KithMoot Model Workshop: http://localhost:${port}\nLocal review only. Save/export explicitly; Ctrl-C stops the server.`))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit()) })
}
