import { expect, it } from 'vitest'
import type { SignerEffectBoundary, SignetSession } from 'signet-login'
import { generateSecretKey, getPublicKey, finalizeEvent, type EventTemplate } from 'nostr-tools/pure'
import { nostrMessageIdentity } from './nostr-message-signer.js'

function fixture() {
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  let starts = 0, release = async () => {}
  const account = { pubkey, method: 'nip07', signer: { pubkey, method: 'nip07', providerEffectBoundary: 1,
    capabilities: { canSignEvents: true, hasNip44: true },
    nip44: { encrypt: async (_peer: string, _text: string, boundary: SignerEffectBoundary) => {
      await release()
      return boundary.start(async () => { starts++; return 'provider ciphertext' })
    } },
    signEvent: (template: EventTemplate, boundary: SignerEffectBoundary) => boundary.start(async () => finalizeEvent(template, key)),
  } } as unknown as SignetSession
  let selected: SignetSession | undefined = account
  const identity = nostrMessageIdentity(account, () => selected)!
  return { account, identity, starts: () => starts, stop: () => { selected = undefined },
    delay: (wait: () => Promise<void>) => { release = wait } }
}
it('checks the selected account at a deferred actual provider start', async () => {
  const f = fixture(); let release!: () => void
  f.delay(() => new Promise<void>(resolve => { release = resolve }))
  const pending = f.identity.encrypt(f.account.pubkey, 'never started', () => true)
  f.stop(); release(); await expect(pending).rejects.toThrow('no longer available')
  expect(f.starts()).toBe(0)
})
it('checks view lifetime at actual start even while the account remains selected', async () => {
  const f = fixture(); let release!: () => void, current = true
  f.delay(() => new Promise<void>(resolve => { release = resolve }))
  const pending = f.identity.encrypt(f.account.pubkey, 'never started', () => current)
  current = false; release(); await expect(pending).rejects.toThrow('no longer available'); expect(f.starts()).toBe(0)
})
it('refuses unsupported signer transports rather than omitting provider guards', () => {
  const f = fixture(), account = { ...f.account, method: 'nip46' } as SignetSession
  expect(nostrMessageIdentity(account, () => account)).toBeUndefined()
})
