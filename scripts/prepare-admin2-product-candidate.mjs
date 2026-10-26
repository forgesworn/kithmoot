#!/usr/bin/env node
/** Local inputs only. No fetch, compilation, provenance rewrite or publication. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { repositoryRoot, candidateDirectory, verifyCandidateDirectory } from './admin2-product-candidate.mjs'
if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-admin2-product-candidate.mjs <exact local qualification web directory>')
const files = verifyCandidateDirectory(resolve(process.argv[2]))
mkdirSync(candidateDirectory, { recursive: true })
for (const [name, bytes] of files) writeFileSync(resolve(candidateDirectory, name), bytes)
// Existing source imports refer to this declaration location. Only the exact
// declaration is needed here; candidate executable bytes stay outside public/.
const types = resolve(repositoryRoot, 'app/public/vmls-wasm-admin-invitation')
mkdirSync(types, { recursive: true })
writeFileSync(resolve(types, 'vmls_wasm.d.ts'), files.get('vmls_wasm.d.ts'))
console.log('Prepared exact Admin2 product candidate input. Native qualificationOnly and experimental provenance retained; default profile remains disabled.')
