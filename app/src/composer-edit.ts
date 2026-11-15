import { compareMessages } from '../../src/message-order.js'
import type { ResolvedMessage } from '../../src/messages.js'

/** Whether a message offers Edit: the person's own, an ordinary message
 *  rather than one of a kind such as a transcript, and not retracted. The
 *  message menu and Up in an empty composer both ask this. */
export function editableBy(message: Pick<ResolvedMessage, 'original' | 'retracted'>, me: string): boolean {
  return me !== '' && message.original.participant === me && !message.original.kind && !message.retracted
}

/** The message Up in an empty composer edits: the newest one that offers
 *  Edit, in the order the conversation is shown, whoever wrote after it. */
export function latestEditable(conversation: Iterable<ResolvedMessage>, me: string): ResolvedMessage | undefined {
  let latest: ResolvedMessage | undefined
  for (const message of conversation) {
    if (!editableBy(message, me)) continue
    if (!latest || compareMessages(message.original, latest.original) > 0) latest = message
  }
  return latest
}
