export interface InvitationBlockContext {
  account(): object | undefined
  inbox(): { dismiss(id: string): Promise<void> } | undefined
  block(sender: string): void
}

export async function declineAndBlockInvitation(id: string, sender: string, context: InvitationBlockContext): Promise<void> {
  const account = context.account(), inbox = context.inbox()
  if (!account || !inbox) throw new Error('This invitation is no longer available in the current account.')
  // Durable dismissal may outlive sign-out, account replacement or an inbox
  // restart. It never authorises a block in the context that replaced it.
  await inbox.dismiss(id)
  if (context.account() !== account || context.inbox() !== inbox) {
    throw new Error('The invitation was declined. The account changed before the block could be applied.')
  }
  context.block(sender)
}
