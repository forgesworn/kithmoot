# Encrypted context

Context uses the independent MIT `@forgesworn/context` library, with Node
persistence, CLI and MCP in `@forgesworn/context-tools`. Both are maintained as
packages in this repository and are published separately to npm at version 0.1.0.
Neither depends on KithMoot or NanoClaw. See [the core package](../packages/context/README.md)
and [Node tools](../packages/context-tools/README.md).

KithMoot owns the browser panel, room integration and agent ownership verifier.
`src/context.ts` remains a compatibility adapter; existing `import { ContextVault }
from 'kithmoot'` callers retain its verifier. The portable package rejects agent
proofs unless a host explicitly supplies verification. It performs no network
or disk operations on import and needs no hosted context service.

The extraction preserves FSWNENC2 bytes, NIP-44 access, the v1 signing domains,
cache and tool schemas. No re-encryption, identity change or cache migration is
required. The `kithmoot-context` executable remains available for existing
NanoClaw MCP registrations and installs the same ownership verifier. A generic
`encrypted-context` executable is also supplied by the Node tools package; do
not substitute it for a KithMoot connector that reads agent ownership grants.

## Use in KithMoot

Open **Room details → Context**. Create a collection, then save records with
their source references. Facts, decisions, tasks, blockers, questions and
evidence retain their signer and observation date.

- **Personal:** the owner and explicitly granted agents belonging to that
  owner. It cannot be bound to a room or retrieved by a room adapter.
- **Kin:** a chosen circle, granted individually in a room.
- **Kith:** collaborators, granted individually in a room.

Kin and Kith are audience labels. Neither room membership, agent ownership
nor the label itself grants access. A collection has one owner; the owner
chooses each recipient's read/write permission and expiry. A verified room
agent's ownership proof is available in the grant form; an offline agent
needs its principal's public signed proof. A principal's secret key never
belongs in an agent container.

Under **Sharing and permissions**, choose a recipient and grant access.
Then choose **Upload and download access file** and deliver the downloaded
file to that recipient through an approved channel. They choose **Import
or back up context → Preview access file**, review the owner, scope and
storage origin, then explicitly download/import it. A room adapter rejects
private and other-room access before contacting storage.

The selected file storage server in room settings also serves context.
Opening, searching and previewing context do not fetch it. Download an
encrypted backup and retain access to the signing identity: login alone
cannot reconstruct a lost collection when every cache and access file is
gone. Browser storage can run out; a failed save is reported, not presented
as a committed change. Backups can be restored without storage access.

## Library

```ts
import { ContextVault } from 'kithmoot'

const vault = new ContextVault({
  identity: { pubkey, signEvent, encrypt, decrypt }, // injected NIP-44 peer crypt
  servers: ['https://your-blossom.example'],
  room: roomId, // mandatory for an agent serving this room
})
await vault.restore(encryptedCache) // optional; no network
const collections = vault.list()
const context = vault.read(collections[0].id, 'blocker')
const updated = await vault.append(context.id, context.head, {
  kind: 'blocker', text: 'A person must check the board display.',
  source: 'kithmoot://room/chat/source-message-id', observedAt: unixSeconds,
})
const encryptedCacheToPersist = await vault.save()
```

An external signer should be wrapped with functions calling its methods,
preserving their receiver. Do not spread a class instance and expect
prototype methods to be copied. `fetch` and the clock can be injected for
testing. Applications decide where encrypted caches live.

## MCP and CLI

Build a checkout with `npm ci --ignore-scripts && npm run build:lib`, using
Node 22 or later. The package supplies `kithmoot-context`; a checkout can run
`node /path/to/kithmoot/bin/kithmoot-context.mjs`.

```json
{
  "mcpServers": {
    "room-context": {
      "command": "node",
      "args": [
        "/path/to/kithmoot/bin/kithmoot-context.mjs", "mcp",
        "--identity", "/private/agent-own.key",
        "--expect-pubkey", "<agent's 64-character public key>",
        "--state", "/agent-workspace/context-room.json",
        "--room", "<64-character room id>",
        "--server", "https://your-blossom.example"
      ]
    }
  }
}
```

The key file must already exist and contain that agent's own hexadecimal
secret. A missing file never creates a new identity; a mismatched pinned
public key prevents startup. The server starts without contacting storage.
Use a separate cache file for each identity and room. Unix cache files are
0600 and written through an exclusive lock and atomic rename; concurrent
writers retry after a busy response. After a crash, the operator may remove
a stale `.lock` only after verifying no process still owns it.

Tools: `context_list`, `context_read`, `context_create`, `context_append`,
`context_preview`, `context_import`, `context_upload`, `context_access`,
`context_grants`, `context_set_grants`. Preview/import accept an `access`
string containing the downloaded JSON event. No tool sends chat messages.
For CLI use, replace `mcp` with `call context_list` (or another tool), and
provide its argument object on stdin. The same implementation backs both.

An existing `kithmoot-agent` process can take `--context <cache>` and repeated
`--context-server <origin>` flags. Its model briefings refresh the local
encrypted cache on every turn. MCP `describe_room` does the same, with
context tools included; stdio clients can request `{"op":"context"}`.
Room and participant must match. Briefings include up to eight collections
and eight recent active records per collection; query the tools for more.

Use `--personal` instead of `--room` only for a separate private assistant.
Never wire that adapter into a shared room. A worker should have its own
identity, an explicit caller allowlist, a bounded job queue and only the
workspace mounts/tools needed for its task. MCP is a tool connection, not
an authentication boundary against another user of the same host account.

## Storage and trust

Snapshots are encrypted using Wildbloom's unchanged FSWNENC2 envelope
(HKDF and authenticated AES-GCM chunks). Uploads use its scoped BUD-11
Blossom authorisation. Storage learns encrypted bytes, their hash and size,
the uploading public key, access times and network metadata. It does not
receive record text, titles, policies or recovery keys in plaintext.

Policies, records, snapshots and access events use verified Nostr
signatures in separate `kithmoot/context/v1/*` domains. They are offline
signed objects, not a public relay index. Access envelopes are encrypted
with NIP-44 to one recipient. The encrypted cache also seals its keys and
policies to the local identity. Anyone controlling an authorised agent's
identity or runtime can read that agent's granted data.

Grant changes are owner-only and rotate the collection key. Removal
protects future updates; recipients keep any data already downloaded, and
an offline old grant remains usable for its old snapshot until expiry.
This release does not discover revocation remotely or claim immediate
revocation of old copies. Expired grants and ownership proofs are checked
on access. A copied key cannot be made to expire cryptographically.

Every update names the previous signed head and an ordered ancestry. A
known reader accepts later snapshots only with its existing head and
ancestry retained and every prior signed record preserved in order.
Concurrent branches, rollbacks and removed history are refused. A current
authorised writer attests the ancestry; this is not a consensus service or
proof that no other branch exists. Keep conflicting access files and
coordinate a writer to preserve both sets of sourced records.

## Current limits

This is a bounded collection store with literal local search, not a graph
extractor, vector search engine or Graphify clone. It does not crawl repos,
auto-extract claims, run embedded instructions, publish public indexes or
sync access files in the background. Data remains evidence, not execution
approval. Any context supplied to an LLM inherits that provider's data
handling: use a local model where the prompt must stay on your hardware.

Collections currently allow 128 signed records, 32 grants and 256 revisions;
a vault allows 32 collections. Start another collection when full.
`supersedes` retains the original signed record and hides it from the
current view. The UI adds records; the library/MCP can submit corrections.
Storage durability and recovery depend on retained copies and keys; an
upload success is not a redundancy or long-term availability guarantee.

Validation includes independent identities and agent ownership proofs,
wrong recipients/rooms, expired/forged grants, tampered ciphertext,
conflicting writers, encrypted restart recovery, real HTTPS transfers
between independent MCP processes, and two independent browser accounts.
