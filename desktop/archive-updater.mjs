import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { MANIFESTS, UPDATE_KEYS, archiveFor, archiveUrl, boundedDigest, desktopUpdate, verifyManifest } from './update-manifest.mjs'

/**
 * Updates for the copies nothing else updates: the Windows ZIP and the Linux
 * tarball. The Mac has Squirrel and the Debian package has apt.
 *
 * Nothing the download server says is taken on trust. The manifest must carry
 * a signature by a key built into this app (update-manifest.mjs); the archive
 * must then match the size and SHA-256 the signed manifest gives, counted as
 * it streams in and cut off the moment it runs long. Only then is it unpacked,
 * beside the installed folder, and swapped in when the person restarts.
 *
 * Same surface as createDesktopUpdater, so the restart prompt and its
 * active-call and unsent-work gates carry over unchanged.
 */

export const UPDATE_ORIGIN = 'https://kithmoot.forgesworn.dev'
const MAX_MANIFEST_BYTES = 64 * 1024
const genericError = 'Could not check for updates. KithMoot will try again.'
const unverified = 'An update was offered that KithMoot could not verify, so it was not installed.'

/** The folder an archive unpacks to, and the executable inside it. */
const layout = (platform, arch) => platform === 'win32'
  ? { folder: `KithMoot-win32-${arch}`, executable: 'KithMoot.exe' }
  : { folder: `KithMoot-linux-${arch}`, executable: 'kithmoot' }

/** Paths the updater owns beside the installed folder. */
export const sidePaths = (installDir, version) => ({
  backup: `${installDir}.previous`,
  unpack: version ? `${installDir}.update-${version}` : undefined,
})

/** Waits for KithMoot to exit, swaps the unpacked folder in, restarts it, and
 *  puts the old folder back if the swap fails. Antivirus and Chromium's
 *  helper processes can hold files for a moment after exit, hence the retries. */
export const WINDOWS_SWAP = `param([int]$WaitPid, [string]$Target, [string]$Staged, [string]$Backup)
$exe = Join-Path $Target 'KithMoot.exe'
try { Wait-Process -Id $WaitPid -Timeout 120 -ErrorAction SilentlyContinue } catch {}
$moved = $false
for ($i = 0; $i -lt 60 -and -not $moved; $i++) {
  try { Move-Item -LiteralPath $Target -Destination $Backup -ErrorAction Stop; $moved = $true } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $moved) { Start-Process -FilePath $exe; exit 1 }
try { Move-Item -LiteralPath $Staged -Destination $Target -ErrorAction Stop }
catch { Move-Item -LiteralPath $Backup -Destination $Target; Start-Process -FilePath $exe; exit 1 }
Start-Process -FilePath $exe
`

const writable = path => { try { accessSync(path, constants.W_OK); return true } catch { return false } }

const defaultExtract = platform => (archive, destination) => {
  const tar = platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : (existsSync('/usr/bin/tar') ? '/usr/bin/tar' : '/bin/tar')
  const args = platform === 'win32' ? ['-xf', archive, '-C', destination] : ['-xzf', archive, '-C', destination, '--no-same-owner']
  const result = spawnSync(tar, args, { stdio: 'ignore', windowsHide: true })
  if (result.status !== 0) throw new Error('the update archive could not be unpacked')
}

export function createArchiveUpdater({
  platform,
  arch,
  packaged,
  currentVersion,
  installDir,
  updatesDir,
  fetch,
  pid = process.pid,
  quit = () => {},
  relaunch = () => {},
  extract = defaultExtract(platform),
  spawn = nodeSpawn,
  fs = { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream },
  isWritable = writable,
  origin = UPDATE_ORIGIN,
  keys = UPDATE_KEYS,
  notify = () => {},
  log = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  initialDelayMs = 30_000,
  intervalMs = 60 * 60_000,
}) {
  const { folder, executable } = layout(platform, arch)
  const enabled = Boolean(packaged && archiveFor(platform, arch, '0.0.0') && installDir && updatesDir
    && basename(installDir) !== '' && fs.existsSync(join(installDir, executable))
    && isWritable(installDir) && isWritable(dirname(installDir)))
  let current = { phase: enabled ? 'idle' : 'disabled' }
  let started = false
  let busy = false
  let staged
  let initialTimer
  let intervalTimer
  let installRequested = false

  const state = () => ({ ...current })
  const transition = (phase, details = {}) => { current = { phase, ...details }; notify(state()) }
  const clearTimers = () => {
    if (initialTimer !== undefined) clearTimeoutFn(initialTimer)
    if (intervalTimer !== undefined) clearIntervalFn(intervalTimer)
    initialTimer = intervalTimer = undefined
  }

  const small = async url => {
    const response = await fetch(url)
    if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`)
    // Counted as it arrives: a server answering with gigabytes must not
    // get them all held in memory before anything checks the size.
    const chunks = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > MAX_MANIFEST_BYTES) throw new Error('manifest is too large')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  /** Streams `url` to `path`, refusing anything that is not exactly `bytes`
   *  long with SHA-256 `sha256`. Deletes what it wrote on any failure. */
  const download = async (url, path, { bytes, sha256 }) => {
    const response = await fetch(url)
    if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`)
    const digest = boundedDigest(bytes)
    const out = fs.createWriteStream(path, { mode: 0o600 })
    const closed = new Promise((resolve, reject) => { out.on('close', resolve); out.on('error', reject) })
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        digest.update(buffer)
        if (!out.write(buffer)) await new Promise(resolve => out.once('drain', resolve))
      }
      out.end()
      await closed
      const got = digest.finish()
      if (got.bytes !== bytes || got.sha256 !== sha256) throw new Error('download does not match the signed manifest')
    } catch (error) {
      out.destroy()
      await closed.catch(() => {})
      fs.rmSync(path, { force: true })
      throw error
    }
  }

  const check = async () => {
    if (!enabled || !started || busy || current.phase === 'ready') return false
    busy = true
    transition('checking')
    try {
      const url = `${origin}/${MANIFESTS.desktop}`
      const [manifest, signature] = await Promise.all([small(url), small(`${url}.sig`)])
      if (!verifyManifest(MANIFESTS.desktop, manifest, signature, keys)) {
        log(new Error('update manifest signature did not verify'))
        transition('error', { message: unverified })
        return false
      }
      const update = desktopUpdate(manifest, { currentVersion, platform, arch })
      if (!update) { transition('idle'); return false }
      transition('downloading', { version: update.version })
      fs.mkdirSync(updatesDir, { recursive: true })
      const archive = join(updatesDir, update.filename)
      fs.rmSync(archive, { force: true })
      try {
        await download(archiveUrl(origin, update.version, update.filename), archive, update)
      } catch (error) {
        if (/signed manifest|larger than/.test(error?.message ?? '')) {
          log(error)
          transition('error', { message: unverified })
          return false
        }
        throw error
      }
      const { unpack } = sidePaths(installDir, update.version)
      fs.rmSync(unpack, { recursive: true, force: true })
      fs.mkdirSync(unpack, { recursive: true })
      try {
        extract(archive, unpack)
        const entries = fs.readdirSync(unpack)
        const app = join(unpack, folder)
        if (entries.length !== 1 || entries[0] !== folder || !fs.statSync(app).isDirectory()
          || !fs.existsSync(join(app, executable)) || !fs.existsSync(join(app, 'resources', 'app.asar'))) {
          throw new Error('the update archive does not hold a KithMoot folder')
        }
        staged = app
      } catch (error) {
        fs.rmSync(unpack, { recursive: true, force: true })
        throw error
      } finally {
        fs.rmSync(archive, { force: true })
      }
      clearTimers()
      transition('ready', { version: update.version })
      return true
    } catch (error) {
      log(error instanceof Error ? error : new Error('Unknown updater error'))
      transition('error', { message: genericError })
      return false
    } finally {
      busy = false
    }
  }

  const install = () => {
    if (current.phase !== 'ready' || !staged || installRequested) return false
    installRequested = true
    const { backup } = sidePaths(installDir)
    try {
      if (platform === 'win32') {
        // A running executable's folder cannot be moved on Windows, so a
        // helper does the swap once this process has gone.
        const script = join(updatesDir, 'swap.ps1')
        fs.writeFileSync(script, WINDOWS_SWAP)
        fs.rmSync(backup, { recursive: true, force: true })
        const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
          '-WaitPid', String(pid), '-Target', installDir, '-Staged', staged, '-Backup', backup], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref?.()
        quit()
      } else {
        // Linux lets a running app's folder be renamed; this process keeps
        // its open files, and the restart runs the new copy.
        fs.rmSync(backup, { recursive: true, force: true })
        fs.renameSync(installDir, backup)
        try { fs.renameSync(staged, installDir) }
        catch (error) { fs.renameSync(backup, installDir); throw error }
        relaunch(join(installDir, executable))
      }
      return true
    } catch (error) {
      installRequested = false
      log(error instanceof Error ? error : new Error('Unknown updater install error'))
      transition('error', { message: 'The update could not restart KithMoot. Try again.' })
      return false
    }
  }

  /** Removes what an earlier update left beside the installed folder: the
   *  previous copy once this one runs, and any unpacked update not taken. */
  const cleanup = () => {
    const parent = dirname(installDir)
    const prefix = `${basename(installDir)}.`
    for (const name of fs.readdirSync(parent)) {
      if (name === `${prefix}previous` || (name.startsWith(`${prefix}update-`) && /^\d+\.\d+\.\d+$/.test(name.slice(`${prefix}update-`.length)))) {
        fs.rmSync(join(parent, name), { recursive: true, force: true })
      }
    }
  }

  const start = () => {
    if (!enabled || started) return false
    started = true
    try { cleanup() } catch (error) { log(error) }
    transition('idle')
    initialTimer = setTimeoutFn(() => {
      initialTimer = undefined
      check()
      if (current.phase !== 'ready') intervalTimer = setIntervalFn(check, intervalMs)
    }, initialDelayMs)
    return true
  }

  return Object.freeze({ start, check, install, state })
}
