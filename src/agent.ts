import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomSession } from './session.js'
import type { ParticipantView, PublishOptions, SessionTiming } from './session.js'
import type { RelayTransport } from './relay-pool.js'
import { NostrRelayPool } from './relay-pool.js'
import { parseRoomLink, encodeRoomLink } from './link.js'
import type { RoomLink } from './link.js'
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
import { generateRoomSecret } from './room.js'
import { canonicalAdmins, hostRoomEpoch, signAdmins } from './epoch.js'
import type { RekeyNotice, RoomEpoch } from './epoch.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from './control.js'
import { normaliseHex } from './hex.js'
import type { PeerFactory } from './peer.js'
import type { ChatLog, ChatMessage } from './chat.js'
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
  /** How long to wait for replayed rekeys when the responder that admitted
   *  this agent did not say which epoch the room is at. See
   *  `RoomSessionBaseOptions.epochSettleMs`. */
  epochSettleMs?: number
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
  readonly relays: string[]
  /** Who may act on this room, when this agent is its keeper. */
  readonly admins: readonly string[]
  readonly #transport: RelayTransport
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
    transport: RelayTransport
    now: () => number
    keeper?: KeeperState
    admins?: string[]
    onState?: (state: KeeperState) => void | Promise<void>
  }) {
    this.session = fields.session
    this.link = fields.link
    this.url = fields.url
    this.relays = fields.relays
    this.#transport = fields.transport
    this.#now = fields.now
    this.#keeper = fields.keeper
    this.admins = fields.admins ?? []
    this.#onState = fields.onState
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
    let expectedEpoch: number | undefined
    if (link.invitation) {
      const transport = makeTransport(relays)
      try {
        const admission = await requestRoomAdmissionCapability({ transport, invitation: link.invitation, now })
        secret = admission.secret
        authority = { inviterSk: admission.delegate.delegateSk, delegation: admission.delegate.chain }
        expectedEpoch = admission.epoch
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
      expectedEpoch,
    })
  }

  /** Make a room, and keep it. */
  static async create(opts: CreateRoomOptions): Promise<RoomAgent> {
    const relays = opts.relays ?? DEFAULT_RELAYS
    const makeTransport = opts.transport ?? ((r: string[]) => new NostrRelayPool(r))
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000))

    let state = opts.state
    if (state?.closed) throw new Error('this room was closed; delete its state to make a new one')
    if (!state) {
      const host = createRoomInvitation()
      state = { secret: generateRoomSecret(), inviterSk: host.inviterSk, bearer: host.invitation.bearer }
    }
    const epochNumber = state.epoch ?? 0
    state = { ...state, epoch: epochNumber, removed: [...new Set((state.removed ?? []).map(normaliseHex))].sort() }
    const invitation = roomInvitation(state.bearer, getPublicKey(state.inviterSk))
    const link: RoomLink = { invitation, relays, iceUrls: opts.iceUrls ?? [] }
    if (opts.policy) link.policy = opts.policy
    const url = encodeRoomLink(opts.base, link)
    if (epochNumber > 0 && !state.epochSecret) throw new Error('keeper state names an epoch above 0 without its secret')
    const epoch: RoomEpoch | undefined =
      epochNumber > 0 && state.epochSecret ? { epoch: epochNumber, secret: state.epochSecret } : undefined

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
      epoch,
      removed: state.removed,
      admins: canonicalAdmins(opts.admins ?? []),
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
      expectedEpoch?: number
      keeper?: KeeperState
      epoch?: RoomEpoch
      removed?: string[]
      admins?: string[]
      policy?: RoomPolicy
      onState?: (state: KeeperState) => void | Promise<void>
    },
  ): Promise<RoomAgent> {
    const transport = opts.makeTransport(opts.relays)
    let agent: RoomAgent | undefined
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
      epoch: opts.epoch,
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
      relays: opts.relays,
      transport,
      now: opts.now,
      keeper: opts.keeper,
      admins: opts.admins,
      onState: opts.onState,
    })
    // A keeper reopening a room remembers who it removed before the roster
    // can tell it anything. Marked on the session by way of the first
    // rekey notice it would otherwise have missed.
    if (opts.keeper && opts.removed?.length) agent.session.forgetParticipants(opts.removed)

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
          epoch: () => session.epoch,
          onRetired: () => {
            if (agent) agent.#stopHosting()
          },
        })
        agent.#hostTransport = hostTransport
        if (opts.keeper) {
          agent.#epochDesk = hostRoomEpoch({
            transport: hostTransport,
            roomId: session.roomId,
            authoritySk: opts.keeper.inviterSk,
            current: () => session.currentEpoch(),
            removed: () => session.removed,
            closed: () => session.closed,
            policy: opts.link.policy,
            now: opts.now,
          })
        }
      } catch {
        // An expired or malformed delegation removes only this agent's
        // ability to answer newcomers. It is still a member of the room it
        // was admitted to, exactly as the app treats the same case.
        hostTransport.close()
      }
    }
    if (opts.keeper) agent.#openDesk()
    return agent
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
    }
  }

  // -------------------------------------------------------------------------
  // The keeper's desk: host controls over the control channel
  // -------------------------------------------------------------------------

  /** Listen for admins on the control channel, and say who they are. */
  #openDesk(): void {
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
    this.#announceAdmins().catch(() => {})
  }

  async #handleControl(m: ChatMessage, openedAt: number): Promise<void> {
    if (this.#left) return
    // Replayed history: a request from before this keeper opened its desk
    // was for a keeper that is gone, and was acted on then or not at all.
    if (m.sentAt < openedAt - 10) return
    if (m.participant === this.participant) return
    const control = decodeControl(m.text)
    if (!control) return
    switch (control.op) {
      case 'catalogue?':
        await this.#announceAdmins()
        return
      case 'remove':
        if (!this.admins.includes(m.participant)) return
        await this.remove(control.participant, m.participant)
        return
      case 'close':
        if (!this.admins.includes(m.participant)) return
        await this.closeRoom(m.participant)
        return
      default:
        return
    }
  }

  /** Say who may act on this room, signed by the authority key. */
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

  async #persist(): Promise<void> {
    const keeper = this.#keeper
    if (!keeper) return
    const current = this.session.currentEpoch()
    const next: KeeperState = {
      secret: keeper.secret,
      inviterSk: keeper.inviterSk,
      bearer: keeper.bearer,
      epoch: current.epoch,
      removed: [...this.session.removed].sort(),
      ...(current.epoch > 0 ? { epochSecret: current.secret } : {}),
      ...(this.session.closed ? { closed: true } : {}),
    }
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
          encodeInvitationRetirement({ invitation: this.link.invitation, inviterSk: keeper.inviterSk, now: this.#now() }),
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
    this.#stopHosting()
    await this.session.leave()
    this.#transport.close()
  }
}
