import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Session, VmlsSignRequest, VmlsSnapshot } from '../public/vmls-wasm/vmls_wasm.js'
import { loadMlsEngine } from './mls-engine.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { base64Encode, type ConsentPrompt, type SignLeafBindingRequest, type SignLeafBindingReply, type VaultContext, type VaultResult } from './mls-vault.js'
import { BrowserPersonaCoordinator, InvalidPersonaRecord } from './mls-persona-coordinator.js'
import { BrowserMlsSessionHost, StaleMlsOperation, type HostedMlsResult, type HostedMlsStep, type MlsSessionContext, type MlsSessionEdits } from './mls-session-host.js'
import { appendMlsHistory, createMlsRoom, readMlsRoom, saveMlsRoom, mlsHistory, MlsRoomRefused, type MlsRoomRecord } from './mls-room-store.js'

export interface MlsRoomContext { vault: VaultContext; rendezvousKey: string; current(): boolean }
export type MlsRoomResult<T> = HostedMlsResult<T> | { state: 'refused'; reason: string }
interface EngineStep { snapshot: VmlsSnapshot | null; events: any[]; outbound: any[] }
export interface MlsRoomEffect { events: any[]; outbound: any[]; ack?: any; outcome?: any; session: string }
const hex = (v: string) => /^[0-9a-f]{64}$/.test(v)
const checked = <T>(r: VaultResult<T>): T => { if (!r.ok) throw new MlsRoomRefused(r.refusal); return r.value }
const request = (r: VmlsSignRequest): SignLeafBindingRequest => ({ v: 1, operation: bytesToHex(r.operation), body: base64Encode(r.body), digest: bytesToHex(r.digest), expires_at: Number(r.expiresAt) })
const effect = (s: Session, step: EngineStep, extra = {}): HostedMlsStep<MlsRoomEffect> => ({ snapshot: step.snapshot, value: { session: bytesToHex(s.id()), events: step.events, outbound: step.outbound, ...extra } })

/** Development-only room operations. This is not a box driver: authenticated
 * capability/reply transport, invitation admission and UI remain separate.
 * No constructor loads WASM, opens storage or connects to the network. */
export class BrowserMlsRoomOperations {
  #epoch = 0
  #cancel = new Set<() => void>()
  constructor(private readonly coordinator: BrowserPersonaCoordinator, private readonly vault: CoordinatedMlsVault,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  invalidate(): void { this.#epoch++; for (const cancel of this.#cancel) cancel() }

  async #using<T>(context: MlsRoomContext, work: (scope: {
    host: BrowserMlsSessionHost<Session>; wasm: Awaited<ReturnType<typeof loadMlsEngine>>;
    platform: InstanceType<Awaited<ReturnType<typeof loadMlsEngine>>['Platform']>;
    binding: { credential: any; expiresAt?: bigint }; device: string; credentialId: string;
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
      const value = output = await work({ host, wasm, platform, device: identity.device.device, credentialId: identity.device.credentialId,
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
        if (room.generation !== String(session.generation()) || bytesToHex(session.homeBox()) !== b.homeBox || bytesToHex(session.installation()) !== b.installation) throw new InvalidPersonaRecord('Room and session binding differ')
        if (b.device !== expected.device || b.credentialId !== expected.credentialId || b.rendezvousKey !== expected.rz) throw new MlsRoomRefused('stale-device')
        checked(await this.vault.checkRoomDevice(tx, ctx, b.device, b.credentialId, needsConsent() ? b.homeBox : undefined))
        use(room)
      },
      persist: async (tx, session, value) => {
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
        s => s.prepareUpdate(BigInt(this.now()), { ...scope.binding, homeBox: hexToBytes(room.binding.homeBox), expiresAt: BigInt(expiresAt) }) as VmlsSignRequest,
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
      return scope.host.step(scope.hostContext, id, s => ({ snapshot: null, value: { name: room.name, session: id, generation: String(s.generation()), phase: s.phase(), history: mlsHistory(room), outbox: s.outbox(), watch: s.watchList() } }),
        this.#edits(scope.ctx, scope, id, r => { room = r }))
    })
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
        const previous = room.history.find(m => m.id === 'sent:' + operation)
        if (previous) {
          if (previous.body !== bytesToHex(body)) throw new MlsRoomRefused('replay')
          return { snapshot: null, value: { session: id, events: [], outbound: [], outcome: { type: 'Duplicate' } } }
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
  process(context: MlsRoomContext, id: string, input: { mailbox: Uint8Array; envelope: Uint8Array; receipt?: Uint8Array; homeBox: string; installation: string }): Promise<MlsRoomResult<MlsRoomEffect>> {
    input = { ...input, mailbox: input.mailbox.slice(), envelope: input.envelope.slice(), receipt: input.receipt?.slice() }
    return this.#using<MlsRoomEffect>(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => {
        if (input.homeBox !== room.binding.homeBox || !hex(input.installation)) throw new MlsRoomRefused('wrong-box')
        if (input.installation !== room.binding.installation) return effect(s, s.observeInstallation(BigInt(this.now()), hexToBytes(input.installation)), { ack: { type: 'Keep' } })
        const processed = s.process(BigInt(this.now()), input.mailbox, input.envelope, input.receipt, undefined)
        if (processed.step.events.some((e: any) => e.type === 'Message') && (!processed.step.snapshot || processed.outcome.type !== 'Accepted')) throw new Error('Unwitnessed MLS message')
        return effect(s, processed.step, { ack: processed.ack, outcome: processed.outcome })
      }, this.#edits<MlsRoomEffect>(scope.ctx, scope, id, r => { room = r }, (r, _s, value) => {
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
