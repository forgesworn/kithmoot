import { NostrMlsKeeperInboxTransport } from '../app/src/mls-keeper-inbox-relay.js'
import { localIdentity } from '../src/identity.js'
const identity = localIdentity(new Uint8Array(32).fill(42))
let active = true, release: (() => void) | undefined
export const keeper = identity.pubkey
export function stop() { active = false }
export function finishSigner() { release?.() }
export function page(url: string, circle: boolean, auth: boolean, holdSigner = false) {
  const signer = { pubkey: identity.pubkey, signEvent: async (event: any) => {
    document.body.dataset.keeperSigning = 'waiting'
    if (holdSigner) await new Promise<void>(resolve => { release = resolve })
    return identity.signEvent(event)
  } }
  return new NostrMlsKeeperInboxTransport(undefined, 500, () => 1_000).page({ relay: { url, read: true, write: false, circle }, keeper,
    since: 900, until: 1_000, current: () => active, ...(auth ? { authentication: signer } : {}) })
}
