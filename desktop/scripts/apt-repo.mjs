// The signed APT repository behind kithmoot.sources: a flat repository kept as
// the assets of one rolling GitHub release, tagged `apt`. Release assets cannot
// hold a slash, so there is no dists/ tree; apt reads InRelease, Packages and
// the .deb files straight from the release's download URL.
//
//   node scripts/apt-repo.mjs            index and sign out/kithmoot_<v>_*.deb into out/apt/
//   node scripts/apt-repo.mjs --publish  and upload them to the `apt` release
//
// The archive key lives in ~/.kithmoot-signing/apt (KITHMOOT_APT_HOME).
import { readFile, writeFile, mkdir, rm, copyFile, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
export const APT_REPOSITORY = 'forgesworn/kithmoot'
export const APT_TAG = 'apt'

/** Reads one member out of a Debian package's ar archive. */
export function arMember(archive, wanted) {
  if (archive.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new Error('Not an ar archive')
  let offset = 8
  while (offset + 60 <= archive.length) {
    const name = archive.subarray(offset, offset + 16).toString('latin1').trim().replace(/\/$/, '')
    const size = Number(archive.subarray(offset + 48, offset + 58).toString('latin1').trim())
    const start = offset + 60
    if (name === wanted || (wanted.endsWith('.') && name.startsWith(wanted))) return { name, data: archive.subarray(start, start + size) }
    offset = start + size + (size % 2)
  }
  throw new Error(`No ${wanted} in the package`)
}

/** The binary key inside a deb822 Signed-By field that holds an armoured block. */
export function embeddedKey(sources) {
  const lines = sources.split('\n').map(line => line.replace(/^ /, ''))
  const start = lines.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----')
  const end = lines.indexOf('-----END PGP PUBLIC KEY BLOCK-----')
  if (start < 0 || end < start) throw new Error('No armoured key in the sources file')
  const body = lines.slice(start + 1, end).filter(line => line && line !== '.' && !line.startsWith('=') && !line.includes(':'))
  return Buffer.from(body.join(''), 'base64')
}

const digest = (algorithm, data) => createHash(algorithm).update(data).digest('hex')

/** One Packages stanza: the package's own control fields, then where and what. */
export function packageStanza(control, deb, filename) {
  return `${control.trimEnd()}\nFilename: ./${filename}\nSize: ${deb.length}\nMD5sum: ${digest('md5', deb)}\nSHA1: ${digest('sha1', deb)}\nSHA256: ${digest('sha256', deb)}\n`
}

export function releaseFile(indices, date = new Date()) {
  const lines = [
    'Origin: KithMoot', 'Label: KithMoot', 'Suite: stable', 'Codename: stable',
    'Architectures: amd64 arm64', `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    'Description: KithMoot desktop for Debian, Ubuntu and their derivatives',
  ]
  for (const algorithm of ['MD5Sum', 'SHA1', 'SHA256']) {
    lines.push(`${algorithm}:`)
    const name = { MD5Sum: 'md5', SHA1: 'sha1', SHA256: 'sha256' }[algorithm]
    for (const [file, data] of indices) lines.push(` ${digest(name, data)} ${String(data.length).padStart(10)} ${file}`)
  }
  return `${lines.join('\n')}\n`
}

async function controlOf(debPath) {
  const member = arMember(await readFile(debPath), 'control.tar.')
  const scratch = await mkdtemp(join(tmpdir(), 'kithmoot-deb-'))
  const file = join(scratch, member.name)
  await writeFile(file, member.data)
  const result = spawnSync('tar', ['-xOf', file, './control'], { encoding: 'utf8' })
  await rm(scratch, { recursive: true, force: true })
  if (result.status !== 0) throw new Error(`Could not read the control file of ${debPath}`)
  return result.stdout
}

function gpg(home, args) {
  const result = spawnSync('gpg', ['--homedir', join(home, 'gnupg'), '--batch', '--yes', '--pinentry-mode', 'loopback',
    '--passphrase-file', join(home, 'passphrase'), ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.status !== 0) throw new Error(`gpg ${args[0]} failed`)
}

export async function buildRepository(debs, outDir) {
  const home = process.env.KITHMOOT_APT_HOME ?? join(homedir(), '.kithmoot-signing/apt')
  const fingerprint = (await readFile(join(home, 'fingerprint'), 'utf8')).trim()
  // The key the packages trust must be the key that signs.
  const signing = await readFile(join(home, 'kithmoot-archive-keyring.gpg'))
  if (!embeddedKey(await readFile(resolve(root, 'linux/kithmoot.sources'), 'utf8')).equals(signing)) throw new Error('linux/kithmoot.sources does not carry the signing key in KITHMOOT_APT_HOME')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const stanzas = []
  for (const deb of debs) {
    stanzas.push(packageStanza(await controlOf(deb), await readFile(deb), basename(deb)))
    await copyFile(deb, join(outDir, basename(deb)))
  }
  const packages = Buffer.from(stanzas.join('\n'))
  const packagesGz = gzipSync(packages, { level: 9 })
  await writeFile(join(outDir, 'Packages'), packages)
  await writeFile(join(outDir, 'Packages.gz'), packagesGz)
  await writeFile(join(outDir, 'Release'), releaseFile([['Packages', packages], ['Packages.gz', packagesGz]]))
  gpg(home, ['--local-user', fingerprint, '--digest-algo', 'SHA512', '--clearsign', '--output', join(outDir, 'InRelease'), join(outDir, 'Release')])
  gpg(home, ['--local-user', fingerprint, '--digest-algo', 'SHA512', '--armor', '--detach-sign', '--output', join(outDir, 'Release.gpg'), join(outDir, 'Release')])
  // For people who subscribe before installing: the same file the package ships, key included.
  await copyFile(resolve(root, 'linux/kithmoot.sources'), join(outDir, 'kithmoot.sources'))
  return outDir
}

function gh(args, options = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', ...options })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`gh ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

export function publishRepository(outDir, debs, version) {
  const exists = gh(['release', 'view', APT_TAG, '--repo', APT_REPOSITORY, '--json', 'assets'], { allowFailure: true })
  if (exists.status !== 0) {
    gh(['release', 'create', APT_TAG, '--repo', APT_REPOSITORY, '--target', 'main', '--latest=false',
      '--title', 'KithMoot for Debian and Ubuntu (APT repository)',
      '--notes', 'The signed APT repository for KithMoot desktop. Install the .deb once, or add kithmoot.sources and the keyring, and later releases arrive through your usual software updates. Not a release to download by hand.'])
  }
  const before = exists.status === 0 ? JSON.parse(exists.stdout).assets.map(asset => asset.name) : []
  const upload = files => gh(['release', 'upload', APT_TAG, '--repo', APT_REPOSITORY, '--clobber', ...files.map(name => join(outDir, name))], { stdio: 'inherit' })
  // Packages first, then the indices, InRelease last: apt never reads an
  // index naming a package that is not there yet.
  upload(debs.map(deb => basename(deb)))
  upload(['kithmoot.sources'])
  upload(['Packages', 'Packages.gz', 'Release', 'Release.gpg'])
  upload(['InRelease'])
  // Keep this release and the one before it; apt only offers the newest.
  const versions = [...new Set(before.map(name => /^kithmoot_(.+)_(?:amd64|arm64)\.deb$/.exec(name)?.[1]).filter(Boolean))]
  const keep = new Set([version, ...versions.filter(other => other !== version).sort(compareVersions).slice(-1)])
  for (const name of before) {
    const other = /^kithmoot_(.+)_(?:amd64|arm64)\.deb$/.exec(name)?.[1]
    if (other && !keep.has(other)) gh(['release', 'delete-asset', APT_TAG, name, '--repo', APT_REPOSITORY, '--yes'], { stdio: 'inherit' })
  }
}

export function compareVersions(a, b) {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const debs = ['amd64', 'arm64'].map(arch => resolve(root, `out/kithmoot_${version}_${arch}.deb`))
  const outDir = await buildRepository(debs, resolve(root, 'out/apt'))
  console.log(`Signed APT repository for ${version} in ${outDir}`)
  if (process.argv.includes('--publish')) {
    publishRepository(outDir, debs, version)
    console.log(`Published to https://github.com/${APT_REPOSITORY}/releases/tag/${APT_TAG}`)
  }
}
