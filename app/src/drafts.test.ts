import { expect, it } from 'vitest'
import { ConversationDrafts, draftSubmissionSnapshot } from './drafts.js'

it('distinguishes two recipients with the same shown name and the same visible draft', () => {
  const draft = new ConversationDrafts().get(undefined)
  draft.text = '@Robin please check'
  draft.pickedMentions = new Map([['robin', 'a'.repeat(64)]])
  const first = draftSubmissionSnapshot(draft.text, draft)
  draft.pickedMentions.set('robin', 'b'.repeat(64))
  expect(draftSubmissionSnapshot(draft.text, draft)).not.toBe(first)
  draft.pickedMentions.set('robin', 'a'.repeat(64))
  expect(draftSubmissionSnapshot(draft.text, draft)).toBe(first)
})
it('keeps the submission fingerprint stable across mention map insertion order and caret movement', () => {
  const draft = new ConversationDrafts().get(undefined)
  draft.pickedMentions = new Map([['robin', 'a'], ['ada', 'b']])
  const first = draftSubmissionSnapshot('@Robin @Ada', draft)
  draft.pickedMentions = new Map([['ada', 'b'], ['robin', 'a']])
  draft.selectionStart = 5; draft.selectionEnd = 8
  expect(draftSubmissionSnapshot('@Robin @Ada', draft)).toBe(first)
})
