import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
/** One small native geometry watcher, kept outside ASAR so it can execute. */
export async function stageWindowHelper(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported window geometry target')
  const dir = resolve(root, `artifacts/window-helper/${platform}-${arch}/window-helper`)
  await mkdir(dir, { recursive: true })
  const file = resolve(dir, `share-window${platform === 'win32' ? '.exe' : ''}`)
  const source = resolve(root, 'native/share-window.c')
  const native = platform === process.platform && arch === process.arch
  const compiler = native && platform !== 'win32' ? 'cc' : process.env.ZIG ?? 'zig'
  const targets = { darwin: 'macos', linux: 'linux-gnu', win32: 'windows-gnu' }
  const cpu = arch === 'x64' ? 'x86_64' : 'aarch64'
  const args = [...(compiler === 'cc' ? [] : ['cc', '-target', `${cpu}-${targets[platform]}`]), '-O2', source, '-o', file,
    ...(platform === 'darwin' ? ['-framework', 'ApplicationServices'] : platform === 'win32' ? ['-ldwmapi', '-luser32', '-s'] : ['-ldl'])]
  const result = spawnSync(compiler, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Window geometry helper build failed for ${platform}-${arch}: ${result.error?.message ?? result.status}`)
  return { dir, file }
}
