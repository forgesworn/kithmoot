import type { AssignmentLog } from '../../src/assignment-log.js'
import type { RoomSession } from '../../src/session.js'

/** A board borrows the chat's existing writer and installation. Closing a
 * card view releases its listeners, never the person's room or task journal. */
export function borrowBoardAgentRoom(session: RoomSession, source: AssignmentLog, current: () => boolean, label?: string) {
  let closed = false
  let review: (() => boolean) | undefined
  const listeners = new Set<() => void>()
  const valid = () => !closed && current() && source.roomId === session.roomId && source.participant === session.participant
  const check = () => {if (!valid()) throw new Error('This board’s linked chat is no longer open for this account')}
  const checked = () => {check(); if (!review || !review()) throw new Error('Review the current card request before sharing it'); return true}
  const listen = (subscribe: () => () => void) => {
    check(); const off = subscribe(); listeners.add(off)
    return () => {listeners.delete(off); off()}
  }
  const close = async () => {closed = true; for (const off of listeners) off(); listeners.clear()}
  const log = {
    participant: source.participant, roomId: source.roomId,
    snapshot: () => {check(); return structuredClone(source.snapshot())},
    onChange: (callback: () => void) => listen(() => source.onChange(() => {if (valid()) callback()})),
    submit: (...args: Parameters<AssignmentLog['submit']>) => {
      checked(); const approved = review!
      return source.submit(args[0], args[1], args[2], args[3], () => valid() && approved())
    },
    retry: async () => {throw new Error('Review the saved card request before retrying it')},
    close: () => {},
  }
  const ended = (callback: () => void) => listen(() => session.onChange(() => {if (!valid()) callback()}))
  const room = {
    roomId: session.roomId, participant: session.participant, device: session.device,
    url: '', relays: [] as string[], destruct: false,
    roster: () => {check(); return structuredClone(session.participants())},
    onRoster: (callback: (roster: ReturnType<RoomSession['participants']>) => void) => listen(() => session.onChange(roster => {if (valid()) callback(structuredClone(roster))})),
    channel: (name: string) => {
      check(); if (name !== 'control') throw new Error('The board reads only this chat’s agent directory')
      const channel = session.channel('control')
      return {
        messages: () => {check(); return structuredClone(channel.messages())},
        onChange: (callback: (messages: ReturnType<typeof channel.messages>) => void) => listen(() => channel.onChange(messages => {if (valid()) callback(structuredClone(messages))})),
        send: async (text: string) => {
          check(); if (text !== JSON.stringify({op: 'catalogue?'})) throw new Error('The board can only refresh this chat’s agent directory')
          const result = await channel.send(text); check(); return result
        },
      }
    },
    onClosed: (callback: () => void) => ended(callback),
    onRemoved: (callback: () => void) => ended(callback),
    onEnded: (callback: () => void) => ended(callback),
    leave: close,
    session: {assignments: async () => {check(); return log}},
  }
  return {label, room, log, close, isCurrent: valid,
    async submitReviewed<T>(guard: () => boolean, submit: () => Promise<T>): Promise<T> {
      check(); if (review) throw new Error('Another card request is still being shared')
      review = guard
      try {checked(); return await submit()} finally {review = undefined}
    },
  }
}

export type BoardAgentRoom = ReturnType<typeof borrowBoardAgentRoom>
