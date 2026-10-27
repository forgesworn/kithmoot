import type { Plugin } from 'vite'
import { mlsInvitationProfile } from './src/mls-invitation-profile.js'
// @ts-expect-error Node-only preparation verifier has no browser declarations.
import { verifyCandidateDirectory } from '../scripts/admin2-product-candidate.mjs'
/** Only the selected candidate may serve or emit these exact local bytes. */
export function admin2ProductCandidate(): Plugin {
  let selected = false
  let files: Map<string, Buffer> | undefined
  return {
    name: 'kithmoot-admin2-product-candidate',
    configResolved(config) { selected = mlsInvitationProfile(config.env) === 'admin2' },
    buildStart() { if (selected) files = verifyCandidateDirectory() },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!selected || !req.url?.startsWith('/j/vmls-wasm-admin2-candidate/')) return next()
        const name = req.url.split('?')[0].slice('/j/vmls-wasm-admin2-candidate/'.length)
        const bytes = verifyCandidateDirectory().get(name)
        if (!bytes || name.endsWith('.d.ts')) { res.statusCode = 404; res.end(); return }
        res.setHeader('content-type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.json') ? 'application/json' : 'text/javascript')
        res.end(bytes)
      })
    },
    generateBundle() {
      if (!selected) return
      for (const [name, source] of files ?? verifyCandidateDirectory()) {
        if (!name.endsWith('.d.ts')) this.emitFile({ type: 'asset', fileName: `vmls-wasm-admin2-candidate/${name}`, source })
      }
    },
  }
}
