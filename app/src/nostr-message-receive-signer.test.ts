import { expect, it } from 'vitest'
import { Nip07Signer, type SignerEffectBoundary, type SignetSession } from 'signet-login'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { ordinaryMessageDecrypt } from './nostr-message-receive-signer.js'

for (const boundary of ['account', 'view', 'expiry', 'method'] as const) it(`actual installed SDK decrypt handoff refuses after ${boundary} changes`, async () => {
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  let release!: () => void, entered!: () => void, calls = 0, live = true
  const pending = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const signer = new Nip07Signer(pubkey, { getPublicKey: async () => pubkey, signEvent: async template => finalizeEvent(template, key),
    nip44: { encrypt: async () => { throw Error('Receive-only') }, decrypt: async () => { calls++; entered(); await pending; return 'provider result' } } })
  const account = { method: 'nip07', signer, pubkey, expiresAt: Date.now() + 60_000 } as SignetSession
  let selected: SignetSession | undefined = account
  const decrypt = ordinaryMessageDecrypt(account, () => selected)!
  const work = decrypt(pubkey, 'synthetic ciphertext', () => live)
  const rejected = expect(work).rejects.toThrow()
  try {
    await started
    if (boundary === 'account') selected = undefined
    else if (boundary === 'view') live = false
    else if (boundary === 'expiry') account.expiresAt = Date.now() - 1
    else signer.nip44!.decrypt = async () => 'substituted'
    release(); await rejected; expect(calls).toBe(1)
  } finally { release(); await signer.close() }
})

it('checks a deferred provider start before dispatch and rejects a wrapper that omits its boundary', async () => {
  const pubkey = getPublicKey(generateSecretKey()); let release!: () => void, live = true, starts = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const crypt = { decrypt: async (_peer: string, _content: string, boundary: SignerEffectBoundary) => {
    await gate; return boundary.start(async () => { starts++; return 'result' })
  } }
  const account = { method: 'nip07', pubkey, signer: { method: 'nip07', pubkey, providerEffectBoundary: 1, nip44: crypt } } as unknown as SignetSession
  const decrypt = ordinaryMessageDecrypt(account, () => account)!
  const work = decrypt(pubkey, 'ciphertext', () => live), rejected = expect(work).rejects.toThrow()
  live = false; release(); await rejected; expect(starts).toBe(0)
  live = true; crypt.decrypt = async () => 'an unchecked result'
  const omitted = ordinaryMessageDecrypt(account, () => account)!
  await expect(omitted(pubkey, 'ciphertext', () => live)).rejects.toThrow('boundary')
})

it('refuses unsupported signer transports and preserves the current actual SDK provider result', async () => {
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  const signer = new Nip07Signer(pubkey, { getPublicKey: async () => pubkey, signEvent: async template => finalizeEvent(template, key),
    nip44: { encrypt: async () => 'unused', decrypt: async () => 'exact provider result' } })
  try {
    const account = { method: 'nip07', signer, pubkey } as SignetSession
    expect(await ordinaryMessageDecrypt(account, () => account)!(pubkey, 'ciphertext', () => true)).toBe('exact provider result')
    expect(ordinaryMessageDecrypt({ ...account, method: 'nip46' } as SignetSession, () => account)).toBeUndefined()
  } finally { await signer.close() }
})
