/** MIT consumer adapter. Bind a static preview to the host and pinned library. */
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkout = fileURLToPath(new URL('../', import.meta.url))
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function visionSource(root = checkout) {
  const revision = git(root, ['rev-parse', 'HEAD'])
  const entry = git(root, ['ls-tree', 'HEAD', '--', 'vision'])
  const pin = /^160000 commit ([0-9a-f]{40})\tvision$/.exec(entry)?.[1]
  if (!pin) throw new Error('KithMoot must pin the independent vision submodule before building a preview')
  const component = join(root, 'vision')
  let visionRevision
  try { visionRevision = git(component, ['rev-parse', 'HEAD']) }
  catch { throw new Error('Initialise the vision dependency with npm run vision:init') }
  if (visionRevision !== pin) throw new Error('Vision checkout differs from the commit pinned by KithMoot; run npm run vision:init')
  for (const [directory, label] of [[component, 'Vision'], [root, 'KithMoot']]) {
    if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: directory }).status !== 0) {
      throw new Error(`${label} sources have tracked changes; commit them before building a preview`)
    }
  }
  return { revision, visionRevision }
}

export async function buildVisionLab(output, options = {}, root = checkout) {
  const source = visionSource(root)
  const { buildLab } = await import(pathToFileURL(join(root, 'vision/lab/build.mjs')).href)
  const manifest = await buildLab(output, options) // Refuses an existing output directory.
  try {
    const after = visionSource(root)
    if (source.revision !== after.revision || source.visionRevision !== after.visionRevision ||
        manifest.revision !== source.visionRevision || manifest.source_dirty !== false) {
      throw new Error('Source changed during the vision preview build; rebuild from the committed pin')
    }
    manifest.vision_revision = manifest.revision
    manifest.vision_repository = 'https://github.com/forgesworn/kithmoot-vision'
    manifest.revision = source.revision
    await writeFile(join(resolve(output), 'lab-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    return manifest
  } catch (error) { await rm(resolve(output), { recursive: true, force: true }); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Use --output NEW_DIRECTORY')
  const manifest = await buildVisionLab(args[1])
  console.log(JSON.stringify({ revision: manifest.revision, vision_revision: manifest.vision_revision,
    source_dirty: manifest.source_dirty, qualified: manifest.qualified, files: Object.keys(manifest.files).length }))
}
