import type { EventTemplate } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { sha256BlobHex, uploadEnvelopeBlob, type BlossomDescriptor } from '../../src/attachment.js'

export interface CopyEnvelopeOptions {
  server: string
  envelope: Blob
  sha256: string
  identity: ParticipantIdentity
  /** Recheck the captured account and destination before signing and sending. */
  current: () => void
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** Claim the exact encrypted attachment on the person's own Blossom server.
 * No plaintext, recovery key, room announcement or new envelope is produced. */
export async function copyEnvelopeToWildbloom(options: CopyEnvelopeOptions): Promise<BlossomDescriptor> {
  const hash = options.sha256.toLowerCase()
  if (await sha256BlobHex(options.envelope) !== hash) throw new Error('The encrypted file changed. Open it again before saving a copy.')
  const sign = async (template: EventTemplate) => {
    options.current()
    const signed = await options.identity.signEvent(structuredClone(template))
    if (signed.pubkey !== options.identity.pubkey) throw new Error('The signer approved a different identity. Reconnect your account and try again.')
    options.current()
    return signed
  }
  return uploadEnvelopeBlob(options.server, options.envelope, hash, {
    sign,
    signal: options.signal,
    fetch: options.fetch,
  })
}

/** Actionable copy failures, without leaking the attachment key or contents. */
export function attachmentCopyError(error: unknown, host: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number(/\((\d{3})[:)]/.exec(message)?.[1] ?? /answered (\d{3})/.exec(message)?.[1])
  if (status === 401 || status === 403) return `${host} didn’t let this identity save the file. Use an identity your Wildbloom Node allows, then try again.`
  if (status === 413) return `${host} won’t take a file this big.`
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed|timeout|Could not reach/i.test(message)) return `Couldn’t reach ${host}. Try again.`
  if (/account|destination|identity|signer/i.test(message)) return message
  return `Couldn’t save the encrypted copy to ${host}. ${message}`
}
