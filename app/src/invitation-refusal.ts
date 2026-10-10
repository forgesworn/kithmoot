import { encodeInvitationDecline, type RoomInvitation, type InvitationDelegation } from '../../src/invitation.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { Event } from 'nostr-tools/pure'

export interface InvitationRefusalAttempt { readonly event: Event; send(): Promise<void> }

/** One signed response per explicit decision. Retries cannot renew its clock
 * or switch rooms; acknowledgement never proves the guest received it. */
export function prepareInvitationRefusal(opts: {
  invitation: RoomInvitation; inviterSk: Uint8Array; delegation: InvitationDelegation[]
  requester: string; request: string; transport: RelayTransport
  expiresAt: number; stillCurrent(): boolean; now(): number
}): InvitationRefusalAttempt {
  const { transport, expiresAt, stillCurrent, now } = opts
  const check = () => {
    if (!stillCurrent() || now() >= expiresAt) throw new Error('This admission decision is no longer current.')
  }
  check()
  const event = encodeInvitationDecline({ invitation: opts.invitation, inviterSk: opts.inviterSk,
    delegation: opts.delegation, requester: opts.requester, request: opts.request, now: now() })
  return { event, async send() {
    check()
    await transport.publish(event)
    check()
  } }
}
