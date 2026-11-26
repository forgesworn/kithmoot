import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { BrowserLinkRelay } from './browser-link-relay.js'
import type { BrowserLink, PairedBox } from './browser-link.js'
import { BrowserRoomConsents, planRoomGrants, ROOM_GRANT_TERM, ROOM_READ_KINDS, type RoomConsent } from './browser-room-consent.js'
import { BrowserRoomBarrier } from './browser-room-barrier.js'
import { PUBLIC_ROOM_OPERATIONS } from './public-room-operation.js'

export interface RoomRouteSource extends Pick<BrowserLink, 'resume' | 'boxes' | 'pairedBoxes' | 'openSocket'> {}

export interface RoomActivationInput {
  room: string
  box: PairedBox
  device: string
  scopes: string[]
  aliases: string[]
  /** Already authenticated, current room devices, explicitly shown in UI. */
  guests?: { persona: string; device: string }[]
  readiness: () => Promise<Event>
}
type Store = Pick<BrowserRoomConsents, 'all' | 'put'>
type Barrier = Pick<BrowserRoomBarrier, 'changed' | 'closed'>
type Carrier = (consent: RoomConsent, kinds: number[]) => RelayTransport

/** Durable room activation. Any uncertain acknowledgement retains the same
 * statements and the private-route hold. Resuming repeats immutable events;
 * it never invents another grant ID or restores public routing implicitly. */
export class BrowserRoomActivation {
  constructor(private identity: () => ParticipantIdentity | undefined,
    private link: RoomRouteSource,
    readonly store: Store = new BrowserRoomConsents(), readonly barrier: Barrier = new BrowserRoomBarrier(),
    private carrier: Carrier = (consent, kinds) => new BrowserLinkRelay(link, consent.box, this.#identity(consent.account), { room: consent.room, kinds }),
    private now: () => number = () => Math.floor(Date.now() / 1000),
    private exclusive: <T>(room: string, work: () => Promise<T>) => Promise<T> = async (room, work) => await navigator.locks.request(`kithmoot.room-activation.${room}`, work)) {}

  #identity(account?: string): ParticipantIdentity {
    const identity = this.identity()
    if (!identity || (account && identity.pubkey !== account)) throw new Error('Sign in as this room’s saved account before changing Bothy access.')
    return identity
  }
  async #route(consent: RoomConsent): Promise<void> {
    if (consent.box.eventUrl.startsWith('ws://')) await this.link.resume(consent.account)
    this.#identity(consent.account)
    if (!this.link.boxes().some(b => b.routeId === consent.box.routeId && b.eventUrl === consent.box.eventUrl)) {
      const route = consent.box.eventUrl.startsWith('wss://') ? 'standalone Wok relay' : 'Bothy pairing'
      throw new Error(`The saved ${route} is unavailable. Public routing remains held.`)
    }
  }
  async #save(consent: RoomConsent): Promise<void> { await this.store.put(consent); this.barrier.changed() }
  async activate(input: RoomActivationInput): Promise<void> {
    const account = this.#identity().pubkey
    await this.exclusive(input.room, async () => {
      this.#identity(account)
      let consent = (await this.store.all()).find(c => c.room === input.room && c.account === account)
      if (consent && consent.phase !== 'retired') {
        if (consent.box.routeId !== input.box.routeId || consent.device !== input.device) throw new Error('Finish the saved room transition before choosing another route or device.')
        if (consent.phase === 'withdrawing') throw new Error('Finish withdrawing this room’s grants first.')
        if (!consent.grants.length && consent.expires <= this.now()) {
          consent = { ...consent, phase: 'installing', expires: this.now() + ROOM_GRANT_TERM }
          await this.#save(consent)
        }
        // A member's own selection learns a stream this version carries and an earlier one did not (the room's board).
        // It grants nothing: only the keeper's grant lets this device use it, so the keeper renews first.
        const added = consent.grants.length ? [] : input.scopes.filter(scope => !consent!.scopes.includes(scope))
        if (added.length) {
          consent = { ...consent, scopes: [...consent.scopes, ...added] }
          await this.#save(consent)
        }
      } else {
        const at = this.now()
        const planned = { grants: [] as RoomConsent['grants'], expires: at + ROOM_GRANT_TERM }
        if (input.guests) for (const scope of input.scopes) {
          const plan = await planRoomGrants(this.#identity(account), input.box, scope,
            [{ persona: account, device: input.device }, ...input.guests], at)
          planned.grants.push(...plan.grants); planned.expires = plan.expires
        }
        this.#identity(account)
        consent = { account, room: input.room, box: input.box, device: input.device, scopes: [...input.scopes], aliases: [...input.aliases], phase: 'installing', ...planned }
        await this.#save(consent)
      }
      await this.#install(consent, input.readiness)
    })
  }
  async #install(consent: RoomConsent, readiness: () => Promise<Event>): Promise<void> {
    if (consent.expires <= this.now()) throw new Error('This room’s Bothy permission expired. Renew it before resuming.')
    await this.#route(consent)
    // An exclusive lease proves every cooperating tab released all public
    // sockets. Keep it until active state is durable, including readback.
    await this.#closed(consent, async () => {
      this.#identity(consent.account)
      if (consent.grants.length) await this.#publish(consent, consent.grants.map(g => g.active))
      const event = await readiness()
      this.#identity(consent.account)
      if (!verifyEventUncached(event) || event.kind !== 20461 || event.pubkey !== consent.device || event.tags.filter(t => t[0] === 'd').length !== 1 || !event.tags.some(t => t.length === 2 && t[0] === 'd' && t[1] === consent.room)) throw new Error('Room readiness must be signed by this room’s current device.')
      const pool = this.carrier(consent, [...ROOM_READ_KINDS])
      try { await confirmedReadback(pool, event) } finally { pool.close() }
      this.#identity(consent.account)
      await this.#save({ ...consent, phase: 'active' })
    })
  }
  /** Renews the keeper's grants. `wanted` names streams the room should carry: one this permission does not yet carry
   *  (the room's board, for a route activated by an earlier version) is granted to the devices its room stream is. */
  async renew(room: string, readiness: () => Promise<Event>, wanted: readonly string[] = []): Promise<void> {
    const account = this.#identity().pubkey
    await this.exclusive(room, async () => {
      const consent = (await this.store.all()).find(c => c.account === account && c.room === room)
      if (!consent || consent.phase === 'withdrawing' || consent.phase === 'retired') throw new Error('No renewable room permission is saved.')
      if (!consent.grants.length) throw new Error('Ask the Bothy keeper to renew this device’s grant, then resume the room.')
      const at = this.now()
      const plans = { grants: [] as RoomConsent['grants'], expires: consent.expires }
      // An interrupted renewal already saved the scopes it was granting.
      const scopes = consent.phase === 'renewing' ? consent.scopes : [...consent.scopes, ...wanted.filter(scope => !consent.scopes.includes(scope))]
      const granted = (scope: string) => consent.grants.filter(g => g.active.tags.some(t => t[0] === 'd' && t[1] === scope))
      // One expiry for the whole permission, a stream granted for the first time included.
      const floor = Math.max(0, ...consent.grants.map(g => Number(g.active.tags.find(t => t[0] === 'expiration')?.[1]) + 1))
      if (consent.phase === 'renewing') plans.grants = consent.grants
      else for (const scope of scopes) {
        const previous = granted(scope)
        const selected = (previous.length ? previous : granted(consent.room))
          .map(g => ({ persona: g.active.tags.find(t => t[0] === 'p')![1], device: g.active.tags.find(t => t[0] === 'device')![1] }))
        const planned = await planRoomGrants(this.#identity(account), consent.box, scope, selected, at, previous, floor)
        plans.grants.push(...planned.grants); plans.expires = planned.expires
      }
      this.#identity(account)
      const next: RoomConsent = { ...consent, scopes, ...plans, phase: 'renewing' }
      await this.#save(next)
      await this.#install(next, readiness)
    })
  }
  async withdraw(room: string): Promise<void> {
    const account = this.#identity().pubkey
    await this.exclusive(room, async () => {
      const consent = (await this.store.all()).find(c => c.account === account && c.room === room)
      if (!consent || consent.phase === 'retired') return
      // Never claim server revocation using our clock as the sole evidence.
      // Expired signed withdrawals need a freshly signed bounded expiration.
      const next: RoomConsent = { ...consent, grants: structuredClone(consent.grants), phase: 'withdrawing' }
      for (const plan of next.grants) if (Number(plan.revoked.tags.find(t => t[0] === 'expiration')?.[1]) <= this.now()) {
        const template = { kind: 24242, content: '', created_at: Math.max(this.now(), plan.revoked.created_at + 1),
          tags: plan.revoked.tags.map(t => t[0] === 'expiration' ? ['expiration', String(Math.max(consent.expires, this.now() + 86400))] : t) }
        const event = await this.#identity(account).signEvent(structuredClone(template))
        if (!verifyEventUncached(event) || event.pubkey !== account || event.kind !== template.kind || event.content !== '' || event.created_at !== template.created_at || JSON.stringify(event.tags) !== JSON.stringify(template.tags)) throw new Error('The signer changed the requested grant withdrawal.')
        plan.revoked = event
      }
      this.#identity(account)
      await this.#save(next)
      await this.#route(next)
      await this.#closed(next, async () => {
        this.#identity(account)
        if (next.grants.length) await this.#publish(next, next.grants.map(g => g.revoked))
        // Guest consent has no authority to revoke the keeper’s grant.
        // Its local route is stopped, with no claim of server revocation.
        this.#identity(account)
        await this.#save({ ...next, phase: 'retired' })
      })
    })
  }
  async #publish(consent: RoomConsent, events: Event[]): Promise<void> {
    for (const event of events) {
      const scope = event.tags.find(t => t[0] === 'd')![1]
      const pool = this.carrier({ ...consent, room: scope }, [24242])
      try { this.#identity(consent.account); await pool.publish(event) } finally { pool.close() }
    }
  }
  #closed(consent: RoomConsent, work: () => Promise<void>): Promise<void> {
    const rooms = [...new Set([consent.room, ...consent.scopes, ...consent.aliases.map(a => a.slice(7)), PUBLIC_ROOM_OPERATIONS])].sort()
    const next = (index: number): Promise<void> => index === rooms.length ? work() : this.barrier.closed(rooms[index], () => next(index + 1))
    return next(0)
  }
}

export async function confirmedReadback(pool: RelayTransport, event: Event, timeoutMs = 15_000): Promise<void> {
  let stop: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let received!: () => void
  const read = new Promise<void>((resolve, reject) => { received = resolve; timer = setTimeout(() => reject(new Error('Bothy did not return the exact room readiness event.')), timeoutMs) })
  // Both results are observed even when publication fails first.
  void read.catch(() => {})
  try {
    const room = event.tags.find(t => t[0] === 'd')?.[1]
    if (!room) throw new Error('Missing room readiness scope.')
    stop = pool.subscribe([{ ids: [event.id], kinds: [event.kind], '#d': [room] }], e => { if (e.id === event.id && verifyEventUncached(e)) received() })
    await pool.publish(event)
    await read
  } finally { clearTimeout(timer); stop?.() }
}
