// Debian package for any current Debian or Ubuntu derivative, x64 and ARM64.
// Installs to /opt/KithMoot, adds the signed KithMoot APT source so the
// system's software updater carries every later release, and never reads or
// writes the profile in ~/.config/KithMoot.
import { cp, mkdir, readFile, rm, stat, symlink, writeFile, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const linux = resolve(root, 'linux')
export const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }
export const DESKTOP_ID = 'dev.forgesworn.kithmoot.desktop'

// The t64 names are what Ubuntu 24.04 and Debian 13 call these libraries;
// older releases keep the plain names. The t64 name comes first: on Ubuntu
// 24.04 the plain libasound2 is only a virtual package, and apt fills it with
// an OSS stub that lacks the ALSA symbols Chromium needs.
export const DEPENDS = [
  'libgtk-3-0t64 | libgtk-3-0', 'libnss3', 'libasound2t64 | libasound2', 'libgbm1',
  'libatspi2.0-0t64 | libatspi2.0-0', 'libcups2t64 | libcups2', 'libdrm2', 'libxkbcommon0',
  'libxcomposite1', 'libxdamage1', 'libxrandr2', 'libxtst6', 'libxss1', 'libnotify4',
  'libsecret-1-0', 'libuuid1', 'xdg-utils', 'ca-certificates',
]

export function controlFile({ version, arch, installedKiB }) {
  return [
    'Package: kithmoot',
    `Version: ${version}`,
    `Architecture: ${DEB_ARCH[arch]}`,
    'Maintainer: ForgeSworn <https://github.com/forgesworn/kithmoot/issues>',
    `Installed-Size: ${installedKiB}`,
    `Depends: ${DEPENDS.join(', ')}`,
    'Section: net',
    'Priority: optional',
    'Homepage: https://kithmoot.forgesworn.dev',
    'Description: Private rooms, chat and calls',
    ' KithMoot is an open, serverless workspace built on Nostr: rooms, chat,',
    ' files and calls, with no operator holding the guest list.',
    ' .',
    ' Installing this package adds the signed KithMoot APT source, so later',
    ' releases arrive through your usual software updates.',
    '',
  ].join('\n')
}

export function desktopEntry() {
  return [
    '[Desktop Entry]', 'Type=Application', 'Name=KithMoot', 'Comment=Private rooms, chat and calls',
    'Exec=/opt/KithMoot/kithmoot', 'Icon=kithmoot', 'Terminal=false',
    'Categories=Network;InstantMessaging;', 'StartupWMClass=KithMoot', '',
  ].join('\n')
}

async function sizeKiB(path) {
  const info = await lstat(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const name of await readdir(path)) total += await sizeKiB(join(path, name))
  return total
}

function dpkgDeb(stage, output) {
  // Inside a container the modes and root ownership are set where they are
  // real, whatever the host's filesystem makes of a setuid bit.
  const script = [
    'set -e', 'cp -a /in/stage /tmp/stage', 'cd /tmp/stage',
    'chown -R root:root .',
    'find . -type d -exec chmod 0755 {} +',
    'find . -type f -exec chmod go-w,a+r {} +',
    'chmod 0755 DEBIAN/postinst DEBIAN/postrm opt/KithMoot/kithmoot opt/KithMoot/chrome_crashpad_handler',
    'chmod 0644 DEBIAN/control DEBIAN/conffiles',
    // Chromium falls back to the setuid sandbox where user namespaces are
    // refused; Google Chrome's own package ships it the same way.
    'chmod 4755 opt/KithMoot/chrome-sandbox',
    "find . -path ./DEBIAN -prune -o -type f -printf '%P\\0' | xargs -0 md5sum > DEBIAN/md5sums",
    'chmod 0644 DEBIAN/md5sums',
    `dpkg-deb --build -Zxz /tmp/stage /out/${output.split('/').pop()}`,
  ].join(' && ')
  const result = spawnSync('docker', ['run', '--rm', '-v', `${stage}:/in/stage:ro`, '-v', `${resolve(output, '..')}:/out`, 'debian:bookworm-slim', 'sh', '-c', script], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`dpkg-deb failed for ${output}; the package is built in Docker, so Docker must be running`)
}

export async function buildDeb({ source, arch, version, outDir = resolve(root, 'out') }) {
  const stage = resolve(outDir, `deb-stage-${DEB_ARCH[arch]}`)
  await rm(stage, { recursive: true, force: true })
  const app = join(stage, 'opt/KithMoot')
  await mkdir(join(stage, 'DEBIAN'), { recursive: true })
  // install.py and README.txt belong to the tarball, not to a package.
  await cp(source, app, { recursive: true, verbatimSymlinks: true, filter: path => !['install.py', 'README.txt'].includes(relative(source, path)) })
  await writeFile(join(app, 'resources/kithmoot-version'), `${version}\n`)
  await cp(join(linux, 'apparmor-profile'), join(app, 'resources/apparmor-profile'))
  await mkdir(join(stage, 'usr/bin'), { recursive: true })
  await symlink('../../opt/KithMoot/kithmoot', join(stage, 'usr/bin/kithmoot'))
  await mkdir(join(stage, 'usr/share/applications'), { recursive: true })
  await writeFile(join(stage, 'usr/share/applications', DESKTOP_ID), desktopEntry())
  await mkdir(join(stage, 'usr/share/icons/hicolor/512x512/apps'), { recursive: true })
  await cp(resolve(root, '../app/public/pwa-512x512.png'), join(stage, 'usr/share/icons/hicolor/512x512/apps/kithmoot.png'))
  await mkdir(join(stage, 'usr/share/keyrings'), { recursive: true })
  await cp(join(linux, 'kithmoot-archive-keyring.gpg'), join(stage, 'usr/share/keyrings/kithmoot-archive-keyring.gpg'))
  // A conffile: someone who deletes the source stays unsubscribed on upgrade.
  await mkdir(join(stage, 'etc/apt/sources.list.d'), { recursive: true })
  await cp(join(linux, 'kithmoot.sources'), join(stage, 'etc/apt/sources.list.d/kithmoot.sources'))
  await writeFile(join(stage, 'DEBIAN/conffiles'), '/etc/apt/sources.list.d/kithmoot.sources\n')
  await cp(join(linux, 'postinst'), join(stage, 'DEBIAN/postinst'))
  await cp(join(linux, 'postrm'), join(stage, 'DEBIAN/postrm'))
  const installedKiB = Math.ceil((await sizeKiB(join(stage, 'opt')) + await sizeKiB(join(stage, 'usr')) + await sizeKiB(join(stage, 'etc'))) / 1024)
  await writeFile(join(stage, 'DEBIAN/control'), controlFile({ version, arch, installedKiB }))
  const output = resolve(outDir, `kithmoot_${version}_${DEB_ARCH[arch]}.deb`)
  await rm(output, { force: true })
  dpkgDeb(stage, output)
  await rm(stage, { recursive: true, force: true })
  const hash = createHash('sha256').update(await readFile(output)).digest('hex')
  await writeFile(`${output}.sha256`, `${hash}  ${output.split('/').pop()}\n`)
  console.log(`${hash}  ${output} (${((await stat(output)).size / 1048576).toFixed(0)} MiB)`)
  return output
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  for (const arch of ['x64', 'arm64']) await buildDeb({ source: resolve(root, `out/KithMoot-linux-${arch}`), arch, version })
}
