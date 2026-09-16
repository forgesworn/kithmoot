import { packager } from '@electron/packager'
import { readFile, copyFile, chmod, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
for (const arch of ['x64', 'arm64']) {
  const [directory] = await packager({
    dir: root, out: resolve(root, 'out'), name: 'KithMoot', executableName: 'kithmoot',
    platform: 'linux', arch, electronVersion: '44.4.1', appVersion: version,
    overwrite: true, asar: true,
    ignore: [/^\/out($|\/)/, /^\/artifacts($|\/)/, /^\/test-results($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/README.md$/],
  })
  await copyFile(resolve(root, '../app/public/pwa-512x512.png'), resolve(directory, 'kithmoot.png'))
  await copyFile(resolve(root, 'scripts/install-linux.py'), resolve(directory, 'install.py'))
  await chmod(resolve(directory, 'install.py'), 0o755)
  await writeFile(resolve(directory, 'README.txt'), `KithMoot ${version} - Linux ${arch}\n\nExtract this folder, then run: python3 install.py\nInstalls for your user only, without sudo, and adds KithMoot to Applications.\nRequires a current desktop Linux with glibc, GTK3, NSS, ALSA and a notification service.\nRun kithmoot directly from this folder for a portable preview.\nDo not disable Chromium's sandbox. Your distro must allow unprivileged user namespaces.\nDock counts require a launcher supporting LauncherEntry (such as KDE or Ubuntu Dock).\nThe window title also shows the count. GNOME setups may need a dock extension.\nEnable notifications in KithMoot's notification controls; previews are private by default.\nZen bell has its own switch and Preview sound button. Bells are muted during calls.\nKeep KithMoot open or minimised to receive notifications. Quitting stops delivery.\nQuiet rooms are read only while open. Updates are manual.\nLocal preview; packages are not repository-signed.\n`)
  const archive = resolve(root, `out/KithMoot-${version}-linux-${arch}.tar.gz`)
  const result = spawnSync('tar', ['-czf', archive, '-C', resolve(directory, '..'), directory.split('/').pop()], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Archive failed')
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
  await writeFile(`${archive}.sha256`, `${hash}  ${archive.split('/').pop()}\n`)
  console.log(`${hash}  ${archive}`)
}
