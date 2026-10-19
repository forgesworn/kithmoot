/** Read-only hosted preview. Only reviewed, original drawing assets can ship. */
import { readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { labAssets, labHeaders } from './serve.mjs'
import { checkedWeights } from './core.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export async function buildLab(output, options = {}) {
  const assets = await labAssets(options)
  const card = JSON.parse(await readFile(assets.routes.get('/default.json'), 'utf8'))
  if (card.scope !== 'general' || card.licence !== 'MIT' || card.public_release_allowed !== true ||
      card.synthetic_only !== true || card.qualified !== false || card.pretrained_weights !== null) {
    throw new Error('Hosted lab accepts only unqualified, original MIT drawing weights; personal models must stay in the browser')
  }
  const weights = await readFile(assets.routes.get('/default.kvm'))
  await checkedWeights(Uint8Array.from(weights).buffer, card)
  if (sha256(assets.manifest) !== card.manifest_sha256) throw new Error('Drawing manifest differs from the model card')
  const dataRoot = await realpath(assets.dataDirectory)
  const checkedAsset = async record => {
    const path = await realpath(resolve(dataRoot, record.path))
    if (!path.startsWith(dataRoot + '/')) throw new Error('Drawing asset escapes its directory')
    if (sha256(await readFile(path)) !== record.sha256) throw new Error('Drawing asset checksum mismatch')
  }
  for (const row of assets.rows) {
    const rights = row.rights
    if (row.scope !== 'general' || row.synthetic !== true || rights?.licence !== 'PROJECT-OWNED' ||
        !['training', 'commercial', 'mit_weights'].every(name => rights[name] === true)) {
      throw new Error('Hosted examples must be original drawings with reviewed public-training rights')
    }
    await checkedAsset({ path: rights.evidence, sha256: rights.evidence_sha256 })
    for (const name of ['rgb', 'alpha', 'reference', 'previous_alpha', 'held_objects']) if (row[name]) await checkedAsset(row[name])
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (revision.status !== 0) throw new Error('Build from the source checkout to retain its revision')
  const dirty = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root })
  if (![0, 1].includes(dirty.status)) throw new Error('Cannot check source state')
  output = resolve(output)
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output) // Refuse existing directories, including previous exports.
  try {
    const files = {}
    for (const [url, source] of assets.routes) {
      if (url === '/') continue
      const relative = url.slice(1), bytes = await readFile(source)
      await mkdir(dirname(join(output, relative)), { recursive: true })
      await writeFile(join(output, relative), bytes)
      files[relative] = sha256(bytes)
    }
    const examples = Buffer.from(JSON.stringify(assets.examples) + '\n')
    await writeFile(join(output, 'examples.json'), examples); files['examples.json'] = sha256(examples)
    const manifest = { format: 'kithmoot-camera-lab-static-v1', revision: revision.stdout.trim(), source_dirty: dirty.status !== 0,
      qualified: false, model_scope: 'original-drawings-only', camera_frames_uploaded: false, audio_recorded: false,
      model_sha256: card.portable_weights_sha256, headers: labHeaders, files }
    await writeFile(join(output, 'lab-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    return manifest
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Use --output NEW_DIRECTORY after npm run vision:lab -- --prepare')
  const manifest = await buildLab(args[1])
  console.log(JSON.stringify({ revision: manifest.revision, source_dirty: manifest.source_dirty, files: Object.keys(manifest.files).length,
    qualified: false, model_scope: manifest.model_scope }))
}
