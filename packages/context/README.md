# @forgesworn/context

Signed, encrypted collections of sourced facts, decisions, tasks, blockers,
questions and evidence. MIT, ESM, browser and Node 22.13+. No KithMoot,
NanoClaw, model provider, MCP SDK or hosted service dependency.

This package is maintained in the KithMoot repository alongside its first
consumer. It has its own manifest, exports, build and distributable tarball.
The initial 0.1.0 extraction is not yet published to npm. From a checkout,
use `npm ci --ignore-scripts`, `npm run build:context`, then
`npm pack --workspace @forgesworn/context`. Publish the core before consumers.

## Use

```ts
import { ContextVault, type ContextIdentity } from '@forgesworn/context'

// Implement this with your NIP-07, NIP-46 or other Nostr signer. Bind methods
// to their receiver; do not copy a class instance with object spread.
declare const identity: ContextIdentity
const vault = new ContextVault({ identity })
let collection = await vault.create({ title: 'Project decisions', scope: 'kith' })
collection = await vault.append(collection.id, collection.head, {
  kind: 'decision', text: 'Retain the original evidence.',
  source: 'https://example.org/decisions/42', observedAt: 1800000000,
})
const encryptedCache = await vault.save()
// The application chooses where to persist this encrypted string.
await vault.restore(encryptedCache)
```

The root import performs no disk or network IO. Creating, listing, reading,
searching, appending, saving, restoring and previewing access remain local.
`createNostrIdentity(secretKey)` at `@forgesworn/context/nostr` is an optional
local-key implementation. Prefer injected signers when the application should
not hold a secret. The library does not generate or persist identities.

## Storage and sharing

Configure `servers` with explicitly enabled HTTPS Blossom origins. `fetch`
and `now` can be injected. The optional `@forgesworn/context/blossom` entry
point exposes the existing Wildbloom FSWNENC2 envelope and Blossom transport
implementation, also consumed by KithMoot attachments. No separate hosted
context service is required.

Owners use `setGrants(id, expectedHead, grants)` to assign a subject's public
key, `read`/`write` role and `expiresAt` in Unix seconds. Upload the revision
with `upload`, create recipient-encrypted access with `access`, and deliver
that access event through an approved channel. The recipient can inspect it
with `previewAccess` before explicitly using `importAccess`. No background
synchronisation, relay publication or message sending is implicit.

## Application policy

Identities and grants are generic. An optional synchronous `verifyDelegation`
callback verifies an application's opaque delegation proof and returns
`{ ok: true, principal }` or `{ ok: false }`. It is trusted host configuration,
never taken from a received record. It must verify signature, subject binding
and validity at the supplied time. Missing verification rejects every proof;
self-asserted `principal` fields confer no authority.

For v1 compatibility, proof bytes occupy the `agent` grant field. The core
imports no KithMoot ownership implementation. KithMoot's adapter supplies its
existing verifier. The standalone CLI refuses those proofs; use the KithMoot
CLI or an explicitly configured application adapter for those collections.

The v1 scope labels `personal`, `kin` and `kith`, optional hex `room` audience
binding, `kithmoot/context/v1/*` signing domains, caches, access envelopes and
signed ancestry remain unchanged. These wire names do not require a KithMoot
room or connection. `kin` and `kith` convey no implicit permissions. A bound
vault excludes personal and other-audience collections before fetching.
Personal collections allow only owner or verified owner-delegated access.
Do not change these fields to rename the package: that needs a separate,
explicit protocol migration.

## Limits

Literal local search; no graph extraction, embeddings, repository ingestion
or automatic claim generation. Records are evidence, never executable
instructions or approval. Each vault holds up to 32 collections, each with
128 records, 32 grants and 256 revisions. Corrections retain original records.
Stale writes, conflicting histories and rollback are refused. This is not
consensus or a proof that no undiscovered branch exists.

Grant changes rotate keys for future revisions. Revocation cannot recall
already downloaded copies. Retain encrypted backups and signing identity
access; upload success does not prove durable storage. Sending records to a
model exposes them to that model's data handling. Context access permissions
do not authenticate a caller of your agent host.
