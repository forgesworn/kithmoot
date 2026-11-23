import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
export async function stageCompositorCompanions() {
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const dir = resolve(desktop, 'artifacts/compositor-companions/drawing')
  await mkdir(dir, { recursive: true })
  for (const name of ['gnome', 'kwin', 'install.py', 'README.md']) {
    await cp(resolve(desktop, 'compositors', name), resolve(dir, name), { recursive: true, filter: source => !source.endsWith('gschemas.compiled') })
  }
  return dir
}
