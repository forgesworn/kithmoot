import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const script = new URL('./prune-releases.sh', import.meta.url).pathname
const roots = []

/** A scratch DEPLOY_ROOT holding `names` under releases/, each given the
 *  modification time in `mtimes` (seconds), and current pointing at `live`. */
function box(names, { mtimes = {}, live } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prune-releases-'))
  roots.push(root)
  for (const name of names) {
    const dir = join(root, 'releases', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), name)
    if (mtimes[name] !== undefined) utimesSync(dir, mtimes[name], mtimes[name])
  }
  if (live) symlinkSync(join(root, 'releases', live), join(root, 'current'))
  return root
}

function prune(root, keep) {
  const run = spawnSync('bash', [script, root, String(keep)], { encoding: 'utf8' })
  return { ...run, left: readdirSync(join(root, 'releases')).sort() }
}

const locked = []
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pruning old releases', () => {
  it('keeps the newest releases by their timestamp names, whatever their modification times say', () => {
    // A hand-placed page or a copy into an old release touches its directory,
    // and rsync gives a new one the staging tree's time. On 14 November 2026
    // `--prune 10` deleted the release deployed an hour before because of it.
    const names = ['20261114T120000Z', '20261114T130000Z', '20261114T140000Z', '20261114T150000Z']
    const root = box(names, {
      mtimes: { '20261114T120000Z': 4_000, '20261114T130000Z': 3_000, '20261114T140000Z': 1_000, '20261114T150000Z': 2_000 },
      live: '20261114T150000Z',
    })
    const run = prune(root, 2)
    expect(run.status).toBe(0)
    expect(run.left).toEqual(['20261114T140000Z', '20261114T150000Z'])
  })

  it('never removes the live release, even when it is past the count', () => {
    const names = ['20261110T000000Z', '20261111T000000Z', '20261112T000000Z', '20261113T000000Z']
    const root = box(names, { live: '20261110T000000Z' })
    const run = prune(root, 2)
    expect(run.status).toBe(0)
    expect(run.left).toEqual(['20261110T000000Z', '20261112T000000Z', '20261113T000000Z'])
  })

  it('leaves anything that is not a release directory alone', () => {
    const root = box(['20261112T000000Z', '20261113T000000Z', '20261114T000000Z', 'notes'], {
      mtimes: { notes: 1 }, live: '20261114T000000Z',
    })
    writeFileSync(join(root, 'releases', 'README'), 'by hand')
    const run = prune(root, 1)
    expect(run.status).toBe(0)
    expect(run.left).toEqual(['20261114T000000Z', 'README', 'notes'])
  })

  it.skipIf(process.getuid?.() === 0)('reports and keeps a release it cannot delete, and carries on', () => {
    // One a root deploy left behind: the site is already live, so this must
    // not fail the deploy.
    const root = box(['20261111T000000Z', '20261112T000000Z', '20261113T000000Z', '20261114T000000Z'], { live: '20261114T000000Z' })
    const stuck = join(root, 'releases', '20261112T000000Z', 'apk')
    mkdirSync(stuck)
    writeFileSync(join(stuck, 'old.apk'), 'x')
    chmodSync(stuck, 0o555)
    locked.push(stuck)
    const run = prune(root, 2)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('kept 20261112T000000Z')
    expect(run.left).toEqual(['20261112T000000Z', '20261113T000000Z', '20261114T000000Z'])
  })

  it('refuses a count below one', () => {
    const root = box(['20261113T000000Z', '20261114T000000Z'], { live: '20261114T000000Z' })
    const run = prune(root, 0)
    expect(run.status).not.toBe(0)
    expect(run.left).toEqual(['20261113T000000Z', '20261114T000000Z'])
  })
})
