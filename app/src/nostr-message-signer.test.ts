import { expect, it, vi } from 'vitest'
import { Nip07Signer, type SignerEffectBoundary, type SignetSession } from 'signet-login'
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

// Exercise the installed SDK class, not a replacement implementation of its
// provider boundary. Still an in-process synthetic provider, not extension UI.
for (const operation of ['encrypt', 'seal'] as const) for (const boundary of ['account', 'view'] as const) {
  it(`rejects actual SDK ${operation} handoff after ${boundary} changes while the provider is running`, async () => {
    const key = generateSecretKey(), pubkey = getPublicKey(key)
    let release!: () => void, entered!: () => void, calls = 0, current = true
    const waiting = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const provider = { getPublicKey: async () => pubkey,
      signEvent: async (template: EventTemplate) => { calls++; entered(); await waiting; return finalizeEvent(template, key) },
      nip44: { encrypt: async () => { calls++; entered(); await waiting; return 'actual provider result' }, decrypt: async () => '' },
    }
    const signer = new Nip07Signer(pubkey, provider), account = { pubkey, method: 'nip07', signer } as SignetSession
    let selected: SignetSession | undefined = account
    const identity = nostrMessageIdentity(account, () => selected)!
    const pending = operation === 'encrypt' ? identity.encrypt(pubkey, 'synthetic text', () => current)
      : identity.signEvent({ kind: 13, created_at: 1, tags: [], content: 'synthetic ciphertext' }, () => current)
    const rejected = expect(pending).rejects.toThrow('no longer available')
    try {
      await started; expect(calls).toBe(1)
      if (boundary === 'account') selected = undefined; else current = false
      release(); await rejected; expect(calls).toBe(1)
    } finally { release(); await signer.close() }
  })
}

for (const cancel of [false, true]) it(`actual SDK transient signing retry ${cancel ? 'cannot restart after cancellation' : 'works while the view remains current'}`, async () => {
  vi.useFakeTimers()
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  let calls = 0, current = true
  const signer = new Nip07Signer(pubkey, { getPublicKey: async () => pubkey,
    signEvent: async (template: EventTemplate) => { if (++calls === 1) throw Error('Extension context invalidated'); return finalizeEvent(template, key) },
    nip44: { encrypt: async () => 'unused', decrypt: async () => '' },
  })
  const account = { pubkey, method: 'nip07', signer } as SignetSession, identity = nostrMessageIdentity(account, () => account)!
  try {
    const pending = identity.signEvent({ kind: 13, created_at: 1, tags: [], content: 'synthetic ciphertext' }, () => current)
    // Attach both outcomes before advancing time; a cancellation is expected.
    const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    await vi.advanceTimersByTimeAsync(0); expect(calls).toBe(1)
    if (cancel) current = false
    await vi.advanceTimersByTimeAsync(300)
    const result = await settled
    if (cancel) { expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined(); expect(calls).toBe(1) }
    else { expect(result.error).toBeUndefined(); expect(result.value?.pubkey).toBe(pubkey); expect(calls).toBe(2) }
  } finally { await signer.close(); vi.useRealTimers() }
})
