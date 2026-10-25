import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const verifier = join(root, 'deploy/verify-android-publication.mjs')
const site = join(root, 'site/index.html')
const original = JSON.parse(readFileSync(join(root, 'site/android-release.json'), 'utf8'))
let directory

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kithmoot-android-manifest-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function verify(releaseNotes, include = true) {
  const publication = { ...original }
  if (include) publication.releaseNotes = releaseNotes
  else delete publication.releaseNotes
  const manifest = join(directory, 'android-release.json')
  writeFileSync(manifest, JSON.stringify(publication, null, 2) + '\n')
  return spawnSync(process.execPath, [verifier, '--manifest', manifest, '--site', site], { cwd: root, encoding: 'utf8' })
}

describe('Android publication release notes', () => {
  it('accepts an older manifest without notes', () => {
    expect(verify(undefined, false).status).toBe(0)
  })

  it('accepts two notes', () => {
    expect(verify(['Loudspeaker control in calls.', 'Unread chats open at the latest message.']).status).toBe(0)
  })

  it('accepts three notes', () => {
    expect(verify(['One improvement.', 'Another improvement.', 'A third improvement.']).status).toBe(0)
  })

  for (const [name, notes] of [
    ['null', null],
    ['not an array', 'two'],
    ['empty', []],
    ['only one', ['Only one.']],
    ['more than three', ['One.', 'Two.', 'Three.', 'Four.']],
    ['non-string entries', [1, 2]],
    ['blank entries', ['', 'Two.']],
    ['untrimmed entries', [' leading', 'Two.']],
    ['multiline entries', ['First\nSecond', 'Two.']],
    ['overlong entries', ['x'.repeat(141), 'Two.']],
  ]) {
    it(`refuses ${name}`, () => {
      expect(verify(notes).status).toBe(1)
    })
  }
})
