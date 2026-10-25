import { readMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, BrowserPersonaCoordinator, type PersonaReader } from './mls-persona-coordinator.js'
import type { MlsRevocationInboxContext } from './mls-revocation-inbox.js'
import { readMlsRoom } from './mls-room-store.js'
import { loadMlsEngine } from './mls-engine.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { Platform, Session } from '../public/vmls-wasm/vmls_wasm.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'

export interface MlsVerifiedGrantRoom { session: string; leaf: string; name: string; rendezvousKey: string; homeBox: string }

const hex32 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** Fresh witnessed admission only. Approved and terminal requests retain the
 * device hold; request expiry and deferral never retire it. This does not
 * validate a prospective MLS Add or replace an old-client barrier. */
export class BrowserMlsKeeperAdmission {
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>,
    private context: () => MlsRevocationInboxContext | undefined, private vault?: CoordinatedMlsVault,
    private storageScope?: (tx: PersonaReader, node: string, device: string, now: number) => Promise<void>) {}

  /** The device gate is already held by the concrete ledger. Retain the
   * persona lock from fresh genuine roster validation through actual grant
   * settlement. Remove/Update cannot slip between the read and publication.
   * Provisional coordinator callbacks never release external effects. */
  async withVerifiedRoom<T>(keeper: string, sender: string, device: string, room: MlsVerifiedGrantRoom,
    current: () => boolean, effect: (current: () => boolean) => Promise<T>, now: () => number): Promise<T> {
    if (!(this.coordinator instanceof BrowserPersonaCoordinator) || !(this.vault instanceof CoordinatedMlsVault) ||
        !CoordinatedMlsVault.prototype.usesCoordinator.call(this.vault, this.coordinator)) throw new Error('Verified room installation requires the exact concrete persona coordinator and vault.')
    const expected = structuredClone(room), initial = this.context()
    if (![keeper, sender, device, expected?.session, expected?.leaf, expected?.rendezvousKey, expected?.homeBox].every(hex32) ||
        keeper === sender || typeof expected.name !== 'string' || !initial || initial.vault.persona !== keeper) throw new Error('Select a current verified member and keeper room.')
    const scope = { ...initial, vault: { ...initial.vault } }
    let floor = 0, validUntil = Infinity
    const live = () => {
      const next = this.context(), at = now()
      return !!next && current() && scope.current() && scope.foreground() && next.current() && next.foreground() &&
        this.vault!.current(scope.vault) && Number.isSafeInteger(at) && at >= floor && at < validUntil &&
        JSON.stringify(next.vault) === JSON.stringify(scope.vault)
    }
    const result = await this.coordinator.withConfirmedEffect(keeper, async tx => {
      await this.storageScope?.(tx, expected.homeBox, device, now())
      const journal = await readMlsMembership(tx)
      if (journal.inbox && journal.inbox.keeper !== keeper) throw new InvalidPersonaRecord('Keeper admission belongs to another persona')
      if (journal.inbox?.prompts.some(prompt => ['approved', 'done'].includes(prompt.state) && prompt.request.device === device)) throw new Error('This device has a retained keeper revocation hold. Recover with a new device key.')
      // Even a not-yet-committed ordinary Remove retires installation intent.
      if (journal.removals.some(removal => removal.session === expected.session &&
          (removal.kind === 'device' && removal.target === expected.leaf || removal.kind === 'person' && removal.target === sender))) throw new Error('The selected member has a retained removal intent.')
      const savedRoom = await readMlsRoom(tx, expected.session)
      if (savedRoom.keeper !== keeper || savedRoom.name !== expected.name || savedRoom.binding.rendezvousKey !== expected.rendezvousKey ||
          savedRoom.binding.homeBox !== expected.homeBox || savedRoom.binding.installation === null) throw new Error('The reviewed keeper room binding changed.')
      const ownDevice = await CoordinatedMlsVault.prototype.checkRoomDevice.call(this.vault!, tx, scope.vault, savedRoom.binding.device, savedRoom.binding.credentialId)
      if (!ownDevice.ok) throw new Error(`The keeper device is unavailable: ${ownDevice.refusal}.`)
      const saved = await tx.readSession(expected.session)
      if (!saved) throw new InvalidPersonaRecord('The keeper room session is missing')
      let platform: Platform | undefined, session: Session | undefined
      try {
        const wasm = await loadMlsEngine()
        platform = new wasm.Platform(hexToBytes(savedRoom.binding.device), hexToBytes(expected.rendezvousKey), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
        session = wasm.Session.open(platform, hexToBytes(expected.session), saved.plaintext, saved.generation)
        const installation = session.installation()
        if (bytesToHex(session.id()) !== expected.session || session.generation() !== saved.generation || savedRoom.generation !== String(saved.generation) ||
            bytesToHex(session.homeBox()) !== savedRoom.binding.homeBox || !installation || bytesToHex(installation) !== savedRoom.binding.installation) throw new InvalidPersonaRecord('Keeper admission snapshot does not match its room')
        if (session.phase().type !== 'Active') throw new Error('The keeper room is not active.')
        const members = session.members() as any[]
        const own = members.find(info => info.own)
        if (!own || bytesToHex(own.member.identity) !== keeper || bytesToHex(own.member.device) !== savedRoom.binding.device) throw new InvalidPersonaRecord('Keeper admission local identity binding differs')
        const member = members.find(info => bytesToHex(info.member.leafId) === expected.leaf)
        // The pinned engine verifies binding expiry <= credential expiry
        // when admitting/updating each roster leaf. Session.members exposes
        // only that conservative bound, not a separate credential expiry.
        // Checking both bindings therefore also proves both credentials live;
        // the keeper's current vault credential was checked directly above.
        const at = now(), expiries = [own.bindingExpiresAt, member?.bindingExpiresAt].map(value => Number(value))
        if (!member || member.pending || member.own || bytesToHex(member.member.identity) !== sender || bytesToHex(member.member.device) !== device ||
            bytesToHex(member.homeBox) !== expected.homeBox || own.pending || !Number.isSafeInteger(at) || at < 0 ||
            expiries.some(expires => !Number.isSafeInteger(expires) || expires <= at)) throw new Error('The keeper or selected member binding or credential changed or expired.')
        floor = at; validUntil = Math.min(...expiries)
        if (!live()) throw new Error('The keeper account or foreground session changed.')
      } finally { saved.plaintext.fill(0); try { session?.free() } finally { platform?.free() } }
    }, () => effect(live), live)
    if (result.state !== 'active' || !live()) throw new Error('The verified grant installation is held or interrupted. Check its retained ledger before retrying.')
    return result.value
  }

  async assertGrantScope(keeper: string, node: string, device: string, current: () => boolean, now: () => number): Promise<void> {
    if (!this.storageScope) return
    const initial = this.context()
    if (!initial || initial.vault.persona !== keeper || ![keeper,node,device].every(hex32)) throw new Error('Open the current keeper before checking grant scope.')
    const live = () => { const next = this.context(); return current() && initial.current() && initial.foreground() && !!next && next.current() && next.foreground() && JSON.stringify(next.vault) === JSON.stringify(initial.vault) }
    const result = await this.coordinator.transact(keeper, tx => this.storageScope!(tx, node, device, now()), live)
    if (result.state !== 'active' || !live()) throw new Error('A current protected grant scope check is required.')
  }
  async admit(keeper: string, sender: string, device: string, current: () => boolean, node?: string, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<() => boolean> {
    const initial = this.context()
    if (![keeper, sender, device].every(hex32) || !initial || initial.vault.persona !== keeper || !initial.current() || !initial.foreground() || !current()) {
      throw new Error('Open this keeper account in the foreground before installing a grant.')
    }
    const scope = { ...initial, vault: { ...initial.vault } }
    const live = () => {
      const next = this.context()
      return !!next && current() && scope.current() && scope.foreground() && next.current() && next.foreground() &&
        JSON.stringify(next.vault) === JSON.stringify(scope.vault)
    }
    const checked = await this.coordinator.transact(keeper, async tx => {
      if (this.storageScope) {
        if (!hex32(node)) throw new Error('A selected node is required for storage scope exclusion.')
        await this.storageScope(tx, node, device, now())
      }
      const journal = await readMlsMembership(tx)
      if (journal.inbox && journal.inbox.keeper !== keeper) throw new InvalidPersonaRecord('Keeper admission belongs to another persona')
      const hold = journal.inbox?.prompts.find(prompt => ['approved', 'done'].includes(prompt.state) && prompt.request.device === device)
      if (hold) {
        if (hold.request.sender !== sender) throw new Error('This device has a retained keeper hold for another person.')
        throw new Error('This device has a retained keeper revocation hold. Recover with a new device key.')
      }
    }, live)
    if (checked.state !== 'active' || !live()) throw new Error('A fresh witnessed keeper admission check is required.')
    return live
  }
}
