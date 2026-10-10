/**
 * Pure helpers for one row of the rooms list: what order it sorts in, what
 * its time and preview line say, and what its presence line says out loud.
 * No DOM here on purpose - `main.ts` builds the row, this module only
 * decides what it should hold, so it is cheap to test against real dates
 * and real message shapes without a browser.
 */

/** A message old enough to matter here: when it went round the sort, who
 *  sent it, and what it said. */
export interface ActivityMessage {
  sentAt: number
}

/** Latest readable message time. Opening a room is a read action, not new
 * conversation activity. Zero means no readable message time is known. */
export function activityAt(_room: { openedAt?: number }, messages: readonly ActivityMessage[]): number {
  let latest = 0
  for (const message of messages) if (message.sentAt > latest) latest = message.sentAt
  return latest
}

/** Newest activity first, like Signal and WhatsApp - not alphabetical. */
export function sortByActivity<T extends { roomId: string }>(rooms: readonly T[], activityOf: (room: T) => number): T[] {
  return [...rooms].sort((a, b) => activityOf(b) - activityOf(a) || a.roomId.localeCompare(b.roomId))
}

/** en-GB time for a row's second line: today's clock time, `Yesterday`,
 *  a weekday out to six days, then `19 Sept`. */
export function formatActivityTime(seconds: number, now: number = Date.now() / 1000): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const at = new Date(seconds * 1000)
  const today = new Date(now * 1000)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(today) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days <= 6) return at.toLocaleDateString('en-GB', { weekday: 'short' })
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** A message worth a preview line: enough to say who sent it and what it
 *  held, without needing the whole `ChatMessage` shape. */
export interface PreviewMessage {
  participant: string
  text: string
  attachments?: readonly unknown[]
}

/** The room list's second line for its newest message: `You: …` for your
 *  own, `{Name}: …` for anybody else's, `{Name} sent a file` for a file
 *  with no caption, or undefined when there is nothing to preview (the
 *  caller falls back to "No messages yet" and the other precedence lines
 *  in section 9 of the spec). */
export function previewLine(
  message: PreviewMessage | undefined,
  selfParticipant: string,
  nameOf: (participant: string) => string,
): string | undefined {
  if (!message) return undefined
  const who = message.participant === selfParticipant ? 'You' : nameOf(message.participant)
  if (message.text) return `${who}: ${message.text}`
  if (message.attachments && message.attachments.length > 0) return `${who} sent a file`
  return undefined
}

/** Who is here, in the two forms a screen reader and a squint each need:
 *  `1 here` / `1 person here`, `3 here` / `2 people and 1 agent here`. */
export function presenceText(present: readonly { agent?: boolean }[]): { visible: string; spoken: string } {
  const agents = present.filter((p) => p.agent).length
  const people = present.length - agents
  const visible = `${present.length} here`
  const parts: string[] = []
  if (people) parts.push(`${people} ${people === 1 ? 'person' : 'people'}`)
  if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
  const spoken = parts.length ? `${parts.join(' and ')} here` : 'nobody here'
  return { visible, spoken }
}
