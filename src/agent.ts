import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomSession, CONFERENCE_ENDED_MESSAGE } from './session.js'
import { requireRoomEnds } from './expiration.js'
import type { ParticipantView, PublishOptions, SessionTiming } from './session.js'
import type { RelayTransport } from './relay-pool.js'
import { NostrRelayPool, normaliseRelayConfig, MAX_POOL_RELAYS } from './relay-pool.js'
import { invitationRelaysFrom, verifyRoomRelays, withRoomRelays } from './room-relays.js'
import { isQuietPolicy, quietRoomTransport, type QuietRoomOptions, type QuietRoomTransport } from './quiet.js'
import { parseRoomLink, encodeRoomLink } from './link.js'
import type { RoomLink } from './link.js'
import { encodePersistentInvitation, requestPersistentRoomAdmission } from './persistent-invitation.js'
import {
  createRoomInvitation,
  encodeInvitationRetirement,
  hostRoomInvitation,
  requestRoomAdmissionCapability,
  roomInvitation,
} from './invitation.js'
import type { InvitationDelegation } from './invitation.js'
import { localIdentity } from './identity.js'
import type { ParticipantIdentity } from './identity.js'
import { generateRoomSecret, deriveRoom } from './room.js'
import { canonicalAdmins, canonicalChannels, hostRoomEpoch, signAdmins, signChannels, verifyAdmins, verifyChannels } from './epoch.js'
import type { RekeyNotice, RoomEpoch } from './epoch.js'
import { CONTROL_CHANNEL, DEFAULT_APPROVAL_OPTIONS, decodeControl, encodeControl, type ControlMessage } from './control.js'
import { normaliseHex } from './hex.js'
import { randomBytes } from '@noble/hashes/utils'
import type { PeerFactory } from './peer.js'
import type { ChatLog, ChatMessage } from './chat.js'
import type { ChatInvite } from './messages.js'
import type { RemoteTrack } from './mesh.js'
import type { AgentOwnership, ForwarderRef, KindredProof, RoomPolicy, SingularRole, TrackAdvert } from './types.js'
import { parseForwarderRef } from './descriptor.js'
import { verifyAgentOwnership } from './ownership.js'
import { meetingAllows, verifyMeetingPolicy, type MeetingPolicy } from './meeting.js'

/**
 * The relays an agent uses when its link names none. The same three the app
 * defaults to, so a link written without hints lands in the same room from
 * any of them: see the app's note on its list.
 */
export const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom']

/**
 * The relays an agent connects to for a room: the room's own first, then the
 * agent's own, up to `MAX_POOL_RELAYS`, the same order the app uses. The
 * room's are never cut. An agent with neither falls back to the defaults.
 */
export function agentRelayPool(room: readonly string[], own: readonly string[]): string[] {
  const ownConfigs = [...new Set(own)].slice(0, MAX_POOL_RELAYS).map((url) => normaliseRelayConfig([url])[0]!)
  const pool = withRoomRelays(room, ownConfigs).map((relay) => relay.url)
  return pool.length ? pool : [...DEFAULT_RELAYS]
}

/**
 * The channel agents talk to each other on. Every member can open it - see
 * `RoomSession.channel` - which is the point: a person can always read what
 * the agents acting for them are saying to one another.
 */
export const AGENT_CHANNEL = 'agents'

/**
 * The channel a listening agent writes what people SAID into, as
 * transcripts - see `ChatMessage.kind`. Separate from the conversation so
 * the people's chat is not filled with their own words, and so a person
 * can open it when they want it and close it when they do not.
 */
export const TRANSCRIPT_CHANNEL = 'transcript'

/**
 * The channel a scribe writes minutes into: what a call came to, drawn
 * from the transcript, on request or when the call ends. Reserved beside
 * `agents` and `transcript`, and like a transcript it is the writer's
 * claim about what was said - see `docs/agents.md`, "Minutes".
 */
export const MINUTES_CHANNEL = 'minutes'

/**
 * What a keeper holds. Enough to reopen the same room, with the same link,
 * after a restart: the traffic secret, the root inviter key that alone can
 * admit people indefinitely, and the bearer the link carries. A process
 * that persists this is a room that outlives the process.
 *
 * And, since epochs: which epoch the room is in, that epoch's secret, and
 * who has been removed, so a restart reopens the room in the same epoch
 * and keeps refusing the same people. All three absent means epoch 0 and
 * nobody removed, which is what every state written before epochs says.
 */
export interface KeeperState {
  /** New rooms use v3; absent on existing keeper files means retain v2. */
  persistent?: true
  secret: Uint8Array
  inviterSk: Uint8Array
  bearer: Uint8Array
  /** The epoch the room is in. Absent means 0. */
  epoch?: number
  /** The current epoch's secret. Present exactly when `epoch` is above 0. */
  epochSecret?: Uint8Array
  /** Participants removed at any epoch, lower-case hex. */
  removed?: string[]
  /** True once the room was closed. A closed room is not reopened. */
  closed?: boolean
  /** Participants the room knows, lower-case hex: the member list its last
   *  rekey wrote, and everybody seen or let in since. Kept so a restarted
   *  keeper still knows members who have been away since, and writes them
   *  into its next rekey (#207). Absent from state written before. */
  members?: string[]
  /** Participants who asked to be nudged when they miss messages, lower-case
   *  hex. Absent until somebody has. See `Nudger` in src/node/nudge.ts. */
  nudge?: string[]
  /** The room's named channels, beyond the unnamed main chat. Absent until
   *  an admin has opened one. Kept so a keeper restart does not silently
   *  empty a room's channel list and take its conversations off every
   *  client's screen. */
  channels?: string[]
  /** A conference room's end, in unix seconds. Kept so a restarted keeper
   *  re-signs the invitation with the same end, tags what it publishes, and
   *  refuses to reopen the room once it has passed. */
  endsAt?: number
}

/** How this agent takes part in a quiet room, when the link says the room
 *  is one. Omit it and the agent posts as the identity's own device, slot
 *  0, and keeps its used counters for this process only. See `quiet.ts`. */
export type AgentQuietOptions = Partial<Pick<QuietRoomOptions, 'slot' | 'used' | 'onUsed' | 'onPosted' | 'onError' | 'intervalSeconds' | 'lookbackSeconds' | 'schedule' | 'slotOffset'>>

interface CommonAgentOptions {
  quiet?: AgentQuietOptions
  /** What the room calls this agent. */
  name: string
  /** The participant. A fresh local key when omitted, which is a perfectly
   *  good identity for an agent that is here for one room. */
  identity?: ParticipantIdentity
  /** A human integration may derive a private room-scoped identity after
   * admission reveals the room ID. The derivation secret stays in its host. */
  identityForRoom?: (roomId: string) => ParticipantIdentity
  deviceKeyForRoom?: (roomId: string) => Uint8Array
  /** This endpoint's key. Fresh when omitted; per room, as the app keeps
   *  it, so a relay cannot follow one agent from room to room. */
  deviceSk?: Uint8Array
  /** Builds a transport for a relay list. The real pool by default; tests
   *  hand in the simulator. */
  transport?: (relays: string[]) => RelayTransport
  /** Media. Omit for an agent that reads, writes and listens to the chat
   *  only - roster, chat and channels work without it. */
  factory?: PeerFactory
  now?: () => number
  timing?: SessionTiming
  announceJitterMs?: number
  /** How long to wait for replayed rekeys when the responder that admitted
   *  this agent did not say which epoch the room is at. See
   *  `RoomSessionBaseOptions.epochSettleMs`. */
  epochSettleMs?: number
  /** Declare this device an agent in the roster. On by default, and turning
   *  it off is lying to the room about what this is - see
   *  `RosterEntry.agent`. */
  agent?: boolean
  /** Opt in when this driver sends signed request-received markers. */
  requestReceipts?: boolean
  /** What this agent publishes at join. Nothing, by default. */
  tracks?: TrackAdvert[]
  claims?: Partial<Record<SingularRole, number>>
  /** This agent's kindred proof, for a gated room. */
  proof?: KindredProof
  /** This agent's ownership proof: its principal's signed word that it is
   *  theirs, carried on every roster entry and message. See
   *  `docs/agents.md`, "Whose agent is this". */
  owner?: AgentOwnership
}

/** What an agent asks a person to decide. */
export interface ApprovalRequestOptions {
  /** What is being asked. At most 500 characters. */
  text: string
  /** The verdicts the agent will take. `approve` and `decline` by default. */
  options?: string[]
  /** How long to wait. Ten minutes by default. */
  ttlSeconds?: number
  /** A caller's own id, when it has one; random otherwise. */
  id?: string
}

/** The admin's answer that lets an unknown participant in (#207). */
export const LET_IN = 'let in'
/** How long a keeper's "let them in?" question stays open. */
const LET_IN_ASK_SECONDS = 600

/** How an approval request ended. */
export interface ApprovalOutcome {
  id: string
  /** One of the request's options, or `expired` when nobody answered. */
  verdict: string
  /** Who answered. Absent on expiry. */
  by?: string
  note?: string
  /** Unix seconds. */
  at: number
  expired: boolean
}

/** A verdict the agent did not take, and why. */
export interface IgnoredApproval {
  id: string
  by: string
  verdict: string
  reason: 'not an approver' | 'unknown request' | 'not an option' | 'already answered' | 'expired'
}

export interface JoinRoomOptions extends CommonAgentOptions {
  /** The room link, exactly as a person was sent it. */
  link: string
  /** The agent's own relays. They are used after the room's own (the signed
   *  invitation's, else the link's), which are always in the pool first. */
  relays?: string[]
  /**
   * Whether to answer the link for whoever arrives next. On by default: an
   * agent that is always online is the best possible responder, and a room
   * with one in it admits people whether or not the person who created it
   * still has the tab open. Bounded, like every delegation - see
   * `docs/decisions.md` - so a room meant to outlive that bound wants a
   * keeper, not a delegate: see `RoomAgent.create`.
   */
  hostInvitation?: boolean
}

export interface CreateRoomOptions extends CommonAgentOptions {
  /** Where the app is served, for the link: `https://host/j/`. */
  base: string
  /** What the room is called. Rides in the link, so everybody sent it
   *  calls the room the same thing - see `RoomLink.name`. */
  roomName?: string
  relays?: string[]
  iceUrls?: string[]
  policy?: RoomPolicy
  /** A previous keeper's state, to reopen the same room rather than make a
   *  new one. */
  state?: KeeperState
  /** Make a new room a conference room that ends at this time, in unix
   *  seconds: after now and no more than 30 days on. Ignored when `state`
   *  is given, which carries its own. */
  endsAt?: number
  /**
   * Participants who may act on the room through the control channel:
   * remove a member, close the room, ask somebody to mute. The keeper
   * announces the list, signed by the room's authority key, and acts on a
   * signed request from anybody on it. Nobody, by default: a room with no
   * admins is a room only its keeper's operator can act on.
   */
  admins?: string[]
  /** Called with the state to persist whenever it changes: on every epoch,
   *  and on close. A keeper that ignores this reopens in the wrong epoch. */
  onState?: (state: KeeperState) => void | Promise<void>
  /**
   * Forwarders this room may promote to, published in its descriptor by
   * the keeper: at start, after every rekey (the descriptor rides the
   * epoch key), and whenever a device arrives, because the descriptor is
   * an ephemeral kind and a late joiner is never sent what it missed. Each
   * is the line `server/forwarder.mjs` prints. Refused at construction
   * when malformed; see `parseForwarderRef`.
   */
  forwarders?: ForwarderRef[]
}

/**
 * Somebody in the room asking a host to bring an agent in or send it away.
 *
 * `by` is the participant who asked. Every rule about who may do this is a
 * rule about `by`, which is why it is here and why nothing in this file
 * interprets it.
 */
/**
 * A private conversation offered to this agent: the sealed invitation as it
 * came, and who sent it. Opening it takes the agent's participant secret
 * (see `openInvite` in `dm.ts`), which this class does not hold, so the
 * decision and the key both stay with the driver - the same seam as
 * `PresenceRequest`.
 */
export interface AgentInvitation {
  invite: ChatInvite
  /** Who offered it: the participant key on the message. */
  from: string
  /** The sender's name on the message, if they gave one. */
  name?: string
  /** The private room's id, so a driver can recognise one it already opened. */
  room: string
  sentAt: number
}

export interface PresenceRequest {
  op: 'invite' | 'dismiss' | 'catalogue?'
  /** The host addressed, absent on `catalogue?` which addresses everyone. */
  host?: string
  /** The catalogue entry, absent on `catalogue?`. */
  agent?: string
  by: string
}

/**
 * An automated participant, with the same standing in the room as a person.
 *
 * Nothing here drives a browser. An agent reads the same link a person was
 * sent, presents it at the same rendezvous, is admitted by whoever is
 * answering, and joins with the same session a browser tab uses: it is in
 * the roster, it can read and write the chat, it can hold a media
 * connection if it is given one, and it answers the link for the next
 * arrival. The one thing it says that a person does not is `agent: true`,
 * so the people in the room can decide what to send it.
 *
 * Two ways in. `join` takes a link and is an ordinary member: admitted by
 * somebody, and a delegated responder for as long as that delegation
 * lasts. `create` makes the room, holds the root inviter key, and can
 * admit people for as long as it runs - which is what a room that is meant
 * to stay open for days, with people and their agents drifting in and out,
 * needs. That agent is the room's keeper, and `keeperState` is what to
 * persist so a restart reopens the same room on the same link.
 *
 * A keeper is also the room's authority: the one party that can move the
 * room to a new epoch, which is how a member is removed (see `epoch.ts`).
 * It does so on its own operator's say-so, through `remove` and
 * `closeRoom`, and on a signed control message from a participant on its
 * admin list, which it announces to the room.
 */
export class RoomAgent {
  readonly session: RoomSession
  readonly link: RoomLink
  /** The link, as it should be handed to the next person. */
  readonly url: string
  /** The relays this agent is connected to now: the room's first. */
  get relays(): string[] {
    return [...this.#pool]
  }
  #pool: string[]
  /** The room's own relays, fixed when it was made. */
  readonly #fixedRoomRelays: string[]
  /** What the room's authority's newest `relays` op added, and its version. */
  #addedRoomRelays: string[] = []
  #relaysVersion = -1
  readonly #ownRelays: string[]
  /** The transports that dial the pool, moved when the room's relays grow. */
  readonly #pools: RelayTransport[]
  /** Who may act on this room, when this agent is its keeper. */
  readonly admins: readonly string[]
  /** This agent's ownership proof, when it carries one. */
  readonly owner?: AgentOwnership
  /** The admin list as the keeper announced it, verified against the
   *  authority pinned in the link. Empty until heard. */
  readonly #presenceListeners = new Set<(request: PresenceRequest) => void>()
  readonly #announcedAdmins = new Set<string>()
  #announcedAdminsAt = 0
  readonly #announcedChannels = new Set<string>()
  /** The room's meeting policy, newest verified version. */
  #meeting: MeetingPolicy | undefined
  readonly #channelListeners = new Set<(channels: ReadonlySet<string>) => void>()
  #announcedChannelsAt = 0
  /** The keeper's own view of the room's channels, which is what it signs.
   *  On a non-keeper this stays empty and `announcedChannels` is what
   *  matters. */
  readonly #channels = new Set<string>()
  /** Approval requests this agent has open, by id. */
  readonly #approvals = new Map<string, { options: string[]; expiresAt: number; resolve: (o: ApprovalOutcome) => void; timer: ReturnType<typeof setTimeout> }>()
  readonly #approvalListeners = new Set<(outcome: ApprovalOutcome) => void>()
  readonly #ignoredListeners = new Set<(ignored: IgnoredApproval) => void>()
  /** What this keeper's descriptor names. Empty means no descriptor. */
  readonly #forwarders: ForwarderRef[]
  /** Devices this keeper has restated the descriptor to. */
  readonly #described = new Set<string>()
  #describeTimer?: ReturnType<typeof setTimeout>
  #rosterUnsub?: () => void
  #membersUnsub?: () => void
  readonly #transport: RelayTransport
  /** The quiet transport, when this is a quiet room: what still waits to
   *  be posted, and whether this agent may post at all. */
  get quiet(): QuietRoomTransport | undefined {
    const t = this.#transport as Partial<QuietRoomTransport>
    return t.quiet === true ? (t as QuietRoomTransport) : undefined
  }
  readonly #now: () => number
  #hostTransport?: RelayTransport
  #host?: { close(): void }
  #epochDesk?: { close(): void }
  #controlUnsub?: () => void
  #keeper?: KeeperState
  readonly #onState?: (state: KeeperState) => void | Promise<void>
  readonly #epochListeners = new Set<(notice: RekeyNotice) => void>()
  readonly #closedListeners = new Set<(notice: { epoch: number; by?: string }) => void>()
  readonly #removedListeners = new Set<(notice: { epoch: number; by?: string }) => void>()
  #left = false

  private constructor(fields: {
    session: RoomSession
    link: RoomLink
    url: string
    relays: string[]
    room: string[]
    own: string[]
    pools: RelayTransport[]
    transport: RelayTransport
    now: () => number
    keeper?: KeeperState
    admins?: string[]
    owner?: AgentOwnership
    onState?: (state: KeeperState) => void | Promise<void>
    forwarders?: ForwarderRef[]
  }) {
    this.#forwarders = fields.forwarders ?? []
    this.session = fields.session
    this.link = fields.link
    this.url = fields.url
    this.#pool = fields.relays
    this.#fixedRoomRelays = fields.room
    this.#ownRelays = fields.own
    this.#pools = fields.pools
    this.#transport = fields.transport
    this.#now = fields.now
    this.#keeper = fields.keeper
    // A keeper restart must not silently empty the room's channel list and
    // take its conversations off every client's screen.
    for (const name of fields.keeper?.channels ?? []) this.#channels.add(name)
    this.admins = fields.admins ?? []
    this.owner = fields.owner
    this.#onState = fields.onState
  }

  /** Join the room behind `link`. */
  static async join(opts: JoinRoomOptions): Promise<RoomAgent> {
    const link = parseRoomLink(opts.link)
    if (link.pairingCode) {
      throw new Error('this is a pairing link for somebody’s second device, not an invitation to the room')
    }
    const own = opts.relays ?? []
    let room = invitationRelaysFrom(link.relays)
    const makeTransport = opts.transport ?? ((r: string[]) => new NostrRelayPool(r))
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

    let secret: Uint8Array
    let authority: { inviterSk: Uint8Array; delegation: InvitationDelegation[] } | undefined
    let expectedEpoch: number | undefined
    let endsAt: number | undefined
    // Settled before asking, so the request can say who is asking: the host
    // that lets this agent in then knows it, and hands it the room's key even
    // after a removal (#207). A room-scoped identity is known only once the
    // room is, so that request goes unnamed and a member is asked instead.
    const identity = opts.identityForRoom ? undefined : (opts.identity ?? localIdentity(generateSecretKey()))
    if (link.invitation) {
      const transport = makeTransport(agentRelayPool(room, own))
      try {
        const admission = link.invitation.persistent
          ? await requestPersistentRoomAdmission({ transport, invitation: link.invitation })
          : await requestRoomAdmissionCapability({
            transport,
            invitation: link.invitation,
            now,
            ...(identity ? { participant: identity.pubkey } : {}),
          })
        secret = admission.secret
        if ('endsAt' in admission && admission.endsAt !== undefined) {
          if (now() >= admission.endsAt) throw new Error(CONFERENCE_ENDED_MESSAGE)
          endsAt = admission.endsAt
        }
        if ('delegate' in admission) authority = { inviterSk: admission.delegate.delegateSk, delegation: admission.delegate.chain }
        expectedEpoch = admission.epoch
        // The relays the room's inviter signed beat the link's unsigned hints.
        if ('relays' in admission && admission.relays?.length) room = invitationRelaysFrom(admission.relays)
      } finally {
        transport.close()
      }
    } else {
      secret = link.secret as Uint8Array
    }

    return RoomAgent.#start({
      ...opts,
      identity: opts.identityForRoom?.(deriveRoom(secret).roomId) ?? identity,
      deviceSk: opts.deviceKeyForRoom?.(deriveRoom(secret).roomId) ?? opts.deviceSk,
      link,
      url: opts.link,
      room,
      own,
      secret,
      makeTransport,
      now,
      authority: opts.hostInvitation === false ? undefined : authority,
      expectedEpoch,
      endsAt,
    })
  }

  /** Make a room, and keep it. */
  static async create(opts: CreateRoomOptions): Promise<RoomAgent> {
    const relays = opts.relays ?? DEFAULT_RELAYS
    // What the room is made on is fixed, and signed into its invitation.
    const room = invitationRelaysFrom(relays)
    const makeTransport = opts.transport ?? ((r: string[]) => new NostrRelayPool(r))
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

    let state = opts.state
    if (state?.closed) throw new Error('this room was closed; delete its state to make a new one')
    if (!state) {
      const host = createRoomInvitation(true)
      state = { secret: generateRoomSecret(), inviterSk: host.inviterSk, bearer: host.invitation.bearer, persistent: true }
      if (opts.endsAt !== undefined) state.endsAt = requireRoomEnds(opts.endsAt, now())
    }
    if (state.endsAt !== undefined && now() >= state.endsAt) throw new Error(CONFERENCE_ENDED_MESSAGE)
    const epochNumber = state.epoch ?? 0
    state = {
      ...state,
      epoch: epochNumber,
      removed: [...new Set((state.removed ?? []).map(normaliseHex))].sort(),
      ...(state.members ? { members: [...new Set(state.members.map(normaliseHex))].sort() } : {}),
    }
    const invitation = roomInvitation(state.bearer, getPublicKey(state.inviterSk), state.persistent === true)
    const link: RoomLink = { invitation, relays, iceUrls: opts.iceUrls ?? [] }
    if (opts.policy) link.policy = opts.policy
    if (opts.roomName !== undefined) link.name = opts.roomName
    const url = encodeRoomLink(opts.base, link)
    if (epochNumber > 0 && !state.epochSecret) throw new Error('keeper state names an epoch above 0 without its secret')
    // Refused here, before a relay is dialled: a keeper in a room with a
    // descriptor it cannot publish is a forwarder nobody will ever reach.
    const forwarders = (opts.forwarders ?? []).map(parseForwarderRef)
    const epoch: RoomEpoch | undefined =
      epochNumber > 0 && state.epochSecret ? { epoch: epochNumber, secret: state.epochSecret } : undefined

    return RoomAgent.#start({
      ...opts,
      link,
      url,
      room,
      own: relays,
      secret: state.secret,
      makeTransport,
      now,
      authority: { inviterSk: state.inviterSk, delegation: [] },
      keeper: state,
      epoch,
      removed: state.removed,
      admins: canonicalAdmins(opts.admins ?? []),
      forwarders,
    })
  }

  static async #start(
    opts: CommonAgentOptions & {
      link: RoomLink
      url: string
      room: string[]
      own: string[]
      secret: Uint8Array
      makeTransport: (relays: string[]) => RelayTransport
      now: () => number
      authority?: { inviterSk: Uint8Array; delegation: InvitationDelegation[] }
      expectedEpoch?: number
      endsAt?: number
      keeper?: KeeperState
      epoch?: RoomEpoch
      removed?: string[]
      admins?: string[]
      policy?: RoomPolicy
      onState?: (state: KeeperState) => void | Promise<void>
      forwarders?: ForwarderRef[]
    },
  ): Promise<RoomAgent> {
    const identity = opts.identity ?? localIdentity(generateSecretKey())
    const pool = agentRelayPool(opts.room, opts.own)
    const plain = opts.makeTransport(pool)
    // A quiet room's chat rides in drops; the session tells the wrapper
    // the epoch key. Everything else the agent does stays in the open.
    const transport: RelayTransport = isQuietPolicy(opts.link.policy)
      ? quietRoomTransport(plain, { policy: opts.link.policy!, participant: identity.pubkey, slot: 0, now: opts.now, ...opts.quiet })
      : plain
    let agent: RoomAgent | undefined
    const session = new RoomSession({
      transport,
      secret: opts.secret,
      identity,
      deviceSk: opts.deviceSk ?? generateSecretKey(),
      factory: opts.factory,
      policy: opts.link.policy,
      proof: opts.proof,
      name: opts.name,
      agent: opts.agent ?? true,
      requestReceipts: opts.requestReceipts,
      owner: opts.owner,
      now: opts.now,
      timing: opts.timing,
      announceJitterMs: opts.announceJitterMs,
      epoch: opts.epoch,
      endsAt: opts.endsAt ?? opts.keeper?.endsAt,
      authority: opts.link.invitation?.inviter,
      // A keeper is the authority: it holds the epoch and waits for nobody.
      expectedEpoch: opts.keeper ? (opts.epoch?.epoch ?? 0) : opts.expectedEpoch,
      epochSettleMs: opts.epochSettleMs,
      onEpoch: (notice) => {
        if (agent) agent.#onEpoch(notice)
      },
      onRemoved: (notice) => {
        if (agent) agent.#emit(agent.#removedListeners, notice)
      },
      onClosed: (notice) => {
        if (agent) agent.#emit(agent.#closedListeners, notice)
      },
    })
    agent = new RoomAgent({
      session,
      link: opts.link,
      url: opts.url,
      relays: pool,
      room: opts.room,
      own: opts.own,
      pools: [plain],
      transport,
      now: opts.now,
      keeper: opts.keeper,
      admins: opts.admins,
      owner: opts.owner,
      onState: opts.onState,
      forwarders: opts.forwarders,
    })
    // A keeper reopening a room remembers who it removed before the roster
    // can tell it anything. Marked on the session by way of the first
    // rekey notice it would otherwise have missed.
    if (opts.keeper && opts.removed?.length) agent.session.forgetParticipants(opts.removed)
    // And who it knew, so a member away since the restart is still one.
    if (opts.keeper?.members?.length) agent.session.rememberMembers(opts.keeper.members)
    if (opts.keeper) agent.#keepMembers()

    try {
      if (opts.keeper?.persistent && opts.link.invitation) {
        await transport.publish(encodePersistentInvitation({ invitation: opts.link.invitation, roomSecret: opts.secret, inviterSk: opts.keeper.inviterSk, now: opts.now(), endsAt: opts.keeper.endsAt, relays: opts.room.length ? opts.room : undefined }))
      }
      await session.join(opts.tracks ?? [], opts.claims ?? {})
    } catch (err) {
      transport.close()
      throw err
    }

    if (opts.authority && opts.link.invitation) {
      const hostTransport = opts.makeTransport(agent.#pool)
      try {
        agent.#host = hostRoomInvitation({
          transport: hostTransport,
          invitation: opts.link.invitation,
          inviterSk: opts.authority.inviterSk,
          delegation: opts.authority.delegation,
          roomSecret: opts.secret,
          now: opts.now,
          epoch: () => session.epoch,
          // Whoever this keeper's link admits is somebody the room knows,
          // so its epoch desk answers them after a removal too (#207).
          admit: (request) => {
            if (request.participant) session.letIn(request.participant)
            return true
          },
          onRetired: () => {
            if (agent) agent.#stopHosting()
          },
        })
        agent.#hostTransport = hostTransport
        agent.#pools.push(hostTransport)
        if (opts.keeper) {
          const admins = new Set(agent.admins.map((a) => a.toLowerCase()))
          agent.#epochDesk = hostRoomEpoch({
            transport: hostTransport,
            roomId: session.roomId,
            authoritySk: opts.keeper.inviterSk,
            roomKey: deriveRoom(opts.secret).roomKey,
            current: () => session.currentEpoch(),
            removed: () => session.removed,
            // Once the room has removed somebody, its key goes only to people
            // it knows (#207): the member list, the roster, whoever this
            // keeper's link let in, and the room's admins, who may come from
            // a release that predates the admission proof.
            known: (participant) => session.knows(participant) || admins.has(participant.toLowerCase()),
            members: () => session.memberList(),
            // The room's last month, so a newcomer, or a device back after
            // several rekeys, reads it as a member who stayed does.
            past: () => session.pastSecrets(),
            // Sealed by the newest credential the roster has shown for the
            // device, so a copied device heals (see seal.ts).
            credentialFor: (device) => session.credentialFor(device),
            onUnknown: (request) => {
              if (agent) agent.#askAdminsToLetIn(request.participant).catch(() => {})
            },
            closed: () => session.closed,
            policy: opts.link.policy,
            legacyParticipants: new Set(agent.admins),
            now: opts.now,
            expiresAt: opts.keeper.endsAt,
          })
        }
      } catch {
        // An expired or malformed delegation removes only this agent's
        // ability to answer newcomers. It is still a member of the room it
        // was admitted to, exactly as the app treats the same case.
        hostTransport.close()
      }
    }
    agent.#openControl()
    if (opts.keeper && agent.#forwarders.length) agent.#keepDescribing()
    return agent
  }

  // -------------------------------------------------------------------------
  // The keeper's descriptor: where the room may forward to
  // -------------------------------------------------------------------------

  /** Publish now, and again for every device that arrives. Coalesced, so
   *  twenty arrivals cost one descriptor rather than twenty. */
  #keepDescribing(): void {
    this.#describe().catch(() => {})
    for (const view of this.session.participants()) for (const d of view.devices) this.#described.add(d)
    this.#rosterUnsub = this.session.onChange((views) => {
      let arrived = false
      for (const view of views) {
        for (const device of view.devices) {
          if (this.#described.has(device)) continue
          this.#described.add(device)
          if (device !== this.device) arrived = true
        }
      }
      if (!arrived || this.#describeTimer !== undefined) return
      const timer = setTimeout(() => {
        this.#describeTimer = undefined
        this.#describe().catch(() => {})
      }, 200)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.#describeTimer = timer
    })
  }

  async #describe(): Promise<void> {
    if (this.#left || this.session.closed || !this.#forwarders.length) return
    await this.session.publishDescriptor({ forwarders: this.#forwarders })
  }

  /** The forwarders this keeper publishes for its room. */
  get forwarders(): readonly ForwarderRef[] {
    return this.#forwarders
  }

  #stopHosting(): void {
    this.#host?.close()
    this.#host = undefined
    this.#epochDesk?.close()
    this.#epochDesk = undefined
    this.#hostTransport?.close()
    this.#hostTransport = undefined
  }

  #emit<T>(listeners: Set<(notice: T) => void>, notice: T): void {
    for (const cb of [...listeners]) {
      try {
        cb(notice)
      } catch {
        // A listener's problem, not the room's.
      }
    }
  }

  #onEpoch(notice: RekeyNotice): void {
    this.#emit(this.#epochListeners, notice)
    if (this.#keeper) {
      this.#persist().catch(() => {})
      this.#announceAdmins().catch(() => {})
      // The descriptor rode the old epoch's key; whoever moved needs it
      // again under the new one.
      this.#describe().catch(() => {})
    }
  }

  // -------------------------------------------------------------------------
  // The control channel: the keeper's desk, and every agent's ears for who
  // the admins are and for answers to what it asked
  // -------------------------------------------------------------------------

  #openControl(): void {
    const log = this.session.channel(CONTROL_CHANNEL)
    const seen = new Set<string>()
    const openedAt = this.#now()
    this.#controlUnsub = log.onChange((messages) => {
      for (const m of messages) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        this.#handleControl(m, openedAt).catch(() => {})
      }
    })
    if (this.#keeper) this.#announceAdmins().catch(() => {})
    // Not a keeper: ask who the admins are, the way the app does on arrival.
    else log.send(encodeControl({ op: 'catalogue?' })).catch(() => {})
  }

  /**
   * The authority's newest `relays` op adds relays to the pool, as it does in
   * the app: additive, never taking one away, room relays still first, only
   * the pool cap ever leaving one of the agent's own out. Anything unsigned,
   * stale or not from the authority is ignored.
   */
  #adoptRoomRelays(control: Extract<ControlMessage, { op: 'relays' }>, m: ChatMessage): void {
    const authority = this.link.invitation?.inviter
    if (!authority) return
    if (control.version <= this.#relaysVersion) return
    if (!verifyRoomRelays({ roomId: this.roomId, version: control.version, relays: control.relays, sig: control.sig, authority })) return
    this.#relaysVersion = control.version
    this.#addedRoomRelays = invitationRelaysFrom(control.relays)
    const next = agentRelayPool([...new Set([...this.#fixedRoomRelays, ...this.#addedRoomRelays])], this.#ownRelays)
    if (next.join(' ') === this.#pool.join(' ')) return
    this.#pool = next
    for (const transport of this.#pools) {
      try { transport.setRelays?.(next) } catch { /* A closed transport has no pool to move. */ }
    }
  }

  #emitPresence(request: PresenceRequest): void {
    for (const cb of this.#presenceListeners) {
      try {
        cb(request)
      } catch {
        // A driver that throws is not this class's problem to survive badly.
      }
    }
  }

  async #handleControl(m: ChatMessage, openedAt: number): Promise<void> {
    if (this.#left) return
    const control = decodeControl(m.text)
    if (!control) return
    // The admin list is worth reading from history: the keeper said it
    // once, and it is signed, so it is as true replayed as it was live.
    if (control.op === 'admins') {
      const authority = this.link.invitation?.inviter
      if (!authority || control.host !== m.participant || m.sentAt < this.#announcedAdminsAt) return
      if (!verifyAdmins({ roomId: this.roomId, epoch: control.epoch, admins: control.admins, sig: control.sig, authority })) return
      this.#announcedAdmins.clear()
      for (const a of control.admins) this.#announcedAdmins.add(a)
      this.#announcedAdminsAt = m.sentAt
      return
    }
    // Same reasoning as the admin list: signed, so as true replayed as live.
    if (control.op === 'channels') {
      const authority = this.link.invitation?.inviter
      if (!authority || control.host !== m.participant || m.sentAt < this.#announcedChannelsAt) return
      if (!verifyChannels({ roomId: this.roomId, epoch: control.epoch, channels: control.channels, sig: control.sig, authority })) return
      this.#announcedChannels.clear()
      for (const c of control.channels) this.#announcedChannels.add(c)
      this.#announcedChannelsAt = m.sentAt
      this.#emit(this.#channelListeners, new Set(this.#announcedChannels))
      return
    }
    // Meeting mode: signed by the authority, so believed whoever reposted
    // it, replayed or live; the newest version wins.
    if (control.op === 'meeting') {
      const authority = this.link.invitation?.inviter
      if (!authority || (this.#meeting && this.#meeting.version >= control.version)) return
      const policy: MeetingPolicy = { on: control.on, speakers: control.speakers, version: control.version }
      if (!verifyMeetingPolicy({ roomId: this.roomId, policy, sig: control.sig, authority })) return
      this.#meeting = policy
      return
    }
    // The authority's relays op, signed, so as true replayed as live.
    if (control.op === 'relays') {
      this.#adoptRoomRelays(control, m)
      return
    }
    // Replayed history: a request from before this agent opened its ears
    // was for one that is gone, and was acted on then or not at all.
    if (m.sentAt < openedAt - 10) return
    if (m.participant === this.participant) return
    switch (control.op) {
      case 'approval':
        this.#onVerdict(m, control.id, control.verdict, control.note)
        return
      case 'catalogue?':
        if (this.#keeper) {
          await this.#announceAdmins()
          await this.#announceChannels()
        }
        this.#emitPresence({ op: 'catalogue?', by: m.participant })
        return
      case 'invite':
      case 'dismiss':
        // Passed up with the asker's key and no judgement applied. This
        // class does not know whose agent it is running.
        this.#emitPresence({ op: control.op, host: control.host, agent: control.agent, by: m.participant })
        return
      case 'remove':
        if (!this.#keeper || !this.admins.includes(m.participant)) return
        await this.remove(control.participant, m.participant)
        return
      case 'close':
        if (!this.#keeper || !this.admins.includes(m.participant)) return
        await this.closeRoom(m.participant)
        return
      case 'channel':
        if (!this.#keeper || !this.admins.includes(m.participant)) return
        await this.setChannel(control.name, control.open)
        return
      default:
        return
    }
  }

  /** The room's meeting policy, as the authority last signed it, once heard. */
  get meeting(): MeetingPolicy | undefined {
    return this.#meeting
  }

  /**
   * Whether this agent may take in what `participant` says: always, unless
   * the room is in meeting mode and they are not a speaker. The same rule
   * every person's app applies, so an agent in the room - a transcriber
   * above all - hears no more than the people do. A track nobody owns
   * (`participant` undefined) is refused while the meeting is on.
   */
  mayHear(participant: string | undefined): boolean {
    if (!this.#meeting?.on) return true
    return participant !== undefined && meetingAllows(this.#meeting, participant, 'audio')
  }

  /** The admin list as the keeper announced it, once heard. */
  get announcedAdmins(): ReadonlySet<string> {
    return this.#announcedAdmins
  }

  /** Whether a participant's answer counts: on the announced admin list,
   *  or this agent's own verified principal. */
  #isApprover(participant: string): boolean {
    return this.#announcedAdmins.has(participant) || (this.#keeper !== undefined && this.admins.includes(participant)) || (this.owner !== undefined && this.owner.principal === participant && verifyAgentOwnership(this.owner, { agent: this.participant, now: this.#now() }).ok)
  }

  /**
   * Ask a person for a decision, in the room, where everybody can see the
   * question and the answer. Resolves with the first verdict from somebody
   * this agent listens to - an announced admin, or its own principal - or
   * with `expired` when the time runs out. Never rejects for a bad answer:
   * one from anybody else is ignored and reported through
   * `onApprovalIgnored`, so a driver can see who tried.
   */
  async requestApproval(opts: ApprovalRequestOptions): Promise<ApprovalOutcome> {
    const id = opts.id ?? hex(randomBytes(8))
    const options = [...new Set(opts.options?.length ? opts.options : DEFAULT_APPROVAL_OPTIONS)]
    const ttl = opts.ttlSeconds ?? 600
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('ttlSeconds must be positive')
    if (this.#approvals.has(id)) throw new Error(`approval ${id} is already open`)
    const expiresAt = this.#now() + Math.ceil(ttl)
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.#approvals.delete(id)) return
        const expired: ApprovalOutcome = { id, verdict: 'expired', at: this.#now(), expired: true }
        resolve(expired)
        this.#emit(this.#approvalListeners, expired)
      }, ttl * 1000)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.#approvals.set(id, { options, expiresAt, resolve, timer })
    })
    try {
      await this.session
        .channel(CONTROL_CHANNEL)
        .send(encodeControl({ op: 'approval-request', id, text: opts.text, options, expiresAt }))
    } catch (err) {
      const open = this.#approvals.get(id)
      if (open) {
        clearTimeout(open.timer)
        this.#approvals.delete(id)
      }
      throw err
    }
    return outcome
  }

  #onVerdict(m: ChatMessage, id: string, verdict: string, note?: string): void {
    const open = this.#approvals.get(id)
    const ignore = (reason: IgnoredApproval['reason']): void => this.#emit(this.#ignoredListeners, { id, by: m.participant, verdict, reason })
    if (!open) return ignore('unknown request')
    if (!this.#isApprover(m.participant)) return ignore('not an approver')
    if (m.sentAt > open.expiresAt) return ignore('expired')
    if (!open.options.includes(verdict)) return ignore('not an option')
    clearTimeout(open.timer)
    this.#approvals.delete(id)
    const outcome: ApprovalOutcome = { id, verdict, by: m.participant, ...(note ? { note } : {}), at: m.sentAt, expired: false }
    open.resolve(outcome)
    this.#emit(this.#approvalListeners, outcome)
  }

  /** Every outcome of a request this agent made: a verdict, or expiry. */
  /**
   * Presence requests on the control channel: somebody clicking Invite or
   * Dismiss, or asking every host to say its catalogue again.
   *
   * **`by` is the asking participant.** It is carried because the rule about
   * who may bring an agent into a room cannot be enforced without it, and
   * because the sender is already on the message: not carrying it forward is
   * the omission, not adding it. Deciding what to do with `by` is the
   * driver's, not this class's; an agent run for one person and an agent run
   * for a room have different answers and neither belongs here.
   */
  onPresenceRequest(cb: (request: PresenceRequest) => void): () => void {
    this.#presenceListeners.add(cb)
    return () => this.#presenceListeners.delete(cb)
  }

  /**
   * Private invitations addressed to this agent, from the room's chat.
   *
   * A DM is a room of two (docs/messages.md), and the way in is an
   * `invite` on a message in a room both are already in, sealed to the
   * addressee. Replayed history counts: an invitation from before this
   * process started is still a conversation somebody wanted, and a
   * restarted agent that ignored it would have gone quiet on them. The
   * driver dedupes by `room`. Nothing here decides whether to accept.
   */
  onInvite(cb: (invitation: AgentInvitation) => void): () => void {
    const seen = new Set<string>()
    return this.chat.onChange((messages) => {
      for (const m of messages) {
        if (!m.invite || seen.has(m.id)) continue
        seen.add(m.id)
        if (m.invite.to !== this.participant || m.participant === this.participant) continue
        try {
          cb({ invite: m.invite, from: m.participant, room: m.invite.room, sentAt: m.sentAt, ...(m.name ? { name: m.name } : {}) })
        } catch {
          // A driver that throws is not this class's problem to survive badly.
        }
      }
    })
  }

  /** Say something on the control channel: a catalogue, or a refusal. */
  async sendControl(message: ControlMessage): Promise<void> {
    if (this.#left) return
    await this.session.channel(CONTROL_CHANNEL).send(encodeControl(message))
  }

  onApproval(cb: (outcome: ApprovalOutcome) => void): () => void {
    this.#approvalListeners.add(cb)
    return () => this.#approvalListeners.delete(cb)
  }

  /** A verdict this agent did not take, and why. */
  onApprovalIgnored(cb: (ignored: IgnoredApproval) => void): () => void {
    this.#ignoredListeners.add(cb)
    return () => this.#ignoredListeners.delete(cb)
  }

  /** Say who may act on this room, signed by the authority key. */
  /** The channels the keeper announced, once heard. Empty on a room whose
   *  keeper has never opened one. */
  get announcedChannels(): ReadonlySet<string> {
    return this.#announcedChannels
  }

  onChannels(cb: (channels: ReadonlySet<string>) => void): () => void {
    this.#channelListeners.add(cb)
    return () => this.#channelListeners.delete(cb)
  }

  /**
   * Open or close a named channel. Keeper only.
   *
   * Idempotent: opening one that is already open, or closing one that was
   * never open, changes nothing and announces nothing, so a client that
   * retries a request it is unsure about does not make the room flicker.
   */
  async setChannel(name: string, open: boolean): Promise<void> {
    if (!this.#keeper) return
    const [canonical] = canonicalChannels([name])
    const had = this.#channels.has(canonical!)
    if (had === open) return
    if (open) this.#channels.add(canonical!)
    else this.#channels.delete(canonical!)
    await this.#persist()
    await this.#announceChannels()
  }

  async #announceChannels(): Promise<void> {
    const keeper = this.#keeper
    if (!keeper || this.#left || this.session.closed) return
    const channels = canonicalChannels([...this.#channels])
    const epoch = this.session.epoch
    try {
      await this.session.channel(CONTROL_CHANNEL).send(
        encodeControl({
          op: 'channels',
          host: this.participant,
          channels,
          epoch,
          sig: signChannels({ roomId: this.roomId, epoch, channels, authoritySk: keeper.inviterSk }),
        }),
      )
    } catch {
      // Same as the admin list: re-announced on the next `catalogue?`.
    }
  }

  async #announceAdmins(): Promise<void> {
    const keeper = this.#keeper
    if (!keeper || this.#left || this.session.closed) return
    const admins = [...this.admins]
    const epoch = this.session.epoch
    try {
      await this.session.channel(CONTROL_CHANNEL).send(
        encodeControl({
          op: 'admins',
          host: this.participant,
          admins,
          epoch,
          sig: signAdmins({ roomId: this.roomId, epoch, admins, authoritySk: keeper.inviterSk }),
        }),
      )
    } catch {
      // A relay that refused the announcement gets it again on the next
      // `catalogue?`, which every arriving client sends.
    }
  }

  /**
   * Somebody the room does not know asked this keeper for the room's key
   * after a removal (#207): a newcomer on the link, or a removed person
   * under a new key, which no rule about keys can tell apart. A keeper has
   * nobody at it to decide, so it asks the room's admins, as an approval
   * request every admin's app shows as a card; the first admin's
   * `let in` lets them in, and they are handed the key on their next ask.
   * One question per person at a time. With no admins there is nobody to
   * ask, and a member on the web or desktop lets them in instead.
   */
  async #askAdminsToLetIn(participant: string): Promise<void> {
    if (!this.#keeper || this.#left || !this.admins.length) return
    const id = `let-in-${participant.slice(0, 16)}`
    if (this.#approvals.has(id)) return
    const outcome = await this.requestApproval({
      id,
      text: `Somebody new (${participant.slice(0, 8)}…) wants to join. Let them in?`,
      options: [LET_IN, 'decline'],
      ttlSeconds: LET_IN_ASK_SECONDS,
    })
    if (outcome.verdict !== LET_IN || this.#left) return
    this.session.letIn(participant)
    await this.#persist()
  }

  /** Persist again whenever somebody new joins the room's member list, so
   *  a restart does not forget them (#207). */
  #keepMembers(): void {
    let count = this.session.memberList().length
    this.#membersUnsub = this.session.onChange(() => {
      if (this.#left) return
      const now = this.session.memberList().length
      if (now === count) return
      count = now
      this.#persist().catch(() => {})
    })
  }

  async #persist(): Promise<void> {
    const keeper = this.#keeper
    if (!keeper) return
    const current = this.session.currentEpoch()
    const next: KeeperState = {
      secret: keeper.secret,
      inviterSk: keeper.inviterSk,
      bearer: keeper.bearer,
      ...(keeper.persistent ? { persistent: true as const } : {}),
      epoch: current.epoch,
      removed: [...this.session.removed].sort(),
      members: this.session.memberList(),
      ...(current.epoch > 0 ? { epochSecret: current.secret } : {}),
      ...(this.session.closed ? { closed: true } : {}),
      ...(keeper.nudge?.length ? { nudge: keeper.nudge } : {}),
      ...(this.#channels.size ? { channels: canonicalChannels([...this.#channels]) } : {}),
      ...(keeper.endsAt !== undefined ? { endsAt: keeper.endsAt } : {}),
    }
    this.#keeper = next
    await this.#onState?.(next)
  }

  /**
   * Change what the keeper remembers beyond the room itself - today, who
   * asked to be nudged - and persist it through the same `onState` an
   * epoch change goes through, so there is one state file and one writer.
   * Only a keeper has state to amend.
   */
  async amendKeeperState(patch: Pick<KeeperState, 'nudge'>): Promise<void> {
    const keeper = this.#keeper
    if (!keeper) throw new Error('only a keeper has state to amend')
    const nudge = [...new Set(patch.nudge ?? [])].sort()
    const next: KeeperState = { ...keeper }
    if (nudge.length) next.nudge = nudge
    else delete next.nudge
    this.#keeper = next
    await this.#onState?.(next)
  }

  /**
   * Remove a participant: move the room to a new epoch whose secret they
   * are not given. Only the keeper can. `by` names the admin who asked,
   * when one did, and rides in the rekey so everybody can see who acted.
   * Idempotent: removing somebody twice is one epoch, not two.
   */
  async remove(participant: string, by?: string): Promise<void> {
    const keeper = this.#keeper
    if (!keeper) throw new Error('only the keeper can remove a member')
    const target = normaliseHex(participant)
    if (target === this.participant) throw new Error('the keeper cannot remove itself; close the room instead')
    if (this.session.removed.has(target)) return
    await this.session.rekey({ authoritySk: keeper.inviterSk, removed: [target], by })
  }

  /**
   * Close the room: a final epoch with nobody kept, the link retired, the
   * desk shut, and this agent gone. The state is marked closed first, so a
   * process restarted by its supervisor does not reopen what was closed.
   */
  async closeRoom(by?: string): Promise<void> {
    const keeper = this.#keeper
    if (!keeper) throw new Error('only the keeper can close the room')
    if (this.#left || this.session.closed) return
    this.#keeper = { ...keeper, closed: true }
    await this.#onState?.({ ...this.#keeper, epoch: this.session.epoch, removed: [...this.session.removed].sort(), ...(this.session.epoch > 0 ? { epochSecret: this.session.currentEpoch().secret } : {}) })
    if (this.link.invitation) {
      try {
        await (this.#hostTransport ?? this.#transport).publish(
          encodeInvitationRetirement({ invitation: this.link.invitation, inviterSk: keeper.inviterSk, now: this.#now(), endsAt: keeper.endsAt }),
        )
      } catch {
        // Cooperative delegates that miss the tombstone stop when their
        // delegation lapses; nobody they admit can read the room anyway.
      }
    }
    this.#stopHosting()
    await this.session.rekey({ authoritySk: keeper.inviterSk, closed: true, by })
    await this.leave()
  }

  /** Every epoch this agent moves to, and every one it makes. */
  onEpoch(cb: (notice: RekeyNotice) => void): () => void {
    this.#epochListeners.add(cb)
    return () => this.#epochListeners.delete(cb)
  }

  /** The room was closed by its authority. A joiner should leave. */
  onClosed(cb: (notice: { epoch: number; by?: string }) => void): () => void {
    this.#closedListeners.add(cb)
    return () => this.#closedListeners.delete(cb)
  }

  /** This participant was removed. A joiner should leave. */
  onRemoved(cb: (notice: { epoch: number; by?: string }) => void): () => void {
    this.#removedListeners.add(cb)
    return () => this.#removedListeners.delete(cb)
  }

  /** Whether this agent is currently answering the link for newcomers. */
  get hosting(): boolean {
    return this.#host !== undefined
  }

  /** What to persist so a restart reopens this room. Only a keeper has
   *  one; a joiner holds a bounded delegation, not the room. Current as of
   *  the last epoch change; `onState` is told the moment it moves. */
  get keeperState(): KeeperState | undefined {
    return this.#keeper
  }

  get roomId(): string {
    return this.session.roomId
  }

  get participant(): string {
    return this.session.participant
  }

  get device(): string {
    return this.session.device
  }

  /** The people's conversation. */
  get chat(): ChatLog {
    return this.session.chat
  }

  /** Where agents talk to each other. See `AGENT_CHANNEL`. */
  get backchannel(): ChatLog {
    return this.session.channel(AGENT_CHANNEL)
  }

  /** Where a listening agent writes what people said. See
   *  `TRANSCRIPT_CHANNEL`. */
  get transcripts(): ChatLog {
    return this.session.channel(TRANSCRIPT_CHANNEL)
  }

  /** Where a scribe writes minutes. See `MINUTES_CHANNEL`. */
  get minutes(): ChatLog {
    return this.session.channel(MINUTES_CHANNEL)
  }

  channel(name: string): ChatLog {
    return this.session.channel(name)
  }

  /** Who is here, grouped by person. */
  roster(): ParticipantView[] {
    return this.session.participants()
  }

  onRoster(cb: (views: ParticipantView[]) => void): () => void {
    return this.session.onChange(cb)
  }

  onRemoteTrack(cb: (track: RemoteTrack) => void): () => void {
    return this.session.onRemoteTrack(cb)
  }

  publishTracks(tracks: MediaStreamTrack[], opts?: PublishOptions): void {
    this.session.publishTracks(tracks, opts)
  }

  advertise(tracks: TrackAdvert[], claims: Partial<Record<SingularRole, number>> = {}): Promise<void> {
    return this.session.advertise(tracks, claims)
  }

  /** Say goodbye and close everything, hosting included. Resolves once
   *  the farewell has gone out; a process should await it before exiting. */
  async leave(): Promise<void> {
    if (this.#left) return
    this.#left = true
    this.#controlUnsub?.()
    this.#controlUnsub = undefined
    this.#rosterUnsub?.()
    this.#rosterUnsub = undefined
    this.#membersUnsub?.()
    this.#membersUnsub = undefined
    if (this.#describeTimer !== undefined) clearTimeout(this.#describeTimer)
    this.#describeTimer = undefined
    for (const [id, open] of this.#approvals) {
      clearTimeout(open.timer)
      open.resolve({ id, verdict: 'expired', at: this.#now(), expired: true })
    }
    this.#approvals.clear()
    this.#stopHosting()
    await this.session.leave()
    this.#transport.close()
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
