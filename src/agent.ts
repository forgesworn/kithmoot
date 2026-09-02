import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomSession } from './session.js'
import type { ParticipantView, PublishOptions, SessionTiming } from './session.js'
import type { RelayTransport } from './relay-pool.js'
import { NostrRelayPool } from './relay-pool.js'
import { parseRoomLink, encodeRoomLink } from './link.js'
import type { RoomLink } from './link.js'
import { createRoomInvitation, hostRoomInvitation, requestRoomAdmissionCapability, roomInvitation } from './invitation.js'
import type { InvitationDelegation } from './invitation.js'
import { localIdentity } from './identity.js'
import type { ParticipantIdentity } from './identity.js'
import { generateRoomSecret } from './room.js'
import type { PeerFactory } from './peer.js'
import type { ChatLog } from './chat.js'
import type { RemoteTrack } from './mesh.js'
import type { KindredProof, RoomPolicy, SingularRole, TrackAdvert } from './types.js'

/**
 * The relays an agent uses when its link names none. The same three the
 * app defaults to, so a link written without hints lands in the same room
 * from either.
 */
export const DEFAULT_RELAYS = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']

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
 * What a keeper holds. Enough to reopen the same room, with the same link,
 * after a restart: the traffic secret, the root inviter key that alone can
 * admit people indefinitely, and the bearer the link carries. A process
 * that persists this is a room that outlives the process.
 */
export interface KeeperState {
  secret: Uint8Array
  inviterSk: Uint8Array
  bearer: Uint8Array
}

interface CommonAgentOptions {
  /** What the room calls this agent. */
  name: string
  /** The participant. A fresh local key when omitted, which is a perfectly
   *  good identity for an agent that is here for one room. */
  identity?: ParticipantIdentity
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
  /** Declare this device an agent in the roster. On by default, and turning
   *  it off is lying to the room about what this is - see
   *  `RosterEntry.agent`. */
  agent?: boolean
  /** What this agent publishes at join. Nothing, by default. */
  tracks?: TrackAdvert[]
  claims?: Partial<Record<SingularRole, number>>
  /** This agent's kindred proof, for a gated room. */
  proof?: KindredProof
}

export interface JoinRoomOptions extends CommonAgentOptions {
  /** The room link, exactly as a person was sent it. */
  link: string
  /** Relays to use instead of the link's hints. */
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
  relays?: string[]
  iceUrls?: string[]
  policy?: RoomPolicy
  /** A previous keeper's state, to reopen the same room rather than make a
   *  new one. */
  state?: KeeperState
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
 */
export class RoomAgent {
  readonly session: RoomSession
  readonly link: RoomLink
  /** The link, as it should be handed to the next person. */
  readonly url: string
  readonly relays: string[]
  readonly #transport: RelayTransport
  #hostTransport?: RelayTransport
  #host?: { close(): void }
  readonly #keeper?: KeeperState
  #left = false

  private constructor(fields: {
    session: RoomSession
    link: RoomLink
    url: string
    relays: string[]
    transport: RelayTransport
    keeper?: KeeperState
  }) {
    this.session = fields.session
    this.link = fields.link
    this.url = fields.url
    this.relays = fields.relays
    this.#transport = fields.transport
    this.#keeper = fields.keeper
  }

  /** Join the room behind `link`. */
  static async join(opts: JoinRoomOptions): Promise<RoomAgent> {
    const link = parseRoomLink(opts.link)
    if (link.pairingCode) {
      throw new Error('this is a pairing link for somebody’s second device, not an invitation to the room')
    }
    const relays = opts.relays ?? (link.relays.length ? link.relays : DEFAULT_RELAYS)
    const makeTransport = opts.transport ?? ((r: string[]) => new NostrRelayPool(r))
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

    let secret: Uint8Array
    let authority: { inviterSk: Uint8Array; delegation: InvitationDelegation[] } | undefined
    if (link.invitation) {
      const transport = makeTransport(relays)
      try {
        const admission = await requestRoomAdmissionCapability({ transport, invitation: link.invitation, now })
        secret = admission.secret
        authority = { inviterSk: admission.delegate.delegateSk, delegation: admission.delegate.chain }
      } finally {
        transport.close()
      }
    } else {
      secret = link.secret as Uint8Array
    }

    return RoomAgent.#start({
      ...opts,
      link,
      url: opts.link,
      relays,
      secret,
      makeTransport,
      now,
      authority: opts.hostInvitation === false ? undefined : authority,
    })
  }

  /** Make a room, and keep it. */
  static async create(opts: CreateRoomOptions): Promise<RoomAgent> {
    const relays = opts.relays ?? DEFAULT_RELAYS
    const makeTransport = opts.transport ?? ((r: string[]) => new NostrRelayPool(r))
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

    let state = opts.state
    if (!state) {
      const host = createRoomInvitation()
      state = { secret: generateRoomSecret(), inviterSk: host.inviterSk, bearer: host.invitation.bearer }
    }
    const invitation = roomInvitation(state.bearer, getPublicKey(state.inviterSk))
    const link: RoomLink = { invitation, relays, iceUrls: opts.iceUrls ?? [] }
    if (opts.policy) link.policy = opts.policy
    const url = encodeRoomLink(opts.base, link)

    return RoomAgent.#start({
      ...opts,
      link,
      url,
      relays,
      secret: state.secret,
      makeTransport,
      now,
      authority: { inviterSk: state.inviterSk, delegation: [] },
      keeper: state,
    })
  }

  static async #start(
    opts: CommonAgentOptions & {
      link: RoomLink
      url: string
      relays: string[]
      secret: Uint8Array
      makeTransport: (relays: string[]) => RelayTransport
      now: () => number
      authority?: { inviterSk: Uint8Array; delegation: InvitationDelegation[] }
      keeper?: KeeperState
    },
  ): Promise<RoomAgent> {
    const transport = opts.makeTransport(opts.relays)
    const session = new RoomSession({
      transport,
      secret: opts.secret,
      identity: opts.identity ?? localIdentity(generateSecretKey()),
      deviceSk: opts.deviceSk ?? generateSecretKey(),
      factory: opts.factory,
      policy: opts.link.policy,
      proof: opts.proof,
      name: opts.name,
      agent: opts.agent ?? true,
      now: opts.now,
      timing: opts.timing,
      announceJitterMs: opts.announceJitterMs,
    })
    const agent = new RoomAgent({
      session,
      link: opts.link,
      url: opts.url,
      relays: opts.relays,
      transport,
      keeper: opts.keeper,
    })

    try {
      await session.join(opts.tracks ?? [], opts.claims ?? {})
    } catch (err) {
      transport.close()
      throw err
    }

    if (opts.authority && opts.link.invitation) {
      const hostTransport = opts.makeTransport(opts.relays)
      try {
        agent.#host = hostRoomInvitation({
          transport: hostTransport,
          invitation: opts.link.invitation,
          inviterSk: opts.authority.inviterSk,
          delegation: opts.authority.delegation,
          roomSecret: opts.secret,
          now: opts.now,
          onRetired: () => agent.#stopHosting(),
        })
        agent.#hostTransport = hostTransport
      } catch {
        // An expired or malformed delegation removes only this agent's
        // ability to answer newcomers. It is still a member of the room it
        // was admitted to, exactly as the app treats the same case.
        hostTransport.close()
      }
    }
    return agent
  }

  #stopHosting(): void {
    this.#host?.close()
    this.#host = undefined
    this.#hostTransport?.close()
    this.#hostTransport = undefined
  }

  /** Whether this agent is currently answering the link for newcomers. */
  get hosting(): boolean {
    return this.#host !== undefined
  }

  /** What to persist so a restart reopens this room. Only a keeper has
   *  one; a joiner holds a bounded delegation, not the room. */
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

  /** Say goodbye and close everything, hosting included. */
  leave(): void {
    if (this.#left) return
    this.#left = true
    this.#stopHosting()
    this.session.leave()
    this.#transport.close()
  }
}
