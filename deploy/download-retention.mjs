// Which published installers the server keeps, and where the rest are
// downloaded from. The server's download volume holds every version ever
// published unless something retires them (11 November 2026 it filled up).
//
// The newest `keep` desktop and Android versions stay on the server. An older
// version moves to its GitHub release only when every one of its files is
// there with the same size and SHA-256 (GitHub's asset digest): its entry in
// versions.json then links to GitHub and the server copy can go. An older
// version with no identical GitHub copy stays on the server, unless it is
// named to be dropped: it then leaves versions.json, and its server copy can
// go once the live list no longer names it.
//
// Pure, so the rules can be tested without a server or GitHub.

const VERSION = /^\d+\.\d+\.\d+$/
export const REPOS = { desktop: 'forgesworn/kithmoot', android: 'forgesworn/kithmoot-android' }

/** A GitHub release download URL for one file of a version. */
export function githubUrl(product, version, filename) {
  return `https://github.com/${REPOS[product]}/releases/download/v${version}/${encodeURIComponent(filename)}`
}

/** True when every file of a release is served from its GitHub release. */
export function onGithub(release) {
  return release.files.length > 0 && release.files.every(file => file.url.startsWith(`https://github.com/forgesworn/`))
}

/** True when every file of a release is served by this server. */
export function onServer(release) {
  return release.files.length > 0 && release.files.every(file => file.url.startsWith('/apk/'))
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

/**
 * Add back the versions an earlier versions.json linked to GitHub, which a
 * listing of the server no longer finds. A version the server still holds
 * keeps its server entry.
 */
export function keepRetired(result, previous) {
  const out = { desktop: [...result.desktop], android: [...result.android] }
  for (const product of ['desktop', 'android']) {
    const listed = new Set(out[product].map(release => release.version))
    for (const release of previous?.[product] ?? []) {
      if (!listed.has(release.version) && onGithub(release)) out[product].push(release)
    }
    out[product].sort((a, b) => compareVersions(b.version, a.version))
  }
  return out
}

/**
 * What to retire. `assets(product, version)` gives the GitHub release's assets
 * as `{ name, size, digest }` (digest `sha256:<hex>`), or undefined when there
 * is no release. `current` names the version each manifest offers now, which
 * is never retired whatever `keep` says.
 *
 * Returns the new versions.json, the versions retired, and the older versions
 * kept on the server because GitHub has no identical copy.
 */
export function planRetirement(versions, { keep, assets, current = {} }) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('keep at least one version on the server')
  const next = { desktop: [], android: [] }
  const retired = { desktop: [], android: [] }
  const stays = { desktop: [], android: [] }
  for (const product of ['desktop', 'android']) {
    const releases = [...versions[product]].sort((a, b) => compareVersions(b.version, a.version))
    releases.forEach((release, index) => {
      const old = index >= keep && release.version !== current[product]
      if (!old || !onServer(release) || !VERSION.test(release.version)) { next[product].push(release); return }
      const held = assets(product, release.version)
      const byName = new Map((held ?? []).map(asset => [asset.name, asset]))
      const identical = !!held && release.files.every(file => {
        const asset = byName.get(file.filename)
        return !!asset && asset.size === file.bytes && asset.digest === `sha256:${file.sha256}`
      })
      if (!identical) { stays[product].push(release.version); next[product].push(release); return }
      retired[product].push(release.version)
      next[product].push({ ...release, files: release.files.map(file => ({ ...file, url: githubUrl(product, release.version, file.filename) })) })
    })
  }
  return { versions: next, retired, stays }
}

function checkVersions(drop) {
  for (const product of ['desktop', 'android']) {
    for (const version of drop?.[product] ?? []) if (!VERSION.test(version)) throw new Error(`${product}: not a version: ${version}`)
  }
}

/**
 * Unlist old versions named in `drop` (`{ desktop: [...], android: [...] }`),
 * for versions with no identical GitHub copy that are no longer worth
 * offering. Refuses one of the newest `keep` and the version a manifest
 * offers now. A version not listed is no error.
 */
export function dropVersions(versions, { drop, keep, current = {} }) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('keep at least one version on the server')
  checkVersions(drop)
  const next = { ...versions }
  const dropped = { desktop: [], android: [] }
  for (const product of ['desktop', 'android']) {
    const named = new Set(drop?.[product] ?? [])
    if (current[product] && named.has(current[product])) throw new Error(`${product} ${current[product]} is the version a manifest offers now`)
    const releases = [...(versions[product] ?? [])].sort((a, b) => compareVersions(b.version, a.version))
    const kept = releases.slice(0, keep).filter(release => named.has(release.version))
    if (kept.length) throw new Error(`${product} ${kept.map(r => r.version).join(' ')} is among the newest ${keep}`)
    next[product] = releases.filter(release => {
      if (!named.has(release.version)) return true
      dropped[product].push(release.version)
      return false
    })
  }
  return { versions: next, dropped }
}

/**
 * The server paths a live versions.json no longer links, for versions it
 * sends to GitHub: a desktop version's folder, an Android version's APKs.
 * With `drop`, also those of the dropped versions the live list no longer
 * names. Never the version a live manifest offers now, nor a newer one.
 */
export function removablePaths(live, current = {}, drop = {}) {
  checkVersions(drop)
  const paths = []
  for (const release of live.desktop ?? []) {
    if (onGithub(release) && VERSION.test(release.version) && release.version !== current.desktop) paths.push(`desktop/${release.version}`)
  }
  for (const release of live.android ?? []) {
    if (!onGithub(release) || !VERSION.test(release.version) || release.version === current.android) continue
    for (const file of release.files) if (/^kithmoot-\d+\.\d+\.\d+-(production|preview)\.apk$/.test(file.filename)) paths.push(file.filename)
  }
  for (const product of ['desktop', 'android']) {
    const listed = new Set((live[product] ?? []).map(release => release.version))
    for (const version of drop[product] ?? []) {
      if (listed.has(version) || !current[product] || compareVersions(version, current[product]) >= 0) continue
      if (product === 'desktop') paths.push(`desktop/${version}`)
      else paths.push(`kithmoot-${version}-production.apk`, `kithmoot-${version}-preview.apk`)
    }
  }
  return paths
}
