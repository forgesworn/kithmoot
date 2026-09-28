// T0.2 of docs/plans/2026-09-28-circle-kit-extraction.md (girnel repository):
// a snapshot of the export names of `src/index.ts` (the whole public
// library surface) and of each module the plan's §1.1 table names as
// moving to the shared kit - `hex`, `verify`, `identity`, `kinds`, `types`,
// `credential`, `room`, `network-hints`, `display-name`, `access`,
// `invitation`, `persistent-invitation`, `link`, `epoch`, `chat` (the
// `deriveChannel` codec lives here) and `lane`.
//
// This is a tripwire, not a design opinion: it does not say an export
// SHOULD or SHOULD NOT exist, only that the current set is recorded, so an
// export removed or renamed anywhere in these files - by this extraction or
// by ordinary KithMoot development in the meantime - fails here loudly
// instead of surfacing as a mismatch once the kit tries to consume it.
//
// `src/api-surface.snapshot.json` is the committed baseline. To update it
// deliberately: `node scripts/api-surface.mjs`.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleExports } from '../scripts/api-surface.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const snapshotPath = join(here, 'api-surface.snapshot.json')
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, string[]>

/** Name in the snapshot -> file the plan's §1.1 table names it from. */
const MODULES: Record<string, string> = {
  index: 'index.ts',
  hex: 'hex.ts',
  verify: 'verify.ts',
  identity: 'identity.ts',
  kinds: 'kinds.ts',
  types: 'types.ts',
  credential: 'credential.ts',
  room: 'room.ts',
  'network-hints': 'network-hints.ts',
  'display-name': 'display-name.ts',
  access: 'access.ts',
  invitation: 'invitation.ts',
  'persistent-invitation': 'persistent-invitation.ts',
  link: 'link.ts',
  epoch: 'epoch.ts',
  chat: 'chat.ts',
  lane: 'lane.ts',
}

describe('API surface snapshot', () => {
  it('the snapshot names exactly the modules T0.2 tracks, no more and no fewer', () => {
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(MODULES).sort())
  })

  for (const [name, file] of Object.entries(MODULES)) {
    it(`${name} (src/${file}) exports exactly the names in the committed snapshot`, () => {
      const live = moduleExports(join(here, file))
      expect(live).toEqual(snapshot[name])
    })
  }

  it('every snapshot entry is sorted and free of duplicates, so a diff is ever only an actual change', () => {
    for (const [name, names] of Object.entries(snapshot)) {
      expect(names, name).toEqual([...names].sort())
      expect(new Set(names).size, name).toBe(names.length)
    }
  })
})
