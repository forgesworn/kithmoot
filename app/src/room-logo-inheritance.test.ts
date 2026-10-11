import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLogoImage } from '../../src/logo-image.js'
import type { SharedProject } from '../../src/project-directory.js'
import { inheritedRoomLogo, projectAdmissionBrand } from './room-logo-inheritance.js'

const room = 'ab'.repeat(32)
const image = createLogoImage(new Uint8Array(readFileSync(new URL('../../desktop/icons/kithmoot-128.png', import.meta.url))), 'image/png')
const project = (key: string): SharedProject => ({
  key, owner: 'cd'.repeat(32), project: key, heads: [], revision: 1,
  joined: true, withdrawn: false, conflicted: false, pendingSends: 0, logo: image,
  definition: { name: key, members: [], rooms: [{ room, name: 'Workshop', link: 'unused by display' }], archived: false, authorityRevision: 1 },
})

describe('locally authorised admission branding', () => {
  const link = 'https://app.invalid/j/#exact-persistent-invitation'
  const previewProject = (key: string): SharedProject => {
    const p = project(key); p.definition!.rooms[0]!.link = link; return p
  }
  it('previews only a joined verified directory invitation without granting room access', () => {
    const p = previewProject('a')
    expect(projectAdmissionBrand(link, [p])).toEqual({ room, name: 'Workshop', projectName: 'a', image })
    expect(p.joined).toBe(true); expect(p.definition!.rooms).toHaveLength(1)
    p.joined = false
    expect(projectAdmissionBrand(link, [p])).toBeUndefined()
  })
  it('matches the exact fragment across app origins and rejects unknown or malformed links', () => {
    expect(projectAdmissionBrand('https://another-app.invalid/j/#exact-persistent-invitation', [previewProject('a')])?.image).toEqual(image)
    for (const other of ['not a URL', 'https://app.invalid/j/', 'https://app.invalid/j/#another-invitation']) expect(projectAdmissionBrand(other, [previewProject('a')])).toBeUndefined()
  })
  it('withholds ambiguous project branding and all mismatching resolved room IDs', () => {
    const a = previewProject('a'), b = previewProject('b')
    expect(projectAdmissionBrand(link, [a, b])).toBeUndefined()
    expect(projectAdmissionBrand(link, [a, b], room, 'shared:b')?.projectName).toBe('b')
    expect(projectAdmissionBrand(link, [a], 'ef'.repeat(32))).toBeUndefined()
    b.definition!.rooms[0]!.room = 'ef'.repeat(32)
    expect(projectAdmissionBrand(link, [a, b], undefined, 'shared:a')).toBeUndefined()
  })
  it('clears withdrawn or archived previews and does not display conflicting artwork', () => {
    const p = previewProject('a')
    p.logoConflicted = true
    expect(projectAdmissionBrand(link, [p])?.image).toBeUndefined()
    p.withdrawn = true
    expect(projectAdmissionBrand(link, [p])).toBeUndefined()
    p.withdrawn = false; p.definition!.archived = true
    expect(projectAdmissionBrand(link, [p])).toBeUndefined()
  })
  it('waits for admission to prove a room behind a refreshed invitation', () => {
    const refreshed = 'https://app.invalid/j/#refreshed-invitation'
    expect(projectAdmissionBrand(refreshed, [previewProject('a')])).toBeUndefined()
    expect(projectAdmissionBrand(refreshed, [previewProject('a')], room)?.image).toEqual(image)
    expect(projectAdmissionBrand(refreshed, [previewProject('a')], 'ef'.repeat(32))).toBeUndefined()
  })
  it('still requires project selection when an admitted room has several contexts', () => {
    const refreshed = 'https://app.invalid/j/#refreshed-invitation'
    const projects = [previewProject('a'), previewProject('b')]
    expect(projectAdmissionBrand(refreshed, projects, room)).toBeUndefined()
    expect(projectAdmissionBrand(refreshed, projects, room, 'shared:b')?.projectName).toBe('b')
  })
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
