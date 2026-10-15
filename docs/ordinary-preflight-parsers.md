# Signet and pending preflight parsers

The shared Signet snapshot validator and pending pair parser are used by the
existing protected adapters and can also run on captured raw snapshots before
native owner or tab-marker allocation. They return frozen counts only. No
loader, pruning, current clock, entropy, network, Storage write or owner effect
is part of these validators.

Signet retains the exact ten SDK names in browser custody. Unknown names under
`signet:login.`, the reserved namespace root, account wrapping and tab relocation
hold. Session coherence, signed proof, captured origin/app/account, secret
scalars, bunker relays, pending handshake fields and value bounds use the same
checks as the adapter. Stored proof integrity is checked at its signed time;
this is not a fresh login or room membership. The current dependency and lockfile
pin published `signet-login@0.19.1`; see [SDK provenance](ordinary-sdk-provenance.md).
That release does not establish protected production startup.

Pending preflight structurally validates every queue and both physical owners
before invoking any supplied binding callback. Only exact account-scoped room names are accepted; legacy
unscoped names, nesting and unsupported suffixes hold. The parser verifies each
outer signature from fresh JSON, exact carrier fields, artwork, queue bounds
and duplicate IDs across the durable/transient pair. The binding callback is
mandatory, receives the actual browser/tab owner and must return exactly true
for each independently cloned record.
It must be a pure same-image inner-message/account/room/channel/participant
check supplied by the complete composition. Signature integrity alone does not
supply that check. Empty writer cuts retain no sends. Counts never attach a
publisher or authorise replay. Binding callback exceptions retain the existing
adapter revocation/error path; raw preflight normalises them to HOLD. Queue capacity applies per captured account and
room, across both owners.

The new unit tests exercise raw preflight and actual pending queue serialisation.
The existing native Signet and pending specs still exercise SDK login/restore,
CAS races, stale queues, receipt uncertainty, incomplete migration and effect
fences through the changed adapters. Additional native cases run preflight on
captured Storage before constructing any owner, with clock, entropy, key
allocation, encryption, database opening, Storage writes and networking blocked.
Those probes use synthetic signed inputs and binding predicates, not production
bootstrap, independent clients or a complete authority image.

These are unpublished source integration steps. Other private namespaces,
physical classification, navigation/access ownership, complete same-image
bindings, raw-owner preflight before `OrdinaryTabLifetime`, startup ordering,
real client/capacity fences, awaited effects and coordinated forgetting remain
required. The current main startup is not wired to this work.
