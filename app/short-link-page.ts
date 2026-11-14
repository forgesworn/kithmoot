import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Connect, Plugin } from 'vite'
import { build as esbuild } from 'esbuild'

const root = resolve(import.meta.dirname, 'short-link')
/** Built beside the page rather than in app/dist, which is served at /j/:
 * this page lives at /n/. deploy/deploy.sh copies it into the release. */
export const shortLinkOut = resolve(root, 'dist')

async function bundle(): Promise<string> {
  const result = await esbuild({
    entryPoints: [resolve(import.meta.dirname, 'src/short-link-open.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    write: false,
    minify: true,
    legalComments: 'none',
  })
  return result.outputFiles?.[0]?.text ?? ''
}

function serve(script: () => Promise<string>): Connect.NextHandleFunction {
  return (req, res, next) => {
    const path = req.url?.split('?')[0]
    // Caddy's file server adds the slash the same way; the browser keeps
    // the #fragment across the redirect.
    if (path === '/n') { res.statusCode = 301; res.setHeader('location', '/n/' + (req.url?.slice(2) ?? '')); res.end(); return }
    if (path === '/n/' || path === '/n/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-cache')
      res.end(readFileSync(resolve(root, 'index.html')))
      return
    }
    if (path === '/n/open.js') {
      script().then(code => { res.setHeader('content-type', 'text/javascript'); res.setHeader('cache-control', 'no-cache'); res.end(code) },
        (err: Error) => { res.statusCode = 500; res.end(`/* ${err.message} */`) })
      return
    }
    if (path?.startsWith('/n/')) { res.statusCode = 404; res.end(); return }
    next()
  }
}

/**
 * The short-link page, https://<host>/n/#<short link>: see app/src/short-link.ts.
 * Development bundles it on each request, `vite preview` serves what the
 * build wrote, and a web build writes it to app/short-link/dist. The desktop
 * build leaves it out: the desktop app opens links itself and sends other
 * pages on its origin to the system browser.
 */
export function shortLinkPage(desktop: boolean): Plugin {
  let building = false
  return {
    name: 'kithmoot-short-link-page',
    configResolved(config) { building = config.command === 'build' },
    configureServer(server) {
      server.middlewares.use(serve(bundle))
      server.watcher.add([resolve(root, 'index.html'), resolve(import.meta.dirname, 'src/short-link.ts'), resolve(import.meta.dirname, 'src/short-link-open.ts')])
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve(async () => readFileSync(resolve(shortLinkOut, 'open.js'), 'utf8')))
    },
    async closeBundle() {
      if (!building || desktop) return
      mkdirSync(shortLinkOut, { recursive: true })
      writeFileSync(resolve(shortLinkOut, 'index.html'), readFileSync(resolve(root, 'index.html')))
      writeFileSync(resolve(shortLinkOut, 'open.js'), await bundle())
    },
  }
}
