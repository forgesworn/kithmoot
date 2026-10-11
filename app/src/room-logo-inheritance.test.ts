import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLogoImage } from '../../src/logo-image.js'
import type { SharedProject } from '../../src/project-directory.js'
import { inheritedRoomLogo } from './room-logo-inheritance.js'

const room = 'ab'.repeat(32)
const image = createLogoImage(new Uint8Array(readFileSync(new URL('../../desktop/icons/kithmoot-128.png', import.meta.url))), 'image/png')
const project = (key: string): SharedProject => ({
  key, owner: 'cd'.repeat(32), project: key, heads: [], revision: 1,
  joined: true, withdrawn: false, conflicted: false, pendingSends: 0, logo: image,
  definition: { name: key, members: [], rooms: [{ room, name: 'Workshop', link: 'unused by display' }], archived: false, authorityRevision: 1 },
})

describe('room logo inheritance', () => {
  it('uses the sole joined project and restores inheritance after removing a room override', () => {
    expect(inheritedRoomLogo(room, undefined, [project('a')])).toEqual(image)
    expect(inheritedRoomLogo(room, null, [project('a')])).toEqual(image)
    const override = { ...image, sha256: 'different override' }
    expect(inheritedRoomLogo(room, override, [project('a'), project('b')], 'shared:b')).toBe(override)
  })
  it('requires a selected context when a room belongs to several joined projects', () => {
    const a = project('a'), b = { ...project('b'), logo: null }
    expect(inheritedRoomLogo(room, null, [a, b])).toBeUndefined()
    expect(inheritedRoomLogo(room, null, [a, b], 'shared:a')).toEqual(image)
    expect(inheritedRoomLogo(room, null, [a, b], 'shared:b')).toBeUndefined()
    expect(inheritedRoomLogo(room, null, [a, b], 'shared:unknown')).toBeUndefined()
  })
  it.each(['joined', 'withdrawn', 'conflicted', 'archived', 'unrelated'] as const)('does not inherit from an unavailable %s project', reason => {
    const p = project('a')
    if (reason === 'joined') p.joined = false
    if (reason === 'withdrawn') p.withdrawn = true
    if (reason === 'conflicted') p.conflicted = true
    if (reason === 'archived') p.definition!.archived = true
    if (reason === 'unrelated') p.definition!.rooms = []
    expect(inheritedRoomLogo(room, undefined, [p], 'shared:a')).toBeUndefined()
  })
  it('withholds conflicting project artwork without changing membership or choosing another project', () => {
    const a = { ...project('a'), logoConflicted: true }, b = project('b')
    expect(inheritedRoomLogo(room, undefined, [a], 'shared:a')).toBeUndefined()
    expect(inheritedRoomLogo(room, undefined, [a, b], 'shared:a')).toBeUndefined()
    expect(a.joined).toBe(true)
  })
})
