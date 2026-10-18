import { beforeEach, describe, expect, it, vi } from 'vitest'

const owned = vi.hoisted(() => ({
  bootstrap: { load: vi.fn(), close: vi.fn(), revoke: vi.fn() },
  foreground: { close: vi.fn(), revoke: vi.fn() },
}))
vi.mock('./ordinary-state-owner.js', () => ({ MAX_ORDINARY_TAB_OWNERS: 64,
  OrdinaryStateOwner: { joinPairLifetime() {} } }))
vi.mock('./ordinary-foreground-signer.js', () => ({
  OrdinaryForegroundSigner: { open: async () => owned.foreground },
}))
vi.mock('./ordinary-persistent-bootstrap.js', () => ({
  OrdinaryPersistentBootstrap: { open: async () => owned.bootstrap },
  wipeOrdinaryPersistentBootstrapResult() {},
}))
vi.mock('../../src/invitation.js', () => ({ deriveInvitationId: () => 'invitation' }))
import { OrdinaryMemberStartup, type OrdinaryMemberStartupOptions } from './ordinary-member-startup.js'

function options(): OrdinaryMemberStartupOptions {
  const identity = { pubkey: 'participant', signEvent: vi.fn() }
  const browser = { inspectRenewalStartup: async () => ({ status: 'ordinary', operations: [] }),
    openExisting: async () => {}, retryRetention() {} }
  const tab = { openExisting: async () => {}, retryRetention() {} }
  const session = { signer: identity }
  return { browser, tab, invitation: {}, account: identity.pubkey, identity, link: 'link', keep: true,
    credentialExpiresAt: 123, live: () => true,
    current: () => ({ identity, account: identity.pubkey, participant: identity.pubkey,
      invitationId: 'invitation', link: 'link', keep: true, credentialExpiresAt: 123 }),
    foreground: { session, stop() {} },
  } as unknown as OrdinaryMemberStartupOptions
}

beforeEach(() => {
  vi.resetAllMocks()
  owned.bootstrap.load.mockResolvedValue({})
  owned.bootstrap.close.mockResolvedValue(undefined)
  owned.foreground.close.mockResolvedValue(undefined)
})

describe('owned startup cleanup', () => {
  it('joins bootstrap close before foreground close, including rejection', async () => {
    const startup = await OrdinaryMemberStartup.open(options())
    const failure = new Error('bootstrap close failed')
    let reject!: (error: Error) => void
    owned.bootstrap.close.mockImplementation(() => new Promise<void>((_, no) => { reject = no }))
    const closing = startup.close()
    const observed = closing.catch(error => error)
    expect(startup.close()).toBe(closing)
    expect(owned.bootstrap.revoke).toHaveBeenCalledOnce()
    expect(owned.foreground.revoke).toHaveBeenCalledOnce()
    expect(owned.bootstrap.close).toHaveBeenCalledOnce()
    expect(owned.foreground.close).not.toHaveBeenCalled()
    reject(failure)
    expect(await observed).toBe(failure)
    expect(owned.foreground.close).toHaveBeenCalledOnce()
    expect(startup.close()).toBe(closing)
  })

  it('preserves a foreground close failure after bootstrap settles', async () => {
    const startup = await OrdinaryMemberStartup.open(options())
    const failure = new Error('foreground close failed')
    owned.foreground.close.mockRejectedValue(failure)
    await expect(startup.close()).rejects.toBe(failure)
    expect(owned.bootstrap.close).toHaveBeenCalledOnce()
    expect(owned.foreground.close).toHaveBeenCalledOnce()
  })

  it('retains both errors when both resources reject close', async () => {
    const startup = await OrdinaryMemberStartup.open(options())
    const errors = [new Error('bootstrap close failed'), new Error('foreground close failed')]
    owned.bootstrap.close.mockRejectedValue(errors[0])
    owned.foreground.close.mockRejectedValue(errors[1])
    const failure = await startup.close().catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual(errors)
  })

  it('joins failed construction cleanup and preserves the original refusal', async () => {
    const failure = new Error('load refused')
    owned.bootstrap.load.mockRejectedValue(failure)
    owned.bootstrap.close.mockRejectedValue(new Error('bootstrap close failed'))
    owned.foreground.close.mockRejectedValue(new Error('foreground close failed'))
    await expect(OrdinaryMemberStartup.open(options())).rejects.toBe(failure)
    expect(owned.bootstrap.close).toHaveBeenCalledOnce()
    expect(owned.foreground.close).toHaveBeenCalledOnce()
  })
})
