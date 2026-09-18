import { expect, it } from 'vitest'
import type { ChatMessage } from '../../src/chat.js'
import type { Named } from '../../src/messages.js'
import { mentionPattern, mentionedNames, segmentMentions } from './mention-render.js'

const ADA = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

// Ada's announced joining name happens to double as an everyday word, the
// same shape of collision the report was about ("Daddy"). Bob's roster
// name is ordinary. Neither is a real person's name.
const roster: Named[] = [
  { participant: ADA, name: 'Chirrup' },
  { participant: BOB, name: 'Bob' },
]

function highlighted(text: string, message: Pick<ChatMessage, 'text' | 'mentions'>): string[] {
  const names = mentionedNames(message, roster, (p) => roster.find((r) => r.participant === p)?.name)
  const pattern = mentionPattern(names)
  return segmentMentions(text, pattern, new Set())
    .filter((s) => s.mention)
    .map((s) => s.text)
}

it('a message that explicitly mentions nobody highlights no roster name, even one it contains', () => {
  const text = 'my chirrup woke the house up again'
  expect(highlighted(text, { text, mentions: [] })).toEqual([])
})

it('a message that names somebody else does not highlight a bystander whose name is also in the text', () => {
  const text = 'chirrup, tell Bob I said hi'
  // Only Ada (Chirrup) is actually addressed; Bob is merely mentioned in
  // the prose, not addressed on the wire.
  expect(highlighted(text, { text, mentions: [ADA] })).toEqual(['chirrup'])
})

it('a message with no mentions field at all still matches by name, as it did before the field existed', () => {
  const text = 'chirrup, are you there?'
  expect(highlighted(text, { text, mentions: undefined })).toEqual(['chirrup'])
})

it('mentionedNames highlights the displayed name, not the announced roster name, once a profile is known', () => {
  const displayName = (p: string) => (p === ADA ? 'Ada Realname' : roster.find((r) => r.participant === p)?.name)
  const names = mentionedNames({ text: 'x', mentions: [ADA] }, roster, displayName)
  expect(names).toEqual(['Ada Realname'])

  // The announced name no longer matches once the profile name is what is
  // actually shown; the displayed name does.
  const pattern = mentionPattern(names)
  expect(segmentMentions('chirrup is not it', pattern, new Set()).some((s) => s.mention)).toBe(false)
  expect(segmentMentions('Ada Realname is it', pattern, new Set()).some((s) => s.mention)).toBe(true)
})

it('segmentMentions marks the room mention and the reader\'s own name as "me"', () => {
  const pattern = mentionPattern(['Chirrup'])
  const mine = new Set(['chirrup'])
  const segments = segmentMentions('@all chirrup', pattern, mine)
  const mentions = segments.filter((s) => s.mention)
  expect(mentions.map((s) => s.text)).toEqual(['@all', 'chirrup'])
  expect(mentions.every((s) => s.me)).toBe(true)
})

it('segmentMentions never drops or reorders any text', () => {
  const pattern = mentionPattern(['Chirrup'])
  const text = 'before chirrup after'
  const rebuilt = segmentMentions(text, pattern, new Set()).map((s) => s.text).join('')
  expect(rebuilt).toBe(text)
})

it('an empty pattern (no names, no room mention text) still returns the original text untouched', () => {
  expect(segmentMentions('hello world', mentionPattern([]), new Set())).toEqual([
    { text: 'hello world', mention: false, me: false },
  ])
})
