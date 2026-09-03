import { MAX_CHAT_TEXT_LENGTH } from './chat.js'

/**
 * The channel a room's agent hosts and its people use to ask for agents.
 *
 * A named channel like `agents` and `transcript`, derived from the room key
 * (`deriveChannel`), so every member can read it and nobody outside the
 * room can find it. What rides on it is small JSON messages: a host saying
 * what it can run, a person asking it to run one, the host saying it did.
 * Text, because the chat is text; bounded, because the chat is bounded.
 */
export const CONTROL_CHANNEL = 'control'

/** One agent a host can start. */
export interface CatalogueEntry {
  /** Stable, short, what a person clicks. */
  id: string
  /** What the room will call it. */
  name: string
  /** One line, for the person choosing. */
  description?: string
  /** Whether it transcribes what it is allowed to hear. */
  listens?: boolean
}

/** One agent a host is running now. */
export interface RunningAgent {
  id: string
  name: string
  /** The participant it joined as, once known. */
  participant?: string
  /** Unix seconds. */
  since: number
}

export type ControlMessage =
  /** A host, saying what it can run and what it is running. Sent when it
   *  starts, whenever that changes, and in answer to `catalogue?`. */
  | { op: 'catalogue'; host: string; name: string; agents: CatalogueEntry[]; running: RunningAgent[] }
  /** Anybody: every host, please say again. A person opening the room an
   *  hour after the host started should not have to wait for a change. */
  | { op: 'catalogue?' }
  /** Anybody: host, start this one. */
  | { op: 'invite'; host: string; agent: string }
  /** Anybody: host, stop this one. */
  | { op: 'dismiss'; host: string; agent: string }
  /** The host: it started. */
  | { op: 'invited'; host: string; agent: string; name: string; participant?: string }
  /** The host: it stopped, for whatever reason. */
  | { op: 'dismissed'; host: string; agent: string; name: string; reason?: string }
  /** The host: it could not. */
  | { op: 'error'; host: string; agent?: string; message: string }
  /**
   * The room's keeper, saying who may act on the room: remove a member,
   * close it, ask somebody to mute. `sig` is the authority key's signature
   * over the room id, the epoch and the list (`signAdmins` in `epoch.ts`),
   * because this channel is one every member can write to and a claim to
   * be the admin list is exactly what a member would forge. A client checks
   * it against the inviter pinned in the link and ignores one that fails.
   * Sent when the keeper starts, on every epoch, and in answer to
   * `catalogue?`.
   */
  | { op: 'admins'; host: string; admins: string[]; epoch: number; sig: string }
  /** An admin: keeper, remove this participant. Acted on only when the
   *  sender is on the announced list; the keeper checks. */
  | { op: 'remove'; participant: string }
  /** An admin: keeper, close the room. */
  | { op: 'close' }
  /**
   * An admin: this participant, please stop sending. A request the target's
   * own client honours by stopping its outgoing tracks, and nothing more:
   * media goes device to device, so nothing in the middle could enforce it,
   * and a client that ignores this is a client that ignores it. Removal is
   * what enforces; this is manners.
   */
  | { op: 'mute'; participant: string }
  /** A member, to the room's keeper: tell me over Nostr when there are new
   *  messages here and I am not. The sender is the message's participant,
   *  bound by its credential like any chat message, so there is nothing to
   *  name. See `Nudger` in src/node/nudge.ts. */
  | { op: 'nudge'; on: boolean }
  /**
   * An agent asking a person for a decision, where everybody can see it
   * asked. `options` are the verdicts it will take, `approve`/`decline`
   * when absent; `expiresAt` is unix seconds after which it stops waiting.
   * Answered by an `approval` from somebody the agent will listen to: a
   * participant on the keeper's announced admin list, or the agent's own
   * verified principal (`AgentOwnership`). Anybody else's answer is
   * ignored, and the agent says so to whoever is driving it.
   */
  | { op: 'approval-request'; id: string; text: string; options?: string[]; expiresAt?: number }
  /** A person's answer to an `approval-request`, one of its options. The
   *  sender is the chat message's credential-bound participant, which is
   *  what makes it a signed answer. */
  | { op: 'approval'; id: string; verdict: string; note?: string }

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MAX_AGENTS = 12
const MAX_ADMINS = 32
/** An approval id: what the agent chose, short and safe to put in a DOM id. */
const APPROVAL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const APPROVAL_OPTION = /^[a-z0-9][a-z0-9 _-]{0,31}$/i
export const MAX_APPROVAL_TEXT = 500
export const MAX_APPROVAL_OPTIONS = 8
export const DEFAULT_APPROVAL_OPTIONS: readonly string[] = ['approve', 'decline']
const MAX_DESCRIPTION = 140

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
}

export function encodeControl(message: ControlMessage): string {
  const text = JSON.stringify(message)
  if (text.length > MAX_CHAT_TEXT_LENGTH) throw new Error('control message too long')
  return text
}

/**
 * Read a control message off the channel. Null for anything that is not
 * one, which includes a person typing into the channel by hand; nothing
 * here throws, because it runs inside a chat listener.
 */
export function decodeControl(text: string): ControlMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const host = typeof m.host === 'string' ? m.host.toLowerCase() : undefined
  const hostOk = host !== undefined && HEX64.test(host)
  const agent = str(m.agent, 32)
  const agentOk = agent !== undefined && ID.test(agent)
  switch (m.op) {
    case 'catalogue?':
      return { op: 'catalogue?' }
    case 'catalogue': {
      if (!hostOk || !Array.isArray(m.agents) || !Array.isArray(m.running)) return null
      const name = str(m.name, 64) ?? 'Agent host'
      const agents: CatalogueEntry[] = []
      for (const e of m.agents.slice(0, MAX_AGENTS)) {
        if (typeof e !== 'object' || e === null) continue
        const x = e as Record<string, unknown>
        const id = str(x.id, 32)
        const n = str(x.name, 64)
        if (!id || !ID.test(id) || !n) continue
        const entry: CatalogueEntry = { id, name: n }
        const d = str(x.description, MAX_DESCRIPTION)
        if (d) entry.description = d
        if (x.listens === true) entry.listens = true
        agents.push(entry)
      }
      const running: RunningAgent[] = []
      for (const e of m.running.slice(0, MAX_AGENTS)) {
        if (typeof e !== 'object' || e === null) continue
        const x = e as Record<string, unknown>
        const id = str(x.id, 32)
        const n = str(x.name, 64)
        if (!id || !ID.test(id) || !n || typeof x.since !== 'number') continue
        const r: RunningAgent = { id, name: n, since: x.since }
        const p = typeof x.participant === 'string' ? x.participant.toLowerCase() : undefined
        if (p && HEX64.test(p)) r.participant = p
        running.push(r)
      }
      return { op: 'catalogue', host: host!, name, agents, running }
    }
    case 'invite':
    case 'dismiss':
      if (!hostOk || !agentOk) return null
      return { op: m.op, host: host!, agent: agent! }
    case 'invited': {
      if (!hostOk || !agentOk) return null
      const name = str(m.name, 64)
      if (!name) return null
      const out: ControlMessage = { op: 'invited', host: host!, agent: agent!, name }
      const p = typeof m.participant === 'string' ? m.participant.toLowerCase() : undefined
      if (p && HEX64.test(p)) out.participant = p
      return out
    }
    case 'dismissed': {
      if (!hostOk || !agentOk) return null
      const name = str(m.name, 64)
      if (!name) return null
      const out: ControlMessage = { op: 'dismissed', host: host!, agent: agent!, name }
      const reason = str(m.reason, MAX_DESCRIPTION)
      if (reason) out.reason = reason
      return out
    }
    case 'error': {
      if (!hostOk) return null
      const message = str(m.message, MAX_DESCRIPTION)
      if (!message) return null
      const out: ControlMessage = { op: 'error', host: host!, message }
      if (agentOk) out.agent = agent
      return out
    }
    case 'admins': {
      if (!hostOk || !Array.isArray(m.admins) || m.admins.length > MAX_ADMINS) return null
      if (!m.admins.every((a) => typeof a === 'string' && HEX64.test(a.toLowerCase()))) return null
      if (!Number.isSafeInteger(m.epoch) || (m.epoch as number) < 0) return null
      if (typeof m.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(m.sig)) return null
      return {
        op: 'admins',
        host: host!,
        admins: [...new Set((m.admins as string[]).map((a) => a.toLowerCase()))].sort(),
        epoch: m.epoch as number,
        sig: m.sig.toLowerCase(),
      }
    }
    case 'remove':
    case 'mute': {
      const participant = typeof m.participant === 'string' ? m.participant.toLowerCase() : undefined
      if (participant === undefined || !HEX64.test(participant)) return null
      return { op: m.op, participant }
    }
    case 'close':
      return { op: 'close' }
    case 'approval-request': {
      const id = str(m.id, 64)
      const text = str(m.text, MAX_APPROVAL_TEXT)
      if (!id || !APPROVAL_ID.test(id) || !text) return null
      const out: ControlMessage = { op: 'approval-request', id, text }
      if (m.options !== undefined) {
        if (!Array.isArray(m.options) || m.options.length === 0 || m.options.length > MAX_APPROVAL_OPTIONS) return null
        if (!m.options.every((o) => typeof o === 'string' && APPROVAL_OPTION.test(o))) return null
        out.options = [...new Set(m.options as string[])]
      }
      if (m.expiresAt !== undefined) {
        if (!Number.isSafeInteger(m.expiresAt) || (m.expiresAt as number) <= 0) return null
        out.expiresAt = m.expiresAt as number
      }
      return out
    }
    case 'approval': {
      const id = str(m.id, 64)
      const verdict = str(m.verdict, 32)
      if (!id || !APPROVAL_ID.test(id) || !verdict || !APPROVAL_OPTION.test(verdict)) return null
      const out: ControlMessage = { op: 'approval', id, verdict }
      const note = str(m.note, MAX_DESCRIPTION)
      if (note) out.note = note
      return out
    }
    case 'nudge':
      if (typeof m.on !== 'boolean') return null
      return { op: 'nudge', on: m.on }
    default:
      return null
  }
}
