import { createReadStream, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, sep } from 'node:path'
import type { Plugin } from 'vite'

/** Ship a pinned Girnel artifact from our own origin. The reviewed package's
 * manifest verifies every file before development serving or production build. */
export function girnelAssets(): Plugin {
  const root = resolve(import.meta.dirname, '../node_modules/@forgesworn/girnel-embed/public')
  const provenance = JSON.parse(readFileSync(resolve(root, '../provenance.json'), 'utf8')) as {assets: Record<string, string>}
  const files: string[] = []
  for (const path of readdirSync(root, {recursive: true, encoding: 'utf8'})) {
    if (!(path in provenance.assets)) continue
    const file = resolve(root, path)
    if (!file.startsWith(root + sep) || createHash('sha256').update(readFileSync(file)).digest('hex') !== provenance.assets[path]) throw new Error(`Girnel asset failed verification: ${path}`)
    files.push(path)
  }
  if (files.length !== Object.keys(provenance.assets).length || !files.includes('embedded/index.html')) throw new Error('Girnel asset package is incomplete')
  return {name: 'kithmoot-girnel-boards',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.startsWith('/j/girnel/')) return next()
        const path = url.slice('/j/girnel/'.length)
        if (!files.includes(path)) {res.statusCode = 404; res.end(); return}
        const file = resolve(root, path)
        res.setHeader('content-type', path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const file of files) this.emitFile({type: 'asset', fileName: `girnel/${relative(root, resolve(root, file))}`, source: readFileSync(resolve(root, file))})
    },
  }
}
