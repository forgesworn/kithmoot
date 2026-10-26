import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const candidateDirectory = resolve(repositoryRoot, '.local/admin2-product-candidate')
export const candidatePin = JSON.parse(readFileSync(resolve(repositoryRoot, 'app/src/mls-admin2-candidate-pin.json'), 'utf8'))
/** A consumer candidate accepts exact qualification bytes without relabelling them. */
export function verifyCandidateDirectory(directory = candidateDirectory) {
  const files = new Map()
  for (const [name, hash] of Object.entries({ 'manifest.json': candidatePin.manifest, ...candidatePin.files })) {
    const bytes = readFileSync(resolve(directory, name))
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Admin2 product candidate hash differs: ${name}`)
    files.set(name, bytes)
  }
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  if (manifest.sourceCommit !== candidatePin.sourceCommit || manifest.qualificationOnly !== true || manifest.experimental !== true || manifest.snapshotVersion !== 5 ||
      manifest.target !== 'web' || manifest.profile !== 'Vennel/invitation-admins/2' || manifest.policy !== 'designated-leaf-admins/1') throw new Error('Admin2 product candidate provenance differs')
  for (const [name, hash] of Object.entries(candidatePin.files)) if (manifest.files?.[name] !== hash) throw new Error(`Admin2 product candidate manifest differs: ${name}`)
  return files
}
