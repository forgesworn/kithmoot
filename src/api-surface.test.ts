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
import { moduleExports, MODULES } from '../scripts/api-surface.mjs'
import { KINDS } from './kinds.js'

const here = dirname(fileURLToPath(import.meta.url))
const snapshotPath = join(here, 'api-surface.snapshot.json')
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, string[]>

// `MODULES` (name in the snapshot -> file the plan's §1.1 table names it
// from) is imported from `scripts/api-surface.mjs` rather than duplicated
// here, so the tracked module list can never drift between this check and
// the script that (deliberately) regenerates the snapshot.

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

// ===========================================================================
// KINDS: the snapshot above records that the `KINDS` NAME is exported from
// `kinds.ts`, but not its keys or numeric values - a kind silently renumbered
// or renamed would still pass every check above. Kept as a plain literal
// test rather than folded into a vector file, because there is nothing here
// to sign, encrypt or decode: a kind number is read directly off the object,
// never derived.
// ===========================================================================

/** The circle-layer subset: kinds T1's vector work exercises (credential,
 *  invitation request/grant/retirement, persistent group invitation, rekey,
 *  epoch request/grant) - as opposed to presence, chat, signalling, pairing
 *  and the rest, which `KINDS` also carries and this test deliberately does
 *  not pin. */
const CIRCLE_KIND_NAMES = [
  'CREDENTIAL',
  'INVITATION_REQUEST',
  'INVITATION_GRANT',
  'INVITATION_RETIREMENT',
  'GROUP_INVITATION',
  'ROOM_REKEY',
  'EPOCH_REQUEST',
  'EPOCH_GRANT',
] as const

describe('circle-layer kind numbers', () => {
  it('names exactly the 8 circle kinds this vector work covers, frozen to their current numbers', () => {
    expect(CIRCLE_KIND_NAMES).toHaveLength(8)
    expect(CIRCLE_KIND_NAMES.map((name) => KINDS[name])).toEqual([20460, 20466, 20467, 1461, 1463, 1462, 20468, 20469])
  })

  it('every circle kind number is unique, among themselves and across the whole KINDS registry', () => {
    const circleValues = CIRCLE_KIND_NAMES.map((name) => KINDS[name])
    expect(new Set(circleValues).size).toBe(circleValues.length)

    const allValues = Object.values(KINDS)
    expect(new Set(allValues).size, 'KINDS has two names sharing one wire kind number').toBe(allValues.length)
  })

  it('every circle kind name named here is actually present in KINDS, so a rename here fails loudly rather than silently comparing undefined to undefined', () => {
    for (const name of CIRCLE_KIND_NAMES) expect(Object.prototype.hasOwnProperty.call(KINDS, name), name).toBe(true)
  })
})
