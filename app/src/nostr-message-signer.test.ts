import { expect, it, vi } from 'vitest'
import { Nip07Signer, type SignetSession, type SignetSigner, type EventTemplate } from 'signet-login'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { signetFixtureEvent, signetFixtureSession } from '../../test/signet-session-fixture.js'
import { nostrMessageIdentity } from './nostr-message-signer.js'

function fixture() {
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  let starts = 0, release = async () => {}
  const signer: SignetSigner = { pubkey, method: 'nip07', providerEffectBoundary: 1,
    capabilities: { canSignEvents: true, hasNip44: true },
    nip44: { encrypt: async (_peer, _text, boundary) => {
      await release()
      if (!boundary) throw Error('Missing fixture provider boundary')
      return boundary.start(async () => { starts++; return 'provider ciphertext' })
    }, decrypt: async () => { throw Error('Unexpected fixture decryption') } },
    signEvent: (template, boundary) => boundary ? boundary.start(async () => signetFixtureEvent(template, key))
      : Promise.reject(Error('Missing fixture provider boundary')),
    close: async () => {},
  }
  const account = signetFixtureSession(signer, key)
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
  const f = fixture(), account: SignetSession = { ...f.account, method: 'bunker' }
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
      signEvent: async (template: EventTemplate) => { calls++; entered(); await waiting; return signetFixtureEvent(template, key) },
      nip44: { encrypt: async () => { calls++; entered(); await waiting; return 'actual provider result' }, decrypt: async () => '' },
    }
    const signer = new Nip07Signer(pubkey, provider), account = signetFixtureSession(signer, key)
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
    signEvent: async (template: EventTemplate) => { if (++calls === 1) throw Error('Extension context invalidated'); return signetFixtureEvent(template, key) },
    nip44: { encrypt: async () => 'unused', decrypt: async () => '' },
  })
  const account = signetFixtureSession(signer, key), identity = nostrMessageIdentity(account, () => account)!
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

it('event-only file approvals reuse the actual SDK boundary without requiring signer encryption support', async () => {
  const { nostrEventSigner } = await import('./nostr-message-signer.js')
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  let current = true, starts = 0
  const signer = new Nip07Signer(pubkey, { getPublicKey: async () => pubkey,
    signEvent: async template => { starts++; return signetFixtureEvent(template,key) } })
  const account = signetFixtureSession(signer,key), identity = nostrEventSigner(account,() => account)!
  expect(nostrMessageIdentity(account,() => account)).toBeUndefined()
  expect(identity).toBeDefined()
  const event = await identity.signEvent({kind:24242,created_at:1000,tags:[],content:'file approval'},() => current)
  expect(event.pubkey).toBe(pubkey); expect(starts).toBe(1)
  current = false
  await expect(identity.signEvent({kind:24242,created_at:1000,tags:[],content:'held'},() => current)).rejects.toThrow('no longer available')
  expect(starts).toBe(1)
  await signer.close()
})
