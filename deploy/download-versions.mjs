#!/usr/bin/env node
// Writes site/downloads/versions.json: every installer published under /apk,
// with the size and SHA-256 the server holds, so the downloads page can offer
// any earlier version. Run after uploading a release and before deploy.sh.
//
//   DEPLOY_HOST=deploy@62.238.98.53 node deploy/download-versions.mjs
//
// A file already listed with the same size keeps its recorded hash; only new
// files are hashed on the server.
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const host = process.env.DEPLOY_HOST ?? 'deploy@62.238.98.53'
const root = process.env.DEPLOY_ROOT ?? '/var/www/kithmoot'
const output = fileURLToPath(new URL('../site/downloads/versions.json', import.meta.url))

/** What a published file is, from its name alone; undefined for anything that is not an installer. */
export function classify(path) {
  let match = /^desktop\/([^/]+)\/KithMoot-\1-(mac|linux|windows)-(arm64|x64)\.(zip|tar\.gz)$/.exec(path)
  if (match) {
    const [, version, os, arch, extension] = match
    const kind = os === 'linux' ? 'tarball' : os === 'mac' ? 'app' : 'portable'
    return { product: 'desktop', version, os, arch, kind, extension }
  }
  match = /^desktop\/([^/]+)\/kithmoot_\1_(amd64|arm64)\.deb$/.exec(path)
  if (match) return { product: 'desktop', version: match[1], os: 'linux', arch: match[2] === 'amd64' ? 'x64' : 'arm64', kind: 'deb', extension: 'deb' }
  match = /^kithmoot-(\d+\.\d+\.\d+)-(production|preview)\.apk$/.exec(path)
  if (match) return { product: 'android', version: match[1], os: 'android', arch: 'any', kind: match[2], extension: 'apk' }
  return undefined
}

export function compareVersions(a, b) {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

const ORDER = ['mac', 'windows', 'linux', 'android']
const KIND = ['deb', 'tarball', 'app', 'portable', 'production', 'preview']

export function manifest(entries) {
  const products = { desktop: new Map(), android: new Map() }
  for (const entry of entries) {
    const info = classify(entry.path)
    if (!info) continue
    const versions = products[info.product]
    const release = versions.get(info.version) ?? { version: info.version, published: entry.published, files: [] }
    if (entry.published < release.published) release.published = entry.published
    release.files.push({
      os: info.os, arch: info.arch, kind: info.kind,
      filename: entry.path.split('/').pop(), url: `/apk/${entry.path}`, bytes: entry.bytes, sha256: entry.sha256,
    })
    versions.set(info.version, release)
  }
  const list = map => [...map.values()].sort((a, b) => compareVersions(b.version, a.version)).map(release => ({
    ...release,
    files: release.files.sort((a, b) => ORDER.indexOf(a.os) - ORDER.indexOf(b.os) || KIND.indexOf(a.kind) - KIND.indexOf(b.kind) || a.arch.localeCompare(b.arch)),
  }))
  return { desktop: list(products.desktop), android: list(products.android) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const known = new Map()
  try {
    const previous = JSON.parse(await readFile(output, 'utf8'))
    for (const release of [...previous.desktop, ...previous.android]) for (const file of release.files) known.set(file.url, file)
  } catch {}
  const ssh = (script, input) => {
    const result = spawnSync('ssh', [host, script], { input, encoding: 'utf8', maxBuffer: 64 << 20 })
    if (result.status !== 0) throw new Error(`ssh failed: ${result.stderr}`)
    return result.stdout
  }
  // size, modification time and path of every candidate file
  const listing = ssh(`cd ${root}/apk && find desktop -type f \\( -name '*.zip' -o -name '*.tar.gz' -o -name '*.deb' \\) -printf '%s %T@ %p\\n'; find . -maxdepth 1 -type f -name 'kithmoot-*.apk' -printf '%s %T@ %P\\n'`)
  const entries = listing.trim().split('\n').map(line => {
    const [bytes, time, path] = line.split(' ')
    return { bytes: Number(bytes), published: new Date(Number(time) * 1000).toISOString().slice(0, 10), path }
  }).filter(entry => classify(entry.path))
  const unhashed = entries.filter(entry => known.get(`/apk/${entry.path}`)?.bytes !== entry.bytes)
  if (unhashed.length) {
    console.log(`Hashing ${unhashed.length} file(s) on ${host}`)
    const sums = ssh(`cd ${root}/apk && xargs -0 sha256sum`, unhashed.map(entry => entry.path).join('\0'))
    for (const line of sums.trim().split('\n')) {
      const [sha256, path] = line.split(/\s+/)
      known.set(`/apk/${path}`, { sha256, bytes: unhashed.find(entry => entry.path === path).bytes })
    }
  }
  for (const entry of entries) entry.sha256 = known.get(`/apk/${entry.path}`).sha256
  const result = manifest(entries)
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`${output}: ${result.desktop.length} desktop and ${result.android.length} Android versions`)
}
