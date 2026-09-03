/**
 * When to tell a person about a message they are not looking at, and what
 * to say.
 *
 * There is no server to push from, so a notification can only come from
 * this person's own open app: a tab in the background, or a tab on the
 * rooms list while something lands in a room it is watching. The decision
 * is pure, so it is tested with no browser: a message is worth a
 * notification when it is news rather than history, when it is somebody
 * else's, and when the person is not already looking at it - the document
 * is hidden, or the room it landed in is not the one on screen.
 *
 * What goes to the operating system is bounded on purpose. A notification
 * names the room and the sender; the text goes with it only when the
 * person has said so, because a notification centre is a place other
 * people see over a shoulder and other apps read with permission.
 *
 * Nothing here touches the DOM. `main.ts` hands in `document.hidden`, the
 * room on screen and the delivery, and this decides.
 */
import type { ChatMessage } from '../../src/chat.js'
import type { DeviceStore } from './device-store.js'

export const NOTIFY_STORAGE_KEY = 'kithmoot.notify'
export const NOTIFY_TEXT_STORAGE_KEY = 'kithmoot.notify-text'

/** A message this much older than the moment a room was first followed is
 *  history replayed by a relay, not news: nobody said it to a tab that was
 *  not there. The same grace an agent runtime gives itself. */
export const HISTORY_GRACE_SECONDS = 10

/** How much of a message goes into the operating system's notification
 *  when the person has asked for the text at all. */
export const PREVIEW_LENGTH = 140

/** The conversations worth interrupting somebody for. */
export type NotifyChannel = 'chat' | 'agents' | 'minutes'

export interface NotifySettings {
  /** The person asked to be told, on this device. */
  enabled: boolean
  /** And said the message text may go into the notification. Off by
   *  default: what leaves the app for the OS is the room and the sender. */
  showText: boolean
}

export function notifySettings(store: DeviceStore): NotifySettings {
  return {
    enabled: store.get(NOTIFY_STORAGE_KEY) === 'true',
    showText: store.get(NOTIFY_TEXT_STORAGE_KEY) === 'true',
  }
}

export function setNotifySettings(store: DeviceStore, patch: Partial<NotifySettings>): NotifySettings {
  const next = { ...notifySettings(store), ...patch }
  store.set(NOTIFY_STORAGE_KEY, String(next.enabled))
  store.set(NOTIFY_TEXT_STORAGE_KEY, String(next.showText))
  return next
}

/** Where a message landed. */
export interface Arrival {
  roomId: string
  message: Pick<ChatMessage, 'id' | 'participant' | 'sentAt'>
}

/** What the person is looking at, as of the arrival. */
export interface NotifyContext {
  /** `document.hidden`: the tab is in the background, or the screen is off. */
  hidden: boolean
  /** The room joined and on screen, or undefined on the rooms list. */
  shownRoomId?: string
  /** This person's participant pubkey. Their own messages are never news. */
  self?: string
  /** Unix seconds this device started following the room the message is
   *  in. Anything older than that, less the grace, is history. */
  followedSince: number
}

/**
 * Whether one message is worth a notification. The whole rule, in one
 * place: not history, not our own, and not something already on screen.
 */
export function shouldNotify(arrival: Arrival, context: NotifyContext): boolean {
  const { message } = arrival
  if (message.sentAt < context.followedSince - HISTORY_GRACE_SECONDS) return false
  if (context.self !== undefined && message.participant === context.self) return false
  if (context.hidden) return true
  return context.shownRoomId !== arrival.roomId
}

export interface NotificationContent {
  title: string
  body: string
  /** One tag per room and conversation, so a burst replaces itself rather
   *  than stacking up. */
  tag: string
}

/**
 * What the notification says. The room is the title, because that is what
 * a person on three rooms needs first; the sender is in the body, as a
 * name is shown everywhere else, beside a short key. The text is there
 * only when asked for, and then cut short: a notification is a nudge to
 * open the room, not a place to read it.
 */
export function notificationContent(opts: {
  roomId: string
  room: string
  sender: string
  channel: NotifyChannel
  text: string
  showText: boolean
}): NotificationContent {
  const preview = opts.showText ? clip(opts.text) : undefined
  let body: string
  switch (opts.channel) {
    case 'agents':
      body = preview !== undefined ? `${opts.sender} (agents): ${preview}` : `${opts.sender} said something on the agents channel`
      break
    case 'minutes':
      body = preview !== undefined ? `Minutes from ${opts.sender}: ${preview}` : `${opts.sender} wrote minutes`
      break
    default:
      body = preview !== undefined ? `${opts.sender}: ${preview}` : `${opts.sender} said something`
  }
  return { title: opts.room, body, tag: `kithmoot:${opts.roomId}:${opts.channel}` }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const characters = [...flat]
  if (characters.length <= PREVIEW_LENGTH) return flat
  return characters.slice(0, PREVIEW_LENGTH - 1).join('').trimEnd() + '…'
}

/** The document title while there is something unseen: a count in front
 *  of the name, and the plain name once there is not. */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base
}

export interface FollowOptions {
  roomId: string
  channel: NotifyChannel
  /** What the room is called on screen, looked up at delivery so a name
   *  learnt later is the one used. */
  room: () => string
  /** How to show a sender: the name on the message beside a short key,
   *  the way it is shown everywhere else. */
  sender: (message: ChatMessage) => string
}

export interface NotifierOptions {
  settings: () => NotifySettings
  hidden: () => boolean
  shownRoomId: () => string | undefined
  self: () => string | undefined
  /** Puts one notification in front of the person. Whatever it throws or
   *  rejects with is swallowed: a notification that cannot be shown is not
   *  a reason to stop reading the room. */
  deliver: (content: NotificationContent, arrival: Arrival) => void | Promise<void>
  /** Called whenever the count of things unseen changes. */
  onPending?: (count: number) => void
  /** Unix seconds. */
  now?: () => number
}

/**
 * The rule above, applied to the logs as they change.
 *
 * A log reports its whole history on every change, so this remembers what
 * it has already seen and considers only what is new. Each conversation
 * followed is stamped with when it was first followed, which is what
 * separates history from news for that conversation. The count of things
 * unseen goes up while the document is hidden and back to nothing when the
 * person looks.
 */
export class Notifier {
  readonly #opts: NotifierOptions
  readonly #now: () => number
  readonly #seen = new Set<string>()
  #pending = 0

  constructor(opts: NotifierOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /** How many notifications have gone out since the person last looked. */
  get pending(): number {
    return this.#pending
  }

  /** The person is looking: nothing is unseen any more. */
  seen(): void {
    if (this.#pending === 0) return
    this.#pending = 0
    this.#opts.onPending?.(0)
  }

  /**
   * Follow one conversation. Returns the listener to hand to its log's
   * `onChange`; the first call it gets is the history, which is remembered
   * and never notified.
   */
  follow(follow: FollowOptions): (messages: ChatMessage[]) => void {
    const followedSince = this.#now()
    return (messages) => {
      for (const message of messages) {
        if (this.#seen.has(message.id)) continue
        this.#seen.add(message.id)
        const arrival: Arrival = { roomId: follow.roomId, message }
        const settings = this.#opts.settings()
        if (!settings.enabled) continue
        const hidden = this.#opts.hidden()
        if (!shouldNotify(arrival, { hidden, shownRoomId: this.#opts.shownRoomId(), self: this.#opts.self(), followedSince })) continue
        const content = notificationContent({
          roomId: follow.roomId,
          room: follow.room(),
          sender: follow.sender(message),
          channel: follow.channel,
          text: message.text,
          showText: settings.showText,
        })
        if (hidden) {
          this.#pending++
          this.#opts.onPending?.(this.#pending)
        }
        try {
          const result = this.#opts.deliver(content, arrival)
          if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(() => {})
        } catch {
          // See `deliver`.
        }
      }
    }
  }
}
