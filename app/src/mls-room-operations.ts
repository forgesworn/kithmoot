import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Session, VmlsSignRequest, VmlsEcdhRequest, VmlsSnapshot } from '../public/vmls-wasm/vmls_wasm.js'
import type { RendezvousReceipt, RendezvousVault } from './rendezvous-vault.js'
import { withMlsRendezvous } from './mls-rendezvous-custody.js'
import { loadMlsEngine } from './mls-engine.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { base64Encode, type ConsentPrompt, type SignLeafBindingRequest, type SignLeafBindingReply, type VaultContext, type VaultResult } from './mls-vault.js'
import { BrowserPersonaCoordinator, InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { BrowserMlsSessionHost, StaleMlsOperation, type HostedMlsResult, type HostedMlsStep, type MlsSessionContext, type MlsSessionEdits } from './mls-session-host.js'
import { appendMlsHistory, rememberMlsOrdering, createMlsRoom, readMlsRoom, saveMlsRoom, mlsHistory, mlsRoomIds, MlsRoomRefused, type MlsRoomRecord } from './mls-room-store.js'

export interface MlsRoomContext { vault: VaultContext; rendezvousKey: string; current(): boolean }
export interface MlsJoinOptions {
  operation: string; name: string; homeBox: string; introductionBox: string; adderRz: string; counter: bigint; expiresAt: number
  rendezvous: RendezvousReceipt
}
export type MlsRoomResult<T> = HostedMlsResult<T> | { state: 'refused'; reason: string }
interface EngineStep { snapshot: VmlsSnapshot | null; events: any[]; outbound: any[] }
export interface MlsRoomEffect { events: any[]; outbound: any[]; ack?: any; outcome?: any; session: string; generation: string }
const hex = (v: string) => /^[0-9a-f]{64}(?![\s\S])/.test(v)
const checked = <T>(r: VaultResult<T>): T => { if (!r.ok) throw new MlsRoomRefused(r.refusal); return r.value }
const request = (r: VmlsSignRequest): SignLeafBindingRequest => ({ v: 1, operation: bytesToHex(r.operation), body: base64Encode(r.body), digest: bytesToHex(r.digest), expires_at: Number(r.expiresAt) })
const effect = (s: Session, step: EngineStep, extra = {}): HostedMlsStep<MlsRoomEffect> => ({ snapshot: step.snapshot, value: { session: bytesToHex(s.id()), generation: String(s.generation()), events: step.events, outbound: step.outbound, ...extra } })

/** Development-only room operations. This is not a box driver: authenticated
 * capability/reply transport, invitation admission and UI remain separate.
 * No constructor loads WASM, opens storage or connects to the network. */
export class BrowserMlsRoomOperations {
  #epoch = 0
  #cancel = new Set<() => void>()
  constructor(private readonly coordinator: BrowserPersonaCoordinator, private readonly vault: CoordinatedMlsVault,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  invalidate(): void { this.#epoch++; for (const cancel of this.#cancel) cancel() }

  /** Single-box join ceremony: homeBox is the expected group's box and this
   * leaf's box; introductionBox is explicitly resolved by the invitation.
   * Only an active result releases Introduction bytes. Retry an uncertain
   * adoption by discovering/reopening its saved session, never by rejoining. */
  async join(context: MlsRoomContext, options: MlsJoinOptions, source: RendezvousVault, consent: ConsentPrompt): Promise<MlsRoomResult<MlsRoomEffect>> {
    options = { ...options, rendezvous: { ...options.rendezvous } }
    const ctx = Object.freeze({ ...context.vault }), rz = context.rendezvousKey, epoch = this.#epoch, valid = context.current.bind(context)
    const current = () => epoch === this.#epoch && valid() && this.vault.current(ctx)
    let ownedResult: MlsRoomResult<MlsRoomEffect> | undefined, released = false
    let credentialExpiresAt = 0, deadline = 0
    try {
      if (!hex(options.operation) || options.rendezvous.identity !== ctx.persona || options.rendezvous.rendezvousPubkey !== rz || !hex(options.homeBox) || !hex(options.introductionBox) || !hex(options.adderRz) ||
        typeof options.counter !== 'bigint' || options.counter < 0n || options.counter > 0x7fffffffffffffffn || !Number.isSafeInteger(options.expiresAt) || typeof options.name !== 'string' || options.name.length < 1 || options.name.length > 120) throw new MlsRoomRefused('malformed')
      let releaseCurrent = () => false
      const result = await withMlsRendezvous(source, options.rendezvous, this.now, current, async custody => {
        releaseCurrent = custody.releaseCurrent
        return ownedResult = await this.#using<MlsRoomEffect>({ vault: ctx, rendezvousKey: rz, current: custody.current }, async scope => {
          credentialExpiresAt = scope.credentialExpiresAt
          const { host, wasm, platform, device, credentialId, hostContext } = scope
          const pending = wasm.Session.prepareCapability(platform, BigInt(this.now()), {
            binding: { ...scope.binding, homeBox: hexToBytes(options.homeBox), expiresAt: BigInt(options.expiresAt) },
            expiresAt: BigInt(options.expiresAt), adderRz: hexToBytes(options.adderRz), counter: options.counter,
          })
          let disposed = false, wake!: () => void, timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined
          let cleanupFailure: { error: unknown } | undefined, held: HostedMlsResult<MlsRoomEffect> | undefined
          const cancelled = new Promise<undefined>(resolve => { wake = () => resolve(undefined) })
          const cancel = () => {
            if (disposed) return
            disposed = true
            try { pending.free() } catch (error) { cleanupFailure ??= { error } } finally { wake() }
          }
          this.#cancel.add(cancel)
          try {
            const ask: VmlsSignRequest = pending.signRequest(), dh: VmlsEcdhRequest = pending.ecdhRequest(), typed = request(ask)
            deadline = typed.expires_at
            const ecdh = Object.freeze({ v: 1 as const, operation: bytesToHex(dh.operation), peer_rz: bytesToHex(dh.peerRz), expires_at: Number(dh.expiresAt) })
            if (ecdh.operation !== typed.operation || ecdh.expires_at !== typed.expires_at || ecdh.peer_rz !== options.adderRz) throw new MlsRoomRefused('malformed')
            const live = () => !disposed && scope.current() && custody.current() && this.now() <= typed.expires_at
            const remaining = Math.min(typed.expires_at + 1, options.expiresAt, options.rendezvous.expiresAt) - this.now()
            if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 601) throw new StaleMlsOperation()
            timer = setTimeout(cancel, remaining * 1000)
            // A child mutation in another tab invalidates synchronously, and a
            // bounded poll releases the custody lock even if consent never returns.
            poll = setInterval(() => { if (!live()) cancel() }, 50)
            const sharedAnswer = custody.derive(ecdh)
            const signing = this.vault.signLeafBindingV1(ctx, typed, async s => {
              if (!live()) return 'deny'
              const decision = await consent(s)
              return live() ? decision : 'deny'
            })
            const signed = await Promise.race([signing, cancelled])
            if (!signed || !live()) throw new StaleMlsOperation()
            const reply = checked(signed)
            return held = await host.create({ ...hostContext, current: live }, () => {
              const accepted = checked(this.vault.acceptSignReply(typed, reply))
              if (!live() || accepted.device !== device) throw new StaleMlsOperation()
              const shared = custody.accept(ecdh, sharedAnswer)
              try {
                const made: { session: Session; step: EngineStep } = pending.complete(BigInt(this.now()), ask.operation, hexToBytes(accepted.signature), shared)
                return { session: made.session, step: effect(made.session, made.step) }
              } finally { shared.fill(0) }
            }, {
              validate: async tx => {
                checked(await this.vault.checkRoomDevice(tx, ctx, device, credentialId, options.homeBox))
                for (const id of await mlsRoomIds(tx)) if ((await readMlsRoom(tx, id)).join?.operation === options.operation) throw new MlsRoomRefused('join-exists')
                if (!live()) throw new StaleMlsOperation()
              },
              persist: async (tx, session) => {
                if (session.installation() !== null || session.phase().type !== 'PendingJoin' || bytesToHex(session.homeBox()) !== '00'.repeat(32)) throw new InvalidPersonaRecord('Invalid pending join')
                await createMlsRoom(tx, { version: 1, session: bytesToHex(session.id()), generation: String(session.generation()), name: options.name,
                  binding: { device, credentialId, rendezvousKey: rz, homeBox: options.homeBox, installation: null }, history: [],
                  join: { operation: options.operation, adderRz: options.adderRz, introductionBox: options.introductionBox, counter: String(options.counter), expiresAt: options.expiresAt } })
              },
            })
          } finally {
            if (timer !== undefined) clearTimeout(timer)
            if (poll !== undefined) clearInterval(poll)
            this.#cancel.delete(cancel); cancel()
            if (cleanupFailure) { wipe(held); throw cleanupFailure.error }
          }
        }, options.expiresAt)
      })
      if (result.state === 'active' && (!releaseCurrent() || this.now() >= Math.min(options.expiresAt, credentialExpiresAt) || this.now() > deadline)) return { state: 'pending', reason: 'stale', refused: false }
      released = true
      return result
    } catch (error) { if (error instanceof MlsRoomRefused) return { state: 'refused', reason: error.reason }; throw error }
    finally { if (!released) wipe(ownedResult) }
  }

  /** Recover an uncertain adoption by its stable caller operation, without
   * requiring the expired provisioned child or making another capability. */
  findJoin(context: MlsRoomContext, operation: string): Promise<MlsRoomResult<string | null>> {
    return this.#using<string | null>(context, async scope => {
      if (!hex(operation)) throw new MlsRoomRefused('malformed')
      return this.coordinator.readConfirmed(scope.ctx.persona, async tx => {
        checked(await this.vault.checkRoomDevice(tx, scope.ctx, scope.device, scope.credentialId))
        for (const id of await mlsRoomIds(tx)) {
          const room = await readMlsRoom(tx, id)
          if (room.join?.operation !== operation) continue
          if (room.binding.device !== scope.device || room.binding.credentialId !== scope.credentialId || room.binding.rendezvousKey !== scope.rz) throw new MlsRoomRefused('stale-device')
          return id
        }
        return null
      }, scope.current)
    })
  }

  async #using<T>(context: MlsRoomContext, work: (scope: {
    host: BrowserMlsSessionHost<Session>; wasm: Awaited<ReturnType<typeof loadMlsEngine>>;
    platform: InstanceType<Awaited<ReturnType<typeof loadMlsEngine>>['Platform']>;
    binding: { credential: any; expiresAt?: bigint }; device: string; credentialId: string; credentialExpiresAt: number;
    ctx: VaultContext; current: () => boolean; hostContext: MlsSessionContext; rz: string;
  }) => Promise<HostedMlsResult<T>>, validUntil = Infinity): Promise<MlsRoomResult<T>> {
    const ctx = Object.freeze({ ...context.vault }), rz = context.rendezvousKey, epoch = this.#epoch
    const valid = context.current.bind(context)
    const current = () => epoch === this.#epoch && valid() && this.vault.current(ctx)
    let platform: InstanceType<Awaited<ReturnType<typeof loadMlsEngine>>['Platform']> | undefined
    let cancel: (() => void) | undefined, output: HostedMlsResult<T> | undefined, released = false
    const close = () => {
      const stopping = cancel; cancel = undefined
      try { if (stopping) { this.#cancel.delete(stopping); stopping() } }
      finally { const freeing = platform; platform = undefined; freeing?.free() }
    }
    try {
      if (!current()) throw new StaleMlsOperation()
      if (!hex(rz)) throw new MlsRoomRefused('malformed')
      const identity = checked(await this.vault.credential(ctx)), wasm = await loadMlsEngine()
      if (!current()) throw new StaleMlsOperation()
      const live = () => current() && this.now() < Math.min(identity.device.credentialExpiresAt, validUntil)
      platform = new wasm.Platform(hexToBytes(identity.device.device), hexToBytes(rz), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
      const host = new BrowserMlsSessionHost(this.coordinator, (id, plaintext, mark) => wasm.Session.open(platform!, id, plaintext, mark))
      cancel = () => host.invalidate(); this.#cancel.add(cancel)
      const c = identity.credential
      const value = output = await work({ host, wasm, platform, device: identity.device.device, credentialId: identity.device.credentialId, credentialExpiresAt: identity.device.credentialExpiresAt,
        binding: { credential: { pubkey: hexToBytes(c.pubkey), createdAt: BigInt(c.created_at), tags: structuredClone(c.tags), content: c.content, sig: hexToBytes(c.sig) } },
        ctx, current: live, hostContext: { persona: ctx.persona, current: live }, rz })
      close()
      if (!live()) return { state: 'pending', reason: 'stale', refused: false }
      released = true
      return value
    } catch (error) {
      if (error instanceof MlsRoomRefused) return { state: 'refused', reason: error.reason }
      if (error instanceof StaleMlsOperation) return { state: 'pending', reason: 'stale', refused: false }
      throw error
    } finally {
      try { close() } finally { if (!released) wipe(output) }
    }
  }

  /** Caller supplies a box identity and installation from authenticated
   * capabilities. This API does not claim those transport checks itself. */
  create(context: MlsRoomContext, options: { name: string; homeBox: string; installation: string; expiresAt: number }, consent: ConsentPrompt): Promise<MlsRoomResult<MlsRoomEffect>> {
    options = { ...options }
    return this.#using<MlsRoomEffect>(context, async scope => {
      const { host, wasm, platform, device, credentialId, ctx, current, hostContext, rz } = scope
      if (!hex(options.homeBox) || !hex(options.installation) || !Number.isSafeInteger(options.expiresAt) || typeof options.name !== 'string' || options.name.length < 1 || options.name.length > 120) throw new MlsRoomRefused('malformed')
      const pending = wasm.Session.prepareCreate(platform, BigInt(this.now()), { ...scope.binding, homeBox: hexToBytes(options.homeBox), expiresAt: BigInt(options.expiresAt) }, hexToBytes(options.installation))
      let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, wake!: () => void
      const cancelled = new Promise<undefined>(resolve => { wake = () => resolve(undefined) })
      let cleanupFailure: { error: unknown } | undefined, held: HostedMlsResult<MlsRoomEffect> | undefined
      const cancel = () => {
        if (disposed) return
        disposed = true
        try { pending.free() } catch (error) { cleanupFailure ??= { error } } finally { wake() }
      }
      this.#cancel.add(cancel)
      try {
        const ask: VmlsSignRequest = pending.request(), typed = request(ask)
        const remaining = Number(ask.expiresAt) - this.now()
        if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 600) throw new StaleMlsOperation()
        timer = setTimeout(cancel, (remaining + 1) * 1000)
        const signed = await Promise.race([this.vault.signLeafBindingV1(ctx, typed, consent), cancelled])
        if (!signed || disposed || !current()) throw new StaleMlsOperation()
        const reply = checked(signed)
        const live = () => !disposed && current() && this.now() <= typed.expires_at && this.now() < options.expiresAt
        return held = await host.create({ ...hostContext, current: live }, () => {
          const accepted = checked(this.vault.acceptSignReply(typed, reply))
          if (!live() || accepted.device !== device) throw new StaleMlsOperation()
          const made: { session: Session; step: EngineStep } = pending.complete(BigInt(this.now()), ask.operation, hexToBytes(accepted.signature))
          return { session: made.session, step: effect(made.session, made.step) }
        }, {
          validate: async tx => { checked(await this.vault.checkRoomDevice(tx, ctx, device, credentialId, options.homeBox)) },
          persist: async (tx, session) => {
            const room: MlsRoomRecord = { version: 1, session: bytesToHex(session.id()), generation: String(session.generation()), name: options.name,
              binding: { device, credentialId, rendezvousKey: rz, homeBox: options.homeBox, installation: options.installation }, history: [] }
            await createMlsRoom(tx, room)
          },
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.#cancel.delete(cancel); cancel()
        if (cleanupFailure) { wipe(held); throw cleanupFailure.error }
      }
    }, options.expiresAt)
  }

  #edits<T>(ctx: VaultContext, expected: { device: string; credentialId: string; rz: string }, id: string,
    use: (room: MlsRoomRecord) => void, persist?: (room: MlsRoomRecord, session: Session, value: T) => void,
    needsConsent: () => boolean = () => false): MlsSessionEdits<Session, T> {
    let room: MlsRoomRecord
    return {
      before: async (tx, session) => {
        room = await readMlsRoom(tx, id)
        const b = room.binding
        const installation: Uint8Array | null = session.installation()
        if (room.generation !== String(session.generation()) || bytesToHex(session.homeBox()) !== (b.installation === null ? '00'.repeat(32) : b.homeBox) || (installation === null ? null : bytesToHex(installation)) !== b.installation) throw new InvalidPersonaRecord('Room and session binding differ')
        if (b.device !== expected.device || b.credentialId !== expected.credentialId || b.rendezvousKey !== expected.rz) throw new MlsRoomRefused('stale-device')
        checked(await this.vault.checkRoomDevice(tx, ctx, b.device, b.credentialId, needsConsent() ? b.homeBox : undefined))
        use(room)
      },
      persist: async (tx, session, value) => {
        const events = (value as Partial<MlsRoomEffect> | undefined)?.events
        if (events) rememberMlsOrdering(room, events)
        persist?.(room, session, value)
        room.generation = String(session.generation())
        await saveMlsRoom(tx, room)
      },
    }
  }

  update(context: MlsRoomContext, id: string, expiresAt: number, consent: ConsentPrompt): Promise<MlsRoomResult<MlsRoomEffect>> {
    return this.#using<MlsRoomEffect>(context, async scope => {
      if (!Number.isSafeInteger(expiresAt)) throw new MlsRoomRefused('malformed')
      let room: MlsRoomRecord, typed: SignLeafBindingRequest, signed: SignLeafBindingReply, signatureReturned = false
      return scope.host.signedStep({ ...scope.hostContext, current: () => scope.current() && this.now() < expiresAt }, id,
        s => { if (room.binding.installation === null) throw new MlsRoomRefused('not-joined'); return s.prepareUpdate(BigInt(this.now()), { ...scope.binding, homeBox: hexToBytes(room.binding.homeBox), expiresAt: BigInt(expiresAt) }) as VmlsSignRequest },
        async ask => { typed = request(ask); signed = checked(await this.vault.signLeafBindingV1(scope.ctx, typed, consent)); signatureReturned = true; return signed },
        (s, ask) => {
          const reply = checked(this.vault.acceptSignReply(typed, signed))
          if (reply.device !== scope.device || this.now() >= expiresAt) throw new StaleMlsOperation()
          return effect(s, s.completeUpdate(BigInt(this.now()), ask.operation, hexToBytes(reply.signature)))
        }, this.#edits(scope.ctx, scope, id, r => { room = r }, undefined, () => signatureReturned), this.now)
    }, expiresAt)
  }

  read(context: MlsRoomContext, id: string) {
    return this.#using(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => ({ snapshot: null, value: { name: room.name, session: id, generation: String(s.generation()), phase: s.phase(), updateRequired: s.updateRequired(), join: room.join, history: mlsHistory(room), outbox: s.outbox(), watch: s.watchList() } }),
        this.#edits(scope.ctx, scope, id, r => { room = r }))
    })
  }

  /** Minimal witnessed state for one driver round. No chat plaintext. */
  driverState(context: MlsRoomContext, id: string): Promise<MlsRoomResult<MlsDriverState>> {
    return this.#using<MlsDriverState>(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => ({ snapshot: null, value: {
        generation: String(s.generation()), phase: s.phase(), epoch: s.epoch() as bigint | null,
        binding: room.binding, join: room.join, ordering: room.ordering ?? [], outbox: s.outbox() as MlsOutbound[], watch: s.watchList() as MlsWatch[],
      } }), this.#edits(scope.ctx, scope, id, r => { room = r }))
    })
  }

  /** Fresh, exact-room confirmation for unjournalled box authentication.
   * Normal session cleanup invalidates its short-lived confirmation; this
   * separate transaction owns no engine handle and closes before signing. */
  async confirmTransport(context: MlsRoomContext, id: string, expected: { generation: string; homeBox: string }): Promise<MlsRoomResult<void>> {
    const ctx = Object.freeze({ ...context.vault }), rz = context.rendezvousKey, epoch = this.#epoch, valid = context.current.bind(context)
    expected = { ...expected }
    const current = () => epoch === this.#epoch && valid() && this.vault.current(ctx)
    try {
      return await this.coordinator.transact(ctx.persona, async tx => {
        const room = await readMlsRoom(tx, id), b = room.binding
        if (room.generation !== expected.generation) throw new StaleMlsOperation()
        if (b.homeBox !== expected.homeBox || b.rendezvousKey !== rz) throw new MlsRoomRefused('wrong-box')
        checked(await this.vault.checkRoomDevice(tx, ctx, b.device, b.credentialId))
      }, current)
    } catch (error) {
      if (error instanceof StaleMlsOperation) return { state: 'pending', reason: 'stale', refused: false }
      if (error instanceof MlsRoomRefused) return { state: 'refused', reason: error.reason }
      throw error
    }
  }

  /** Every network answer is conditional on the predecessor that authorised
   * its request. Reconcile and check inside the persona lock, never retarget a
   * delayed answer to a newer session. No box I/O in this transaction. */
  drive(context: MlsRoomContext, id: string, guard: MlsDriverGuard, command: MlsDriverCommand): Promise<MlsRoomResult<MlsRoomEffect>> {
    guard = { ...guard }; command = structuredClone(command)
    return this.#using<MlsRoomEffect>(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => {
        if (guard.generation !== String(s.generation())) throw new StaleMlsOperation()
        if (guard.homeBox !== room.binding.homeBox || !hex(guard.installation)) throw new MlsRoomRefused('wrong-box')
        if (command.type !== 'installation' && room.binding.installation !== null && guard.installation !== room.binding.installation) throw new MlsRoomRefused('wrong-installation')
        try {
          const now = BigInt(this.now())
          switch (command.type) {
            case 'installation': return effect(s, ['Active', 'NeedsRecovery'].includes(s.phase().type) ? s.observeInstallation(now, hexToBytes(guard.installation)) : { snapshot: null, events: [], outbound: [] })
            case 'tick': return effect(s, s.tick(now))
            case 'delivered':
              if (!command.records.length || command.records.some(id => !s.outbox().some((r: MlsOutbound) => bytesToHex(r.recordId) === bytesToHex(id)))) throw new StaleMlsOperation()
              return effect(s, s.outboundDelivered(command.records))
            case 'deposit': return effect(s, s.depositResult(now, command.attempt, command.receipt))
            case 'slot': return effect(s, s.slotStatus(now, command.attempt, command.status, command.receipt))
            case 'receipt':
              if (command.receipt.length !== 197 || bytesToHex(command.receipt.subarray(65, 97)) !== command.slot) throw new MlsRoomRefused('wrong-slot')
              if (!room.ordering?.some(q => q.slot === command.slot && q.attempt === command.attempt)) throw new StaleMlsOperation()
              // A failed signature/association leaves the durable query pending.
              return effect(s, s.observeReceipt(now, command.receipt))
            case 'drained': return effect(s, s.mailboxDrained(command.mailbox))
          }
        } catch (error) {
          if ((error as any)?.kind === 'engine') throw new MlsRoomRefused('engine:' + (error as any).code)
          throw error
        }
      }, this.#edits<MlsRoomEffect>(scope.ctx, scope, id, r => { room = r }, r => {
        if (command.type === 'receipt') r.ordering = r.ordering?.filter(q => q.slot !== command.slot || q.attempt !== command.attempt)
      }))
    }).finally(() => wipe(command))
  }

  rename(context: MlsRoomContext, id: string, name: string): Promise<MlsRoomResult<void>> {
    return this.#using(context, async scope => {
      if (typeof name !== 'string' || name.length < 1 || name.length > 120) throw new MlsRoomRefused('malformed')
      return scope.host.step(scope.hostContext, id, () => ({ snapshot: null, value: undefined }), this.#edits(scope.ctx, scope, id, () => undefined, r => { r.name = name }))
    })
  }

  /** A stable caller operation id makes an uncertain local send idempotent.
   * Reusing it for different bytes refuses; ids are never silently evicted. */
  send(context: MlsRoomContext, id: string, operation: string, body: Uint8Array): Promise<MlsRoomResult<MlsRoomEffect>> {
    body = body.slice()
    return this.#using<MlsRoomEffect>(context, async scope => {
      if (!hex(operation)) throw new MlsRoomRefused('malformed')
      let room: MlsRoomRecord, message: { leaf: string; epoch: string } | undefined
      return scope.host.step(scope.hostContext, id, s => {
        if (room.binding.installation === null) throw new MlsRoomRefused('not-joined')
        if (s.updateRequired()) throw new MlsRoomRefused('update-required')
        const previous = room.history.find(m => m.id === 'sent:' + operation)
        if (previous) {
          if (previous.body !== bytesToHex(body)) throw new MlsRoomRefused('replay')
          return { snapshot: null, value: { session: id, generation: String(s.generation()), events: [], outbound: [], outcome: { type: 'Duplicate' } } }
        }
        message = { leaf: bytesToHex(s.ownLeafId()), epoch: String(s.epoch()) }
        return effect(s, s.send(body))
      }, this.#edits(scope.ctx, scope, id, r => { room = r }, r => {
        if (message) appendMlsHistory(r, { id: 'sent:' + operation, direction: 'sent', ...message, body })
      }))
    }).finally(() => body.fill(0))
  }

  /** The driver must verify the box reply, requested mailbox and receipt
   * framing before this call. Only an active result may acknowledge the box. */
  process(context: MlsRoomContext, id: string, input: { mailbox: Uint8Array; envelope: Uint8Array; receipt?: Uint8Array; homeBox: string; installation: string; generation?: string }): Promise<MlsRoomResult<MlsRoomEffect>> {
    input = { ...input, mailbox: input.mailbox.slice(), envelope: input.envelope.slice(), receipt: input.receipt?.slice() }
    return this.#using<MlsRoomEffect>(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => {
        if (input.generation !== undefined && input.generation !== String(s.generation())) throw new StaleMlsOperation()
        if (input.homeBox !== room.binding.homeBox || !hex(input.installation)) throw new MlsRoomRefused('wrong-box')
        if (room.binding.installation !== null && input.installation !== room.binding.installation) return effect(s, s.observeInstallation(BigInt(this.now()), hexToBytes(input.installation)), { ack: { type: 'Keep' } })
        const processed = s.process(BigInt(this.now()), input.mailbox, input.envelope, input.receipt,
          room.binding.installation === null ? { homeBox: hexToBytes(input.homeBox), installation: hexToBytes(input.installation) } : undefined)
        if (s.installation() !== null && bytesToHex(s.homeBox()) !== room.binding.homeBox) throw new MlsRoomRefused('wrong-box')
        if (processed.step.events.some((e: any) => e.type === 'Message') && (!processed.step.snapshot || processed.outcome.type !== 'Accepted')) throw new Error('Unwitnessed MLS message')
        return effect(s, processed.step, { ack: processed.ack, outcome: processed.outcome })
      }, this.#edits<MlsRoomEffect>(scope.ctx, scope, id, r => { room = r }, (r, s, value) => {
        if (r.binding.installation === null && s.installation() !== null) {
          if (!value.events.some(e => e.type === 'Joined') || value.outcome?.type !== 'Accepted') throw new InvalidPersonaRecord('Unwitnessed Welcome binding')
          r.binding.installation = bytesToHex(s.installation())
        }
        for (const event of value.events) if (event.type === 'Message') appendMlsHistory(r, {
          id: 'received:' + bytesToHex(sha256(input.envelope)), direction: 'received', leaf: bytesToHex(event.sender.leafId), epoch: String(event.epoch), body: event.body,
        })
      }))
    }).finally(() => { input.mailbox.fill(0); input.envelope.fill(0); input.receipt?.fill(0) })
  }
}

function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) wipe(v)
}

export interface MlsDriverGuard { generation: string; homeBox: string; installation: string }
export type MlsDriverCommand =
  | { type: 'installation' | 'tick' }
  | { type: 'delivered'; records: Uint8Array[] }
  | { type: 'deposit'; attempt: number; receipt: Uint8Array }
  | { type: 'slot'; attempt: number; status: 'Expired' | 'Void'; receipt: Uint8Array }
  | { type: 'receipt'; slot: string; attempt: number; receipt: Uint8Array }
  | { type: 'drained'; mailbox: Uint8Array }
export type MlsDestination =
  | { type: 'Leaf'; leafId: Uint8Array; homeBox: Uint8Array }
  | { type: 'CommitSlot'; homeBox: Uint8Array; epoch: bigint; attempt: number }
  | { type: 'ForkEvidence'; homeBox: Uint8Array; expiresAt: bigint }
  | { type: 'Introduction'; peerRz: Uint8Array }
  | { type: 'Welcome'; packageId: Uint8Array }
export interface MlsOutbound { recordId: Uint8Array; mailbox: Uint8Array; envelope: Uint8Array; destination: MlsDestination }
export interface MlsWatch { mailbox: Uint8Array; homeBox: Uint8Array | null; kind: { type: 'OwnLeaf' | 'RetainedLeaf' | 'ForkEvidence' | 'Welcome' } | { type: 'CommitSlot'; epoch: bigint; attempt: number } }
export interface MlsDriverState { generation: string; phase: { type: string; reason?: string }; epoch: bigint | null; binding: MlsRoomRecord['binding']; join?: MlsRoomRecord['join']; ordering: { slot: string; attempt: number }[]; outbox: MlsOutbound[]; watch: MlsWatch[] }
