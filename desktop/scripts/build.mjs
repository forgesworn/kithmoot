import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const run = (cmd, args, env = {}) => {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('npm', ['run', 'build:context'])
run(resolve(root, 'node_modules/.bin/vite'), ['build', '--config', 'app/vite.config.ts'], { VITE_DESKTOP: 'true' })
