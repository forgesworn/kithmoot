#!/usr/bin/env node
// Keep the server's download volume from filling: the newest versions stay on
// the server, older ones are downloaded from their identical GitHub releases.
// Rules in deploy/download-retention.mjs. Two steps, a deploy apart, so no
// link ever points at a file that has gone:
//
// 1. Plan, then commit and deploy site/downloads/versions.json:
//      node deploy/retire-downloads.mjs --keep 10
//    Versions older than the newest 10 (desktop and Android each) link to
//    their GitHub release when every file there has the same size and SHA-256.
//    Needs an authenticated `gh`.
//
// 2. Once that versions.json is live, delete the server copies it no longer
//    links:
//      DEPLOY_HOST=deploy@62.238.98.53 node deploy/retire-downloads.mjs --remove
//    reads the live versions.json, release.json and android-release.json and
//    prints what it would delete; add --yes to delete.
//
// An old version with no identical GitHub copy can be dropped outright:
// `--drop desktop:0.1.84,0.1.85 --drop android:0.6.1` in step 1 takes it out
// of versions.json, and the same flags in step 2 delete its server copy once
// the live list no longer names it. Never one of the newest --keep, nor the
// version a manifest offers now.
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { REPOS, dropVersions, planRetirement, removablePaths } from './download-retention.mjs'

const host = process.env.DEPLOY_HOST ?? 'deploy@62.238.98.53'
const root = process.env.DEPLOY_ROOT ?? '/var/www/kithmoot'
const origin = process.env.SITE_ORIGIN ?? 'https://kithmoot.app'
const site = new URL('../site/', import.meta.url)
const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

/** Every `--drop product:v1,v2` given, as `{ desktop: [...], android: [...] }`. */
function dropList() {
  const drop = { desktop: [], android: [] }
  args.forEach((arg, index) => {
    if (arg !== '--drop') return
    const [product, list = ''] = String(args[index + 1] ?? '').split(':')
    if (!(product in drop) || !list) throw new Error(`--drop takes desktop:<versions> or android:<versions>, got ${args[index + 1]}`)
    drop[product].push(...list.split(',').filter(Boolean))
  })
  return drop
}

async function plan() {
  const keep = Number(option('--keep') ?? 10)
  const path = fileURLToPath(new URL('downloads/versions.json', site))
  const versions = JSON.parse(await readFile(path, 'utf8'))
  const current = {
    desktop: JSON.parse(await readFile(new URL('downloads/release.json', site), 'utf8')).version,
    android: JSON.parse(await readFile(new URL('android-release.json', site), 'utf8')).versionName,
  }
  const assets = (product, version) => {
    const result = spawnSync('gh', ['api', `repos/${REPOS[product]}/releases/tags/v${version}`, '--jq', '[.assets[] | {name, size, digest}]'], { encoding: 'utf8' })
    if (result.status !== 0) return undefined
    return JSON.parse(result.stdout)
  }
  const planned = planRetirement(versions, { keep, assets, current })
  const { versions: next, dropped } = dropVersions(planned.versions, { keep, drop: dropList(), current })
  const { retired, stays } = planned
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
  for (const product of ['desktop', 'android']) {
    console.log(`${product}: ${retired[product].length} newly linked to GitHub${retired[product].length ? ` (${retired[product].join(' ')})` : ''}`)
    if (dropped[product].length) console.log(`${product}: dropped from the list: ${dropped[product].join(' ')}`)
    const left = stays[product].filter(version => !dropped[product].includes(version))
    if (left.length) console.log(`${product}: kept on the server, no identical GitHub copy: ${left.join(' ')}`)
  }
  console.log(`Wrote ${path}. Commit and deploy it, then run --remove.`)
}

async function remove() {
  const fetchJson = async name => {
    const response = await fetch(new URL(name, origin), { cache: 'no-store' })
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
    return response.json()
  }
  const live = await fetchJson('/downloads/versions.json')
  const current = { desktop: (await fetchJson('/downloads/release.json')).version, android: (await fetchJson('/android-release.json')).versionName }
  const paths = removablePaths(live, current, dropList())
  // On the server: each path under apk/, followed through a version folder's
  // link to the volume it lives on, and only ever a folder named for its
  // version or an APK named for its version. Anything else is skipped.
  const script = `set -u
cd ${root}/apk || exit 1
total=0
while IFS= read -r p; do
  case "$p" in desktop/[0-9]*.[0-9]*.[0-9]*|kithmoot-[0-9]*.[0-9]*.[0-9]*-production.apk|kithmoot-[0-9]*.[0-9]*.[0-9]*-preview.apk) ;; *) echo "skip $p"; continue ;; esac
  [ -e "$p" ] || continue
  target=$(readlink -f -- "$p")
  case "$target" in /opt/bulk/kithmoot-delivery-*/*/*|${root}/*/*) ;; *) echo "skip $p -> $target"; continue ;; esac
  [ "$(basename -- "$target")" = "$(basename -- "$p")" ] || { echo "skip $p -> $target"; continue; }
  size=$(du -sk -- "$target" | cut -f1)
  # A folder or file this user cannot delete (one uploaded as root) stays,
  # and says so: rm -rf leaves it in place without failing the loop.
  blocked=
  [ -w "$(dirname -- "$target")" ] || blocked=yes
  [ -d "$target" ] && [ ! -w "$target" ] && blocked=yes
  if [ -n "$blocked" ]; then echo "kept $p: not removable by $(id -un)"; continue; fi
  if [ "$DO" = yes ]; then
    rm -rf -- "$target" 2>/dev/null
    if [ -e "$target" ]; then echo "kept $p: not removable by $(id -un)"; continue; fi
    [ -L "$p" ] && rm -f -- "$p"; echo "removed $p ($((size / 1024)) MiB)"
  else echo "would remove $p ($((size / 1024)) MiB)"; fi
  total=$((total + size))
done
echo "total $((total / 1024 / 1024)) GiB"`
  const run = spawnSync('ssh', [host, `DO=${args.includes('--yes') ? 'yes' : 'no'} sh -c '${script.replace(/'/g, `'\\''`)}'`], { input: paths.join('\n') + '\n', encoding: 'utf8' })
  process.stdout.write(run.stdout)
  if (run.status !== 0) throw new Error(`ssh failed: ${run.stderr}`)
  if (!args.includes('--yes')) console.log('Nothing deleted. Add --yes to delete.')
}

if (args.includes('--remove')) await remove()
else await plan()
