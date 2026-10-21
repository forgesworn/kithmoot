import { describe, expect, it, vi } from 'vitest'
import { declineAndBlockInvitation } from './invitation-block-action.js'

function fixture() {
  const originalAccount = { pubkey: 'alice' }
  let account: object | undefined = originalAccount
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const effects: string[] = []
  const originalInbox = { dismiss: vi.fn(async (id: string) => { await waiting; effects.push(`dismiss:${id}`) }) }
  let inbox: typeof originalInbox | undefined = originalInbox
  const block = vi.fn((sender: string) => effects.push(`block:${sender}`))
  return { originalAccount, originalInbox, effects, block, release,
    account: (value: object | undefined) => { account = value },
    inbox: (value: typeof originalInbox | undefined) => { inbox = value },
    run: () => declineAndBlockInvitation('invitation', 'sender', { account: () => account, inbox: () => inbox, block }) }
}

describe('account-bound decline and block', () => {
  it('blocks only after the original invitation dismissal finishes in the same account', async () => {
    const f = fixture(), pending = f.run()
    expect(f.block).not.toHaveBeenCalled()
    f.release(); await pending
    expect(f.effects).toEqual(['dismiss:invitation', 'block:sender'])
    expect(f.originalInbox.dismiss).toHaveBeenCalledExactlyOnceWith('invitation')
  })

  it.each([{ pubkey: 'bob' }, { pubkey: 'alice' }])('does not carry an old action into a replacement session %j', async replacement => {
    const f = fixture(), refused = expect(f.run()).rejects.toThrow('account changed')
    f.account(replacement); f.release(); await refused
    expect(f.effects).toEqual(['dismiss:invitation'])
    expect(f.block).not.toHaveBeenCalled()
  })

  it('does not act on a replacement invitation journal in the same session', async () => {
    const f = fixture(), replacement = { dismiss: vi.fn(async (_id: string) => {}) }
    const refused = expect(f.run()).rejects.toThrow('account changed')
    f.inbox(replacement); f.release(); await refused
    expect(f.effects).toEqual(['dismiss:invitation'])
    expect(replacement.dismiss).not.toHaveBeenCalled()
    expect(f.block).not.toHaveBeenCalled()
  })

  it('does not write a block after sign-out', async () => {
    const f = fixture(), refused = expect(f.run()).rejects.toThrow('account changed')
    f.account(undefined); f.inbox(undefined); f.release(); await refused
    expect(f.effects).toEqual(['dismiss:invitation'])
    expect(f.block).not.toHaveBeenCalled()
  })

  it('refuses when the journal is withdrawn while dismissal finishes', async () => {
    const f = fixture(), refused = expect(f.run()).rejects.toThrow('account changed')
    f.inbox(undefined); f.release(); await refused
    expect(f.effects).toEqual(['dismiss:invitation'])
    expect(f.block).not.toHaveBeenCalled()
  })

  it.each(['account', 'inbox'] as const)('does not start without the original %s', async missing => {
    const f = fixture(); f[missing](undefined); f.release()
    await expect(f.run()).rejects.toThrow('current account')
    expect(f.originalInbox.dismiss).not.toHaveBeenCalled()
    expect(f.block).not.toHaveBeenCalled()
  })

  it('does not block when durable dismissal fails', async () => {
    const f = fixture(), failure = Error('write refused')
    f.originalInbox.dismiss.mockRejectedValueOnce(failure)
    await expect(f.run()).rejects.toBe(failure)
    expect(f.block).not.toHaveBeenCalled()
  })
})
