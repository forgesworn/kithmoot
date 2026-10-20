import { describe, expect, it } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { encrypt, decrypt } from 'nostr-tools/nip04'
import { Nip07Signer, type SignetSession } from 'signet-login'
import { LegacyMessageLifetime } from './legacy-message-lifetime.js'
import { LegacyMessageInbox } from './legacy-message-inbox.js'
import { legacyMessageDecrypt } from './legacy-message-signer.js'

const key = (last: number) => Uint8Array.from([...Array<number>(31).fill(0), last])
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('legacy view lifetime through overlapping account work', () => {
  it('refuses a new inbox until both concurrent transitions have settled', async () => {
    const first = deferred(), second = deferred(), invalidated: boolean[] = []
    let entryDisabled = false
    const lifetime = new LegacyMessageLifetime(() => invalidated.push(lifetime.idle), () => { entryDisabled = !lifetime.idle })
    let subscriptions = 0, releases = 0
    const tryOpen = () => {
      const inbox = new LegacyMessageInbox({ account: getPublicKey(key(1)), current: () => lifetime.idle, blocked: () => false,
        changed: () => {}, transport: { subscribe: () => { subscriptions++; return () => {} }, close: () => { releases++ } } })
      inbox.open(); return inbox
    }
    const a = lifetime.run(async () => { await first.promise; return 'first' })
    const b = lifetime.run(async () => { await second.promise; return 'second' })
    expect(entryDisabled).toBe(true); expect(invalidated).toEqual([false, false])
    tryOpen().close(); expect(subscriptions).toBe(0)
    first.resolve(); expect(await a).toBe('first')
    expect(entryDisabled).toBe(true); tryOpen().close(); expect(subscriptions).toBe(0)
    second.resolve(); expect(await b).toBe('second')
    expect(entryDisabled).toBe(false)
    const opened = tryOpen(); expect(subscriptions).toBe(1); opened.close()
    expect(releases).toBe(3)
  })

  it('a refused nested transition does not release the enclosing forget fence', async () => {
    const innerReady = deferred(), innerSettled = deferred(), outerDone = deferred()
    let invalidations = 0
    const lifetime = new LegacyMessageLifetime(() => { invalidations++ }, () => {})
    const outer = lifetime.run(async () => {
      try { await lifetime.run(async () => { await innerReady.promise; throw Error('refused') }) }
      catch { innerSettled.resolve() }
      expect(lifetime.idle).toBe(false)
      await outerDone.promise
    })
    expect(lifetime.idle).toBe(false); expect(invalidations).toBe(2)
    innerReady.resolve()
    await innerSettled.promise
    expect(lifetime.idle).toBe(false)
    outerDone.resolve(); await outer
    expect(lifetime.idle).toBe(true)
  })

  it('closes a pending real SDK decrypt before nested work and never adopts its late result', async () => {
    const recipient = key(1), sender = key(2), account = getPublicKey(recipient), peer = getPublicKey(sender)
    const providerStarted = deferred(), providerDone = deferred(), outerDone = deferred(), innerDone = deferred()
    const event = finalizeEvent({ kind: 4, created_at: 1_800_000_000, tags: [['p', account]],
      content: await encrypt(sender, account, 'A late legacy result') }, sender)
    let decrypts = 0, subscriptions = 0, closed = 0, off = 0
    const signer = new Nip07Signer(account, { getPublicKey: async () => account,
      signEvent: async () => { throw Error('Unexpected signing') }, nip04: {
        encrypt: async () => { throw Error('Unexpected encryption') },
        decrypt: async (author, ciphertext) => { expect(author).toBe(peer); decrypts++; providerStarted.resolve(); await providerDone.promise; return decrypt(recipient, author, ciphertext) },
      } })
    const session: SignetSession = { pubkey: account, method: 'nip07', signer,
      authEvent: finalizeEvent({ kind: 21236, created_at: 1_800_000_000, tags: [], content: 'Public test session' }, recipient) as SignetSession['authEvent'] }
    let inbox: LegacyMessageInbox | undefined
    const lifetime = new LegacyMessageLifetime(() => inbox?.close(), () => {})
    inbox = new LegacyMessageInbox({ account, current: () => lifetime.idle, blocked: () => false, changed: () => {},
      decrypt: legacyMessageDecrypt(session, () => session),
      transport: { subscribe: (_filters, receive) => { subscriptions++; receive(event); return () => { off++ } }, close: () => { closed++ } } })
    inbox.open(); const opening = inbox.openMessage(event.id); await providerStarted.promise
    const transition = lifetime.run(async () => {
      await lifetime.run(() => innerDone.promise)
      await outerDone.promise
    })
    expect(inbox.snapshot().messages).toEqual([]); expect(closed).toBe(1); expect(off).toBe(1)
    innerDone.resolve(); providerDone.resolve(); await opening
    expect(lifetime.idle).toBe(false); expect(inbox.snapshot().messages).toEqual([])
    expect(decrypts).toBe(1); expect(subscriptions).toBe(1)
    outerDone.resolve(); await transition
    expect(lifetime.idle).toBe(true); expect(inbox.snapshot().messages).toEqual([])
  })
})
