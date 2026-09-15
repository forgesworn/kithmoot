import { expect, it } from 'vitest'
import type { ChatMessage } from '../../src/chat.js'
import { agentRequestStatuses } from './agent-request-status.js'

const person = 'a'.repeat(64), tally = 'b'.repeat(64), chip = 'c'.repeat(64)
const request = { id: '1'.repeat(32), participant: person, text: '@Tally help', mentions: [tally], sentAt: 100 } as ChatMessage
const agents = [{ participant: tally, name: 'Tally', present: true }]
const received = {
  id: '2'.repeat(32), participant: tally, text: '👍', sentAt: 105,
  reaction: { participant: person, messageId: request.id, emoji: '👍', active: true, revision: 1, receipt: 'received' },
} as ChatMessage

it('distinguishes a waiting request, missing receipt and disconnected agent', () => {
  expect(agentRequestStatuses([request], request, agents, 100_000)).toEqual(['Waiting for Tally to receive this…'])
  expect(agentRequestStatuses([request], request, agents, 131_000)[0]).toContain('No receipt from Tally')
  expect(agentRequestStatuses([request], request, [{ ...agents[0]!, present: false }], 131_000)[0]).toContain('not currently connected')
})

it('requires a receipt from the addressed agent, not an ordinary thumbs-up or another agent', () => {
  const status = (receipt: ChatMessage) => agentRequestStatuses([request, receipt], request, agents, 110_000)[0]
  expect(status(received)).toContain('Tally received this')
  expect(status({ ...received, participant: chip })).toContain('Waiting')
  expect(status({ ...received, reaction: { ...received.reaction!, receipt: undefined } })).toContain('Waiting')
})

it('clears only for a linked reply from the addressed agent, and respects retractions', () => {
  const reply = { id: '3'.repeat(32), participant: tally, text: 'Here is the answer', sentAt: 110, reply: { participant: person, messageId: request.id } } as ChatMessage
  expect(agentRequestStatuses([request, reply], request, agents, 115_000)).toEqual([])
  expect(agentRequestStatuses([request, { ...reply, reply: undefined }], request, agents, 115_000)).not.toEqual([])
  expect(agentRequestStatuses([request, { ...reply, participant: chip }], request, agents, 115_000)).not.toEqual([])
  const retraction = { id: '4'.repeat(32), participant: tally, retracts: reply.id, text: '', sentAt: 120 } as ChatMessage
  expect(agentRequestStatuses([request, reply, retraction], request, agents, 125_000)).not.toEqual([])
  expect(agentRequestStatuses([request, { ...retraction, participant: person, retracts: request.id }], request, agents, 125_000)).toEqual([])
})

it('does not add absent historic agents to @all or show a receipt from another conversation', () => {
  const all = { ...request, mentions: ['everyone'] }
  expect(agentRequestStatuses([all], all, [...agents, { participant: chip, name: 'Chip', present: false }], 110_000)).toHaveLength(1)
  expect(agentRequestStatuses([request], request, agents, 110_000)[0]).toContain('Waiting')
})
