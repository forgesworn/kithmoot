import type { ChatMessage } from '../../src/chat.js'
import { mentionedBy, refKey, resolveConversation } from '../../src/messages.js'
import { reactionsFor } from '../../src/reactions.js'

export interface RequestAgent { participant: string; name?: string; present: boolean; requestReceipts?: boolean }

/** Per-conversation evidence only: a thumbs-up without a receipt marker and
 * an unrelated later message do not prove this request was received/answered. */
export function agentRequestStatuses(messages: ChatMessage[], request: ChatMessage, agents: RequestAgent[], now: number): string[] {
  return readAgentRequestStatuses(messages)(request, agents, now)
}

export function readAgentRequestStatuses(messages: ChatMessage[]) {
  const conversation = resolveConversation(messages)
  const replies = new Set<string>()
  for (const reply of conversation.byKey.values()) {
    if (!reply.retracted && reply.reply) replies.add(`${refKey(reply.reply)}:${reply.original.participant}`)
  }
  const receipts = new Map<string, Set<string>>()
  return (request: ChatMessage, agents: RequestAgent[], now: number): string[] => {
    if (request.reaction || request.retracts) return []
    const current = conversation.byKey.get(refKey({ participant: request.participant, messageId: request.id }))
    if (!current || current.retracted) return []
    const addressed = agents.filter(agent => agent.participant !== request.participant &&
      // For @all, only current members are recipients; old disconnected agents
      // remembered by this tab must not turn into additional intended recipients.
      (agent.present || current.shown.mentions?.includes(agent.participant)) &&
      mentionedBy(current.shown, agent.participant, agents, { agent: true }))
    const key = refKey({ participant: request.participant, messageId: request.id })
    if (!receipts.has(key)) receipts.set(key, new Set((reactionsFor(messages, request).get('👍') ?? [])
      .filter(m => m.reaction?.active && m.reaction.receipt === 'received').map(m => m.participant)))
    return addressed.flatMap(agent => {
      const replied = replies.has(`${key}:${agent.participant}`)
      if (replied) return []
      const name = agent.name || agent.participant.slice(0, 8)
      const received = receipts.get(key)!.has(agent.participant)
      if (received) return [`${name} received this. ${now - request.sentAt * 1000 < 120_000 ? 'A reply may still be pending.' : 'Check the conversation for a reply before retrying.'}`]
      // Older and external drivers can answer without sending receipt markers
      // or linked replies. Their silence on this protocol is not a delivery fault.
      if (agent.requestReceipts !== true) return []
      if (!agent.present) return [`${name} is not currently connected. Retry when they return.`]
      return [now - request.sentAt * 1000 < 30_000 ? `Waiting for ${name} to receive this…` : `No receipt from ${name} yet. Check their connection or retry.`]
    })
  }
}
