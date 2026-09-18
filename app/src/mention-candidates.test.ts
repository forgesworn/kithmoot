import { expect, it } from 'vitest'
import type { Named } from '../../src/messages.js'
import { buildMentionCandidates, resolveDraftMentions } from './mention-candidates.js'

const ADA = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const BUZZ = 'c'.repeat(64)

it('candidates are named as they are shown, not by an announced name a profile has since corrected', () => {
  // Bob joined announcing "Buzz"; his profile has since arrived and says
  // "Bob" - the same mismatch the roster fixes elsewhere in the app.
  const roster = [{ participant: BOB, name: 'Bob', agent: false }]
  const choices = buildMentionCandidates('', roster, () => 'npub1bob…')
  expect(choices.map((c) => c.name)).toEqual(['Bob', 'all'])
  expect(choices[0]).toMatchObject({ participant: BOB, npub: undefined })
})

it('two participants shown under the same name both appear, each with its own npub', () => {
  const roster = [
    { participant: ADA, name: 'Robin', agent: false },
    { participant: BOB, name: 'Robin', agent: true },
  ]
  const choices = buildMentionCandidates('rob', roster, (p) => (p === ADA ? 'npub1ada…' : 'npub1bob…'))
  const robins = choices.filter((c) => c.name === 'Robin')
  expect(robins).toHaveLength(2)
  expect(robins.map((c) => c.participant).sort()).toEqual([ADA, BOB].sort())
  expect(robins.every((c) => c.npub !== undefined)).toBe(true)
  expect(new Set(robins.map((c) => c.npub)).size).toBe(2)
})

it('a name only one participant answers to never carries an npub, even when the query matches several people', () => {
  const roster = [
    { participant: ADA, name: 'Ada', agent: false },
    { participant: BOB, name: 'Bob', agent: false },
  ]
  const choices = buildMentionCandidates('', roster, () => 'npub1x…')
  expect(choices.find((c) => c.name === 'Ada')?.npub).toBeUndefined()
  expect(choices.find((c) => c.name === 'Bob')?.npub).toBeUndefined()
})

it('a query narrows and orders candidates, names that start with it before names that merely contain it', () => {
  const roster = [
    { participant: ADA, name: 'Robina', agent: false },
    { participant: BOB, name: 'Marobin', agent: false },
  ]
  const choices = buildMentionCandidates('rob', roster, () => 'npub1x…')
  expect(choices.map((c) => c.name)).toEqual(['Robina', 'Marobin'])
})

it('a participant with no name at all is not a candidate', () => {
  const roster = [{ participant: ADA, name: '', agent: false }]
  expect(buildMentionCandidates('', roster, () => 'x').map((c) => c.name)).toEqual(['all'])
})

it('resolveDraftMentions: a hand-typed name with nobody picked matches by name, as mentionsOf always has', () => {
  const roster: Named[] = [{ participant: ADA, name: 'Ada' }]
  expect(resolveDraftMentions('Ada, are you there', roster, new Map(), 32)).toEqual([ADA])
})

it('resolveDraftMentions: a name shared by two participants resolves to the one that was actually picked', () => {
  const roster: Named[] = [
    { participant: ADA, name: 'Robin' },
    { participant: BOB, name: 'Robin' },
  ]
  const picked = new Map([['robin', BOB]])
  expect(resolveDraftMentions('Robin, over to you', roster, picked, 32)).toEqual([BOB])
})

it('resolveDraftMentions: a shared name nobody picked still matches every participant who answers to it', () => {
  const roster: Named[] = [
    { participant: ADA, name: 'Robin' },
    { participant: BOB, name: 'Robin' },
  ]
  expect(resolveDraftMentions('Robin, over to you', roster, new Map(), 32).sort()).toEqual([ADA, BOB].sort())
})

it('resolveDraftMentions: a stale pick for a name no longer shared does not drop the plain match', () => {
  const roster: Named[] = [{ participant: ADA, name: 'Robin' }]
  const picked = new Map([['robin', BUZZ]]) // picked before Buzz left the room
  expect(resolveDraftMentions('Robin, over to you', roster, picked, 32)).toEqual([ADA])
})

it('resolveDraftMentions: the shown-name roster still lights up the profile name, not a stale announced one', () => {
  // Bob announced "Buzz"; the roster passed in here already carries his
  // displayed name "Bob" - the caller's job (shownAs), not this function's.
  const roster: Named[] = [{ participant: BOB, name: 'Bob' }]
  expect(resolveDraftMentions('Bob will chair the meeting', roster, new Map(), 32)).toEqual([BOB])
  expect(resolveDraftMentions('Buzz will chair the meeting', roster, new Map(), 32)).toEqual([])
})

it('resolveDraftMentions caps at max, broadcast first', () => {
  const roster: Named[] = [{ participant: ADA, name: 'Ada' }, { participant: BOB, name: 'Bob' }]
  expect(resolveDraftMentions('@all Ada Bob', roster, new Map(), 2)).toHaveLength(2)
})
