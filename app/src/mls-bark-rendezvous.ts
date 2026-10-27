import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { base64urlnopad } from '@scure/base'
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { BrowserPersonaCoordinator, InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { BrowserCoordinatedVaultSignals } from './mls-coordinated-vault.js'
import { readRendezvousProvisionEnvelope } from '../../src/rendezvous-provisioning.js'
import { RendezvousVault, BrowserRendezvousVaultStorage } from './rendezvous-vault.js'

export interface BarkProvisionRequest { v: 1; expectedPersona: string; targetDevice: string; index: number; nonce: string; expiresAt: number }
export interface BarkRendezvousProvider { readonly owner: object; current(): boolean; provision(request: BarkProvisionRequest): Promise<string> }
const captured = new WeakMap<object, BarkRendezvousProvider>()
const HEX = /^[0-9a-f]{64}$/
/** Capture alongside account adoption. This is one typed callable, never an
 * extension key getter, generic RPC or account-key decryption operation. */
export function captureBarkRendezvous(signer: object, persona: string, provider: unknown = (globalThis as any).window?.nostr): void {
  if (captured.has(signer) || (signer as any).method !== 'nip07' || !HEX.test(persona)) return
  const p = provider as any, receiver = p?.heartwood, invoke = receiver?.provisionRendezvousV1
  if (!p || !receiver || typeof invoke !== 'function') return
  const current = () => (globalThis as any).window?.nostr === p && p.heartwood === receiver && receiver.provisionRendezvousV1 === invoke && (signer as any).pubkey === persona
  captured.set(signer, Object.freeze({ owner: receiver, current, async provision(request: BarkProvisionRequest) {
    if (!current() || request.expectedPersona !== persona) throw new Error('The captured Bark account changed. Reconnect before provisioning.')
    const result: unknown = await Reflect.apply(invoke, receiver, [Object.freeze({ ...request })])
    if (!current()) throw new Error('Bark changed while provisioning. No child may be installed.')
    if (typeof result !== 'string' || new TextEncoder().encode(result).length > 8192) throw new Error('Bark returned an unsupported provision envelope.')
    return result
  } }))
}
export function barkRendezvousFor(signer: object): BarkRendezvousProvider | undefined { return captured.get(signer) }
export interface PublicRendezvousDevice { readonly persona: string; readonly device: string }
const devices = new WeakMap<object, () => boolean>()
/** Structural lookalikes confer no custody. Only a protected target read can mint one. */
export function publicRendezvousDeviceCurrent(device: PublicRendezvousDevice, persona: string): boolean {
  try { return device.persona === persona && devices.get(device)?.() === true } catch { return false }
}
export interface BarkRendezvousContext { persona: string; provider: BarkRendezvousProvider; current(): boolean }
const RECORD = bytesToHex(new TextEncoder().encode('kithmoot.rendezvous-target.v1'))
interface Target { version: 1; persona: string; installation: string; scalar: string; device: string }

/** App-owned target scalar stays in a witnessed sealed persona record. Its
 * only secret operation opens a matching purpose-specific provision envelope
 * directly into the existing encrypted rendezvous vault. */
export class BrowserBarkRendezvous {
  readonly #signals = new BrowserCoordinatedVaultSignals()
  constructor(private readonly coordinator: BrowserPersonaCoordinator,
    private readonly source = new RendezvousVault(new BrowserRendezvousVaultStorage()),
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  #live(context: BarkRendezvousContext, revision: string): boolean {
    return context.current() && context.provider.current() && this.#signals.revision() === revision
  }
  async #target(tx: PersonaTransaction, persona: string, create: boolean): Promise<Target> {
    const bytes = await tx.readVault(RECORD)
    if (!bytes) {
      if (!create) throw new Error('The protected rendezvous target is missing. Reopen witness settings.')
      const scalar = secp256k1.utils.randomSecretKey()
      try {
        const target: Target = { version: 1, persona, installation: tx.installation, scalar: bytesToHex(scalar), device: bytesToHex(schnorr.getPublicKey(scalar)) }
        const encoded = new TextEncoder().encode(JSON.stringify(target))
        try { await tx.putVault(RECORD, encoded) } finally { encoded.fill(0) }
        return target
      } finally { scalar.fill(0) }
    }
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Target
      if (Object.keys(value).sort().join(',') !== 'device,installation,persona,scalar,version' || value.version !== 1 || value.persona !== persona || value.installation !== tx.installation || !HEX.test(value.scalar) || !HEX.test(value.device)) throw new Error()
      const scalar = hexToBytes(value.scalar)
      try { if (bytesToHex(schnorr.getPublicKey(scalar)) !== value.device) throw new Error() } finally { scalar.fill(0) }
      return value
    } catch { throw new InvalidPersonaRecord('The protected rendezvous target is unsupported or damaged.') }
    finally { bytes.fill(0) }
  }
  async publicDevice(context: BarkRendezvousContext): Promise<PublicRendezvousDevice> {
    const revision = this.#signals.revision(), current = () => this.#live(context, revision)
    if (!HEX.test(context.persona) || !current()) throw new Error('The Bark rendezvous account is not current.')
    const read = await this.coordinator.transact(context.persona, async tx => {
      const target = await this.#target(tx, context.persona, true)
      try { return { persona: context.persona, device: target.device } } finally { target.scalar = '' }
    }, current)
    if (read.state !== 'active' || !current()) throw new Error('The rendezvous target needs a fresh protected witness check.')
    const device = Object.freeze(read.value)
    devices.set(device, current)
    return device
  }
  async provision(context: BarkRendezvousContext, index: number, expiresAt: number) {
    const revision = this.#signals.revision(), started = this.now(), current = () => this.#live(context, revision) && this.now() >= started && this.now() < expiresAt
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff || !Number.isSafeInteger(started) || !Number.isSafeInteger(expiresAt) || expiresAt <= started || expiresAt - started > 600 || !current()) throw new Error('Choose a current bounded rendezvous provision request.')
    const target = await this.publicDevice(context)
    const prior = await this.source.active(context.persona, target.device)
    try { if (prior && index <= prior.receipt.index) throw new Error('Choose an index newer than the current rendezvous child.') } finally { prior?.wipe() }
    const nonce = crypto.getRandomValues(new Uint8Array(16))
    try {
      const request: BarkProvisionRequest = { v: 1, expectedPersona: context.persona, targetDevice: target.device, index, nonce: base64urlnopad.encode(nonce), expiresAt }
      if (!current() || !publicRendezvousDeviceCurrent(target, context.persona)) throw new Error('The protected provision target changed.')
      const response = await context.provider.provision(request)
      if (!current() || !publicRendezvousDeviceCurrent(target, context.persona)) throw new Error('The provision request expired or its account changed.')
      const expected = { identity: context.persona, device: target.device, nonce, now: this.now() }
      const envelope = readRendezvousProvisionEnvelope(response, expected)
      const publicFields = JSON.parse(response)
      if (!envelope.ok || publicFields.i !== index || publicFields.e !== expiresAt) throw new Error('The provision reply differs from the approved target, index, nonce or expiry.')
      // accept holds the child lock before entering the persona transaction:
      // preserve the established child -> persona lock order.
      const accepted = await this.source.accept(response, { identity: context.persona, device: target.device, nonce, now: this.now() }, {
        decrypt: async (peer, ciphertext) => {
          const opened = await this.coordinator.transact(context.persona, async tx => {
            const saved = await this.#target(tx, context.persona, false)
            if (saved.device !== target.device || !current()) { saved.scalar = ''; throw new Error('The protected provision target changed.') }
            const scalar = hexToBytes(saved.scalar); saved.scalar = ''
            let conversation: Uint8Array | undefined
            try {
              conversation = getConversationKey(scalar, peer)
              const plaintext = decrypt(ciphertext, conversation), inner = JSON.parse(plaintext)
              if (inner.i !== index || inner.e !== expiresAt) throw new Error('The encrypted provision changed the approved index or expiry.')
              return plaintext
            }
            finally { scalar.fill(0); conversation?.fill(0) }
          }, current)
          if (opened.state !== 'active' || !current()) throw new Error('The target decryption was not protected and current.')
          return opened.value
        },
      })
      if (!current() || !publicRendezvousDeviceCurrent(target, context.persona)) throw new Error('The provision result became stale. Reopen the saved child before retrying.')
      if (!accepted.ok) throw new Error(`The encrypted provision was refused (${accepted.reason}).`)
      return accepted.receipt
    } finally { nonce.fill(0) }
  }
}
