# Remaining browser-private family custody

This unpublished helper validates the remaining discovery, file and recovery
families for the ordinary protected-storage migration. The complete same-image
composite, production root, all-client fencing, before-effect consumers and
coordinated forget remain required. This helper does not complete DG08.

`validateOrdinaryPrivateFamilySnapshot` returns frozen counts only. It reads an
owned raw map without a wall clock, network, mutable loader, signer, source
cleanup, entropy, secret generation or expiry pruning. All matched families
belong to the browser owner. Unsupported versions, wrapped namespaces, invalid
JSON or oversized values hold the whole image intact. Unrelated families are
left for the required complete composite; this is not a general validator.

| Family | Preserved custody and explicit boundary |
| --- | --- |
| Box discovery | Past contact revision and node pin, enabled preference, signed status/claim carriers, Link card/serial, and conflict floors. Malformed but genuinely box-signed status is a replay floor and must survive. Claims are shape/signature checked at their own authored time; retired and out-of-order history remains. A retained Link card is verified at its own historical lifetime. Neither these checks nor an enabled flag grant current ownership or a message endpoint. |
| Upload journals | Canonical writer rows, lowercase hash and unique URL/hash tuples, at most 1,000 candidates. The actual writer permits arbitrary or empty URL strings. They stay inert candidate data and cannot authorise contacting their operator. |
| Pending deletion | The shared complete parser verifies the exact signed target and copied expiry with no clock. No event or URL escapes the result. Legacy unbound permissions hold intact for deliberate recovery; migration does not upgrade or prune them. |
| History cursors | Physical account/node binding, at most 64 unique relay/class windows and safe inclusive end times. The actual saver spreads arbitrary JSON extensions; those bytes survive. The producer's locale-dependent order is not changed, and a relay string is not permission to dial. EOSE is not a complete-history claim. |
| File consent | Exact shared-mode/disclosure/origin fields with canonical HTTPS origin. The separate legacy server suggestion stays arbitrary display-only text and never becomes consent. Private Bothy storage is still unconnected. |
| Room logos | At most 64 unsigned cached records, original epoch, bounded verified inline PNG/WebP containers, removal operations and valid record times. The current writer strips sender metadata. Custody supplies no original sender signature, current membership or full image-decoder acceptance. |

Discovery can legitimately retain a past revision after its contact card has
changed, and a node change can retain a previous claim/conflict floor while
clearing old status/card data. Do not require current endorsement or discard
orphan/inert rows during offline custody. The full composite must validate the
other physical families and keep their binding/authority boundaries explicit;
actual discovery still requires a fresh initial relay read before effects.

Primary app writers produce the test fixtures. Their deterministic synthetic
keys, injected relay callbacks, offline deletion response and checked-in PNG
are disclosed substitutions. Unit tests check exact bytes, signatures, capacity,
malformed whole-image holds and absence of a clock/network. Native tests use
actual browser Storage, IDB, Web Locks and WebCrypto with a no-op client fence.
They demonstrate helper migration/reopening and holds before entropy, row writes
or source cleanup, not actual production startup, independent authority, native
quota exhaustion, a real operator or physical-device acceptance.
