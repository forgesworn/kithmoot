import { adminInvitationPreviewEnabled, loadAdminInvitationEngine } from './mls-admin-invitation-engine.js'
import { readAdminInvitationContext, ADMIN_INVITATION_SIGN_METHOD } from '../../src/vmls/admin-invitation.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import type { VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { normaliseRelayConfig } from '../../src/relay-pool.js'
import type { MlsAccountContext } from './mls-persona-account.js'
import { BrowserMlsRoomForeground, type MlsRoomForegroundResult, type MlsRoomForegroundScope } from './mls-room-foreground.js'
import { BrowserMlsRoomEndpoint } from './mls-room-endpoint.js'
import { BrowserMlsPersonaStore } from './mls-persona-store.js'
import { BrowserPersonaLinks } from './mls-persona-link.js'
import { BrowserPersonaCoordinator } from './mls-persona-coordinator.js'
import { RoomCoordinatedMlsVault } from './mls-room-coordinated-vault.js'
import { BrowserMlsRoomCreateCustody, type MlsRoomCreateDevice, type MlsRoomCreateRendezvous } from './mls-room-create-rendezvous.js'
import { BrowserMlsRoomOperations, type MlsRoomResult, type MlsRoomEffect } from './mls-room-operations.js'
import { mlsRoomIds, readMlsRoom, type MlsRoomBinding } from './mls-room-store.js'
import { BrowserMlsRoomLinkVault } from './mls-room-link-vault.js'
import { BrowserMlsBoxClient } from './mls-box-client.js'
import { BrowserMlsRoomConsent } from './mls-room-consent.js'
import { BrowserMlsRoomCeremonyClock } from './mls-room-ceremony-clock.js'
import { BrowserMlsMessageDriver, type MlsDriverRound } from './mls-message-driver.js'
import { pairedWitnessIdentity } from './mls-writer-identity.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { wipeLinkState } from './browser-link-vault.js'
import { BrowserBarkRendezvous, type BarkRendezvousProvider, type BarkRendezvousContext } from './mls-bark-rendezvous.js'
import { readInvitationRegistrationRequest } from './mls-invitation-package.js'
import { loadInvitationEngine, invitationPreviewEnabled } from './mls-invitation-engine.js'
import { readInvitationContext, INVITATION_SIGN_METHOD } from '../../src/vmls/invitation.js'
import type { InvitationConsentPrompt, AdminInvitationConsentPrompt } from './mls-coordinated-vault.js'
import type { ConsentPrompt, VaultContext } from './mls-vault.js'

export interface MlsRoomDevelopmentContext extends MlsAccountContext {
  authority: {
    readonly owner: object; readonly signEvent: ParticipantIdentity['signEvent']
    readonly crypt?: { readonly owner: object; readonly encrypt: VmlsRevocationIdentity['encrypt']; readonly decrypt: VmlsRevocationIdentity['decrypt'] }
    readonly rendezvous?: MlsRoomCreateDevice
    readonly barkRendezvous?: BarkRendezvousProvider
  }
}
interface Active { account: MlsRoomDevelopmentContext; identity: ParticipantIdentity; scope: MlsRoomForegroundScope; clients: Set<BrowserMlsBoxClient>; drivers: Set<BrowserMlsMessageDriver>; current(): boolean }
interface Services { links: BrowserPersonaLinks; coordinator: BrowserPersonaCoordinator; vault: RoomCoordinatedMlsVault; rooms: BrowserMlsRoomOperations; creation: BrowserMlsRoomCreateCustody; bark: BrowserBarkRendezvous }
const stale = () => new Error('Reopen the development room workflow in the current foreground account.')
const hex = (value: string) => /^[0-9a-f]{64}(?![\s\S])/.test(value)
const routeShape = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(value)
export type MlsRoomCreateView = { state: 'saved'; session: string; generation: string } | { state: 'pending'; reason: string; session?: string } |
  { state: 'held'; reason: string }
export type MlsRoomManualView = { state: 'done'; session: string; generation: string; resolved: number; processed: number; held: number; leafHeld: number; stalled: boolean; limited: boolean } |
  { state: 'held' | 'pending'; reason: string }
function wipe(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (value instanceof ArrayBuffer) new Uint8Array(value).fill(0)
  else if (ArrayBuffer.isView(value)) new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0)
  else for (const item of Object.values(value)) wipe(item, seen)
}
const matches = (next: MlsRoomDevelopmentContext['authority'] | undefined, before: MlsRoomDevelopmentContext['authority']) =>
  !!next && next.owner === before.owner && next.signEvent === before.signEvent &&
  next.crypt?.owner === before.crypt?.owner && next.crypt?.encrypt === before.crypt?.encrypt && next.crypt?.decrypt === before.crypt?.decrypt
  && next.barkRendezvous === before.barkRendezvous && (!before.barkRendezvous || before.barkRendezvous.current())
  && next.rendezvous?.owner === before.rendezvous?.owner && next.rendezvous?.deviceKey === before.rendezvous?.deviceKey &&
  next.rendezvous?.provisionOwner === before.rendezvous?.provisionOwner && next.rendezvous?.provision === before.rendezvous?.provision
async function join(work: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

/** Concrete room-only application composition. Construction performs no I/O.
 * It privately owns endpoint, persona and signer custody; callers cannot supply
 * service substitutes or a grant preparation/readiness mark. Creation has its
 * own exact route/child/readback ceremony. Manual rounds use only an exact
 * saved room and route. Experimental invitation joining has a separate
 * trusted-contact ceremony and exact protected context adoption. */
export class BrowserMlsRoomDevelopmentOwner {
  readonly #foreground = new BrowserMlsRoomForeground()
  readonly #endpoint = new BrowserMlsRoomEndpoint(this.#foreground,
    () => this.#active?.current() ? this.#active.identity : undefined,
    () => !!this.#active?.current() && this.#active.account.mode === 'normal')
  #active?: Active
  #services?: Services
  #epoch = 0
  #stopping: Promise<void> = Promise.resolve()
  readonly #consent: BrowserMlsRoomConsent
  constructor(private readonly context: () => MlsRoomDevelopmentContext | undefined, root: Document = document) {
    this.#consent = new BrowserMlsRoomConsent(root)
  }

  /** Explicit Bark operation; target creation is witnessed before its public
   * key is sent, and the actual encrypted child is installed before release. */
  provisionBark(index: number) {
    const clock = new BrowserMlsRoomCeremonyClock()
    return this.#run(true, async (services, active) => {
      if (!active.account.authority.barkRendezvous) throw new Error('Reconnect this account through a supporting Bark extension.')
      const receipt = await services.bark.provision(this.#barkContext(active), index, (clock.read() ?? 0) + 480)
      return { state: 'saved' as const, receipt }
    }, (result, failure) => {
      if (failure || !clock.current() || Math.floor(Date.now() / 1000) >= result.receipt.expiresAt) throw new Error('The Bark provision result is held. Reopen the saved child before retrying.')
      return result
    }, clock.current)
  }
  #barkContext(active: Active): BarkRendezvousContext {
    const provider = active.account.authority.barkRendezvous
    if (!provider) throw stale()
    return { persona: active.account.persona, provider, current: active.current }
  }

  create(routeId: string, name: string, lifetime: number, experimentalInvitation = false, experimentalAdminInvitation = false): Promise<MlsRoomForegroundResult<MlsRoomCreateView>> {
    if (!routeShape(routeId) || typeof name !== 'string' || !name.trim() || name.length > 120 ||
        !Number.isSafeInteger(lifetime) || lifetime < 3600 || lifetime > 30 * 86400) throw new Error('Choose a saved route, a room name and a lifetime between one hour and thirty days.')
    const selected = Object.freeze({ routeId, name: name.trim(), lifetime })
    const clock = new BrowserMlsRoomCeremonyClock()
    let custody: MlsRoomCreateRendezvous | undefined, client: BrowserMlsBoxClient | undefined, context: VaultContext | undefined
    let candidate: MlsRoomResult<MlsRoomEffect> | undefined, box = '', installation = '', postConfirmed = false
    let bindingExpiresAt = 0, credentialExpiresAt = 0
    const pending = (reason: string): MlsRoomCreateView => ({ state: 'pending', reason,
      ...(candidate?.state === 'active' ? { session: candidate.value.session } : {}) })
    return this.#run<MlsRoomCreateView>(true, async (services, active) => {
      if (!active.account.authority.rendezvous && !active.account.authority.barkRendezvous) return { state: 'held', reason: 'Provision this browser’s rendezvous child through Bark or its retained bunker ceremony first.' }
      const deadline = clock.deadline
      const consent: ConsentPrompt = permission => this.#consent.ask(this.#foreground, active.scope, permission, deadline,
        () => active.current() && (!custody || custody.current()))
      try {
        // Endpoint start and box authentication precede child/persona custody.
        await this.#endpoint.resume(active.account.persona)
        context = services.vault.context(location.origin, active.account.persona)
        const credential = await services.vault.credential(context)
        if (!credential.ok) return { state: 'held', reason: 'Enrol a current MLS device in witness settings before creating a room.' }
        credentialExpiresAt = credential.value.device.credentialExpiresAt
        client = await this.#client(active, services, selected.routeId, context, consent)
        box = client.box
        const before = await client.capabilities(active.current)
        if (before.state !== 'ok') return { state: 'held', reason: `The selected Bothy installation could not be authenticated (${before.state}). Enrol the MLS device and review its permissions in witness settings.` }
        installation = before.value.installation
        if (!hex(installation) || !client.usesBinding(selected.routeId, box, context)) return { state: 'held', reason: 'The selected route binding changed.' }
        const now = clock.read()
        if (now === undefined) return { state: 'held', reason: 'The bounded creation ceremony expired or its clock changed.' }
        bindingExpiresAt = now + selected.lifetime
        if (!Number.isSafeInteger(bindingExpiresAt) || bindingExpiresAt <= now || bindingExpiresAt > credentialExpiresAt) {
          return { state: 'held', reason: 'The current credential does not cover the selected room lifetime. Choose a shorter lifetime covered by its expiry in witness settings.' }
        }
        candidate = await services.creation.withCurrent(active.scope, async held => {
          custody = held
          return services.rooms.create({ vault: context!, rendezvousKey: held.receipt.rendezvousPubkey, current: () => active.current() && held.current() },
            { name: selected.name, homeBox: box, installation, expiresAt: bindingExpiresAt, experimentalInvitation, experimentalAdminInvitation }, consent)
        })
        if (candidate.state !== 'active') return candidate.state === 'refused'
          ? { state: 'held', reason: `Room creation refused (${candidate.reason}).` } : pending('Room creation could not be confirmed. Retained state requires a fresh witnessed check.')
        const created = candidate.value
        // Persona and child locks are released before the authenticated reread.
        // The creation transaction's confirmed-read token ended with child
        // custody. Establish a new witnessed predecessor for the same client;
        // never reuse that expired token or turn its refusal into a retry.
        const expected = Object.freeze({ generation: created.generation, homeBox: box, installation })
        const confirmRoom = () => this.#foreground.track(active.scope, () => services.rooms.confirmTransport({ vault: context!,
          rendezvousKey: custody!.receipt.rendezvousPubkey, current: () => active.current() && !!custody?.releaseCurrent() }, created.session, expected))
        const confirmed = await confirmRoom()
        if (confirmed.state !== 'active') return pending('The saved room requires a fresh witness check. Do not recreate it; check saved rooms.')
        const after = await client.capabilities(() => active.current() && !!custody?.releaseCurrent())
        const installationConfirmed = after.state === 'ok' && after.value.installation === installation && client.usesBinding(selected.routeId, box, context)
        // The remote readback may outlive a concurrent persona write. Confirm
        // the identical saved candidate once more after that remote fact.
        postConfirmed = installationConfirmed && (await confirmRoom()).state === 'active'
        return postConfirmed ? { state: 'saved', session: candidate.value.session, generation: candidate.value.generation }
          : pending('The room may be saved, but its Bothy installation could not be reconfirmed. Do not recreate it; check saved rooms.')
      } catch {
        return pending('Room creation could not be confirmed. Any saved room or outbox remains retained; check saved rooms before another creation.')
      }
    }, (result, cleanupFailure) => {
      try {
        const now = clock.read()
        if (candidate?.state === 'active' && (cleanupFailure || !postConfirmed || !custody?.releaseCurrent() ||
            now === undefined || now >= Math.min(bindingExpiresAt, credentialExpiresAt) ||
            !client || !context || !client.usesBinding(selected.routeId, box, context) || !client.isCurrent())) {
          return pending(cleanupFailure ? 'Cleanup failed. Close this page; any saved room/outbox remains retained for a fresh check.'
            : 'Creation authority changed during cleanup. Any saved room/outbox remains retained; check saved rooms.')
        }
        if (cleanupFailure) return pending('Cleanup failed. Close this page before reopening room workflows.')
        return result
      } finally { wipe(candidate); candidate = undefined }
    }, clock.current)
  }

  /** Explicit private-OOB ceremonies. The UI's expected inviter is entered
   * independently from the blob; inspection never fills that trusted pin. */
  invitation(routeId: string, action:
    { type: 'issue'; session: string; target: { persona: string; device: string; rendezvous: string; leafHome: string; expiresAt: number } } |
    { type: 'export'; session: string } | { type: 'response'; session: string } |
    { type: 'update' | 'read'; session: string } | { type: 'send'; session: string; text: string } | { type: 'remove'; session: string; leafId: string } |
    { type: 'accept'; name: string; expectedInviterPersona: string; authorization: Uint8Array } |
    { type: 'record' | 'registration-request'; session: string; authorization: Uint8Array; envelope: Uint8Array } |
    { type: 'add'; session: string; authorization: Uint8Array; envelope: Uint8Array; receipt: Uint8Array } |
    { type: 'role'; session: string; leafId: string; makeAdmin: boolean; expectedCommitment: string } |
    { type: 'register-package'; request: Uint8Array }): Promise<MlsRoomForegroundResult<any>> {
    if (!(invitationPreviewEnabled() || adminInvitationPreviewEnabled()) || !routeShape(routeId)) throw new Error('Choose an exact saved route in the experimental development preview.')
    const admin = adminInvitationPreviewEnabled()
    const selected = structuredClone(action), clock = new BrowserMlsRoomCeremonyClock()
    let held: MlsRoomCreateRendezvous | undefined, credentialExpiresAt = 0, keeperReleaseCurrent = () => false
    return this.#run<any>(true, async (services, active) => {
      await this.#endpoint.resume(active.account.persona)
      const ctx = services.vault.context(location.origin, active.account.persona)
      const original = await services.vault.credential(ctx)
      if (!original.ok) throw new Error('Enrol a current MLS device before this ceremony.')
      credentialExpiresAt = original.value.device.credentialExpiresAt
      const consent: ConsentPrompt = permission => this.#consent.ask(this.#foreground, active.scope, permission, clock.deadline, active.current)
      const inviteConsent: InvitationConsentPrompt = permission => this.#consent.askInvitation(this.#foreground, active.scope, permission, clock.deadline,
        () => active.current() && !!held?.current())
      const adminConsent: AdminInvitationConsentPrompt = permission => this.#consent.askAdminInvitation(this.#foreground, active.scope, permission, clock.deadline,
        () => active.current() && !!held?.current())
      const client = await this.#client(active, services, routeId, ctx, consent)
      const caps = await client.capabilities(active.current)
      if (caps.state !== 'ok') throw new Error('The selected Bothy installation could not be authenticated.')
      if (selected.type === 'accept') {
        if (!hex(selected.expectedInviterPersona)) throw new Error('Select the expected inviter through your authenticated private contact or OOB source first.')
        const wasm = await (admin ? loadAdminInvitationEngine() : loadInvitationEngine()), info = (admin ? wasm.inspectAdminInvitation : wasm.inspectInvitation)(BigInt(clock.read() ?? 0), selected.authorization)
        const c = admin ? readAdminInvitationContext(info.contextBytes) : readInvitationContext(info.contextBytes)
        if (c.inviterPersona !== selected.expectedInviterPersona || c.joinerPersona !== active.account.persona || c.joinerHome !== client.box || c.groupHome !== client.box || c.groupInstallation !== caps.value.installation) throw new Error('The invitation differs from the trusted inviter, intended account or selected Bothy installation.')
      }
      let boxTime: number | undefined
      if (selected.type === 'register-package') {
        // An authenticated read supplies node time without a storage grant or
        // invitation-bearing mailbox. Any returned bytes are ignored and wiped.
        const probe = crypto.getRandomValues(new Uint8Array(32))
        const sampled = await client.fetch([probe], undefined, active.current); probe.fill(0)
        if (sampled.state !== 'ok' || sampled.serverTime === null) throw new Error('The node clock could not be authenticated for package registration.')
        boxTime = sampled.serverTime
        wipe(sampled.value)
        const after = await client.capabilities(active.current)
        if (after.state !== 'ok' || after.value.installation !== caps.value.installation || !clock.current()) throw new Error('The node installation changed during clock sampling.')
      }
      if (selected.type === 'register-package') {
        const at = clock.read(); if (at === undefined || boxTime === undefined) throw new Error('The keeper registration ceremony expired.')
        const requested = readInvitationRegistrationRequest(selected.request, at)
        if (requested.node !== client.box || requested.installation !== caps.value.installation) throw new Error('The private request differs from the independently selected paired node or current installation.')
        const decision = await this.#consent.askPackageRegistration(this.#foreground, active.scope, { method: 'registerInvitationPackageV1/1',
          principal: ctx.principal, persona: ctx.persona, device: original.value.device.device, homeBox: client.box, registration: requested }, clock.deadline,
          () => active.current() && clock.current() && client.isCurrent() && services.vault.current(ctx))
        if (decision !== 'approve') return { state: 'refused', reason: 'keeper-registration-denied' }
        const registered = await this.#foreground.track(active.scope, () => client.registerInvitationPackageSettled(selected.request, boxTime!))
        if (registered.state !== 'ok') return { state: 'pending', reason: 'The node did not return the required signed registration receipt. No member Add is authorised by this result.' }
        const after = await client.capabilities(active.current)
        if (after.state !== 'ok' || after.value.installation !== requested.installation) { wipe(registered.value); return { state: 'pending', reason: 'The node installation changed after registration.' } }
        keeperReleaseCurrent = () => active.current() && clock.current() && services.vault.current(ctx) && client.isCurrent() && client.usesBinding(routeId, requested.node, ctx) && Math.floor(Date.now() / 1000) < requested.expiresAt
        return { state: 'active', value: { registrationReceipt: registered.value.registrationReceipt, expiresAt: requested.expiresAt } }
      }
      return services.creation.withInvitation(active.scope, async custody => {
        held = custody
        const context = { vault: ctx, rendezvousKey: custody.receipt.rendezvousPubkey, current: () => active.current() && custody.current() && clock.current() }
        if ('session' in selected) {
          if (!hex(selected.session)) throw new Error('Choose an exact saved room.')
          const checked = await services.coordinator.transact(active.account.persona, async tx => {
            const room = await readMlsRoom(tx, selected.session)
            return !!room.invitation && (admin ? room.profile === 'InvitationAdmins2' : room.profile !== 'InvitationAdmins2') && room.binding.homeBox === client.box && room.binding.rendezvousKey === context.rendezvousKey &&
              (room.binding.installation === null || room.binding.installation === caps.value.installation)
          }, context.current)
          if (checked.state !== 'active' || !checked.value) throw new Error('The selected saved experimental room, route or rendezvous child changed.')
        }
        switch (selected.type) {
          case 'issue': return admin ? services.rooms.issueAdminInvitation(context, selected.session, selected.target, adminConsent) : services.rooms.issueInvitation(context, selected.session, selected.target, inviteConsent)
          case 'export': return (admin ? services.rooms.exportAdminInvitation.bind(services.rooms) : services.rooms.exportInvitation.bind(services.rooms))(context, selected.session)
          case 'response': return (admin ? services.rooms.adminInvitationResponse.bind(services.rooms) : services.rooms.invitationResponse.bind(services.rooms))(context, selected.session)
          case 'read': return services.rooms.read(context, selected.session)
          case 'send': return services.rooms.send(context, selected.session, bytesToHex(crypto.getRandomValues(new Uint8Array(32))), new TextEncoder().encode(selected.text))
          case 'remove': return (admin ? services.rooms.removeAdminInvitationMember.bind(services.rooms) : services.rooms.removeInvitationMember.bind(services.rooms))(context, selected.session, selected.leafId)
          case 'role': {
            if (!admin) throw new Error('Device admin roles require the Admin2 profile.')
            return services.rooms.changeAdminRole(context, selected.session, selected.leafId, selected.makeAdmin, selected.expectedCommitment)
          }
          case 'update': {
            const credential = await services.vault.credential(ctx), at = clock.read()
            if (!credential.ok || at === undefined) throw new Error('The enrolled credential or ceremony expired.')
            return services.rooms.update(context, selected.session, Math.min(at + 7 * 86400, credential.value.device.credentialExpiresAt), consent)
          }
          case 'accept': {
            const wasm = await (admin ? loadAdminInvitationEngine() : loadInvitationEngine()), inspected = (admin ? wasm.inspectAdminInvitation : wasm.inspectInvitation)(BigInt(clock.read() ?? 0), selected.authorization)
            const c = admin ? readAdminInvitationContext(inspected.contextBytes) : readInvitationContext(inspected.contextBytes), identity = await services.vault.credential(ctx)
            if (!identity.ok || c.joinerDevice !== identity.value.device.device || c.joinerRz !== context.rendezvousKey) throw new Error('This invitation targets a different enrolled device or rendezvous child.')
            const ask = admin ? this.#consent.askAdminInvitation.bind(this.#consent) : this.#consent.askInvitation.bind(this.#consent)
            const decision = await ask(this.#foreground, active.scope, { method: admin ? ADMIN_INVITATION_SIGN_METHOD : INVITATION_SIGN_METHOD, purpose: 'accept',
              principal: ctx.principal, persona: ctx.persona, device: identity.value.device.device, homeBox: client.box, context: c } as any, clock.deadline, context.current)
            if (decision !== 'approve') return { state: 'refused', reason: 'private-ceremony-denied' }
            return (admin ? services.rooms.acceptAdminInvitation.bind(services.rooms) : services.rooms.acceptInvitation.bind(services.rooms))(context, { name: selected.name, homeBox: client.box, expectedInviterPersona: selected.expectedInviterPersona, authorization: selected.authorization }, custody, consent)
          }
          case 'registration-request': return (admin ? services.rooms.adminInvitationResponseAction.bind(services.rooms) : services.rooms.invitationResponseAction.bind(services.rooms))(context, selected.session, selected.authorization, selected.envelope, custody, { type: 'registration-request' })
          case 'add': return (admin ? services.rooms.adminInvitationResponseAction.bind(services.rooms) : services.rooms.invitationResponseAction.bind(services.rooms))(context, selected.session, selected.authorization, selected.envelope, custody, { type: 'add', receipt: selected.receipt })
          case 'record': return (admin ? services.rooms.adminInvitationResponseAction.bind(services.rooms) : services.rooms.invitationResponseAction.bind(services.rooms))(context, selected.session, selected.authorization, selected.envelope, custody, { type: 'record' })
        }
      })
    }, (result, failure) => {
      try {
        if (failure || !clock.current() || !(selected.type === 'register-package' ? keeperReleaseCurrent() : held?.releaseCurrent()) || Math.floor(Date.now() / 1000) >= credentialExpiresAt ||
            result?.state === 'active' && Number.isSafeInteger(result.value?.expiresAt) && Math.floor(Date.now() / 1000) >= result.value.expiresAt) { wipe(result); return { state: 'pending', reason: 'The ceremony changed during cleanup. Reopen the saved room; retained invitation work is preserved.' } }
        return result
      } finally { wipe(selected) }
    }, clock.current).finally(() => wipe(selected))
  }

  manualRound(routeId: string, session: string): Promise<MlsRoomForegroundResult<MlsRoomManualView>> {
    if (!routeShape(routeId) || !hex(session)) throw new Error('Choose one saved room and its paired route.')
    const selected = Object.freeze({ routeId, session }), clock = new BrowserMlsRoomCeremonyClock()
    const rawKey = this.context()?.authority.rendezvous?.deviceKey, key = rawKey?.slice()
    const ceremonyCurrent = () => clock.current() && (!key || !!rawKey && rawKey.length === key.length && key.every((byte, index) => rawKey[index] === byte))
    let client: BrowserMlsBoxClient | undefined, ctx: VaultContext | undefined, rz = '', confirmed = false
    let candidate: MlsDriverRound | undefined, activeScope: Active | undefined, ownedServices: Services | undefined
    let initialBinding: Readonly<MlsRoomBinding> | undefined
    const pending = (reason: string): MlsRoomManualView => ({ state: 'pending', reason })
    return this.#run<MlsRoomManualView>(true, async (services, active) => {
      activeScope = active; ownedServices = services
      try {
        // Endpoint lifecycle precedes driver then persona custody. The saved
        // witnessed binding, never a caller's key, supplies room authority.
        await this.#endpoint.resume(active.account.persona)
        ctx = services.vault.context(location.origin, active.account.persona)
        const credential = await services.vault.credential(ctx)
        if (!credential.ok) return { state: 'held', reason: 'Enrol a current MLS device in witness settings first.' }
        const consent: ConsentPrompt = permission => this.#consent.ask(this.#foreground, active.scope, permission, clock.deadline, active.current)
        client = await this.#client(active, services, selected.routeId, ctx, consent)
        const binding = await this.#foreground.track(active.scope, () => services.coordinator.transact(active.account.persona, async tx => {
          if (!(await mlsRoomIds(tx)).includes(selected.session)) return undefined
          const room = await readMlsRoom(tx, selected.session)
          return { ...room.binding, introductionBox: room.join?.introductionBox, expectedInvitationInstallation: room.invitation?.groupInstallation }
        }, active.current))
        if (binding.state !== 'active') return pending('The saved room requires a fresh witnessed check.')
        const b = binding.value
        if (!b) return { state: 'held', reason: 'The selected saved room is absent. Check saved rooms again.' }
        if (b.homeBox !== client.box || b.introductionBox !== undefined && b.introductionBox !== client.box) {
          return { state: 'held', reason: 'Select the saved room’s exact home-box route. Delivery across different boxes remains held.' }
        }
        if (b.installation === null && !b.expectedInvitationInstallation) return { state: 'held', reason: 'This join is still pending. Authenticated invitation and join recovery remain held.' }
        if (b.device !== credential.value.device.device || b.credentialId !== credential.value.device.credentialId) {
          return { state: 'held', reason: 'The saved room belongs to a different MLS device or credential.' }
        }
        initialBinding = Object.freeze({ device: b.device, credentialId: b.credentialId, rendezvousKey: b.rendezvousKey, homeBox: b.homeBox, installation: b.installation ?? b.expectedInvitationInstallation! })
        rz = b.rendezvousKey
        const context = { vault: ctx, rendezvousKey: rz, current: active.current }
        const driver = new BrowserMlsMessageDriver(services.rooms, client, context, selected.session, () => this.#endpoint.stop(), navigator.locks,
          () => { const now = clock.read(); if (now === undefined) throw stale(); return now })
        active.drivers.add(driver)
        candidate = await this.#foreground.track(active.scope, () => driver.round())
        if (candidate.state !== 'done') return candidate.state === 'stopped'
          ? { state: 'held', reason: `This room is held in ${candidate.phase}. Retained state requires explicit recovery.` }
          : pending('The round could not be confirmed. Any room and uncertain outbox records remain retained.')
        if (candidate.phase !== 'Active') return { state: 'held', reason: `The bounded round finished with this room in ${candidate.phase}. Retained state requires explicit recovery.` }
        if (candidate.installation !== initialBinding.installation) return pending('The authenticated installation changed. Retained work requires explicit recovery.')
        const expected = { generation: candidate.generation, homeBox: initialBinding.homeBox, installation: candidate.installation,
          device: initialBinding.device, credentialId: initialBinding.credentialId }
        const check = await this.#foreground.track(active.scope, () => services.rooms.confirmTransport(context, selected.session, expected))
        confirmed = check.state === 'active'
        if (!confirmed) return pending('The room changed after the round. Any committed or uncertain work remains retained.')
        return { state: 'done', session: selected.session, generation: candidate.generation, resolved: candidate.delivered,
          processed: candidate.processed, held: candidate.held, leafHeld: candidate.leafHeld, stalled: candidate.stalled, limited: candidate.limited }
      } catch {
        return pending('The round could not be confirmed. Check the saved room before another explicit round; uncertain records remain retained.')
      }
    }, async (result, cleanupFailure) => {
      try {
        if (cleanupFailure) return pending('Cleanup failed. Close this page before another round; any committed or uncertain room/outbox state remains retained.')
        if (result.state !== 'done') return result
        if (!confirmed || candidate?.state !== 'done' || !initialBinding || !activeScope?.current() || !ownedServices || !ctx || !client ||
            !client.usesBinding(selected.routeId, client.box, ctx) || !client.isCurrent() || !clock.current()) {
          return pending('Round authority changed during cleanup. Retained work requires a fresh witnessed check.')
        }
        const expected = candidate, context = ctx, owned = ownedServices, actualClient = client
        const binding = initialBinding
        // The owner-current confirmation outlives the closed driver, but not
        // a durable persona revision change. This is local readback only:
        // no endpoint restart or witness exchange after actual cleanup.
        const final = await owned.coordinator.readConfirmed(activeScope.account.persona, async tx => {
          if (!(await mlsRoomIds(tx)).includes(selected.session)) return false
          const room = await readMlsRoom(tx, selected.session), b = room.binding
          return room.generation === expected.generation && b.homeBox === actualClient.box && b.installation === expected.installation &&
            b.rendezvousKey === binding.rendezvousKey && b.device === binding.device && b.credentialId === binding.credentialId &&
            b.homeBox === binding.homeBox && b.installation === binding.installation && (await owned.vault.checkRoomDevice(tx, context, b.device, b.credentialId)).ok
        }, activeScope.current)
        return final.state === 'active' && final.value && activeScope.current() && clock.current() ? result
          : pending('The exact witnessed room changed during cleanup. Any committed or uncertain work remains retained.')
      } finally { wipe(candidate); candidate = undefined }
    }, ceremonyCurrent).finally(() => key?.fill(0))
  }

  async #client(active: Active, services: Services, routeId: string, context: VaultContext, consent: ConsentPrompt): Promise<BrowserMlsBoxClient> {
    if (!this.#endpoint.ownsScope(active.scope) || !routeShape(routeId)) throw stale()
    const state = await new BrowserMlsRoomLinkVault(this.#foreground, this.#endpoint).read()
    try {
      if (!state || state.account !== active.account.persona || !this.#endpoint.ownsScope(active.scope)) throw stale()
      const routes = state.routes.filter(route => route.routeId === routeId)
      if (routes.length !== 1) throw stale()
      const route = routes[0]
      const box = pairedWitnessIdentity({ routeId, card: bytesToHex(route.card), cardSerial: String(route.cardSerial),
        cardVerifiedAt: String(route.cardVerifiedAt), pairedRouteSecret: '', relayUrls: [] })
      const client = new BrowserMlsBoxClient(this.#endpoint, route, box, services.vault, context, consent, active.current)
      active.clients.add(client)
      return client
    } finally { if (state) wipeLinkState(state) }
  }

  routes() { return this.#run(false, async (_services, active) => this.#endpoint.pairedBoxes(active.account.persona)) }
  pair(code: string, relays: readonly string[]) {
    if (typeof code !== 'string' || !code || code.length > 32_768) throw new Error('Enter a bounded room pairing code.')
    if (!Array.isArray(relays) || relays.length < 1 || relays.length > 6) throw new Error('Select one to six explicit Link relays.')
    const selected = normaliseRelayConfig([...relays]).map(relay => relay.url)
    return this.#run(true, async (_services, active) => {
      await this.#endpoint.resume(active.account.persona, selected)
      return this.#endpoint.pair(code)
    })
  }
  roomChoices() {
    return this.#run(true, (services, active) => this.#foreground.track(active.scope, () =>
      services.coordinator.transact(active.account.persona, async tx => {
        const result: { session: string; rendezvousKey: string; name: string; keeper?: string }[] = []
        for (const session of await mlsRoomIds(tx)) {
          const room = await readMlsRoom(tx, session)
          result.push({ session, rendezvousKey: room.binding.rendezvousKey, name: room.name, keeper: room.keeper })
        }
        return result
      }, active.current)))
  }
  /** External invalidation is synchronous. The returned promise joins all
   * actual endpoint, witness and foreground tails, even when another fails. */
  pause(): Promise<void> {
    this.#epoch++; this.#foreground.invalidate()
    this.#consent.cancel()
    const clients = [...this.#active?.clients ?? []]
    const drivers = [...this.#active?.drivers ?? []]
    drivers.forEach(driver => driver.invalidate())
    clients.forEach(client => client.invalidate())
    this.#services?.rooms.invalidate()
    this.#services?.vault.bump(); this.#services?.coordinator.invalidate()
    const previous = this.#stopping, endpoint = this.#endpoint.stop()
    const witnesses = this.#services?.links.pause() ?? Promise.resolve()
    this.#stopping = join([previous, endpoint, witnesses, this.#foreground.settled(), ...clients.map(client => client.settled()), ...drivers.map(driver => driver.close())])
    void this.#stopping.catch(() => {})
    return this.#stopping
  }
  async #run<T>(network: boolean, work: (services: Services, active: Active) => Promise<T>,
    finish?: (result: T, cleanupFailure?: unknown) => T | Promise<T>, ceremonyCurrent: () => boolean = () => true): Promise<MlsRoomForegroundResult<T>> {
    const account = this.context(), epoch = this.#epoch
    if (!account?.identity || account.identity.pubkey !== account.persona || !hex(account.persona) ||
        !account.authority?.owner || typeof account.authority.owner !== 'object' || typeof account.authority.signEvent !== 'function' ||
        account.authority.crypt && (!account.authority.crypt.owner || typeof account.authority.crypt.owner !== 'object' ||
          typeof account.authority.crypt.encrypt !== 'function' || typeof account.authority.crypt.decrypt !== 'function')) throw stale()
    const authority = Object.freeze({ ...account.authority,
      ...(account.authority.rendezvous ? { rendezvous: Object.freeze({ ...account.authority.rendezvous }) } : {}),
      ...(account.authority.crypt ? { crypt: Object.freeze({ ...account.authority.crypt }) } : {}) })
    const captured = { ...account, authority }
    if (network && captured.mode !== 'normal') throw new Error('Room and witness connections are held in quiet and Tor-only modes.')
    const current = () => {
      const next = this.context()
      return ceremonyCurrent() && epoch === this.#epoch && next?.persona === captured.persona && next.generation === captured.generation &&
        next.mode === captured.mode && next.identity?.pubkey === captured.persona && matches(next.authority, authority)
    }
    await this.#stopping
    if (!current()) return { state: 'interrupted' }
    return this.#foreground.run(captured.persona, current, async scope => {
      const check = () => { if (!scope.current()) throw stale() }
      const sign = authority.signEvent.bind(authority.owner)
      const identity: ParticipantIdentity = { pubkey: captured.persona,
        signEvent: template => this.#foreground.track(scope, () => sign(template)) }
      const active: Active = { account: captured, identity, scope, clients: new Set(), drivers: new Set(), current: () => scope.current() }
      this.#active = active
      const services = this.#services ??= this.#create()
      try {
        let result!: T, cleanupFailure: unknown
        try {
          check(); services.links.resume()
          result = await work(services, active)
        } finally {
          this.#consent.cancel()
          active.clients.forEach(client => client.invalidate())
          try {
            // Client settlement and endpoint/witness release are outside all
            // child/persona callbacks, before the final result fence.
            try { await join([...active.drivers].map(driver => driver.close()).concat([...active.clients].map(client => client.settled()))) }
            finally { await join([this.#endpoint.stop(), services.links.pause()]) }
          } catch (error) {
            cleanupFailure = error
            this.#stopping = Promise.reject(error); void this.#stopping.catch(() => {})
            if (!finish) { wipe(result); throw error }
          }
        }
        if (!scope.current()) { if (finish) wipe(await finish(result, cleanupFailure ?? stale())); wipe(result); throw stale() }
        return finish ? await finish(result, cleanupFailure) : result
      } finally { if (this.#active === active) this.#active = undefined }
    })
  }
  #create(): Services {
    const links = new BrowserPersonaLinks(() => !!this.#active?.current() && this.#active.account.mode === 'normal')
    const coordinator = new BrowserPersonaCoordinator(new BrowserMlsPersonaStore(), links.channels)
    const vault = new RoomCoordinatedMlsVault(coordinator, this.#foreground, { generation: () => this.#epoch })
    const bark = new BrowserBarkRendezvous(coordinator)
    const creation = new BrowserMlsRoomCreateCustody(this.#foreground,
      () => this.#active?.current() ? this.context()?.authority.rendezvous : undefined,
      async () => {
        const active = this.#active
        return active?.current() && active.account.authority.barkRendezvous ? bark.publicDevice(this.#barkContext(active)) : undefined
      })
    return { links, coordinator, vault, bark, rooms: new BrowserMlsRoomOperations(coordinator, vault), creation }
  }
}
