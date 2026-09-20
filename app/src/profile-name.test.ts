import { expect, it } from 'vitest'
import { resolveShownName, LastKnownNames } from './profile-name.js'

const ADA = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

it('prefers a fresh profile over both a remembered name and the announced name', () => {
  expect(resolveShownName({
    profileName: 'Ada', rememberedName: 'Nickname', assertedName: 'Announced', profilesEnabled: true,
  })).toBe('Ada')
})

it('prefers a remembered name over the announced name while no profile has arrived', () => {
  expect(resolveShownName({
    profileName: undefined, rememberedName: 'Nickname', assertedName: 'Announced', profilesEnabled: true,
  })).toBe('Nickname')
})

it('falls back to the announced name when nothing has ever been remembered', () => {
  expect(resolveShownName({
    profileName: undefined, rememberedName: undefined, assertedName: 'Announced', profilesEnabled: true,
  })).toBe('Announced')
})

it('never shows a remembered name once profile lookups are switched off', () => {
  expect(resolveShownName({
    profileName: undefined, rememberedName: 'Nickname', assertedName: 'Announced', profilesEnabled: false,
  })).toBe('Announced')
})

it('shows a fresh profile even with lookups switched off, since it can only come from one already in hand', () => {
  expect(resolveShownName({
    profileName: 'Ada', rememberedName: undefined, assertedName: 'Announced', profilesEnabled: false,
  })).toBe('Ada')
})

it('LastKnownNames remembers by pubkey and survives being reseeded from storage', () => {
  const names = new LastKnownNames(500)
  expect(names.remember(ADA, 'Ada')).toBe(true)
  expect(names.get(ADA)).toBe('Ada')
  // The exact same name again changes nothing worth persisting.
  expect(names.remember(ADA, 'Ada')).toBe(false)
  // A changed profile name replaces the remembered one.
  expect(names.remember(ADA, 'Adamant')).toBe(true)
  expect(names.get(ADA)).toBe('Adamant')

  const reseeded = new LastKnownNames(500, Object.entries(names.toRecord()))
  expect(reseeded.get(ADA)).toBe('Adamant')
})

it('LastKnownNames drops the oldest entry once the cap is reached', () => {
  const names = new LastKnownNames(2)
  names.remember(ADA, 'Ada')
  names.remember(BOB, 'Bob')
  names.remember('c'.repeat(64), 'Chip')
  expect(names.get(ADA)).toBeUndefined()
  expect(names.get(BOB)).toBe('Bob')
  expect(names.get('c'.repeat(64))).toBe('Chip')
})
