import { BrowserPersonaCoordinator } from './mls-persona-coordinator.js'
import { CoordinatedMlsVault, type AdminInvitationConsentPrompt, type AdminInvitationSignReply, type InvitationConsentPrompt, type InvitationSignReply, type CoordinatedVaultOptions } from './mls-coordinated-vault.js'
import { BrowserMlsRoomForeground } from './mls-room-foreground.js'
import type { ConsentPrompt, VaultContext, VaultResult, SignLeafBindingReply } from './mls-vault.js'

/** Privately constructed by the room application owner with its concrete
 * coordinator and foreground. Lower create can finish a cancellation race
 * before leaf consent/signing/journalling finishes. Register the actual super
 * work before yielding so a child callback can drain that tail before unlock.
 * Never register the outer room operation or a cleanup/settlement callback. */
export class RoomCoordinatedMlsVault extends CoordinatedMlsVault {
  constructor(coordinator: BrowserPersonaCoordinator, private readonly foreground: BrowserMlsRoomForeground,
    options: CoordinatedVaultOptions = {}) {
    if (!(coordinator instanceof BrowserPersonaCoordinator) || !(foreground instanceof BrowserMlsRoomForeground)) {
      throw new Error('Room signing requires its concrete coordinator and foreground.')
    }
    super(coordinator, options)
  }
  override signAdminInvitationV2(context: VaultContext, input: unknown, consent: AdminInvitationConsentPrompt): Promise<VaultResult<AdminInvitationSignReply>> {
    const scope = this.foreground.capture()
    if (!scope || scope.account !== context.persona) return Promise.resolve({ ok: false, refusal: 'stale' })
    return this.foreground.track(scope, () => super.signAdminInvitationV2(context, input, consent))
  }
  override signInvitationV1(context: VaultContext, input: unknown, consent: InvitationConsentPrompt): Promise<VaultResult<InvitationSignReply>> {
    const scope = this.foreground.capture()
    if (!scope || scope.account !== context.persona) return Promise.resolve({ ok: false, refusal: 'stale' })
    return this.foreground.track(scope, () => super.signInvitationV1(context, input, consent))
  }
  override signLeafBindingV1(context: VaultContext, input: unknown, consent: ConsentPrompt): Promise<VaultResult<SignLeafBindingReply>> {
    const scope = this.foreground.capture()
    if (!scope || scope.account !== context.persona) return Promise.resolve({ ok: false, refusal: 'stale' })
    return this.foreground.track(scope, () => super.signLeafBindingV1(context, input, consent))
  }
}
