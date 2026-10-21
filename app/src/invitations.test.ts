// No DOM in this workspace's vitest (environment: 'node'); the rows are
// proven in the browser by test/people.spec.ts. This covers the naming rule.
import { expect, it } from 'vitest'
import { invitationTitle, inviterIdentity } from './invitations.js'

const key = 'ab'.repeat(32)

it('names an inviter by Signet, then their contact card, then their own profile', () => {
  const profile = { name: 'Bobby', picture: 'https://example.com/b.png' }
  expect(inviterIdentity({ signetName: 'Bob', cardName: 'Robert', known: true, profile })).toEqual({ name: 'Bob', picture: profile.picture })
  expect(inviterIdentity({ cardName: 'Robert', known: true, profile })).toEqual({ name: 'Robert', picture: profile.picture })
  expect(inviterIdentity({ known: true, profile })).toEqual(profile)
  expect(inviterIdentity({ known: true })).toEqual({})
})

it('never takes a stranger\'s name or picture from their own profile', () => {
  expect(inviterIdentity({ known: false, profile: { name: 'Mum', picture: 'https://example.com/m.png' } })).toEqual({})
})

it('says who is asking, and Somebody when there is no name', () => {
  expect(invitationTitle({ pubkey: key, name: 'Bob' })).toBe('Bob invited you to a private chat')
  expect(invitationTitle({ pubkey: key })).toBe('Somebody invited you to a private chat')
})
