/** Real Git fixtures exercise the consumer/component publication boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { visionSource } from './build-vision-lab.mjs'

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (root, message) => git(root, '-c', 'user.name=Vision fixture', '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false', 'commit', '-qm', message)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kithmoot-vision-pin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-q')
  const vision = join(root, 'vision'); await mkdir(vision); git(vision, 'init', '-q')
  await writeFile(join(vision, 'source.txt'), 'owned component\n')
  await writeFile(join(vision, '.gitignore'), 'data/\n')
  git(vision, 'add', '.'); commit(vision, 'Initial component')
  const pin = git(vision, 'rev-parse', 'HEAD')
  await writeFile(join(root, '.gitmodules'), '[submodule "vision"]\n\tpath = vision\n\turl = https://example.invalid/vision.git\n')
  await writeFile(join(root, 'host.txt'), 'consumer\n')
  git(root, 'add', '.gitmodules', 'host.txt')
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${pin},vision`)
  commit(root, 'Pin component')
  return { root, vision, pin }
}

test('consumer records distinct committed host/component revisions and ignores local review data', async t => {
  const { root, vision, pin } = await fixture(t)
  await mkdir(join(vision, 'data')); await writeFile(join(vision, 'data/review.json'), 'local only')
  const source = visionSource(root)
  assert.equal(source.revision, git(root, 'rev-parse', 'HEAD'))
  assert.equal(source.visionRevision, pin)
  assert.notEqual(source.revision, source.visionRevision)
})
test('a newer component checkout cannot silently replace the committed pin', async t => {
  const { root, vision } = await fixture(t)
  await writeFile(join(vision, 'source.txt'), 'new component\n'); git(vision, 'add', 'source.txt'); commit(vision, 'Next component')
  assert.throws(() => visionSource(root), /differs from the commit pinned/)
})
test('tracked component edits refuse a publishable preview', async t => {
  const { root, vision } = await fixture(t)
  await writeFile(join(vision, 'source.txt'), 'uncommitted change\n')
  assert.throws(() => visionSource(root), /Vision sources have tracked changes/)
})
test('tracked host edits refuse a publishable preview', async t => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'host.txt'), 'uncommitted host\n')
  assert.throws(() => visionSource(root), /KithMoot sources have tracked changes/)
})
