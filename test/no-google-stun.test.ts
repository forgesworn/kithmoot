import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * KithMoot's whole ICE-default design (src/ice-defaults.ts, and
 * docs/decisions.md, 13 September 2026) rests on naming no host outside the
 * origin that served a room's page and what the room itself named.
 * `stun.l.google.com` sneaking back into shipped source - a copy-pasted
 * RTCPeerConnection example, a "just for now" fallback while debugging -
 * would quietly reopen exactly the central dependency this change removed,
 * and nothing else would notice: it is a perfectly valid ICE server, so a
 * peer connection built with it works fine and looks correct in every
 * ordinary test. This scans the shipped source trees directly rather than
 * trusting any one call site to keep the promise.
 *
 * Test files are excluded from the scan (this file, and every other
 * *.test.ts/*.test.mjs, would otherwise fail on their own descriptions of
 * what they guard against - including this one).
 *
 * One production file is allowed to carry the literal string, and only
 * that one: `src/ice-defaults.ts`'s `LEGACY_DEFAULT_ICE_URLS`, which exists
 * specifically to recognise it in an existing link's ICE hint and upgrade
 * that room to this origin's own STUN/TURN (see `isDefaultIceUrls` there,
 * and docs/decisions.md). That is remembering the old default to retire
 * it, not naming a new one - every other production file must have no
 * reason whatsoever to mention Google's server.
 */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCAN_ROOTS = ['app/src', 'src', 'server']
const FORBIDDEN = 'stun.l.google.com'
const ALLOWED = new Set(['src/ice-defaults.ts'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.html'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...walk(join(dir, entry.name)))
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !isTestFile(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

describe('no default STUN server outside this origin', () => {
  it('never names stun.l.google.com in shipped source (app/src, src, server), except the one retired-default constant', () => {
    const offenders: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const relative = file.slice(REPO_ROOT.length)
        if (ALLOWED.has(relative)) continue
        if (readFileSync(file, 'utf8').toLowerCase().includes(FORBIDDEN)) offenders.push(relative)
      }
    }
    expect(offenders, `${FORBIDDEN} must not appear in shipped source - see docs/decisions.md, 13 September 2026:\n${offenders.join('\n')}`).toEqual([])
  })
})
